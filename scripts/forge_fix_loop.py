"""Shared fix-application dispatcher for forge review loops.

Both ``forge_review.run_design_review`` and ``forge_plan.run_plan_review``
implement the iron-rule loop: dispatch → classify → fix → commit. Prior to
this module both call sites stubbed out the "fix" step and committed the
unchanged artifact, producing misleading commit messages and an infinite
re-review on the same findings.

``apply_fixes`` dispatches a Claude CLI agent with the current artifact and
a structured list of findings, asks it to emit the *full* updated document,
writes the result back to disk, and returns ``(new_text, changed)``.
Callers should refuse to commit when ``changed`` is ``False`` — that is a
signal the model rejected the fix batch or produced a no-op.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


# Sentinel markers — the LLM is instructed to wrap its updated document
# between these so we can reliably extract it from whatever prose it adds.
_DOC_BEGIN = "<<<FORGE_UPDATED_DOCUMENT>>>"
_DOC_END = "<<<END_FORGE_UPDATED_DOCUMENT>>>"


class FixApplicationError(RuntimeError):
    """Raised when fix application fails in a way the caller should surface."""


# ── Finding formatting ────────────────────────────────────────────────────


def _format_finding(finding: dict[str, Any]) -> str:
    section = finding.get("section") or "<no-section>"
    title = finding.get("title") or "<no-title>"
    severity = finding.get("severity", "medium")
    description = (finding.get("description") or "").strip()
    return (
        f"- [{severity}] {section} :: {title}\n"
        f"  {description}" if description else f"- [{severity}] {section} :: {title}"
    )


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
        "1. Resolve every finding below by editing the document in place.\n"
        "2. Preserve sections and content not mentioned in findings.\n"
        "3. Do NOT add meta-commentary about the changes inside the document.\n"
        f"4. Emit the complete updated document between the markers "
        f"{_DOC_BEGIN} and {_DOC_END}, with nothing else inside those markers.\n"
        "5. If a finding is incoherent or cannot be resolved, leave the "
        "corresponding section unchanged — do not invent content.\n\n"
        "## Findings to resolve\n"
        f"{findings_block}\n\n"
        f"## Current {artifact_kind}\n"
        f"{artifact_text}\n\n"
        f"Now emit the updated {artifact_kind} between the markers."
    )


# ── Document extraction ───────────────────────────────────────────────────


def extract_updated_document(raw_output: str) -> str | None:
    """Pull the updated document out of the model's stdout.

    Returns ``None`` when the markers are missing or empty — callers should
    treat that as "no fixes applied" and refuse to commit.
    """
    if _DOC_BEGIN not in raw_output or _DOC_END not in raw_output:
        return None
    start = raw_output.index(_DOC_BEGIN) + len(_DOC_BEGIN)
    end = raw_output.index(_DOC_END, start)
    body = raw_output[start:end].strip("\n")
    return body or None


# ── Subprocess wrapper (mockable) ─────────────────────────────────────────


def _run_subprocess(
    cmd: list[str],
    *,
    input: str,  # noqa: A002
    env: dict[str, str] | None,
    timeout: int,
) -> subprocess.CompletedProcess:
    """Thin wrapper — replace in tests via ``unittest.mock.patch``."""
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        input=input,
        env=env,
        check=False,
        timeout=timeout,
    )


def _dispatch_fix_agent(prompt: str, *, timeout: int) -> str:
    """Dispatch Claude CLI to apply fixes. Returns raw stdout or "" on error.

    Uses Claude because it is the best at structured full-document edits.
    Callers can monkeypatch this function in tests.
    """
    try:
        from claude_utils import (  # noqa: PLC0415
            AgentDisabledError,
            build_claude_cmd,
            make_clean_env,
        )
    except ImportError:
        return ""

    try:
        cmd = build_claude_cmd()
    except AgentDisabledError as exc:
        print(f"[forge_fix_loop] {exc}", file=sys.stderr)
        return ""

    try:
        result = _run_subprocess(
            cmd, input=prompt, env=make_clean_env(), timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"[forge_fix_loop] dispatch failed: {exc}", file=sys.stderr)
        return ""

    if result.returncode != 0:
        stderr_snippet = (result.stderr or "")[:400]
        print(
            f"[forge_fix_loop] agent exited {result.returncode}: {stderr_snippet}",
            file=sys.stderr,
        )
        return ""
    return result.stdout or ""


# ── Public entrypoint ─────────────────────────────────────────────────────


def apply_fixes(
    artifact_path: Path,
    findings: list[dict[str, Any]],
    *,
    artifact_kind: str,
    round_num: int,
    timeout: int = 600,
) -> tuple[str, bool]:
    """Apply fixes to ``artifact_path`` and write the result back.

    Returns ``(new_text, changed)``:
      - ``new_text`` is the (possibly unchanged) artifact content on disk
      - ``changed`` is ``True`` when the content was actually modified

    When ``findings`` is empty, returns ``(current_text, False)`` without
    dispatching. On dispatch failure or missing markers, returns the
    original text with ``changed=False`` so callers can skip the commit.
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
    raw_output = _dispatch_fix_agent(prompt, timeout=timeout)
    if not raw_output:
        return current_text, False

    updated = extract_updated_document(raw_output)
    if updated is None:
        print(
            "[forge_fix_loop] updated-document markers missing from agent "
            "output; refusing to commit an unchanged artifact.",
            file=sys.stderr,
        )
        return current_text, False

    if updated == current_text:
        return current_text, False

    artifact_path.write_text(updated, encoding="utf-8")
    return updated, True
