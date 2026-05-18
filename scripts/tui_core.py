#!/usr/bin/env python3
"""Shared TUI rendering primitives for stark-skills.

Provides color/plain-mode detection, ANSI helpers, text sanitization,
and reusable formatting functions used by triage_tui.
"""
from __future__ import annotations

import os
import re
import sys
import unicodedata
from dataclasses import dataclass

# ── Constants ────────────────────────────────────────────────────────

BANNER_WIDTH = 72

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# Control chars to strip: C0 (0x00-0x1F except \t \n), DEL (0x7F), C1 (0x80-0x9F)
_CONTROL_RE = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]"
)

# Unicode bidi overrides (U+202A-U+202E), bidi isolates (U+2066-U+2069),
# zero-width chars (U+200B-U+200F, U+FEFF)
_BIDI_ZW_RE = re.compile(
    "[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]"
)


# ── TUIConfig ────────────────────────────────────────────────────────

@dataclass
class TUIConfig:
    """Rendering configuration: color, plain-mode, and JSON-mode flags."""
    color: bool
    plain: bool
    json_mode: bool


def make_config(
    no_color: bool = False,
    plain: bool = False,
    json_mode: bool = False,
) -> TUIConfig:
    """Create a TUIConfig with environment-aware color/plain detection.

    Checks:
      - sys.stdout.isatty()
      - NO_COLOR env var (https://no-color.org)
      - TERM=dumb
      - STARK_PLAIN=1
      - plain=True forces color=False
    """
    # STARK_PLAIN env var forces plain mode
    if os.environ.get("STARK_PLAIN") in ("1", "true", "yes"):
        plain = True

    tty = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
    no_color_env = bool(os.environ.get("NO_COLOR"))
    term_dumb = os.environ.get("TERM", "").lower() == "dumb"
    color = bool(tty and not no_color and not no_color_env and not term_dumb and not plain)
    return TUIConfig(color=color, plain=plain, json_mode=json_mode)


# ── ANSI / icon helpers ──────────────────────────────────────────────

def ansi(code: str, text: str, config: TUIConfig) -> str:
    """Wrap *text* in ANSI escape codes when color is enabled."""
    if not config.color:
        return text
    return f"\033[{code}m{text}\033[0m"


def icon(emoji: str, plain_text: str, config: TUIConfig) -> str:
    """Return *emoji* in rich mode, *plain_text* in plain mode."""
    return plain_text if config.plain else emoji


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from *text*."""
    return _ANSI_RE.sub("", text)


# ── Text sanitization ───────────────────────────────────────────────

def sanitize_text(text: str) -> str:
    """Strip dangerous/invisible characters from externally-sourced text.

    Removes:
      - C0 control chars (0x00-0x1F) except \\n and \\t
      - DEL (0x7F) and C1 controls (0x80-0x9F)
      - Unicode bidi overrides (U+202A-U+202E)
      - Unicode bidi isolates (U+2066-U+2069)
      - Zero-width chars (U+200B-U+200F, U+FEFF)
    """
    text = _CONTROL_RE.sub("", text)
    text = _BIDI_ZW_RE.sub("", text)
    return text


# ── Truncation / slugify ────────────────────────────────────────────

def truncate(text: str, max_width: int) -> str:
    """Truncate *text* to *max_width* visible characters (ANSI excluded).

    If truncation occurs, the last visible char is replaced with '...'.
    """
    visible = strip_ansi(text)
    if len(visible) <= max_width:
        return text

    # Walk through original text, counting only visible chars
    visible_count = 0
    result: list[str] = []
    i = 0
    while i < len(text) and visible_count < max_width - 1:
        # Check for ANSI escape
        m = _ANSI_RE.match(text, i)
        if m:
            result.append(m.group())
            i = m.end()
        else:
            result.append(text[i])
            visible_count += 1
            i += 1

    # Capture any trailing ANSI reset sequences right at the cut point
    while i < len(text):
        m = _ANSI_RE.match(text, i)
        if m:
            result.append(m.group())
            i = m.end()
        else:
            break

    return "".join(result) + "\u2026"


def slugify(text: str, max_len: int = 50) -> str:
    """Convert *text* to a URL/filename-safe slug.

    Lowercase, replace non-[a-z0-9] with hyphens, collapse runs of
    hyphens, strip leading/trailing hyphens, truncate to *max_len*.
    """
    slug = text.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-{2,}", "-", slug)
    slug = slug.strip("-")
    return slug[:max_len].rstrip("-")


# ── Section header ───────────────────────────────────────────────────

def section_header(
    config: TUIConfig,
    title: str,
    emoji: str,
    plain_label: str,
    width: int = BANNER_WIDTH,
) -> str:
    """Render a section header line (em-dash rule with title).

    Returns empty string in json_mode.
    """
    if config.json_mode:
        return ""
    if config.plain:
        return f"=== {plain_label} {title} ==="
    header = f"\u2500\u2500 {emoji}  {title} "
    return header + "\u2500" * max(0, width - len(header))


# ── Banner formatting ────────────────────────────────────────────────

def format_banner(
    config: TUIConfig,
    lines: list[str],
    width: int = BANNER_WIDTH,
) -> str:
    """Wrap pre-formatted *lines* in a box-drawing banner (or plain dividers).

    Each line is padded/truncated to fit within the banner's inner width
    (width - 4 visible characters).  Returns the complete multi-line string.
    """
    inner = width - 4

    def _fmt(text: str) -> str:
        visible = strip_ansi(text)
        if len(visible) > inner:
            text = truncate(text, inner)
            visible = strip_ansi(text)
        if config.plain:
            return visible
        padding = " " * (inner - len(visible))
        return f"\u2551 {text}{padding} \u2551"

    formatted = [_fmt(line) for line in lines]

    if config.plain:
        divider = "=" * width
        return "\n".join([divider] + formatted + [divider])

    top = "\u2554" + ("\u2550" * (width - 2)) + "\u2557"
    bottom = "\u255a" + ("\u2550" * (width - 2)) + "\u255d"
    return "\n".join([top] + formatted + [bottom])


# ── Checklist / KV helpers ───────────────────────────────────────────

def render_checklist_item(
    config: TUIConfig,
    passed: bool | None,
    label: str,
    detail: str,
    duration: float | None = None,
) -> str:
    """Render a checklist line: pass/fail/warn icon + label + detail + optional duration.

    *passed*: True = pass, False = fail, None = warn.
    """
    if passed is True:
        ico = ansi("32", icon("\u2705", "[OK]", config), config)
    elif passed is False:
        ico = ansi("31", icon("\u274c", "[FAIL]", config), config)
    else:
        ico = ansi("33", icon("\u26a0\ufe0f", "[WARN]", config), config)

    line = f"{ico} {label}  {detail}"
    if duration is not None:
        line += f" ({duration:.1f}s)"
    return line


def render_kv_line(
    config: TUIConfig,
    key: str,
    value: str,
    color: str | None = None,
) -> str:
    """Render a key: value line with optional ANSI color on the value."""
    val = ansi(color, value, config) if color else value
    return f"{key}: {val}"
