"""Shared manual red-team dispatcher integration.

This module keeps the design and plan dispatchers byte-aligned for run
identity, fix-plan gating, sidecar rendering, audit persistence, and insights
emission.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

import stark_red_team as rt
from config_loader import get_model_rates, get_red_team_config

GH_COMMENT_LIMIT = 65_536


class _InsightsTelemetrySink(rt.CallTelemetrySink):
    """Live telemetry sink for FU-rt11.

    Forwards per-call ``start`` / ``end`` events into ``red_team_insights``,
    threading cumulative cost so the operator can read budget remaining at
    every call boundary. The cumulative-cost reference is mutated in place
    so all calls in one orchestrator invocation share state.
    """

    def __init__(self, ctx: rt.RedTeamRunContext) -> None:
        self.ctx = ctx
        self.cumulative_cost_usd: float = 0.0
        # Keep a tiny in-memory record of the most recent call's start time
        # so phase-aware audits (e.g. "primary started at T, ended at T+x")
        # can reconstruct the timeline. Keyed by call_id so concurrent calls
        # don't clobber each other.
        self._call_start_iso: dict[str, str] = {}

    def _now(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def start(
        self,
        *,
        call_id: str,
        call_phase: str,
        round_num: int,
        configured_model: str,
        prompt_chars: int,
        truncated: bool,
    ) -> None:
        import red_team_insights

        ts = self._now()
        self._call_start_iso[call_id] = ts
        red_team_insights.emit_call_start(
            self.ctx,
            call_id=call_id,
            call_phase=call_phase,
            round_num=round_num,
            configured_model=configured_model,
            prompt_chars=prompt_chars,
            truncated=truncated,
            cumulative_cost_usd=self.cumulative_cost_usd,
            per_run_budget_usd=self.ctx.per_run_budget_usd,
            timestamp_iso=ts,
        )

    def end(self, record: rt.CallTelemetryRecord) -> None:
        import red_team_insights

        # Snapshot pre-call cumulative cost so the end event can carry both
        # ``cumulative_cost_usd`` (running total INCLUDING this call) and
        # ``budget_remaining_usd`` derived from it. Snapshot BEFORE bumping
        # so the math in ``build_call_end_envelope`` is deterministic.
        cumulative_before = self.cumulative_cost_usd
        self.cumulative_cost_usd += record.cost_usd
        red_team_insights.emit_call_end(
            self.ctx,
            call_id=record.call_id,
            call_phase=record.call_phase,
            round_num=record.round_num,
            configured_model=record.configured_model,
            actual_model=record.actual_model,
            transport=record.transport,
            prompt_chars=record.prompt_chars,
            truncated=record.truncated,
            input_tokens=record.input_tokens,
            output_tokens=record.output_tokens,
            duration_s=record.duration_s,
            cost_usd=record.cost_usd,
            cumulative_cost_usd=cumulative_before,
            per_run_budget_usd=self.ctx.per_run_budget_usd,
            error=record.error,
            request_id=record.request_id,
            timestamp_iso=self._now(),
        )
FIX_PLAN_SECTION_LIMIT = 12 * 1024
_RT_ID_RE = re.compile(r"^rt\d+$")
_KILL_SWITCH_WARNED = False


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def final_status(result: rt.RedTeamResult) -> str:
    return rt.derive_status(result)


def sidecar_path_for(path: Path) -> Path:
    if path.suffix == ".md":
        return path.with_name(path.stem + ".red-team.md")
    return path.with_suffix(path.suffix + ".red-team.md")


def build_dispatch_env() -> dict[str, str]:
    try:
        from runtime_env import build_agent_env

        env = build_agent_env("codex", "local")
    except Exception:
        env = {
            k: v
            for k, v in os.environ.items()
            if k in {"PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR"}
        }

    for key in ("OPENAI_API_KEY", "OPENAI_API_KEY_FILE", "OPENAI_API_KEY_LABEL"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


def _git_text(args: list[str], cwd: str | None) -> str | None:
    try:
        proc = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    text = proc.stdout.strip()
    return text or None


def _repo_root(cwd: str | None) -> Path | None:
    root = _git_text(["git", "rev-parse", "--show-toplevel"], cwd)
    return Path(root).resolve() if root else None


def _repo_name(cwd: str | None) -> str:
    raw = _git_text(["gh", "repo", "view", "--json", "nameWithOwner"], cwd)
    if raw:
        try:
            parsed = json.loads(raw)
            name = parsed.get("nameWithOwner")
            if isinstance(name, str) and name:
                return name
        except (json.JSONDecodeError, ValueError):
            pass
    return "unknown"


def _pr_number(cwd: str | None) -> int | None:
    raw = _git_text(["gh", "pr", "view", "--json", "number"], cwd)
    if not raw:
        return None
    try:
        number = json.loads(raw).get("number")
    except (json.JSONDecodeError, ValueError, AttributeError):
        return None
    return int(number) if isinstance(number, int) else None


def build_run_context(
    *,
    stage: str,
    artifact_path: Path,
    cfg: dict[str, Any],
    model_rates: dict[str, Any],
    cwd: str | None,
) -> rt.RedTeamRunContext:
    repo_root = _repo_root(cwd)
    artifact_relative_path: str | None = None
    if repo_root is not None:
        try:
            artifact_relative_path = str(artifact_path.resolve().relative_to(repo_root))
        except ValueError:
            artifact_relative_path = None

    return rt.RedTeamRunContext(
        run_id=f"manual-{uuid.uuid4().hex[:12]}",
        stage=stage,
        caller="manual",
        repo=_repo_name(cwd) if repo_root is not None else "unknown",
        artifact_relative_path=artifact_relative_path,
        cwd=cwd,
        env=build_dispatch_env(),
        model_rates=model_rates,
        cfg_red_team=cfg,
        per_run_budget_usd=float(cfg.get("per_run_budget_usd", 0.0)),
        pr_number=_pr_number(cwd),
        started_at_iso=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )


def assert_openai_key_available_for_responses(ctx: rt.RedTeamRunContext, model: str) -> None:
    if model not in rt.RESPONSES_API_MODELS:
        return
    if rt._resolve_openai_api_key(ctx.env) is None:
        raise RuntimeError(
            "no OpenAI API key available for red-team Responses API dispatch; "
            "set OPENAI_API_KEY or OPENAI_API_KEY_FILE+OPENAI_API_KEY_LABEL"
        )


def _severity_counts(result: rt.RedTeamResult) -> tuple[int, int, int]:
    return (
        sum(1 for f in result.findings if f.severity == "critical"),
        sum(1 for f in result.findings if f.severity == "high"),
        sum(1 for f in result.findings if f.severity == "medium"),
    )


def _record_run(ctx: rt.RedTeamRunContext, result: rt.RedTeamResult, model: str) -> None:
    import red_team_audit

    critical, high, medium = _severity_counts(result)
    red_team_audit.init_red_team_tables()
    red_team_audit.record_red_team_run(
        {
            "run_id": ctx.run_id,
            "stage": ctx.stage,
            "rounds_used": result.round_num,
            "final_status": final_status(result),
            "total_findings": len(result.findings),
            "critical_count": critical,
            "high_count": high,
            "medium_count": medium,
            "human_review_count": result.human_review_count,
            "duration_s": result.duration_s,
            "cost_usd": result.cost_usd,
            "model": model,
            "caller": ctx.caller,
            "repo": ctx.repo,
            "artifact_relative_path": ctx.artifact_relative_path,
            "pr_number": ctx.pr_number,
            "fix_plan_status": "pending",
            # Pin the local audit row's created_at to the same ISO timestamp
            # the forward-emitted red_team_run event uses, so backfill
            # (--scope=forward) reconstructs byte-identical timestamps.
            "created_at": ctx.started_at_iso,
        }
    )


def _record_and_emit_findings(ctx: rt.RedTeamRunContext, result: rt.RedTeamResult) -> None:
    import red_team_audit
    import red_team_insights

    for finding in result.findings:
        stable_key = rt.compute_stable_key(
            run_id=ctx.run_id,
            stage=ctx.stage,
            round_num=result.round_num,
            persona=finding.persona,
            finding_id=finding.id,
            concern_hash=finding.concern_hash,
        )
        red_team_audit.record_finding(
            run_id=ctx.run_id,
            stage=ctx.stage,
            round_num=result.round_num,
            finding_id=finding.id,
            persona=finding.persona,
            severity=finding.severity,
            concern=finding.concern,
            consequence=finding.consequence,
            counter_proposal=finding.counter_proposal,
            trade_off=finding.trade_off,
            reason_for_uncertainty=finding.reason_for_uncertainty,
            stable_key=stable_key,
            concern_hash=finding.concern_hash,
            risk_key=finding.risk_key,
            affected_component=finding.affected_component,
            failure_mode=finding.failure_mode,
        )
        red_team_insights.emit_finding(ctx, finding=finding, round_num=result.round_num)


def _kill_switch_active() -> bool:
    return os.environ.get("STARK_RED_TEAM_FIX_PLAN_KILL", "").lower() in {
        "1",
        "true",
        "yes",
    }


def _warn_kill_switch_once() -> None:
    global _KILL_SWITCH_WARNED
    if not _KILL_SWITCH_WARNED:
        print("red_team.fix_plan.kill_switch_active", file=sys.stderr)
        _KILL_SWITCH_WARNED = True


def resolve_fix_plan(
    *,
    ctx: rt.RedTeamRunContext,
    challenge: rt.RedTeamResult,
    artifact: str,
    source_spec: str,
    enable_fix_plan_for_calibration: bool,
    telemetry: rt.CallTelemetrySink | None = None,
) -> tuple[str, rt.RedTeamFixPlan | None, list[str]]:
    run_warnings: list[str] = []
    fix_plan: rt.RedTeamFixPlan | None = None

    if _kill_switch_active():
        _warn_kill_switch_once()
        run_warnings.append("red_team.fix_plan.kill_switch_active")
        return "skipped_kill_switch", None, run_warnings
    if not ctx.cfg_red_team["fix_plan"]["enabled"] and not enable_fix_plan_for_calibration:
        return "skipped_disabled", None, run_warnings
    if challenge.error is not None:
        return "skipped_challenge_error", None, run_warnings
    if challenge.blocking_count == 0 and challenge.human_review_count > 0:
        return "skipped_human_review_only", None, run_warnings
    if challenge.blocking_count == 0:
        return "skipped_clean", None, run_warnings
    if challenge.cost_usd >= ctx.per_run_budget_usd:
        return "skipped_budget_exhausted", None, run_warnings

    filtered = [f for f in challenge.findings if not rt.is_human_review(f)]
    _envelope, fits_safely, _omitted = rt.preflight_findings_envelope(
        filtered,
        int(ctx.cfg_red_team["fix_plan"]["max_input_chars"]),
    )
    if not fits_safely:
        return "skipped_input_too_large", None, run_warnings

    fix_plan = rt.run_red_team_fix_plan(
        ctx,
        telemetry=telemetry,
        artifact=artifact,
        source_spec=source_spec,
        challenge_findings=challenge.findings,
        synthesis=challenge.synthesis,
        challenge_cost_usd=challenge.cost_usd,
    )
    status = "success" if fix_plan.error is None else "error"
    if fix_plan.error is None:
        total = challenge.cost_usd + fix_plan.cost_usd
        if total > ctx.per_run_budget_usd:
            run_warnings.append("over_budget_after_fix")
            fix_plan.warnings.append("over_budget_after_fix")
            print(
                f"warn: total cost ${total:.2f} exceeds budget ${ctx.per_run_budget_usd:.2f}",
                file=sys.stderr,
            )
    return status, fix_plan, run_warnings


_INLINE_MARKDOWN_SPECIALS = ("\\", "`", "*", "_", "[", "]", "<", ">", "|")


def _escape_inline(text: str) -> str:
    """Escape Markdown specials in untrusted single-line text.

    Title fields are rendered inside an H3 heading; without escaping, an
    attacker-controlled title like ``[Click](http://attacker)`` or
    ``<img onerror=...>`` would render as a link or HTML in PR comments.
    Escape the inline-rendering specials by prefixing each with a
    backslash. CommonMark renders ``\\[`` as a literal ``[``.
    """
    if not text:
        return ""
    # Backslash MUST be escaped first to avoid double-escaping the
    # backslashes we're about to introduce.
    out = text.replace("\\", "\\\\")
    for ch in _INLINE_MARKDOWN_SPECIALS:
        if ch == "\\":
            continue
        out = out.replace(ch, "\\" + ch)
    return out.replace("\n", " ").strip()


def _escape_block(text: str) -> str:
    """Escape Markdown specials in untrusted multi-line prose.

    Same escapement as :func:`_escape_inline` but preserves newlines and
    paragraph structure so a synthesis paragraph still reads as a
    paragraph. Used for the model's free-text fields embedded in the bot
    PR comment so attacker-influenced artifact / spec text cannot inject
    misleading links, images, raw HTML, or fake review markup into a
    comment that reads as Stark's attestation.

    PR-#430 round-3 review fix #8 / round-4 finding #8: the synthesis
    block was previously emitted raw, so a crafted artifact could embed
    ``[Approved](http://attacker)`` or ``<img onerror=...>`` and the bot
    comment would render them with the GitHub-bot trust badge in front.
    """
    if not text:
        return ""
    out = text.replace("\\", "\\\\")
    for ch in _INLINE_MARKDOWN_SPECIALS:
        if ch == "\\":
            continue
        out = out.replace(ch, "\\" + ch)
    # Preserve paragraph breaks but trim leading/trailing whitespace so
    # the surrounding markdown spacing stays tidy.
    return out.strip()


def _needs_fence(text: str) -> bool:
    """Detect markdown content that must be fenced rather than inlined.

    PR-#430 review fix #11 widened the trigger from "fenced-block markers
    or opening HTML tags" to also catch closing HTML tags
    (``</details>``) and inline-markdown link constructs (``[text](url)``,
    ``![alt](url)``). Without those triggers, attacker-influenced finding
    text could break out of the surrounding ``<details>`` block in the
    PR comment or render misleading clickable links.
    """
    return bool(re.search(r"```|````|<\w+|</\w+|!?\[[^\]]*\]\(", text or ""))


def _max_backtick_run(text: str) -> int:
    """Return the longest run of consecutive backticks in *text*."""
    longest = 0
    current = 0
    for ch in text or "":
        if ch == "`":
            current += 1
            if current > longest:
                longest = current
        else:
            current = 0
    return longest


def _render_text(label: str, value: str) -> list[str]:
    if _needs_fence(value):
        # A static three-backtick fence can be closed by attacker-controlled
        # content that itself contains ```; widen the fence to one more
        # backtick than any run inside the value so the close marker is
        # unambiguous. (≥ 3 backticks; CommonMark requires the close fence
        # to be at least as long as the open.)
        fence_len = max(3, _max_backtick_run(value) + 1)
        fence = "`" * fence_len
        return [f"**{label}.**", "", f"{fence}text", value.strip(), fence]
    return [f"**{label}.** {value.strip()}"]


def _rt_ids(ids: list[str]) -> str:
    valid = [fid for fid in ids if _RT_ID_RE.match(fid)]
    return ", ".join(f"`{fid}`" for fid in valid) if valid else "_None_"


def render_fix_plan_section(
    *,
    fix_plan_status: str,
    fix_plan: rt.RedTeamFixPlan | None,
) -> str:
    lines = ["## Proposed Fix Plan", ""]
    if fix_plan_status == "success" and fix_plan is not None:
        # Per design §4.1, the success block surfaces the canonical model
        # + reasoning effort, total cost / duration / tokens, coverage
        # (addressed of blocking, with deliberately deferred), warnings
        # and any input-truncation flags. Without these the section
        # ships as opaque cost+moves and downstream auditors can't
        # match a sidecar to its insights event.
        addressed_set: set[str] = set()
        for move in fix_plan.moves:
            addressed_set.update(move.addressed_finding_ids)
        addressed_count = len(addressed_set)
        unaddressed_count = len(fix_plan.unaddressed_finding_ids)
        orphan_count = len(fix_plan.orphan_finding_ids)
        blocking_total = addressed_count + unaddressed_count + orphan_count
        lines.append("**Status:** success")
        lines.append(
            f"**Generated by:** `{fix_plan.model}` at reasoning effort "
            f"`{fix_plan.reasoning_effort}`"
        )
        lines.append(
            f"**Cost / duration:** ${fix_plan.cost_usd:.4f} / "
            f"{fix_plan.duration_s:.1f}s | **Tokens:** "
            f"in={fix_plan.input_tokens} out={fix_plan.output_tokens}"
        )
        coverage_extras: list[str] = []
        if unaddressed_count:
            coverage_extras.append(f"{unaddressed_count} deliberately deferred")
        if orphan_count:
            coverage_extras.append(f"{orphan_count} orphaned")
        coverage_suffix = f" ({', '.join(coverage_extras)})" if coverage_extras else ""
        lines.append(
            f"**Coverage:** {addressed_count} of {blocking_total} blocking "
            f"findings addressed{coverage_suffix}"
        )
        if fix_plan.warnings:
            lines.append(
                "**Warnings:** "
                + ", ".join(f"`{_escape_inline(w)}`" for w in fix_plan.warnings)
            )
        if fix_plan.input_truncated and fix_plan.input_omitted_finding_ids:
            lines.append(
                "**Input truncated — omitted finding IDs:** "
                + _rt_ids(fix_plan.input_omitted_finding_ids)
            )
        lines.append("")
        if fix_plan.summary:
            lines.extend(_render_text("Summary", fix_plan.summary))
            lines.append("")
        for index, move in enumerate(fix_plan.moves, 1):
            lines.append(f"### {index}. {_escape_inline(move.title)}")
            lines.append("")
            lines.append(f"**Addresses:** {_rt_ids(move.addressed_finding_ids)}")
            if move.sections_touched:
                lines.append(
                    "**Sections touched:** "
                    + ", ".join(f"`{_escape_inline(s)}`" for s in move.sections_touched)
                )
            lines.append("")
            lines.extend(_render_text("Rationale", move.rationale))
            lines.append("")
            lines.extend(_render_text("New trade-off", move.new_trade_off))
            lines.append("")
        lines.append("### Unaddressed findings")
        lines.append(_rt_ids(fix_plan.unaddressed_finding_ids))
        lines.append("")
        lines.append("### Orphan findings")
        lines.append(_rt_ids(fix_plan.orphan_finding_ids))
        lines.append("")
        if fix_plan.notes:
            lines.append("### Notes")
            lines.append("")
            lines.extend(_render_text("Notes", fix_plan.notes))
            lines.append("")
    elif fix_plan_status == "error" and fix_plan is not None:
        lines.append(f"**Status:** error — {fix_plan.error or 'unknown error'}")
        lines.append(
            f"**Cost / duration:** ${fix_plan.cost_usd:.4f} / {fix_plan.duration_s:.1f}s"
        )
        lines.append("")
        lines.append("The fix-plan call failed. Findings above are still valid. Re-run with")
        lines.append("`--no-pr-comment` to retry locally without re-posting the PR comment.")
        lines.append("")
    else:
        label = fix_plan_status.removeprefix("skipped_").replace("_", " ")
        lines.append(f"**Status:** skipped ({label})")
        lines.append("")
    section = "\n".join(lines)
    if len(section) > FIX_PLAN_SECTION_LIMIT:
        marker = "\n[TRUNCATED — see local SQLite fix_plan_json]"
        return section[: FIX_PLAN_SECTION_LIMIT - len(marker)] + marker
    return section


_SEVERITY_BADGE = {"critical": "🛑", "high": "🔴", "medium": "🟡"}


def render_sidecar_markdown(
    *,
    artifact_path: Path,
    source_spec_path: Path | None,
    result: rt.RedTeamResult,
    model: str,
    run_id: str,
    stage: str,
    fix_plan_status: str | None = None,
    fix_plan: rt.RedTeamFixPlan | None = None,
) -> str:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    status = final_status(result)
    findings_sorted = sorted(
        result.findings,
        key=lambda f: (-rt.SEVERITY_RANK.get(f.severity, 0), f.persona, f.id),
    )

    lines: list[str] = [
        f"# Red-team review — {artifact_path.name}",
        "",
        f"- **Date:** {timestamp}",
        f"- **Run ID:** `{run_id}`",
        f"- **Model:** `{model}`",
        (
            f"- **Source spec:** `{source_spec_path}`"
            if source_spec_path
            else f"- **Source spec:** ({stage} used as its own spec)"
        ),
        f"- **Status:** **{status}**",
        (
            f"- **Findings:** {len(result.findings)} total — "
            f"{result.blocking_count} blocking (≥ high), "
            f"{result.human_review_count} human-review"
        ),
        (
            f"- **Cost:** ${result.cost_usd:.4f} | **Duration:** {result.duration_s:.1f}s | "
            f"**Tokens:** in={result.input_tokens} out={result.output_tokens}"
        ),
        "",
    ]

    if result.error:
        lines.extend(["## Error", "", "```", result.error.strip(), "```", ""])
        excerpt = (result.raw_output or "").strip()
        if excerpt:
            lines.extend(["### Raw output excerpt", "", "```", excerpt[:2000], "```", ""])
    else:
        if result.synthesis:
            lines.extend(["## Synthesis", "", result.synthesis.strip(), ""])
        if not findings_sorted:
            lines.extend(
                [
                    "## Findings",
                    "",
                    "_No findings._ The committee did not raise blocking or human-review concerns.",
                    "",
                ]
            )
        else:
            lines.extend(
                [
                    "## Findings",
                    "",
                    "| # | Severity | Persona | ID | Concern |",
                    "|---|----------|---------|----|---------|",
                ]
            )
            for i, finding in enumerate(findings_sorted, 1):
                badge = _SEVERITY_BADGE.get(finding.severity, "")
                concern_short = finding.concern.replace("\n", " ").strip()
                if len(concern_short) > 140:
                    concern_short = concern_short[:137] + "..."
                lines.append(
                    f"| {i} | {badge} {finding.severity} | {finding.persona} | "
                    f"`{finding.id}` | {concern_short} |"
                )
            lines.extend(["", "## Detail", ""])
            for i, finding in enumerate(findings_sorted, 1):
                badge = _SEVERITY_BADGE.get(finding.severity, "")
                lines.append(
                    f"### {i}. {badge} `{finding.id}` — {finding.persona} ({finding.severity})"
                )
                lines.extend(["", f"**Concern.** {finding.concern.strip()}", ""])
                lines.extend([f"**Consequence.** {finding.consequence.strip()}", ""])
                if finding.counter_proposal == rt.REQUEST_HUMAN_REVIEW:
                    lines.append("**Counter-proposal.** _Requests human review._")
                    if finding.reason_for_uncertainty:
                        lines.extend(["", f"**Reason.** {finding.reason_for_uncertainty.strip()}"])
                else:
                    lines.append(f"**Counter-proposal.** {finding.counter_proposal.strip()}")
                    if finding.trade_off:
                        lines.extend(["", f"**Trade-off.** {finding.trade_off.strip()}"])
                lines.append("")

    if fix_plan_status is not None:
        lines.append(render_fix_plan_section(fix_plan_status=fix_plan_status, fix_plan=fix_plan))
    return "\n".join(lines)


def _persona_anchor(stable_key: str) -> str:
    """Stable HTML anchor id for one finding (FU-rt7 + FU-rt9).

    GitHub strips most punctuation from anchor IDs. Hash the stable key down
    to a short hex slug so the anchor stays addressable across re-rendered
    bodies even when the underlying ``stable_key`` is long.
    """
    digest = hashlib.sha256(stable_key.encode("utf-8")).hexdigest()[:12]
    return f"rt-{digest}"


_PR_COMMENT_MARKER_PREFIX = "<!-- stark-red-team: stage="


def pr_comment_marker(stage: str, artifact_relative_path: str | None) -> str:
    """Return the stable HTML-comment marker for a red-team PR comment.

    Keyed by ``stage`` + artifact path (NOT ``run_id``). The PR-#430-review
    fix for finding #1/#18: every dispatcher run gets a fresh ``run_id``,
    so a marker keyed by run_id would never match the prior comment and
    "edit-or-create" silently degenerates to "always create". Keying by
    artifact identity is what makes "one updatable per-run comment per
    artifact" actually deliver. The active ``run_id`` still appears in
    the rendered body as visible metadata for the audit trail.
    """
    artifact = artifact_relative_path or "(no-artifact)"
    return f"{_PR_COMMENT_MARKER_PREFIX}{stage} artifact={artifact} -->"


# Back-compat alias: the older symbol name stays exported for callers that
# imported it before the marker scheme changed. New code should use
# ``pr_comment_marker`` directly.
def pr_comment_run_marker(run_id: str) -> str:  # pragma: no cover
    del run_id
    raise RuntimeError(
        "pr_comment_run_marker is deprecated — use pr_comment_marker(stage, "
        "artifact_relative_path) so the marker stays stable across reruns."
    )


def _highlights_section(
    findings: list[rt.RedTeamFinding],
    run_id: str,
    stage: str,
    round_num: int,
) -> list[str]:
    """Top-level highlights block for critical / high findings (FU-rt9).

    The collapsible-per-persona body keeps the comment compact, but
    reviewers triaging an actual blocking risk shouldn't have to expand
    sections to find it. Highlights link to the deterministic anchors
    rendered below so clicking a row jumps to the full finding.
    """
    high_findings = [
        f for f in findings
        if not rt.is_human_review(f)
        and rt.SEVERITY_RANK.get(f.severity, 0) >= rt.SEVERITY_RANK["high"]
    ]
    if not high_findings:
        return []
    high_findings = sorted(
        high_findings,
        key=lambda f: (-rt.SEVERITY_RANK.get(f.severity, 0), f.persona, f.id),
    )
    lines: list[str] = ["## Highlights (critical + high)", ""]
    for f in high_findings:
        stable_key = rt.compute_stable_key(
            run_id=run_id,
            stage=stage,
            round_num=round_num,
            persona=f.persona,
            finding_id=f.id,
            concern_hash=f.concern_hash,
        )
        anchor = _persona_anchor(stable_key)
        badge = _SEVERITY_BADGE.get(f.severity, "")
        concern_short = f.concern.replace("\n", " ").strip()
        if len(concern_short) > 140:
            concern_short = concern_short[:137] + "..."
        lines.append(
            f"- {badge} **{f.severity}** · `{f.persona}` · "
            f"[`{f.id}`](#{anchor}) — {_escape_inline(concern_short)}"
        )
    lines.append("")
    return lines


def _findings_collapsible_by_persona(
    findings: list[rt.RedTeamFinding],
    run_id: str,
    stage: str,
    round_num: int,
) -> list[str]:
    """Group findings into per-persona ``<details>`` blocks (FU-rt9).

    Each block opens collapsed by default and includes every finding for
    that persona at any severity, in severity-then-id order. Stable
    anchors are emitted before each finding so the highlights section
    (and external links) can deep-link in.
    """
    if not findings:
        return []
    by_persona: dict[str, list[rt.RedTeamFinding]] = {}
    for f in findings:
        by_persona.setdefault(f.persona, []).append(f)
    persona_order = [p for p in rt.VALID_PERSONA_SLUGS if p in by_persona]

    lines: list[str] = ["## Findings", ""]
    for persona in persona_order:
        rows = sorted(
            by_persona[persona],
            key=lambda x: (-rt.SEVERITY_RANK.get(x.severity, 0), x.id),
        )
        critical = sum(1 for f in rows if f.severity == "critical")
        high = sum(1 for f in rows if f.severity == "high")
        medium = sum(1 for f in rows if f.severity == "medium")
        human_review = sum(1 for f in rows if rt.is_human_review(f))
        summary = (
            f"`{persona}` — {len(rows)} findings "
            f"(critical={critical}, high={high}, medium={medium}"
        )
        if human_review:
            summary += f", human-review={human_review}"
        summary += ")"
        lines.append(f"<details><summary>{summary}</summary>")
        lines.append("")
        for f in rows:
            stable_key = rt.compute_stable_key(
                run_id=run_id,
                stage=stage,
                round_num=round_num,
                persona=f.persona,
                finding_id=f.id,
                concern_hash=f.concern_hash,
            )
            anchor = _persona_anchor(stable_key)
            badge = _SEVERITY_BADGE.get(f.severity, "")
            lines.append(f"<a id=\"{anchor}\"></a>")
            lines.append(
                f"#### {badge} `{f.id}` — {_escape_inline(f.persona)} ({f.severity})"
            )
            lines.append("")
            lines.append(f"<sub>`{stable_key}`</sub>")
            lines.append("")
            if f.risk_key or f.affected_component or f.failure_mode:
                meta_parts = []
                if f.risk_key:
                    meta_parts.append(f"**risk_key:** `{f.risk_key}`")
                if f.affected_component:
                    meta_parts.append(f"**component:** `{f.affected_component}`")
                if f.failure_mode:
                    meta_parts.append(f"**failure_mode:** `{f.failure_mode}`")
                lines.append(" · ".join(meta_parts))
                lines.append("")
            lines.extend(_render_text("Concern", f.concern))
            lines.append("")
            lines.extend(_render_text("Consequence", f.consequence))
            lines.append("")
            if f.counter_proposal == rt.REQUEST_HUMAN_REVIEW:
                lines.append("**Counter-proposal.** _Requests human review._")
                if f.reason_for_uncertainty:
                    lines.append("")
                    lines.extend(_render_text("Reason", f.reason_for_uncertainty))
            else:
                lines.extend(_render_text("Counter-proposal", f.counter_proposal))
                if f.trade_off:
                    lines.append("")
                    lines.extend(_render_text("Trade-off", f.trade_off))
            lines.append("")
        lines.append("</details>")
        lines.append("")
    return lines


def render_pr_comment_body(
    *,
    artifact_path: Path,
    source_spec_path: Path | None,
    result: rt.RedTeamResult,
    model: str,
    run_id: str,
    stage: str,
    artifact_relative_path: str | None = None,
    fix_plan_status: str | None = None,
    fix_plan: rt.RedTeamFixPlan | None = None,
) -> str:
    """Render the FU-rt9 collapsible PR comment body.

    Differs from :func:`render_sidecar_markdown` in three ways:

    - One ``<details>`` block per persona (was: one section per finding,
      flat). 5 personas × 2 rounds = 10 comments collapses to ONE comment
      with 5 collapsible sections.
    - Highlights block at top surfaces critical / high findings without
      forcing reviewers to expand persona sections.
    - HTML-comment marker at the head identifies the comment as belonging
      to a specific (stage, artifact path) so callers can find-and-edit
      instead of posting a fresh comment per round. The marker is
      explicitly NOT keyed by ``run_id`` — every dispatcher run gets a
      fresh run_id, which would defeat the find-by-marker lookup.

    Sidecar markdown (file on disk) keeps the flat layout — collapsibles
    don't render in plain-markdown viewers and the file is read offline.
    """
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    status = final_status(result)
    findings = result.findings

    lines: list[str] = [
        pr_comment_marker(stage, artifact_relative_path or str(artifact_path.name)),
        f"# Red-team review — {artifact_path.name}",
        "",
        f"- **Date:** {timestamp}",
        f"- **Run ID:** `{run_id}`",
        f"- **Model:** `{model}`",
        (
            f"- **Source spec:** `{source_spec_path}`"
            if source_spec_path
            else f"- **Source spec:** ({stage} used as its own spec)"
        ),
        f"- **Status:** **{status}**",
        (
            f"- **Findings:** {len(findings)} total — "
            f"{result.blocking_count} blocking (≥ high), "
            f"{result.human_review_count} human-review"
        ),
        (
            f"- **Cost:** ${result.cost_usd:.4f} | **Duration:** {result.duration_s:.1f}s"
        ),
        "",
    ]

    if result.error:
        lines.extend(["## Error", "", "```", result.error.strip(), "```", ""])
        excerpt = (result.raw_output or "").strip()
        if excerpt:
            lines.extend(["### Raw output excerpt", "", "```", excerpt[:2000], "```", ""])
    else:
        if result.synthesis:
            # Synthesis is model output over attacker-influenceable artifact /
            # spec / PR-diff text. Escape Markdown specials so a crafted
            # input can't inject a fake "approved" link, an HTML image, or
            # other markup into a comment posted by a trusted bot account.
            lines.extend(["## Synthesis", "", _escape_block(result.synthesis), ""])
        lines.extend(_highlights_section(findings, run_id, stage, result.round_num))
        lines.extend(_findings_collapsible_by_persona(findings, run_id, stage, result.round_num))

    if fix_plan_status is not None:
        lines.append(render_fix_plan_section(fix_plan_status=fix_plan_status, fix_plan=fix_plan))
    return "\n".join(lines)


def truncate_pr_comment(body: str, fix_plan: dict[str, Any] | None = None) -> str:
    del fix_plan
    if len(body) <= GH_COMMENT_LIMIT:
        return body
    body = re.sub(
        r"### Notes\n.*?(?=\n##|\Z)",
        "### Notes\n[TRUNCATED — see sidecar]\n",
        body,
        flags=re.S,
    )
    if len(body) <= GH_COMMENT_LIMIT:
        return body
    body = re.sub(r"(\*\*Rationale\.\*\* )(.{200})[^\n]*", r"\1\2 [TRUNCATED]", body)
    if len(body) <= GH_COMMENT_LIMIT:
        return body
    return body[: GH_COMMENT_LIMIT - 80] + "\n[TRUNCATED — see sidecar for full content]"


def sidecar_commit_message(
    *,
    artifact_path: Path,
    result: rt.RedTeamResult,
    challenge_model: str,
    fix_plan_status: str,
    fix_plan: rt.RedTeamFixPlan | None,
    run_id: str,
    stage: str,
    challenge_reasoning_effort: str = "high",
) -> str:
    if fix_plan_status == "success" and fix_plan is not None:
        addressed = []
        seen: set[str] = set()
        for move in fix_plan.moves:
            for fid in move.addressed_finding_ids:
                if fid not in seen:
                    seen.add(fid)
                    addressed.append(fid)
        fix_line = (
            f"Fix plan: {len(fix_plan.moves)} moves addressing "
            + (", ".join(addressed) if addressed else "none")
        )
        fix_effort = fix_plan.reasoning_effort
    elif fix_plan_status == "error" and fix_plan is not None:
        fix_line = f"Fix plan: error ({fix_plan.error or 'unknown error'})"
        fix_effort = str(fix_plan.reasoning_effort or "unknown")
    else:
        fix_line = f"Fix plan: skipped ({fix_plan_status.removeprefix('skipped_').replace('_', ' ')})"
        fix_effort = str(get_red_team_config()["fix_plan"].get("reasoning_effort", "xhigh"))

    return "\n".join(
        [
            f"docs(red-team): findings + fix plan for {artifact_path.name}",
            "",
            (
                f"{len(result.findings)} findings ({result.blocking_count} blocking, "
                f"{result.human_review_count} human-review)"
            ),
            fix_line,
            (
                f"Model: {challenge_model} (challenge: {challenge_reasoning_effort}; "
                f"fix-plan: {fix_effort}) · Run: {run_id}"
            ),
        ]
    )


def _fix_plan_json(fix_plan: rt.RedTeamFixPlan | None) -> str | None:
    if fix_plan is None:
        return None
    return json.dumps(asdict(fix_plan), sort_keys=True, separators=(",", ":"))


def _run_one_call(
    *,
    stage: str,
    artifact: str,
    source_spec: str,
    cfg: dict[str, Any],
    model: str,
    model_rates: dict[str, Any],
    cwd: str | None,
    telemetry: rt.CallTelemetrySink | None,
    round_num: int,
    call_phase: str,
    env: dict[str, str],
) -> rt.RedTeamResult:
    """Run a single ``rt.run_red_team`` call with the given phase label.

    Centralizes the long argument list so the iterative loop body stays
    focused on state-machine transitions rather than dispatch plumbing.
    """
    return rt.run_red_team(
        stage=stage,
        artifact=artifact,
        source_spec=source_spec,
        pr_diff=None,
        personas=cfg["personas"],
        model=model,
        model_rates=model_rates,
        cwd=cwd,
        timeout_s=cfg["timeout_s"],
        min_severity_to_block=cfg["min_severity_to_block"],
        max_input_chars=cfg["max_input_chars"],
        round_num=round_num,
        env=env,
        telemetry=telemetry,
        call_phase=call_phase,
    )


def _run_iterative(
    *,
    ctx: rt.RedTeamRunContext,
    stage: str,
    artifact: str,
    source_spec: str,
    cfg: dict[str, Any],
    model: str,
    model_rates: dict[str, Any],
    cwd: str | None,
    telemetry: rt.CallTelemetrySink | None,
) -> tuple[rt.RedTeamResult, list[Any]]:
    """Drive the FU-rt4 state machine over up to ``max_rounds`` rounds.

    Each iteration runs a primary call, classifies the round, and (if the
    primary saw blocking findings) runs a verification call. The state
    machine in :mod:`red_team_state_machine` decides whether the round
    consumed a remediation slot, whether to terminate, and what transition
    label to log. Flicker rounds repeat without consuming a slot — the
    explicit fix for the contradictory v1 semantics.

    Returns ``(final_result, history)``. ``history`` is the FU-rt4 audit
    log: an ordered list of ``RoundRecord`` instances. Callers that need
    only the result can ignore it.

    ``max_rounds == 1`` (or budget exhaustion) collapses to a single
    primary-only call, preserving v1 behavior for installs that haven't
    enabled iterative refinement.
    """
    import red_team_state_machine as sm

    max_rounds = max(1, int(cfg.get("max_rounds", 1)))
    state = sm.IterativeRunState(max_rounds=max_rounds)

    # Aggregated cost / duration / token totals so the verification call's
    # cost is reflected in the run's audit row, JSON output, and fix-plan
    # budget check (PR #430 review finding #11). Without aggregation, an
    # operator triaging an over-budget halt would see only the primary
    # cost and miss the verification calls that pushed the run over.
    total_cost_usd = 0.0
    total_duration_s = 0.0
    total_input_tokens = 0
    total_output_tokens = 0

    # PR-#430 round-3 review fix #4: track every distinct human-review
    # concern (by ``concern_hash``) seen across the iterative loop. Each
    # round runs against the SAME artifact, so a concern flagged in round
    # 1 and absent from a flicker rerun is model nondeterminism, not the
    # operator silently fixing it. Without this set, a flicker scenario
    # like blocking=1 + hr=1 → flicker → rerun primary clean would erase
    # the round-1 HR halt entirely; the operator never learns the model
    # asked for human review and FU-rt8 has nothing to accept.
    hr_findings_seen: dict[str, rt.RedTeamFinding] = {}

    def _record_hr(r: rt.RedTeamResult | None) -> None:
        if r is None:
            return
        for f in r.findings:
            if not rt.is_human_review(f):
                continue
            key = f.concern_hash or f"unhashed:{f.persona}:{f.id}"
            hr_findings_seen.setdefault(key, f)

    def _accumulate(r: rt.RedTeamResult | None) -> None:
        nonlocal total_cost_usd, total_duration_s, total_input_tokens, total_output_tokens
        if r is None:
            return
        total_cost_usd += r.cost_usd
        total_duration_s += r.duration_s
        total_input_tokens += r.input_tokens
        total_output_tokens += r.output_tokens
        _record_hr(r)

    def _finalize(
        primary: rt.RedTeamResult,
        *,
        terminal_transition: str | None,
    ) -> rt.RedTeamResult:
        """Return a result that surfaces aggregated totals + terminal outcome.

        The findings / synthesis fields stay sourced from the primary
        call. Cost / duration / tokens roll up so downstream readers see
        the run-level totals. PR-#430 review fix (#2 / #5): when the
        state machine exits in a degraded or flicker-exhausted state,
        the error field is set so ``derive_status`` returns ``error``
        (not ``halted``) — the gate cannot vouch for a finding's
        stability if verification didn't agree.

        PR-#430 round-3 review fix #4: any human-review concern that
        appeared in an earlier round but is missing from this primary is
        added back. Each round runs against the same artifact, so HR
        findings from prior rounds are not "fixed by the operator"; they
        are model output the framework should not silently swallow.
        """
        result_error = primary.error
        if not result_error and terminal_transition in {
            "terminate.degraded",
            "terminate.flicker_attempts_exhausted",
            "terminate.budget_exhausted_flicker",
            "terminate.cost_budget_exhausted",
        }:
            result_error = (
                f"red-team gate could not confirm stability: state machine "
                f"exited via {terminal_transition}. The primary findings "
                "(see raw_output) were never verified by a second call."
            )

        present: set[str] = set()
        for f in primary.findings:
            if rt.is_human_review(f):
                present.add(f.concern_hash or f"unhashed:{f.persona}:{f.id}")
        merged_findings = list(primary.findings)
        recovered_hr = 0
        for key, finding in hr_findings_seen.items():
            if key in present:
                continue
            merged_findings.append(finding)
            recovered_hr += 1

        return rt.RedTeamResult(
            stage=primary.stage,
            round_num=primary.round_num,
            synthesis=primary.synthesis,
            findings=merged_findings,
            blocking_count=primary.blocking_count,
            human_review_count=primary.human_review_count + recovered_hr,
            raw_output=primary.raw_output,
            duration_s=total_duration_s,
            cost_usd=total_cost_usd,
            error=result_error,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
        )

    # Round-1 always runs at minimum, even when max_rounds=1.
    round_num = 1
    last_good_result: rt.RedTeamResult | None = None
    while True:
        primary = _run_one_call(
            stage=stage,
            artifact=artifact,
            source_spec=source_spec,
            cfg=cfg,
            model=model,
            model_rates=model_rates,
            cwd=cwd,
            telemetry=telemetry,
            round_num=round_num,
            call_phase="primary",
            env=ctx.env,
        )
        _accumulate(primary)

        # Verification is only required when the primary returned blocking
        # findings — the stability gate has nothing to verify against if
        # the primary said clean.
        verification: rt.RedTeamResult | None = None
        if (
            primary.error is None
            and primary.blocking_count > 0
            and max_rounds > 1
        ):
            verification = _run_one_call(
                stage=stage,
                artifact=artifact,
                source_spec=source_spec,
                cfg=cfg,
                model=model,
                model_rates=model_rates,
                cwd=cwd,
                telemetry=telemetry,
                round_num=round_num,
                call_phase="verification",
                env=ctx.env,
            )
            _accumulate(verification)

        outcome = sm.classify_round(
            primary,
            verification,
            overlap=lambda a, b: rt._overlap(
                a, b, jaccard_min=float(cfg.get("stability_overlap_jaccard_min", 0.4))
            ),
            has_prior_good_round=last_good_result is not None,
            verification_required=max_rounds > 1,
        )
        if outcome != sm.RoundOutcome.error:
            last_good_result = primary

        terminate, transition = sm.should_terminate(state, outcome)
        sm.record_round(
            state,
            round_num=round_num,
            primary=primary,
            verification=verification,
            outcome=outcome,
            transition=transition or "",
        )
        if terminate:
            sm.mark_terminated(state, transition or "terminate.unknown")
            return _finalize(primary, terminal_transition=transition), state.history

        # PR-#430 round-3 review fix #16: cost-budget guard around any
        # decision to do another LLM call. Before this guard, flicker
        # reruns and remediation rounds could keep firing primary +
        # verification calls until ``flicker_attempts`` or ``max_rounds``
        # ran out, even if the run had already blown its
        # ``per_run_budget_usd``. A ``per_run_budget_usd`` of 0 disables
        # the gate (back-compat for callers that haven't configured a
        # budget yet); any positive value enforces it. We terminate via
        # ``terminate.cost_budget_exhausted`` so ``_finalize`` surfaces
        # the gap and the operator sees that a stability decision wasn't
        # reached for budget reasons rather than for stability reasons.
        if (
            ctx.per_run_budget_usd > 0
            and total_cost_usd >= ctx.per_run_budget_usd
        ):
            sm.mark_terminated(state, "terminate.cost_budget_exhausted")
            return (
                _finalize(primary, terminal_transition="terminate.cost_budget_exhausted"),
                state.history,
            )

        # Flicker without budget exhaustion: re-run the same round_num so
        # rounds_used accounting stays consistent with the state machine.
        if outcome == sm.RoundOutcome.flicker:
            continue
        round_num += 1
        if round_num > max_rounds:
            sm.mark_terminated(state, "terminate.budget_exhausted")
            return (
                _finalize(primary, terminal_transition="terminate.budget_exhausted"),
                state.history,
            )


def execute_dispatch(
    *,
    stage: str,
    artifact_path: Path,
    source_spec_path: Path | None,
    model_override: str | None,
    write_sidecar: bool,
    audit: bool,
    cwd: str | None,
    enable_fix_plan_for_calibration: bool,
) -> dict[str, Any]:
    if not artifact_path.exists():
        return {"status": "error", "error": f"{stage} file not found: {artifact_path}"}
    if source_spec_path is not None and not source_spec_path.exists():
        return {"status": "error", "error": f"source-spec file not found: {source_spec_path}"}

    cfg = get_red_team_config()
    model_rates = get_model_rates()
    model = model_override or cfg["model"]
    ctx = build_run_context(
        stage=stage,
        artifact_path=artifact_path,
        cfg=cfg,
        model_rates=model_rates,
        cwd=cwd,
    )
    if getattr(rt.run_red_team, "__module__", "stark_red_team") == "stark_red_team":
        try:
            assert_openai_key_available_for_responses(ctx, model)
        except RuntimeError as exc:
            return {"status": "error", "error": str(exc), "run_id": ctx.run_id, "model": model}

    artifact = read_text(artifact_path)
    if source_spec_path is not None:
        source_spec = read_text(source_spec_path)
    else:
        source_spec = artifact

    if enable_fix_plan_for_calibration:
        print("red_team.fix_plan.calibration_override", file=sys.stderr)

    telemetry = _InsightsTelemetrySink(ctx) if audit else None
    result, history = _run_iterative(
        ctx=ctx,
        stage=stage,
        artifact=artifact,
        source_spec=source_spec,
        cfg=cfg,
        model=model,
        model_rates=model_rates,
        cwd=cwd,
        telemetry=telemetry,
    )
    # FU-rt4 transition log — passed to ``emit_run`` below so the durable
    # ``red_team_run`` event carries every round outcome and the labelled
    # exit edge. PR-#430 round-3 review fix #13: previously this was
    # ``del``eted on the next line, so audit / JSON / metrics consumers
    # had no way to see why a run halted vs. exited cleanly.
    round_outcomes_payload = [
        {
            "round_num": rec.round_num,
            "outcome": rec.outcome.value if hasattr(rec.outcome, "value") else str(rec.outcome),
            "transition": rec.transition,
            "primary_blocking_count": rec.primary.blocking_count if rec.primary else 0,
            "primary_human_review_count": rec.primary.human_review_count if rec.primary else 0,
            "verification_blocking_count": (
                rec.verification.blocking_count if rec.verification else None
            ),
        }
        for rec in history
    ]
    terminal_transition_value = (
        history[-1].transition if history and history[-1].transition else None
    )

    # FU-rt8 — Demote human-review halts when the operator has already
    # accepted the same concern. Accepts persist in the audit DB so the
    # next dispatcher invocation honors them. Only human-review counts
    # move; blocking findings still halt regardless.
    #
    # PR-#430 review fix #3: this lookup is INDEPENDENT of ``audit`` mode.
    # ``--no-audit`` / dry-run was previously short-circuiting accept
    # filtering, so a known-accepted concern still halted those runs.
    # The ``audit`` flag now only gates *writing* audit rows, not reading
    # them.
    if result.error is None and result.human_review_count > 0:
        try:
            import red_team_human_review

            unaccepted, accepted_keys = red_team_human_review.filter_human_review_findings(
                result.findings,
                stage=stage,
                repo=ctx.repo,
            )
            del accepted_keys  # JSON output already exposes findings; keys aren't returned.
            if not unaccepted and len(unaccepted) < result.human_review_count:
                # All human-review findings have matching accepts. Rebuild
                # the result with human_review_count zeroed so derive_status
                # returns "clean"/"halted" by blocking-count alone.
                result = rt.RedTeamResult(
                    stage=result.stage,
                    round_num=result.round_num,
                    synthesis=result.synthesis,
                    findings=result.findings,
                    blocking_count=result.blocking_count,
                    human_review_count=0,
                    raw_output=result.raw_output,
                    duration_s=result.duration_s,
                    cost_usd=result.cost_usd,
                    error=result.error,
                    input_tokens=result.input_tokens,
                    output_tokens=result.output_tokens,
                )
        except Exception as exc:  # pragma: no cover - defensive: never break dispatch
            print(f"  [!] Human-review accept lookup failed: {exc}", file=sys.stderr)

    fix_plan_status = "pending"
    fix_plan: rt.RedTeamFixPlan | None = None
    fix_plan_md: str | None = None
    run_warnings: list[str] = []

    if audit:
        try:
            _record_run(ctx, result, model)
            _record_and_emit_findings(ctx, result)
        except Exception as exc:
            print(f"  [!] Failed to persist red-team audit rows: {exc}", file=sys.stderr)

    fix_plan_status, fix_plan, run_warnings = resolve_fix_plan(
        ctx=ctx,
        challenge=result,
        artifact=artifact,
        source_spec=source_spec,
        enable_fix_plan_for_calibration=enable_fix_plan_for_calibration,
        telemetry=telemetry,
    )
    if fix_plan_status == "success" and fix_plan is not None:
        fix_plan_md = render_fix_plan_section(fix_plan_status=fix_plan_status, fix_plan=fix_plan)

    if audit:
        try:
            import red_team_audit
            import red_team_insights

            red_team_audit.record_fix_plan(
                ctx.run_id,
                fix_plan_md=fix_plan_md,
                fix_plan_json=_fix_plan_json(fix_plan),
                fix_plan_cost_usd=fix_plan.cost_usd if fix_plan is not None else None,
                fix_plan_status=fix_plan_status,
            )
            if fix_plan_status == "success" and fix_plan is not None and fix_plan_md is not None:
                red_team_insights.emit_fix_plan(
                    ctx,
                    fix_plan=fix_plan,
                    fix_plan_md=fix_plan_md,
                    fix_plan_status=fix_plan_status,
                )
            red_team_insights.emit_run(
                ctx,
                result=result,
                model=model,
                fix_plan_status=fix_plan_status,
                run_warnings=run_warnings,
                round_outcomes=round_outcomes_payload,
                terminal_transition=terminal_transition_value,
            )
        except Exception as exc:
            print(f"  [!] Failed to persist or emit fix-plan state: {exc}", file=sys.stderr)

    sidecar_path: Path | None = None
    if write_sidecar:
        sidecar_path = sidecar_path_for(artifact_path)
        sidecar_path.write_text(
            render_sidecar_markdown(
                artifact_path=artifact_path,
                source_spec_path=source_spec_path,
                result=result,
                model=model,
                run_id=ctx.run_id,
                stage=stage,
                fix_plan_status=fix_plan_status,
                fix_plan=fix_plan,
            ),
            encoding="utf-8",
        )

    pr_comment_body = render_pr_comment_body(
        artifact_path=artifact_path,
        source_spec_path=source_spec_path,
        result=result,
        model=model,
        run_id=ctx.run_id,
        artifact_relative_path=ctx.artifact_relative_path,
        stage=stage,
        fix_plan_status=fix_plan_status,
        fix_plan=fix_plan,
    )

    return {
        "status": final_status(result),
        "run_id": ctx.run_id,
        "model": model,
        f"{stage}_path": str(artifact_path),
        "source_spec_path": str(source_spec_path) if source_spec_path else None,
        "sidecar_path": str(sidecar_path) if sidecar_path else None,
        "blocking_count": result.blocking_count,
        "human_review_count": result.human_review_count,
        "total_findings": len(result.findings),
        "duration_s": result.duration_s,
        "cost_usd": result.cost_usd,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "error": result.error,
        "synthesis": result.synthesis,
        "findings": [asdict(f) for f in result.findings],
        "fix_plan_status": fix_plan_status,
        "fix_plan": asdict(fix_plan) if fix_plan is not None else None,
        "run_warnings": run_warnings,
        "repo": ctx.repo,
        "artifact_relative_path": ctx.artifact_relative_path,
        "pr_number": ctx.pr_number,
        # FU-rt4 named transition log (PR-#430 round-3 review fix #13). One
        # entry per state-machine round + the labelled exit edge so
        # downstream consumers can tell why a run terminated.
        "round_outcomes": round_outcomes_payload,
        "terminal_transition": terminal_transition_value,
        # FU-rt9 — collapsible per-persona PR comment body. The skill posts
        # this directly via `gh pr review --comment --body "$pr_comment_body"`
        # instead of feeding the (flat) sidecar markdown through truncation.
        "pr_comment_body": truncate_pr_comment(pr_comment_body),
        # The exact HTML-comment marker on the first line of pr_comment_body.
        # Skills look it up via this key instead of reconstructing the format,
        # so a future marker scheme change touches one renderer, not every
        # SKILL.md (PR-#430 round-3 review fix #1/#7/#8/#11/#12).
        "pr_comment_marker": pr_comment_marker(
            stage, ctx.artifact_relative_path or str(artifact_path.name)
        ),
    }
