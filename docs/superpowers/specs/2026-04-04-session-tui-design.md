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
- Changes to what data `/stark-session` collects — the TUI is a rendering layer. The one exception is the `name` field on `SessionState`, which is a small persistence addition needed for session identity display.
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
    color: bool      # ANSI enabled (auto-detect TTY + NO_COLOR + TERM)
    plain: bool      # no emoji, no box-drawing
    json_mode: bool  # suppress all rendering

def make_config(
    no_color: bool = False,
    plain: bool = False,
    json_mode: bool = False,
) -> TUIConfig:
    """Create TUIConfig with environment-aware color detection.
    
    Color disabled when any of: NO_COLOR set, TERM=dumb, stdout not a TTY,
    no_color=True, plain=True.
    """

def sanitize_text(text: str) -> str:
    """Strip terminal control characters from untrusted input.
    
    Removes all C0/C1 control codes (0x00-0x1F, 0x7F-0x9F) except
    newline (0x0A) and tab (0x09). This prevents ANSI injection,
    OSC commands, and clipboard manipulation from externally-sourced
    strings (branch names, commit messages, PR titles, persona data).
    
    All render functions MUST pass externally-sourced strings through
    this function before formatting.
    """

def ansi(code: str, text: str, config: TUIConfig) -> str:
    """Wrap text in ANSI escape codes if color enabled."""

def icon(emoji: str, plain_text: str, config: TUIConfig) -> str:
    """Return emoji or plain text fallback based on config."""

def strip_ansi(text: str) -> str:
    """Strip ANSI escape codes from text. Used for visible-length calculation."""

def truncate(text: str, max_width: int) -> str:
    """Truncate text to max_width visible characters, appending '…' if truncated.
    Operates on visible length (ANSI codes excluded from count).
    """

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
    
    Lines longer than (width - 4) visible characters are truncated.
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
- `TUIConfig` dataclass and `make_config()` (with added `TERM=dumb` detection)
- `_ansi()` → `ansi()` (public)
- `_icon()` → `icon()` (public)
- `_plain_text()` → `strip_ansi()` (renamed for clarity)
- `_section_header()` → `section_header()` (public, gains `width` param)
- `_format_banner_line()` → internal to `format_banner()`, with truncation
- `_ANSI_RE` constant
- `_BANNER_WIDTH` → default param on `format_banner()`

**New in `tui_core.py`:**
- `sanitize_text()` — terminal injection prevention
- `truncate()` — visible-length-aware text truncation

**What stays in `triage_tui.py`:**
- All label/style dicts (`_REVIEW_LABELS`, `_MODE_LABELS`, `_SEVERITY_LABELS`, `_STATUS_STYLE`, `_DISPATCH_STYLE`)
- All 6 render functions (render_banner, render_triage, render_dispatch_progress, render_summary, render_insights, render_zero_domains)
- These functions switch from calling `_ansi()` to calling `from tui_core import ansi` etc.

**Migration verification:** After extraction, run `python3 -m pytest scripts/test_triage_tui.py -x -q` and verify all 4 existing tests pass with no changes. If any test imports `triage_tui._ansi` or similar private names, update the import to `tui_core.ansi`. This is a required gate before proceeding to session_tui.py implementation.

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

**Data types (TypedDicts for all render inputs):**

```python
class CommitInfo(TypedDict):
    sha: str           # short SHA, e.g., "a628ae0"
    message: str       # first line of commit message
    age: str           # human-readable, e.g., "2h ago"

class PRInfo(TypedDict):
    number: int
    title: str
    status: str        # 'ready' | 'review_requested' | 'draft' | 'merged'

class HealthCheck(TypedDict):
    name: str          # e.g., "Tests", "Build", "Lint"
    passed: bool | None  # True=pass, False=fail, None=warn/skip
    detail: str        # e.g., "586 passed, 22 skipped"
    duration: float | None  # seconds, or None if not timed

class AlertInfo(TypedDict):
    level: str         # 'warning' | 'critical'
    message: str
    context: str       # e.g., "(82%)"

class BoardItem(TypedDict):
    title: str
    status: str        # 'in_flight' | 'blocked' | 'clarify'
    issue_number: str  # e.g., "#234"

class FileChange(TypedDict):
    path: str
    status: str        # 'new' | 'modified' | 'deleted' | 'renamed'

class NextUpItem(TypedDict):
    label: str
    priority: str      # 'action' | 'low'
    issue: str | None  # e.g., "#139" or None

class GitState(TypedDict):
    branch: str
    ahead: int
    behind: int
    uncommitted: list[str]        # ["M scripts/foo.py", "?? scripts/bar.py"]
    recent_commits: list[CommitInfo]

class DiffSummary(TypedDict):
    added: int
    removed: int
    file_count: int
    key_files: list[FileChange]

class BannerData(TypedDict, total=False):
    mode: str           # "start" | "end" — required
    repo: str           # required
    branch: str         # required
    session_id: str     # required
    persona_name: str
    persona_catchphrase: str
    started_at: str     # ISO8601 only (e.g., "2026-04-04T13:55:00+03:00")
    ended_at: str       # ISO8601 only (end mode)
    duration: str       # pre-formatted, e.g., "2h 47m" (end mode)
    session_name: str   # end mode only
```

**`started_at` and `ended_at` are always ISO8601.** The render function extracts `HH:MM` for display. The caller (SKILL.md) reads `session_state.started_at` (already ISO8601) and computes `ended_at` via `datetime.now().isoformat()`.

**Render functions:**

All externally-sourced strings (branch names, commit messages, PR titles, persona data, session names) are passed through `sanitize_text()` from `tui_core` before formatting. Lists are truncated at render time: uncommitted files capped at 10 (with "+ N more"), recent commits at 5, PRs at 10.

```python
def render_session_banner(config: TUIConfig, data: BannerData) -> str:
    """Top banner for start or end. Uses format_banner() from core.
    Lines longer than banner width are truncated via truncate().
    """

def render_git_state(config: TUIConfig, git: GitState) -> str:
    """Git section: branch, ahead/behind, uncommitted files (max 10), recent commits (max 5)."""

def render_prs(config: TUIConfig, prs: list[PRInfo]) -> str:
    """PR section. Status indicators include text labels for accessibility:
    'ready' → ✅ ready to merge / [OK] ready to merge
    'review_requested' → ·· review requested / [REVIEW] review requested
    'draft' → ○ draft / [-] draft
    'merged' → 🟣 merged / [MERGED] merged
    Shows 'No open PRs.' if list is empty.
    """

def render_health(config: TUIConfig, checks: list[HealthCheck]) -> str:
    """Health section using render_checklist_item from core.
    Shows 'No health checks configured.' if list is empty.
    """

def render_alerts(config: TUIConfig, alerts: list[AlertInfo]) -> str:
    """Alerts section. Returns empty string if no alerts (section omitted entirely)."""

def render_board(config: TUIConfig, items: list[BoardItem]) -> str:
    """Board section. Returns empty string if no board items (section omitted entirely).
    Status indicators: in_flight → ▶, blocked → ⏸, clarify → ?
    """

def render_receipt(config: TUIConfig, items: list[HealthCheck]) -> str:
    """End-mode receipt: compact checklist of session actions.
    Items: tests, build, push, PRs, issues, docs, telemetry.
    Uses render_checklist_item from core. Reuses HealthCheck type
    since the schema is identical (name, passed, detail, duration).
    """

def render_diff_summary(config: TUIConfig, diff: DiffSummary) -> str:
    """Diff section: +lines/-lines, file count, notable files."""

def render_next_up(config: TUIConfig, items: list[NextUpItem]) -> str:
    """Next Up section. Actionable items (●) first, low priority (○) after.
    Used by both start and end.
    """
```

**Composition helpers:**

```python
def render_start_briefing(
    config: TUIConfig,
    banner: BannerData,
    git: GitState,
    prs: list[PRInfo],
    health: list[HealthCheck],
    alerts: list[AlertInfo],
    board: list[BoardItem],
    next_up: list[NextUpItem],
) -> str:
    """Compose the full start briefing from all sections.
    Concatenates non-empty sections with newline separators.
    """

def render_end_summary(
    config: TUIConfig,
    banner: BannerData,
    receipt: list[HealthCheck],
    diff: DiffSummary,
    next_up: list[NextUpItem],
) -> str:
    """Compose the full end summary from all sections."""
```

**Error representation:** If data collection fails for a section (e.g., `gh` unavailable, git not a repo), the caller passes an empty list or a single-item list with `passed=None` and `detail="unavailable: <reason>"`. The TUI renders it as a ⚠️ warning. Rendering never raises on missing data.

### 3. Session State Changes

One addition to `session_state.py`:

```python
@dataclass
class SessionState:
    # ... existing fields ...
    name: str | None = None   # meaningful name, set at session end
```

**Backward compatibility:** Existing session state JSON files won't have the `name` key. The `SessionState` deserialization must use `.get("name", None)` so missing keys default to `None` without error. No migration script needed — the field is optional and absent-means-unnamed.

**Session name derivation:** The agent chooses a name at session end by examining (in priority order):
1. PRs merged during the session → `"pr-142-domain-triage"`
2. Issues closed → `"issues-228-238-domain-triage"`
3. Branch name → `"feat-domain-triage"`
4. Most common commit prefix → `"triage-engine-and-tests"`

The name is a short slug (lowercase, hyphens, max 50 chars). The SKILL.md tells the agent: "Name this session based on what was accomplished. Use the branch name or PR titles as a starting point. Keep it under 50 characters, lowercase with hyphens."

No other changes to session_state.py — `started_at`, `session_id`, `repo`, and `branch` already exist.

### 4. SKILL.md Integration

The session SKILL.md currently collects data via subprocess calls and prints plain text. The change:

1. Detect rendering flags from environment and pass to `make_config()`
2. Collect all data into TypedDict structures, wrapping failures as warnings
3. Call composition helpers and print the returned strings

The SKILL.md remains the orchestrator — it collects git state, fetches PRs, runs health checks, reads alerts, queries the project board. The TUI module is purely a rendering layer.

**Flag passthrough:** The SKILL.md must detect `--plain` and `--no-color` from the user's invocation context. Since SKILL.md is interpreted by an LLM agent (not a script), the agent checks:
- If the user said "plain" or the environment has `NO_COLOR=1` → `make_config(no_color=True)`
- If piping output or `TERM=dumb` → auto-detected by `make_config()`
- `json_mode` is not used for session TUI (no JSON output mode for sessions)

**Data collection error handling:** Each data source (git, gh, health checks, board, alerts) is collected independently. If one fails (e.g., `gh` not authenticated, health check command not configured), the SKILL.md:
- Catches the error
- Passes an empty list or a warning item to the corresponding render function
- Continues collecting other data
- Never lets a non-critical data source abort the entire briefing

**Start flow:**
1. `config = make_config()`
2. Collect all data (existing logic), wrapping failures as empty lists or warning items
3. Build TypedDict structures from collected data
4. Print `render_start_briefing(config, ...)`

**End flow:**
1. `config = make_config()`
2. Collect session results (existing logic), wrapping failures
3. Agent chooses session name based on session activity (see naming algorithm above)
4. `session_state.name = chosen_name; session_state.save()`
5. Compute duration: `started = datetime.fromisoformat(session_state.started_at)`, `elapsed = datetime.now(started.tzinfo) - started`, format as "Xh Ym"
6. Print `render_end_summary(config, ...)`

---

## Environment Behavior

Same rules as triage TUI — inherited from `tui_core.py`:

| Condition | ANSI | Emoji | Box-drawing |
|-----------|------|-------|-------------|
| Normal TTY | ✅ | ✅ | ✅ |
| `NO_COLOR=1` | ❌ | ✅ | ✅ |
| `TERM=dumb` | ❌ | ✅ | ✅ |
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

### `test_tui_core.py` — 17 tests

| Test | What It Validates |
|------|-------------------|
| `test_make_config_detects_tty` | TTY → color=True, non-TTY → color=False (mock `sys.stdout.isatty`) |
| `test_make_config_respects_no_color` | NO_COLOR=1 → color=False |
| `test_make_config_respects_term_dumb` | TERM=dumb → color=False |
| `test_ansi_wraps_when_color` | color=True → ANSI codes present |
| `test_ansi_skips_when_no_color` | color=False → no ANSI codes |
| `test_icon_emoji_vs_plain` | plain=False → emoji, plain=True → text |
| `test_strip_ansi_removes_codes` | ANSI-wrapped input → clean output |
| `test_sanitize_strips_control_chars` | Input with CSI/OSC sequences → stripped |
| `test_sanitize_preserves_newline_tab` | \\n and \\t preserved, other controls removed |
| `test_truncate_short_text_unchanged` | Text shorter than max → no change |
| `test_truncate_long_text_with_ellipsis` | Text longer than max → truncated with … |
| `test_truncate_ignores_ansi_in_length` | ANSI codes not counted toward visible length |
| `test_section_header_formats` | Correct em-dash format with title |
| `test_section_header_plain` | Plain mode → `=== [LABEL] Title ===` |
| `test_format_banner_box_drawing` | Full mode → ╔═╗║╚╝ borders |
| `test_format_banner_plain` | Plain mode → `=` dividers |
| `test_format_banner_truncates_long_lines` | Line > width-4 → truncated |

### `test_session_tui.py` — 18 tests

| Test | What It Validates |
|------|-------------------|
| `test_start_banner_contains_session_id` | Session ID appears in banner |
| `test_start_banner_contains_start_time` | Started time (HH:MM) in banner |
| `test_end_banner_contains_duration` | Duration and end time in banner |
| `test_end_banner_contains_session_name` | Session name in end banner |
| `test_alerts_empty_returns_empty` | No alerts → empty string (section omitted) |
| `test_board_empty_returns_empty` | No board items → empty string |
| `test_next_up_ordering` | Actionable items before low priority |
| `test_no_color_strips_ansi` | NO_COLOR → zero ANSI in all output |
| `test_plain_mode_no_emoji` | plain=True → zero emoji characters |
| `test_pr_status_has_text_labels` | All PR statuses include text label, not just symbol |
| `test_receipt_all_passed` | All ✅ receipt |
| `test_receipt_mixed_status` | Mix of ✅/❌/⚠️ |
| `test_render_start_briefing_composition` | All sections concatenated correctly |
| `test_render_end_summary_composition` | Receipt + diff + next up concatenated |
| `test_uncommitted_files_capped_at_10` | >10 uncommitted → shows 10 + "N more" |
| `test_health_empty_shows_message` | Empty health list → "No health checks configured." |
| `test_sanitization_strips_injected_escapes` | Branch name with ANSI → stripped in output |
| `test_error_item_renders_as_warning` | passed=None + "unavailable" detail → ⚠️ line |

### `test_triage_tui.py` — migration verification

After extracting `tui_core.py`, run the existing 4 tests unchanged. If any fail due to import paths (e.g., tests that imported `triage_tui._ansi` directly), update imports to `tui_core.ansi`. All 4 tests must pass before proceeding. This is a required gate, not optional.

### `test_session_state.py` — 1 additional test

| Test | What It Validates |
|------|-------------------|
| `test_name_field_defaults_none_on_old_state` | Load a JSON file without `name` key → `SessionState.name == None` |
