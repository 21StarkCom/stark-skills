#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from domain_triage import DomainVerdict, TriageResult


_BANNER_WIDTH = 72
_BANNER_INNER_WIDTH = _BANNER_WIDTH - 4
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

_REVIEW_LABELS = {
    "pr": ("PR Review", "32", "🔍", "[PR REVIEW]"),
    "design": ("Design Review", "35", "📐", "[DESIGN REVIEW]"),
    "plan": ("Plan Review", "34", "📋", "[PLAN REVIEW]"),
}

_MODE_LABELS = {
    "aggressive": ("33", "⚡", "aggressive"),
    "conservative": ("36", "🛡️", "conservative"),
    "full": ("2", "🔓", "full"),
}

_SEVERITY_LABELS = {
    "critical": ("1;31", "🔴", "critical"),
    "high": ("1;33", "🟡", "high"),
    "medium": ("37", "🟠", "medium"),
    "low": ("2", "⚪", "low"),
}

_STATUS_STYLE = {
    True: ("32", "✅", "[OK]"),
    False: ("31", "⏭️", "[SKIP]"),
}

_DISPATCH_STYLE = {
    "success": ("32", "✅", "[OK]"),
    "failure": ("31", "❌", "[FAIL]"),
    "running": ("33", "···", "[RUN]"),
}


@dataclass
class TUIConfig:
    color: bool
    plain: bool
    json_mode: bool


def make_config(no_color: bool = False, plain: bool = False, json_mode: bool = False) -> TUIConfig:
    """Create a TUIConfig with environment-aware color detection."""
    tty = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
    no_color_env = bool(os.environ.get("NO_COLOR"))
    color = bool(tty and not no_color and not no_color_env and not plain)
    return TUIConfig(color=color, plain=plain, json_mode=json_mode)


def _ansi(code: str, text: str, config: TUIConfig) -> str:
    if not config.color:
        return text
    return f"\033[{code}m{text}\033[0m"


def _plain_text(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _icon(emoji: str, plain_text: str, config: TUIConfig) -> str:
    return plain_text if config.plain else emoji


def _review_meta(review_type: str) -> tuple[str, str, str, str]:
    return _REVIEW_LABELS.get(review_type, (review_type.title(), "37", "🔍", f"[{review_type.upper()}]"))


def _mode_meta(mode: str) -> tuple[str, str, str]:
    return _MODE_LABELS.get(mode, ("37", mode, mode))


def _severity_meta(severity: str) -> tuple[str, str, str]:
    return _SEVERITY_LABELS.get(severity, ("37", severity, severity))


def _format_banner_line(text: str, config: TUIConfig) -> str:
    visible = _plain_text(text)
    trimmed = visible[:_BANNER_INNER_WIDTH]
    if len(visible) > _BANNER_INNER_WIDTH:
        text = text[: len(trimmed)]
        visible = trimmed
    if config.plain:
        return visible
    padding = " " * (_BANNER_INNER_WIDTH - len(visible))
    return f"║ {text}{padding} ║"


def _section_header(config: TUIConfig, title: str, emoji: str, plain_text: str) -> str:
    if config.json_mode:
        return ""
    if config.plain:
        return f"=== {plain_text} {title} ==="
    header = f"── {emoji}  {title} "
    return header + "─" * max(0, _BANNER_WIDTH - len(header))


def _format_duration(duration: float | None) -> str:
    if duration is None:
        return ""
    return f"({duration:.1f}s)"


def _normalize_dispatch_status(status: str) -> str:
    normalized = status.strip().lower()
    if normalized in {"success", "succeeded", "ok", "done", "completed"}:
        return "success"
    if normalized in {"failure", "failed", "error", "timeout", "timed_out"}:
        return "failure"
    return "running"


def _dispatch_detail(status: str, findings_count: int | None) -> str:
    normalized = status.strip().lower()
    if normalized in {"success", "succeeded", "ok", "done", "completed"}:
        if findings_count is None:
            return "completed"
        noun = "finding" if findings_count == 1 else "findings"
        return f"{findings_count} {noun}"
    if normalized in {"timeout", "timed_out"}:
        return "timeout"
    if normalized in {"failure", "failed", "error"}:
        return normalized
    return "running..."


def _get_verdicts(triage_result: Any) -> list[Any]:
    return list(getattr(triage_result, "verdicts", []))


def _get_domains(triage_result: Any, name: str) -> list[str]:
    return list(getattr(triage_result, name, []))


def render_banner(
    config: TUIConfig,
    review_type: str,
    repo: str,
    pr_number: int | None,
    mode: str,
    agent: str,
    model: str,
) -> str:
    """Render the top banner for a triage session."""
    if config.json_mode:
        return ""

    review_label, review_color, review_emoji, review_plain = _review_meta(review_type)
    mode_color, mode_emoji, mode_plain = _mode_meta(mode)

    repo_label = f"{repo} #{pr_number}" if pr_number is not None else repo
    review_prefix = _ansi(review_color, _icon(review_emoji, review_plain, config), config)
    mode_prefix = _ansi(mode_color, _icon(mode_emoji, mode_plain, config), config)

    line_one = f"{review_prefix}  stark-triage · {review_label} · {repo_label}"
    if config.plain:
        line_two = f"Mode: {mode_plain} · Agent: {agent} · Model: {model}"
    else:
        line_two = f"{mode_prefix}  Mode: {mode} · Agent: {agent} · Model: {model}"

    if config.plain:
        divider = "=" * _BANNER_WIDTH
        return "\n".join((divider, _format_banner_line(line_one, config), _format_banner_line(line_two, config), divider))

    top = "╔" + ("═" * (_BANNER_WIDTH - 2)) + "╗"
    bottom = "╚" + ("═" * (_BANNER_WIDTH - 2)) + "╝"
    return "\n".join((top, _format_banner_line(line_one, config), _format_banner_line(line_two, config), bottom))


def render_triage(config: TUIConfig, triage_result: Any) -> str:
    """Render the triage verdict table and footer."""
    if config.json_mode:
        return ""

    verdicts = _get_verdicts(triage_result)
    dispatched_domains = _get_domains(triage_result, "dispatched_domains")
    skipped_domains = _get_domains(triage_result, "skipped_domains")
    domain_width = max((len(getattr(verdict, "domain", "")) for verdict in verdicts), default=12)

    lines = [_section_header(config, "Triage", "🎯", "[TRIAGE]")]
    for verdict in verdicts:
        relevant = bool(getattr(verdict, "relevant", False))
        color, emoji, plain_text = _STATUS_STYLE[relevant]
        icon = _ansi(color, _icon(emoji, plain_text, config), config)
        status_text = "relevant" if relevant else "skip"
        domain = str(getattr(verdict, "domain", "")).ljust(domain_width)
        confidence = f"({float(getattr(verdict, 'confidence', 0.0)):.2f})"
        reason = str(getattr(verdict, "reason", "")).strip()
        line = f"  {icon} {domain}  {status_text:<9} {confidence}"
        if reason:
            line += f" {reason}"
        lines.append(line)

    total = len(verdicts)
    dispatched = len(dispatched_domains)
    saved = len(skipped_domains)
    dispatch_icon = _icon("🚀", "[TRIAGE]", config)
    time_icon = _icon("⏱️", "", config)
    footer_one = f"{dispatch_icon} Dispatching {dispatched}/{total} domains  ·  Saving ~{saved} sub-agent runs"
    footer_two = f"{time_icon} Triage completed in {float(getattr(triage_result, 'duration_s', 0.0)):.1f}s".strip()
    lines.append(footer_one)
    lines.append(_ansi("2", footer_two, config))
    return "\n".join(lines)


def render_dispatch_progress(
    config: TUIConfig,
    index: int,
    total: int,
    agent: str,
    domain: str,
    status: str,
    findings_count: int | None = None,
    duration: float | None = None,
) -> str:
    """Render a single dispatch progress line."""
    if config.json_mode:
        return ""

    normalized = _normalize_dispatch_status(status)
    color, emoji, plain_text = _DISPATCH_STYLE[normalized]
    icon = _ansi(color, _icon(emoji, plain_text, config), config)
    detail = _dispatch_detail(status, findings_count)
    digits = max(1, len(str(total)))
    prefix = f"[{index:>{digits}}/{total}]"
    actor = f"{agent}:{domain}"
    actor_width = max(20, min(34, len(actor) + 2))
    line = f"{prefix} {icon} {actor.ljust(actor_width)} {detail}"
    if duration is not None:
        line += f"    {_ansi('2', _format_duration(duration), config)}"
    return line


def render_summary(
    config: TUIConfig,
    total_findings: int,
    by_severity: dict[str, int],
    succeeded: int,
    failed: int,
    total_duration: float,
    triage_duration: float,
) -> str:
    """Render the final dispatch summary."""
    if config.json_mode:
        return ""

    lines = [_section_header(config, "Summary", "📊", "[SUMMARY]")]
    severity_parts = [f"{total_findings} findings"]
    for severity in ("critical", "high", "medium", "low"):
        count = int(by_severity.get(severity, 0))
        color, emoji, plain_text = _severity_meta(severity)
        if config.plain:
            severity_parts.append(f"{count} {severity}")
        else:
            token = _ansi(color, _icon(emoji, plain_text, config), config)
            severity_parts.append(f"{token} {count} {severity}")
    lines.append("  ·  ".join(severity_parts))

    success_icon = _ansi("32", _icon("✅", "[OK]", config), config)
    failure_icon = _ansi("31", _icon("❌", "[FAIL]", config), config)
    total_runs = succeeded + failed
    failure_label = "failure" if failed == 1 else "failures"
    lines.append(f"{success_icon} {succeeded}/{total_runs} sub-agents succeeded  ·  {failure_icon} {failed} {failure_label}")
    dispatch_duration = max(0.0, total_duration - triage_duration)
    timing_icon = _icon("⏱️", "", config)
    timing_line = f"{timing_icon} Total: {total_duration:.1f}s (triage: {triage_duration:.1f}s + dispatch: {dispatch_duration:.1f}s)".strip()
    lines.append(_ansi("2", timing_line, config))
    return "\n".join(lines)


def render_insights(config: TUIConfig, success: bool, error: str | None = None) -> str:
    """Render the insights emission status section."""
    if config.json_mode:
        return ""

    lines = [_section_header(config, "Insights", "📡", "[INSIGHTS]")]
    if success:
        arrow = _icon("→", "->", config)
        lines.append(f"{arrow} triage_decision event emitted to stark-insights")
    else:
        warning = _ansi("33", _icon("⚠", "[WARN]", config), config)
        detail = error or "unknown error"
        lines.append(f"{warning} stark-insights unavailable: {detail}")
    return "\n".join(lines)


def render_zero_domains(config: TUIConfig) -> str:
    """Render the empty-dispatch message when no domains were selected."""
    if config.json_mode:
        return ""
    marker = _ansi("31", _icon("🚫", "[SKIP]", config), config)
    return f"{marker} Triage found no relevant domains - skipping review"
