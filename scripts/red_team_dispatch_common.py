"""Shared manual red-team dispatcher integration.

This module keeps the design and plan dispatchers byte-aligned for run
identity, fix-plan gating, sidecar rendering, audit persistence, and insights
emission.
"""

from __future__ import annotations

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


def _needs_fence(text: str) -> bool:
    return bool(re.search(r"```|````|<\w+", text or ""))


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

        outcome = sm.classify_round(
            primary,
            verification,
            overlap=lambda a, b: rt._overlap(
                a, b, jaccard_min=float(cfg.get("stability_overlap_jaccard_min", 0.4))
            ),
            has_prior_good_round=last_good_result is not None,
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
            return primary, state.history

        # Flicker without budget exhaustion: re-run the same round_num so
        # rounds_used accounting stays consistent with the state machine.
        if outcome == sm.RoundOutcome.flicker:
            continue
        round_num += 1
        if round_num > max_rounds:
            sm.mark_terminated(state, "terminate.budget_exhausted")
            return primary, state.history


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
    del history  # FU-rt4 transition log; insights events already capture per-round outcomes.

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
    }
