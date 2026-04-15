"""Shared fix-application dispatcher for forge review loops.

Both ``forge_review.run_design_review`` and ``forge_plan.run_plan_review``
implement the iron-rule loop: dispatch → classify → fix → commit. Prior to
this module both call sites stubbed out the "fix" step and committed the
unchanged artifact, producing misleading commit messages and an infinite
re-review on the same findings.

``apply_fixes`` dispatches a Claude CLI agent with the current artifact and
a structured list of findings, asks it to emit a JSON array of
**targeted patches** (``old_string`` / ``new_string`` pairs), applies them
in Python with a uniqueness check, writes the result back to disk, and
returns ``(new_text, changed)``.

Why patches instead of a full rewrite: the original implementation asked
the model to emit the *entire* updated document between markers. Output
scaled with spec_size × finding_count, which put even modestly-sized specs
(~350 lines with ~30 findings) past the subprocess timeout. Patches only
scale with change_size, so a 30-finding round against a 24 KB spec emits
~5-10 KB of JSON instead of a fresh 24 KB rewrite. Unapplied patches
(stale, ambiguous, or fabricated) are rejected at the Python layer and
logged; the iron-rule loop handles them naturally via recurrence.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


# Sentinel markers for the JSON patch array.
_PATCHES_BEGIN = "<<<FORGE_PATCHES>>>"
_PATCHES_END = "<<<END_FORGE_PATCHES>>>"


class FixApplicationError(RuntimeError):
    """Raised when fix application fails in a way the caller should surface."""


# ── Finding formatting ────────────────────────────────────────────────────


def _format_finding(finding: dict[str, Any]) -> str:
    fid = finding.get("id") or ""
    section = finding.get("section") or "<no-section>"
    title = finding.get("title") or "<no-title>"
    severity = finding.get("severity", "medium")
    description = (finding.get("description") or "").strip()
    header_prefix = f"- {fid} " if fid else "- "
    header = f"{header_prefix}[{severity}] {section} :: {title}"
    if description:
        return f"{header}\n  {description}"
    return header


def _format_findings(findings: Iterable[dict[str, Any]]) -> str:
    lines = [_format_finding(f) for f in findings]
    return "\n".join(lines) if lines else "(none)"


# ── Prompt construction ───────────────────────────────────────────────────


def build_fix_prompt(
    *,
    artifact_kind: str,
    artifact_text: str,
    findings: list[dict[str, Any]],
    round_num: int,
) -> str:
    """Build the fix-application prompt.

    ``artifact_kind`` is a short human label ("design spec", "implementation
    plan") used in the instructions. ``findings`` should be the fix-status
    findings only — this module is not a classifier.
    """
    findings_block = _format_findings(findings)
    return (
        f"You are applying review fixes to a {artifact_kind} in forge round "
        f"{round_num}.\n\n"
        "## Rules\n"
        "1. For each finding, emit a JSON patch that resolves it via a\n"
        "   targeted string replacement. Patches apply sequentially — later\n"
        "   patches see the edits made by earlier patches.\n"
        "2. Each patch is an object with fields:\n"
        "   - finding_id: the ID of the finding being addressed (from the\n"
        "     list below). Omit if the patch addresses a cross-cutting issue.\n"
        "   - old_string: an EXACT substring of the current document that\n"
        "     will be replaced. It MUST be unique in the document — include\n"
        "     enough surrounding context (usually 2-4 lines) so there is\n"
        "     exactly one match. Patches with zero matches or multiple\n"
        "     matches are rejected.\n"
        "   - new_string: the replacement text.\n"
        "   - note: (optional) a one-line rationale for the edit.\n"
        f"3. Emit the patches as a JSON array between the markers\n"
        f"   {_PATCHES_BEGIN} and {_PATCHES_END}. Nothing else goes between\n"
        "   those markers — no prose, no code fences, no commentary.\n"
        "4. Preserve every line that no patch touches.\n"
        "5. If a finding cannot be resolved as a single targeted edit — for\n"
        "   example, it requires rewriting entire sections or introducing new\n"
        "   cross-references — omit the patch for it. Do NOT fabricate a\n"
        "   patch whose old_string doesn't actually appear in the document.\n"
        "   The review loop will flag it again next round and escalate if\n"
        "   it recurs.\n"
        "6. An empty array (`[]`) is a valid response when no patch can be\n"
        "   applied cleanly.\n\n"
        "## Findings to resolve\n"
        f"{findings_block}\n\n"
        f"## Current {artifact_kind}\n"
        f"{artifact_text}\n\n"
        f"Now emit the patch array between {_PATCHES_BEGIN} and "
        f"{_PATCHES_END}."
    )


# ── Patch extraction ──────────────────────────────────────────────────────


def extract_patches(raw_output: str) -> list[dict[str, Any]] | None:
    """Parse the JSON patch array from the model's stdout.

    Returns ``None`` when the markers are missing or the body is not valid
    JSON or not an array. Returns an empty list when the body is ``[]``
    (valid no-op signal). Returns a list of normalized patch dicts with
    the keys ``finding_id``, ``old_string``, ``new_string``, ``note``.
    Entries missing ``old_string`` or ``new_string`` are filtered out —
    callers can assume every returned patch has string values for those
    two fields.
    """
    if _PATCHES_BEGIN not in raw_output or _PATCHES_END not in raw_output:
        return None
    start = raw_output.index(_PATCHES_BEGIN) + len(_PATCHES_BEGIN)
    end = raw_output.index(_PATCHES_END, start)
    body = raw_output[start:end].strip()
    if not body:
        return None
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    validated: list[dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        old = entry.get("old_string")
        new = entry.get("new_string")
        if not isinstance(old, str) or not isinstance(new, str):
            continue
        validated.append({
            "finding_id": str(entry.get("finding_id") or ""),
            "old_string": old,
            "new_string": new,
            "note": str(entry.get("note") or ""),
        })
    return validated


# ── Patch application ────────────────────────────────────────────────────


def _apply_patches(
    text: str, patches: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """Apply patches sequentially with a uniqueness check.

    Each patch requires ``old_string`` to appear exactly once in the
    current text. Zero matches → unapplied (stale or fabricated).
    Multiple matches → unapplied (ambiguous — the model didn't provide
    enough surrounding context to disambiguate). Empty ``old_string`` is
    unapplied (would silently become a no-op or an infinite-insert bug).

    Returns ``(new_text, applied, unapplied)`` where ``applied`` and
    ``unapplied`` are lists of the original patch dicts (with an added
    ``reason`` field on unapplied entries).
    """
    applied: list[dict[str, Any]] = []
    unapplied: list[dict[str, Any]] = []
    for patch in patches:
        old = patch.get("old_string", "")
        new = patch.get("new_string", "")
        if not old:
            unapplied.append({**patch, "reason": "empty old_string"})
            continue
        count = text.count(old)
        if count == 1:
            text = text.replace(old, new, 1)
            applied.append(patch)
        elif count == 0:
            unapplied.append({**patch, "reason": "old_string not found in document"})
        else:
            unapplied.append({
                **patch,
                "reason": f"old_string ambiguous ({count} matches)",
            })
    return text, applied, unapplied


# ── Anthropic SDK client factory (mockable) ──────────────────────────────
#
# The fix-dispatch used to shell out to `claude -p -` (the Claude Code CLI).
# That turned out to be fundamentally wrong for this use case: the CLI is
# agentic and exposes Bash/Edit/Read tools by default. On a prompt that
# instructs the model to edit a document, Claude's trained instinct is to
# call Read/Edit in a tool-use loop instead of emitting the requested
# output format. Disabling tools via --tools "" caused even worse behavior
# on large prompts — the model emitted literal <tool_use> XML as text and
# eventually hung in a degenerate thinking state.
#
# The SDK gives us a clean text-in, text-out messages.create() call with
# no tool-use wrapper in the way. It uses AnthropicVertex when the Vertex
# env vars are present (stark-skills's default), falling back to the
# direct Anthropic API if an ANTHROPIC_API_KEY is set. Neither path loads
# hooks, plugins, CLAUDE.md, or any of the CLI startup overhead.


class _FakeUsage:
    def __init__(self, input_tokens: int = 0, output_tokens: int = 0) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


def _read_vertex_env() -> dict[str, str]:
    """Return the env vars the stark-skills subagent pipeline would inject
    into a subprocess — same values used for ``claude -p -`` dispatch.

    The values live in ``runtime_env._VERTEX_ENV`` (or ``claude_utils``
    as a fallback). Reading them from there instead of ``os.environ``
    means the Vertex path works regardless of whether the user's shell
    pre-set the vars, matching how the CLI path worked before.

    Note: ``make_clean_env`` strips ``ANTHROPIC_API_KEY`` on purpose
    (it must never leak into CLI subprocesses), so callers that need to
    check for the direct-API fallback must read ``os.environ`` instead
    of this dict.
    """
    try:
        from claude_utils import make_clean_env  # noqa: PLC0415
        return make_clean_env()
    except ImportError:
        return dict(os.environ)


def _make_anthropic_client() -> Any:
    """Return an Anthropic SDK client, or ``None`` if unavailable.

    Resolution order:
      1. If the ``claude`` agent is disabled in config, return ``None``
         without constructing any client (preserves the old
         ``build_claude_cmd`` contract that honored ``models.claude.enabled``).
      2. Prefer AnthropicVertex when the runtime env injects
         ``CLAUDE_CODE_USE_VERTEX=1`` with a project id. Read those from
         ``_read_vertex_env`` — that dict is Vertex-sanitized (has no
         ``ANTHROPIC_API_KEY``) but always has the Vertex vars.
      3. Fall back to direct ``Anthropic()`` when ``ANTHROPIC_API_KEY``
         is set in the real process environment. This path must read
         ``os.environ`` directly, not ``_read_vertex_env()`` — the latter
         strips the key by design.
      4. Return ``None`` when no auth path is configured; the caller
         logs and returns "" to halt the round.

    Mocked in tests to return a fake object with a ``messages.create``
    method.
    """
    try:
        from config_loader import is_agent_enabled  # noqa: PLC0415
    except ImportError:
        def is_agent_enabled(_agent: str) -> bool:
            return True

    if not is_agent_enabled("claude"):
        print(
            "[forge_fix_loop] claude agent disabled in config; "
            "skipping SDK client construction.",
            file=sys.stderr,
        )
        return None

    try:
        from anthropic import Anthropic, AnthropicVertex  # noqa: PLC0415
    except ImportError:
        return None

    vertex_env = _read_vertex_env()
    if vertex_env.get("CLAUDE_CODE_USE_VERTEX") == "1":
        project_id = vertex_env.get("ANTHROPIC_VERTEX_PROJECT_ID", "")
        region = vertex_env.get("CLOUD_ML_REGION", "global")
        if project_id:
            return AnthropicVertex(project_id=project_id, region=region)
    if os.environ.get("ANTHROPIC_API_KEY"):
        return Anthropic()
    return None


# ── Dispatch logging ──────────────────────────────────────────────────────
#
# The fix-dispatch is a long-running, output-bound API call that used to
# fail silently on timeout with zero visibility into what the model was
# doing. The log file captures the full prompt, elapsed time, status, and
# the response text (or error) so timeouts and silent failures are
# diagnosable after the fact. One file per dispatch.


def _write_log_header(log_path: Path, prompt: str, *, timeout: int) -> None:
    header = (
        "=== Forge fix-dispatch log ===\n"
        f"timestamp: {datetime.now(timezone.utc).isoformat()}\n"
        f"timeout_s: {timeout}\n"
        "--- PROMPT ---\n"
    )
    log_path.write_text(header + prompt + "\n", encoding="utf-8")


def _append_log_result(
    log_path: Path | None,
    *,
    status: str,
    elapsed_s: float,
    stdout: str,
    stderr: str,
) -> None:
    if log_path is None:
        return
    try:
        footer = (
            "\n--- RESULT ---\n"
            f"status: {status}\n"
            f"elapsed_s: {elapsed_s:.2f}\n"
            f"--- STDOUT ---\n{stdout}\n"
            f"--- STDERR ---\n{stderr}\n"
        )
        with log_path.open("a", encoding="utf-8") as f:
            f.write(footer)
    except OSError as exc:
        print(f"[forge_fix_loop] log write failed: {exc}", file=sys.stderr)


def _open_dispatch_log(
    log_dir: Path | None, log_name: str | None, prompt: str, *, timeout: int,
) -> Path | None:
    if log_dir is None or log_name is None:
        return None
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{log_name}.txt"
        _write_log_header(log_path, prompt, timeout=timeout)
        return log_path
    except OSError as exc:
        print(f"[forge_fix_loop] log dir unusable: {exc}", file=sys.stderr)
        return None


_FIX_MODEL_ENV = "FORGE_FIX_MODEL"
_FIX_MODEL_DEFAULT = "claude-opus-4-6"
_FIX_MAX_TOKENS = 16000


def _resolve_fix_model() -> str:
    """Pick the model id for fix dispatch.

    Priority: ``FORGE_FIX_MODEL`` env var > ``models.claude.model_id`` from
    config > ``_FIX_MODEL_DEFAULT``. Honors the same config key that the
    old ``build_claude_cmd`` path respected so user overrides survive the
    CLI → SDK migration.
    """
    override = os.environ.get(_FIX_MODEL_ENV)
    if override:
        return override
    try:
        from config_loader import get_model_id  # noqa: PLC0415
        configured = get_model_id("claude")
        if configured:
            return configured
    except ImportError:
        pass
    return _FIX_MODEL_DEFAULT


def _extract_text_from_response(response: Any) -> str:
    """Concatenate the ``text`` blocks from a messages.create response."""
    parts: list[str] = []
    content = getattr(response, "content", None) or []
    for block in content:
        if getattr(block, "type", "") == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts)


def _dispatch_fix_agent(
    prompt: str,
    *,
    timeout: int,
    log_dir: Path | None = None,
    log_name: str | None = None,
) -> str:
    """Dispatch a fix request via the Anthropic SDK. Returns response text
    or "" on error.

    Uses ``messages.create`` directly instead of shelling out to
    ``claude -p -``. The CLI is agentic and triggered tool-use loops even
    when we only wanted text-in/text-out. The SDK path is a pure LLM call.

    Callers can monkeypatch this function in tests, or patch
    ``_make_anthropic_client`` to inject a fake client. When ``log_dir``
    and ``log_name`` are both provided, the full prompt, elapsed time,
    status, and response text are written to ``log_dir/log_name.txt``.
    """
    log_path = _open_dispatch_log(log_dir, log_name, prompt, timeout=timeout)

    client = _make_anthropic_client()
    if client is None:
        print(
            "[forge_fix_loop] no Anthropic SDK client available — "
            "set CLAUDE_CODE_USE_VERTEX=1 with ANTHROPIC_VERTEX_PROJECT_ID, "
            "or set ANTHROPIC_API_KEY.",
            file=sys.stderr,
        )
        _append_log_result(
            log_path, status="no_client", elapsed_s=0.0,
            stdout="", stderr="no auth configured",
        )
        return ""

    model = _resolve_fix_model()
    start = time.monotonic()
    try:
        response = client.messages.create(
            model=model,
            max_tokens=_FIX_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
            timeout=timeout,
        )
    except Exception as exc:  # noqa: BLE001
        # The SDK raises anthropic.APITimeoutError, APIStatusError,
        # APIConnectionError etc. We log the class name + message and
        # treat all as a no-output failure — the caller halts the round.
        elapsed = time.monotonic() - start
        status = f"sdk_error:{type(exc).__name__}"
        _append_log_result(
            log_path, status=status, elapsed_s=elapsed,
            stdout="", stderr=f"{type(exc).__name__}: {exc}",
        )
        print(
            f"[forge_fix_loop] SDK dispatch failed after {elapsed:.1f}s: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return ""

    elapsed = time.monotonic() - start
    text = _extract_text_from_response(response)
    usage = getattr(response, "usage", _FakeUsage())
    stop_reason = getattr(response, "stop_reason", "")
    _append_log_result(
        log_path,
        status=f"success ({stop_reason})",
        elapsed_s=elapsed,
        stdout=text,
        stderr=(
            f"usage: input_tokens={usage.input_tokens} "
            f"output_tokens={usage.output_tokens}"
        ),
    )
    return text


# ── Public entrypoint ─────────────────────────────────────────────────────


_DEFAULT_LOG_DIR = Path.home() / ".claude" / "code-review" / "logs"


def _derive_log_name(artifact_kind: str, round_num: int) -> str:
    slug = artifact_kind.replace(" ", "_")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"forge-fix-dispatch-{slug}-round{round_num}-{ts}"


def apply_fixes(
    artifact_path: Path,
    findings: list[dict[str, Any]],
    *,
    artifact_kind: str,
    round_num: int,
    timeout: int = 600,
    log_dir: Path | None = None,
) -> tuple[str, bool]:
    """Apply fixes to ``artifact_path`` and write the result back.

    Returns ``(new_text, changed)``:
      - ``new_text`` is the (possibly unchanged) artifact content on disk
      - ``changed`` is ``True`` when the content was actually modified

    When ``findings`` is empty, returns ``(current_text, False)`` without
    dispatching. On dispatch failure or missing markers, returns the
    original text with ``changed=False`` so callers can skip the commit.

    ``log_dir`` overrides the default log output directory
    (``~/.claude/code-review/logs``). Tests should pass ``tmp_path`` here
    to avoid polluting the user's home directory. Pass ``None`` (default)
    to use the real user log directory.
    """
    current_text = artifact_path.read_text(encoding="utf-8")
    if not findings:
        return current_text, False

    prompt = build_fix_prompt(
        artifact_kind=artifact_kind,
        artifact_text=current_text,
        findings=findings,
        round_num=round_num,
    )
    resolved_log_dir = log_dir if log_dir is not None else _DEFAULT_LOG_DIR
    log_name = _derive_log_name(artifact_kind, round_num)
    raw_output = _dispatch_fix_agent(
        prompt,
        timeout=timeout,
        log_dir=resolved_log_dir,
        log_name=log_name,
    )
    if not raw_output:
        return current_text, False

    patches = extract_patches(raw_output)
    if patches is None:
        print(
            "[forge_fix_loop] patch markers missing or unparseable from "
            "agent output; refusing to commit an unchanged artifact.",
            file=sys.stderr,
        )
        return current_text, False

    if not patches:
        # Empty list — model explicitly declined to patch anything.
        return current_text, False

    new_text, applied, unapplied = _apply_patches(current_text, patches)

    if unapplied:
        print(
            f"[forge_fix_loop] {len(unapplied)} of {len(patches)} patches "
            "did not apply cleanly (stale or ambiguous):",
            file=sys.stderr,
        )
        for p in unapplied:
            fid = p.get("finding_id") or "<no-id>"
            reason = p.get("reason", "")
            print(f"  [unapplied] {fid}: {reason}", file=sys.stderr)

    if new_text == current_text:
        return current_text, False

    artifact_path.write_text(new_text, encoding="utf-8")
    print(
        f"[forge_fix_loop] applied {len(applied)} of {len(patches)} patches.",
        file=sys.stderr,
    )
    return new_text, True
