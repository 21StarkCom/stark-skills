# Session TUI — Structured Terminal Output for /stark-session

> Replace the plain text briefing in `/stark-session start` and `/stark-session end` with structured, color-coded terminal output using the same visual language as the triage TUI.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-04-04-session-tui-design.md`

---

## Problem

`/stark-session start` produces a plain text briefing — git state, PRs, health checks, persona, project board, alerts, and suggested tasks. `/stark-session end` produces a flat checklist. Both are hard to scan. The triage orchestrator now has a rich TUI (banners, section headers, color-coded status, emoji indicators), but the session skill — which runs at the start and end of every work session — is still unstructured text.

The triage TUI (`triage_tui.py`) contains reusable rendering primitives (ANSI helpers, banner rendering, section headers, `TUIConfig`) that are duplicated if a second TUI module needs them.

## Goals

1. **Structured start briefing** — color-coded sections for git, PRs, health, alerts, board, and "Next Up" action items
2. **Compact end receipt** — checklist of session actions + diff summary + "Next Up" for the next session
3. **Session identity** — session ID visible in both banners, meaningful name assigned at end, start/end timestamps, duration
4. **Shared TUI core** — extract common primitives from `triage_tui.py` into `tui_core.py` so both modules share the same rendering infrastructure
5. **Environment parity** — same NO_COLOR, non-TTY, and `--plain` behavior as the triage TUI

## Non-Goals

- Persistent/interactive dashboard (live-updating status bar)
- HTML output (that's `dashboard.py`)
- Changes to what data `/stark-session` collects — this is a rendering layer only
- Persona system changes — session TUI displays persona data, doesn't modify selection logic

---

## Architecture

```
┌──────────────────────────────────┐
│        tui_core.py               │
│  TUIConfig, make_config()        │
│  ansi(), icon(), plain_text()    │
│  section_header(), format_banner()│
│  render_checklist_item()         │
│  render_kv_line()                │
└──────────┬───────────┬───────────┘
           │           │
    ┌──────┴──┐   ┌────┴──────┐
    │triage_  │   │session_   │
    │tui.py   │   │tui.py     │
    │(domain  │   │(session   │
    │ review) │   │ briefing) │
    └─────────┘   └───────────┘
```

`tui_core.py` owns the shared rendering infrastructure. `triage_tui.py` and `session_tui.py` each define their own color maps and render functions, importing primitives from core. Both are pure rendering — no I/O, no subprocess calls.

---

## Components

### 1. `tui_core.py` — Shared Rendering Primitives

Extracted from `triage_tui.py`. After extraction, `triage_tui.py` imports from core instead of defining its own primitives. Zero behavior change to triage rendering.

**Public API:**

```python
@dataclass
class TUIConfig:
    color: bool      # ANSI enabled (auto-detect TTY + NO_COLOR)
    plain: bool      # no emoji, no box-drawing
    json_mode: bool  # suppress all rendering

def make_config(
    no_color: bool = False,
    plain: bool = False,
    json_mode: bool = False,
) -> TUIConfig:
    """Create TUIConfig with environment-aware color detection.
    
    Color enabled when: stdout is TTY, NO_COLOR not set, no_color=False, plain=False.
    """

def ansi(code: str, text: str, config: TUIConfig) -> str:
    """Wrap text in ANSI escape codes if color enabled."""

def icon(emoji: str, plain_text: str, config: TUIConfig) -> str:
    """Return emoji or plain text fallback based on config."""

def plain_text(text: str) -> str:
    """Strip ANSI escape codes from text."""

def section_header(
    config: TUIConfig,
    title: str,
    emoji: str,
    plain_label: str,
    width: int = 72,
) -> str:
    """Render section header: ── 🎯  Title ──────────────"""

def format_banner(
    config: TUIConfig,
    lines: list[str],
    width: int = 72,
) -> str:
    """Render a box-drawn banner with the given lines.
    
    Full mode:  ╔═══╗ ║ line ║ ╚═══╝
    Plain mode: ===== line =====
    """

def render_checklist_item(
    config: TUIConfig,
    passed: bool | None,
    label: str,
    detail: str,
    duration: float | None = None,
) -> str:
    """Render a status checklist line: ✅ Tests  586 passed (55s)
    
    passed=True → ✅/[OK] green
    passed=False → ❌/[FAIL] red
    passed=None → ⚠️/[WARN] yellow
    """

def render_kv_line(
    config: TUIConfig,
    key: str,
    value: str,
    color: str | None = None,
) -> str:
    """Render a key-value line with optional color on value."""
```

**What moves from `triage_tui.py`:**
- `TUIConfig` dataclass and `make_config()`
- `_ansi()` → `ansi()` (public)
- `_icon()` → `icon()` (public)
- `_plain_text()` → `plain_text()` (public)
- `_section_header()` → `section_header()` (public, gains `width` param)
- `_format_banner_line()` → internal to `format_banner()`
- `_ANSI_RE` constant
- `_BANNER_WIDTH` → default param on `format_banner()`

**What stays in `triage_tui.py`:**
- All label/style dicts (`_REVIEW_LABELS`, `_MODE_LABELS`, `_SEVERITY_LABELS`, `_STATUS_STYLE`, `_DISPATCH_STYLE`)
- All 6 render functions (render_banner, render_triage, render_dispatch_progress, render_summary, render_insights, render_zero_domains)
- These functions switch from calling `_ansi()` to calling `from tui_core import ansi` etc.

### 2. `session_tui.py` — Session Rendering

Imports all primitives from `tui_core.py`. Defines session-specific color maps and render functions.

**Color scheme:**

| Element | ANSI code | Emoji | Plain text |
|---------|-----------|-------|------------|
| Session start banner | 32 (green) | 🚀 | [SESSION START] |
| Session end banner | 34 (blue) | 🏁 | [SESSION END] |
| Git section | 36 (cyan) | 🔀 | [GIT] |
| PRs section | 35 (magenta) | 📋 | [PRS] |
| Health section | 32 (green) | 🏥 | [HEALTH] |
| Alerts section | 33 (yellow) | ⚠️ | [ALERTS] |
| Board section | 34 (blue) | 📌 | [BOARD] |
| Receipt section | 32 (green) | 📊 | [RECEIPT] |
| Diff section | 34 (blue) | 📈 | [DIFF] |
| Next Up section | 33 (yellow) | 👉 | [NEXT] |
| Persona | 35 (magenta) | 🎭 | [PERSONA] |
| Session info | 37 (white) | 📎 | [SESSION] |
| Actionable item | 33 (yellow) | ● | * |
| Low priority item | 2 (dim) | ○ | - |

**Render functions:**

```python
def render_session_banner(
    config: TUIConfig,
    mode: Literal["start", "end"],
    repo: str,
    branch: str,
    session_id: str,
    persona_name: str | None = None,
    persona_catchphrase: str | None = None,
    started_at: str | None = None,   # ISO8601 or HH:MM
    ended_at: str | None = None,     # ISO8601 or HH:MM (end mode)
    duration: str | None = None,     # e.g., "2h 47m" (end mode)
    session_name: str | None = None, # e.g., "domain-triage-impl" (end mode)
) -> str:
    """Top banner for start or end.
    
    Start:
    ╔═══════════════════════════════════════════════════════════╗
    ║ 🚀  stark-session · start · GetEvinced/design-system     ║
    ║ 🎭  Jules Winnfield — "Allow me to retort."              ║
    ║ 📎  Session: #42 · Started: 13:55                         ║
    ╚═══════════════════════════════════════════════════════════╝
    
    End:
    ╔═══════════════════════════════════════════════════════════╗
    ║ 🏁  stark-session · end · GetEvinced/design-system       ║
    ║ 🎭  Jules Winnfield — "The path of the righteous man..." ║
    ║ 📎  Session: #42 "domain-triage-implementation"           ║
    ║ ⏱️  Ended: 16:42 · Duration: 2h 47m                      ║
    ╚═══════════════════════════════════════════════════════════╝
    """

def render_git_state(
    config: TUIConfig,
    branch: str,
    ahead: int,
    behind: int,
    uncommitted: list[str],   # ["M scripts/foo.py", "?? scripts/bar.py"]
    recent_commits: list[dict],  # [{sha, message, age}]
) -> str:
    """Git section: branch, ahead/behind, uncommitted files, recent commits."""

def render_prs(
    config: TUIConfig,
    prs: list[dict],  # [{number, title, status, labels}]
) -> str:
    """PR section. Status: 'ready' (✅), 'review_requested' (··), 'draft' (○), 'merged' (🟣).
    Shows 'No open PRs.' if list is empty.
    """

def render_health(
    config: TUIConfig,
    checks: list[dict],  # [{name, passed: bool|None, detail, duration}]
) -> str:
    """Health section using render_checklist_item from core."""

def render_alerts(
    config: TUIConfig,
    alerts: list[dict],  # [{level: 'warning'|'critical', message, context}]
) -> str:
    """Alerts section. Returns empty string if no alerts (section omitted entirely)."""

def render_board(
    config: TUIConfig,
    items: list[dict],  # [{title, status: 'in_flight'|'blocked'|'clarify', issue_number}]
) -> str:
    """Board section. Returns empty string if no board items (section omitted entirely)."""

def render_receipt(
    config: TUIConfig,
    items: list[dict],  # [{name, passed: bool|None, detail, duration}]
) -> str:
    """End-mode receipt: compact checklist of session actions.
    Items: tests, build, push, PRs, issues, docs, telemetry.
    Uses render_checklist_item from core.
    """

def render_diff_summary(
    config: TUIConfig,
    added: int,
    removed: int,
    file_count: int,
    key_files: list[dict],  # [{path, status: 'new'|'modified'}]
) -> str:
    """Diff section: +lines/-lines, file count, notable files."""

def render_next_up(
    config: TUIConfig,
    items: list[dict],  # [{label, priority: 'action'|'low', issue: str|None}]
) -> str:
    """Next Up section. Actionable items (●) first, low priority (○) after.
    Used by both start and end.
    """
```

**Composition helpers for the SKILL.md caller:**

```python
def render_start_briefing(
    config: TUIConfig,
    banner_kwargs: dict,
    git: dict,
    prs: list[dict],
    health: list[dict],
    alerts: list[dict],
    board: list[dict],
    next_up: list[dict],
) -> str:
    """Compose the full start briefing from all sections.
    Concatenates non-empty sections with newline separators.
    """

def render_end_summary(
    config: TUIConfig,
    banner_kwargs: dict,
    receipt: list[dict],
    diff: dict,
    next_up: list[dict],
) -> str:
    """Compose the full end summary from all sections."""
```

### 3. Session State Changes

One addition to `session_state.py`:

```python
@dataclass
class SessionState:
    # ... existing fields ...
    name: str | None = None   # meaningful name, set at session end
```

The `name` field is set by the agent at session end based on what happened during the session. Derived from: branch name, commits made, PRs touched, issues closed — whichever gives the most descriptive slug. Examples: `"domain-triage-implementation"`, `"pr-142-review-and-merge"`, `"hotfix-config-deep-merge"`.

No other changes to session_state.py — `started_at`, `session_id`, `repo`, and `branch` already exist.

### 4. SKILL.md Integration

The session SKILL.md currently collects data via subprocess calls and prints plain text. The change:

1. Import or call `session_tui.py` render functions
2. Pass collected data as structured dicts
3. Print the returned strings

The SKILL.md remains the orchestrator — it collects git state, fetches PRs, runs health checks, reads alerts, queries the project board. The TUI module is purely a rendering layer.

**Start flow:**
1. Collect all data (existing logic)
2. `config = make_config()`
3. Print `render_start_briefing(config, ...)`

**End flow:**
1. Collect session results (existing logic)
2. Agent chooses session name based on session activity
3. `session_state.name = chosen_name; session_state.save()`
4. Compute duration from `session_state.started_at`
5. `config = make_config()`
6. Print `render_end_summary(config, ...)`

---

## Environment Behavior

Same rules as triage TUI — inherited from `tui_core.py`:

| Condition | ANSI | Emoji | Box-drawing |
|-----------|------|-------|-------------|
| Normal TTY | ✅ | ✅ | ✅ |
| `NO_COLOR=1` | ❌ | ✅ | ✅ |
| Non-TTY (piped) | ❌ | ✅ | ✅ |
| `--no-color` | ❌ | ✅ | ✅ |
| `--plain` | ❌ | ❌ (`[OK]` etc.) | ❌ (`===` dividers) |
| `json_mode` | — | — | — (empty string) |

---

## Conditional Sections

Alerts and Board sections are omitted entirely when empty — no empty headers. All other sections always render (Git, PRs, Health, Next Up). If there are no PRs, the PR section shows "No open PRs." If health checks aren't configured, the section shows "No health checks configured."

---

## File Inventory

| File | Type | Purpose |
|------|------|---------|
| `scripts/tui_core.py` | New | Shared TUI primitives extracted from triage_tui.py |
| `scripts/session_tui.py` | New | Session-specific render functions |
| `scripts/triage_tui.py` | Modified | Repoint imports to tui_core.py (zero behavior change) |
| `scripts/session_state.py` | Modified | Add `name` field to SessionState |
| `skill/stark-session/SKILL.md` | Modified | Call session_tui render functions |
| `scripts/test_tui_core.py` | New | Tests for shared primitives |
| `scripts/test_session_tui.py` | New | Tests for session rendering |
| `scripts/test_triage_tui.py` | Modified | May need import path updates |

---

## Testing Strategy

### `test_tui_core.py`

| Test | What It Validates |
|------|-------------------|
| `test_make_config_detects_tty` | TTY → color=True, non-TTY → color=False |
| `test_make_config_respects_no_color` | NO_COLOR=1 → color=False |
| `test_ansi_wraps_when_color` | color=True → ANSI codes present |
| `test_ansi_skips_when_no_color` | color=False → no ANSI codes |
| `test_icon_emoji_vs_plain` | plain=False → emoji, plain=True → text |
| `test_plain_text_strips_ansi` | ANSI-wrapped input → clean output |
| `test_section_header_formats` | Correct em-dash format with title |
| `test_section_header_plain` | Plain mode → `=== [LABEL] Title ===` |
| `test_format_banner_box_drawing` | Full mode → ╔═╗║╚╝ borders |
| `test_format_banner_plain` | Plain mode → `=` dividers |
| `test_checklist_item_pass` | passed=True → ✅ green |
| `test_checklist_item_fail` | passed=False → ❌ red |
| `test_checklist_item_warn` | passed=None → ⚠️ yellow |

### `test_session_tui.py`

| Test | What It Validates |
|------|-------------------|
| `test_start_banner_contains_session_id` | Session ID appears in banner |
| `test_end_banner_contains_duration` | Duration and end time in banner |
| `test_end_banner_contains_session_name` | Session name in end banner |
| `test_alerts_empty_returns_empty` | No alerts → empty string (section omitted) |
| `test_board_empty_returns_empty` | No board items → empty string |
| `test_next_up_ordering` | Actionable items before low priority |
| `test_no_color_strips_ansi` | NO_COLOR → zero ANSI in all output |
| `test_plain_mode_no_emoji` | plain=True → zero emoji characters |
| `test_receipt_all_passed` | All ✅ receipt |
| `test_receipt_mixed_status` | Mix of ✅/❌/⚠️ |
| `test_render_start_briefing_composition` | All sections concatenated correctly |
| `test_render_end_summary_composition` | Receipt + diff + next up concatenated |

### Existing test updates

`test_triage_tui.py` — verify all 4 existing tests still pass after extraction. May need import path updates if helpers moved from `triage_tui` to `tui_core`.
