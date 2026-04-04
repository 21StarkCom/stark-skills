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

## Success Criteria

All of the following must be true before this work is considered complete:

1. All unit tests pass: `test_tui_core.py` (23 tests), `test_session_tui.py` (21 tests), `test_triage_tui.py` (existing tests, zero failures after extraction)
2. Triage TUI parity gate: representative triage fixtures rendered before and after extraction in normal, no-color, and plain modes produce byte-for-byte identical output
3. `/stark-session start` on a TTY produces ANSI-colored output with all expected sections present
4. `/stark-session start` with `NO_COLOR=1` produces zero ANSI escape codes in output
5. `/stark-session start --plain` produces zero emoji and no box-drawing characters
6. `/stark-session end` produces a session name matching the slug format (`[a-z0-9-]{1,50}`)
7. With `GH_TOKEN` unset, both start and end degrade gracefully to warning items (no tracebacks)
8. `./install.sh --status` shows `tui_core.py`, `session_tui.py`, and `session_tui_cli.py` in the installed file list
9. Both start and end complete within 45 seconds even when optional data sources are unavailable

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
│  ansi(), icon(), strip_ansi()    │
│  sanitize_text(), slugify()      │
│  section_header(), format_banner()│
│  render_checklist_item()         │
│  render_kv_line()                │
└──────────┬───────────┬───────────┘
           │           │
    ┌──────┴──┐   ┌────┴──────────────┐
    │triage_  │   │session_tui.py     │
    │tui.py   │   │(pure rendering)   │
    │(domain  │   │                   │
    │ review) │   │session_tui_cli.py │
    └─────────┘   │(CLI entry point)  │
                  └───────────────────┘
```

`tui_core.py` owns the shared rendering infrastructure. `triage_tui.py` and `session_tui.py` each define their own color maps and render functions, importing primitives from core. Both are pure rendering — no I/O, no subprocess calls.

`session_tui_cli.py` is the CLI entry point that the SKILL.md invokes. It handles data collection (with enforced timeouts and parallel execution), constructs TypedDicts, calls render functions, and prints output. This separation keeps rendering testable while giving SKILL.md a concrete bash command to run.

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
    no_color=True, plain=True. Note: plain=True forces color=False
    (plain mode disables both emoji/box-drawing AND ANSI color).
    Also checks STARK_PLAIN=1 as a deterministic alternative to LLM
    flag inference for automation/scripting contexts.
    """

def sanitize_text(text: str) -> str:
    """Strip terminal control characters and Unicode spoofing chars from untrusted input.
    
    Removes:
    - All C0/C1 control codes (0x00-0x1F, 0x7F-0x9F) except newline (0x0A) and tab (0x09)
    - Unicode bidi overrides: U+202A-U+202E (LRE/RLE/PDF/LRO/RLO)
    - Unicode bidi isolates: U+2066-U+2069
    - Zero-width characters: U+200B-U+200F, U+FEFF
    
    This prevents ANSI injection, OSC commands, clipboard manipulation,
    and visual text spoofing from externally-sourced strings.
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

def slugify(text: str, max_len: int = 50) -> str:
    """Normalize text into a URL/filename-safe slug.
    Lowercase, replace non-[a-z0-9] with hyphens, collapse consecutive
    hyphens, strip leading/trailing hyphens, truncate to max_len.
    Used for session names to ensure programmatic safety regardless
    of LLM output quality.
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
- `sanitize_text()` — terminal and Unicode spoofing injection prevention
- `truncate()` — visible-length-aware text truncation
- `slugify()` — safe slug generation for session names

**What stays in `triage_tui.py`:**
- All label/style dicts (`_REVIEW_LABELS`, `_MODE_LABELS`, `_SEVERITY_LABELS`, `_STATUS_STYLE`, `_DISPATCH_STYLE`)
- All 6 render functions (render_banner, render_triage, render_dispatch_progress, render_summary, render_insights, render_zero_domains)
- These functions switch from calling `_ansi()` to calling `from tui_core import ansi` etc.
- As part of migration, update triage render functions to call `sanitize_text()` on external strings (agent names, domain keys, finding titles) — this is a security hardening addition. For clean inputs (no control characters or bidi overrides), `sanitize_text()` returns the input unchanged, so the parity gate still holds. Test with inputs containing control characters to verify sanitization works.

**Pre-extraction scan (before writing tui_core.py):** Scan `test_triage_tui.py` and any other files that import from `triage_tui` for references to private names (`_ansi`, `_icon`, `_plain_text`, `_section_header`, `_ANSI_RE`, `_BANNER_WIDTH`). Update any found imports to their `tui_core` equivalents. This scan must complete before extraction so the gate passes on first run.

**Migration parity gate:** After extraction, verify triage output parity:
1. Render representative triage fixtures before and after extraction in normal, no-color, and plain modes
2. Require byte-for-byte identical output (no behavioral change, only import rewiring)
3. Run `python3 -m pytest scripts/test_triage_tui.py -x -q` — zero failures required

**Gate failure path:** If any test fails after extraction: (1) check for direct imports of private symbols not caught by the pre-scan; (2) if tests still fail after import fixes, this is a logic regression — stop, do not proceed to session_tui.py, and surface the failure before taking further action. Maximum debug time for this gate: 2 hours. If not cleared within that window, leave triage_tui.py with its own implementations, import from tui_core only in session_tui.py, and defer full extraction to a follow-up.

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

class _BannerRequired(TypedDict):
    mode: Literal["start", "end"]
    repo: str
    branch: str
    session_id: str
    started_at: str     # ISO8601 with timezone (e.g., "2026-04-04T13:55:00+03:00")

class BannerData(_BannerRequired, total=False):
    persona_name: str
    persona_catchphrase: str
    ended_at: str       # ISO8601 with timezone (end mode)
    duration: str       # pre-formatted, e.g., "2h 47m" (end mode)
    session_name: str   # end mode only
```

**`started_at` and `ended_at` are always ISO8601 with timezone offset** (e.g., `2026-04-04T13:55:00+03:00`). The render function extracts `HH:MM` for display. The caller (SKILL.md) reads `session_state.started_at` (already ISO8601) and computes `ended_at` via `datetime.now(timezone.utc).astimezone().isoformat()`. Duration is computed as `ended - started` using timezone-aware datetimes, avoiding DST errors.

**Render functions:**

Sanitization is applied at data ingestion, not inside render functions. The CLI entry point (`session_tui_cli.py`) passes all externally-sourced strings through `sanitize_text()` when constructing TypedDicts — before they reach the rendering layer. This makes sanitization structural (one place) rather than a per-function discipline that can be missed. Render functions assume inputs are pre-sanitized.

Lists are truncated at render time: uncommitted files capped at 10 (with "+ N more"), recent commits at 5 (with "+ N more"), PRs at 10 (with "+ N more"). All lists use the same truncation indicator format.

```python
def render_session_banner(config: TUIConfig, data: BannerData) -> str:
    """Top banner for start or end. Uses format_banner() from core.
    Lines longer than banner width are truncated via truncate().
    End-mode optional fields: if duration absent → omit duration line;
    if session_name absent → omit name line; if ended_at absent → show
    'end time unavailable'. Never raises on missing optional fields.
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
    Status indicators include text labels for accessibility:
    'in_flight' → ▶ In Flight / [ACTIVE] In Flight
    'blocked' → ⏸ Blocked / [BLOCKED] Blocked
    'clarify' → ? Clarify / [?] Clarify
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
def format_duration(seconds: float) -> str:
    """Format elapsed seconds into a human-readable duration string.
    Rules: if hours > 0: "Xh Ym"; if hours == 0: "Xm"; if minutes == 0
    and hours == 0: "Xs". Examples: 10020 → "2h 47m", 720 → "12m", 45 → "45s".
    """

def render_start_briefing(
    config: TUIConfig,
    banner: BannerData,
    git: GitState | None,
    prs: list[PRInfo],
    health: list[HealthCheck],
    alerts: list[AlertInfo],
    board: list[BoardItem],
    next_up: list[NextUpItem],
) -> str:
    """Compose the full start briefing from all sections.
    Sections rendered in this order: banner, git, prs, health,
    [alerts if non-empty], [board if non-empty], next_up.
    Concatenates non-empty sections with newline separators.
    If git is None, the git section is omitted and a warning line
    is shown: 'Git state unavailable — not a git repository or git not found.'
    """

def render_end_summary(
    config: TUIConfig,
    banner: BannerData,
    receipt: list[HealthCheck],
    diff: DiffSummary | None,
    next_up: list[NextUpItem],
) -> str:
    """Compose the full end summary from all sections.
    Sections rendered in this order: banner, receipt, [diff if not None], next_up.
    If diff is None, the diff section is omitted with a warning line.
    """
```

**Error representation:** If data collection fails for a section (e.g., `gh` unavailable, git not a repo), the caller passes an empty list or a single-item list with `passed=None` and `detail="unavailable: <reason>"`. The TUI renders it as a warning. Rendering never raises on missing data.

**Error redaction:** Raw exception text must never be rendered directly — it may contain tokens, credential-bearing URLs, or sensitive diagnostics. The CLI entry point maps exceptions to short reason codes (e.g., "auth_expired", "timeout", "not_found", "network_error") before constructing the warning TypedDict. Full error details are appended to a persistent log file (`~/.claude/code-review/logs/session-errors.log`) with timestamp and source name for diagnostics. The CLI creates the log directory (`~/.claude/code-review/logs/`) on first write if it doesn't exist. Log retention: truncate to last 1000 lines on each write to prevent unbounded growth. Error text is also redacted in the log: tokens and authorization headers are replaced with `[REDACTED]`.

### 3. Session State Changes

Two additions to `session_state.py`:

```python
@dataclass
class SessionState:
    # ... existing fields ...
    name: str | None = None       # meaningful name, set at session end
    start_head: str | None = None # HEAD SHA at session start, for session-scoped diff
```

**Backward compatibility:** Before specifying the fix, verify how `SessionState` is currently deserialized. Read the current `session_state.py` `load()` method:
- If it uses `cls(**data)`, unknown keys will raise `TypeError` — the load path must be updated to filter to known fields before constructing, or switch to `.get()`.
- If it uses `.get()` for each field, adding defaulted fields is safe.
- Add a test that loads a JSON file with an extra unknown key and asserts no exception — this validates both rollback safety and forward compat.

No migration script needed — both fields are optional and absent-means-None.

**Session name derivation:** The agent chooses a name at session end by examining (in priority order):
1. PRs merged during the session (query: `gh pr list --state merged --search "merged:>={started_date}"` where `started_date` is the date portion of `started_at`, e.g., `2026-04-04` — GitHub search is day-granular, so for short sessions on the same day, filter results by comparing merge timestamps against `started_at`) → `"pr-142-domain-triage"`
2. Issues closed during the session (query: `gh issue list --state closed --search "closed:>={started_date}"`, same day-granular filter + timestamp comparison) → `"issues-228-238-domain-triage"`
3. Branch name → `"feat-domain-triage"`
4. Most common commit prefix from session commits (`git log {start_head}..HEAD --format=%s`) → `"triage-engine-and-tests"`

The agent-generated name is passed through `slugify()` from `tui_core.py` before assignment. This ensures the constraint (lowercase, hyphens only, max 50 chars) is programmatically enforced regardless of LLM output quality. The SKILL.md tells the agent: "Name this session based on what was accomplished. Use the branch name or PR titles as a starting point."

**Fallback:** If all four priority levels produce nothing (e.g., no PRs, no issues, detached HEAD, no commits), the name defaults to `slugify(f"session-{session_id}")` — never `None` at session end.

No other changes to session_state.py — `started_at`, `session_id`, `repo`, and `branch` already exist.

### 4. `session_tui_cli.py` — CLI Entry Point

The SKILL.md is LLM-interpreted markdown — it cannot import Python modules or enforce subprocess timeouts. A CLI entry point bridges this gap.

```python
# scripts/session_tui_cli.py
"""CLI entry point for session TUI rendering.

Usage:
    python3 scripts/session_tui_cli.py start [--plain] [--no-color] [--start-head SHA]
    python3 scripts/session_tui_cli.py end [--plain] [--no-color] [--name NAME] [--start-head SHA] [--started-at ISO8601]

Arguments:
    start|end         Session mode
    --plain           Plain text mode (no emoji, no box-drawing, no ANSI)
    --no-color        Disable ANSI color only (keep emoji and box-drawing)
    --session-id ID   Session ID (displayed in banner)
    --repo REPO       Repo identifier e.g. 'GetEvinced/stark-skills' (displayed in banner)
    --branch BRANCH   Current branch (fallback: auto-detected via git)
    --name NAME       Session name for end banner (pre-slugified by caller)
    --start-head SHA  HEAD SHA at session start (for session-scoped diff)
    --started-at TS   Session start timestamp (ISO8601, for naming queries and duration)
    --persona JSON    Optional JSON with name and catchphrase for persona display

Handles: data collection (with enforced timeouts and parallel execution),
sanitization, TypedDict construction, and rendering.
"""
```

**Pre-upgrade session handling:** If `--start-head` is not provided (e.g., session started before this feature existed), the CLI falls back to `git merge-base origin/main HEAD` for the diff baseline. This is an approximation but avoids errors. A warning line is shown: "Session diff approximate — start HEAD not recorded."

**Data collection with enforced timeouts:** Each data source is collected via `subprocess.run(..., timeout=15, capture_output=True)`. On `TimeoutExpired`, the source is mapped to a warning item (`passed=None, detail="unavailable: timeout"`). Independent sources (git, gh PRs, health checks, board, alerts) are collected concurrently via `concurrent.futures.ThreadPoolExecutor` with a total wall-clock budget of 45 seconds. Any source not complete within the budget is treated as timed out. Each future's `.result()` is wrapped in try/except to catch both `TimeoutExpired` and any unexpected exception — non-timeout exceptions are logged and mapped to a warning item with reason code "error", never allowed to crash the CLI.

**Data collection commands (start mode):**

| Source | Command | TypedDict |
|--------|---------|-----------|
| Branch | `git branch --show-current` | `GitState.branch` |
| Ahead/behind | `git rev-list --left-right --count @{u}...HEAD` | `GitState.ahead`, `GitState.behind` |
| Uncommitted | `git status --short` | `GitState.uncommitted` |
| Recent commits | `git log --oneline --format="%h|%s|%ar" -5` | `GitState.recent_commits` (CommitInfo list) |
| Open PRs | `gh pr list --json number,title,state,isDraft,reviewDecision --limit 10` | `list[PRInfo]` — map: isDraft→'draft', reviewDecision='APPROVED'→'ready', reviewDecision='REVIEW_REQUIRED'→'review_requested', state='MERGED'→'merged' |
| Health checks | Per `.code-review/config.json` → `session.health_checks[]` array, each entry has `name` and `command` fields. Run each command, map exit code to passed (0=True, else False). If no health_checks configured → empty list → "No health checks configured." | `list[HealthCheck]` |
| Board items | `github_projects.py` `list_items()` API (existing script), filtered to "In Progress" and "Blocked" statuses | `list[BoardItem]` |
| Alerts | Read from `~/.claude/code-review/sessions/{session_id}/alerts.json` if exists, else empty list. Alerts are written by external monitoring (e.g., disk usage, stale branch detection). If no file → empty list → section omitted. | `list[AlertInfo]` |

**Data collection commands (end mode):**

| Source | Command | TypedDict |
|--------|---------|-----------|
| Session diff | `git diff --stat {start_head} HEAD` + `git diff --numstat {start_head} HEAD` | `DiffSummary` |
| Key files | Files with >50 line changes or any deleted files, max 5 | `DiffSummary.key_files` |
| Session commits | `git log {start_head}..HEAD --format="%h|%s"` | For naming algorithm |
| Merged PRs | `gh pr list --state merged --search "merged:>={started_at}"` | For naming algorithm |
| Closed issues | `gh issue list --state closed --search "closed:>={started_at}"` | For naming algorithm |

**Flag handling:** `--plain` and `--no-color` are real CLI flags parsed by argparse, not LLM inference. Additionally, `make_config()` auto-detects `NO_COLOR=1`, `TERM=dumb`, `STARK_PLAIN=1`, and non-TTY. The SKILL.md parses `$ARGUMENTS` for `--plain` and `--no-color` and passes them to the CLI.

**Error handling:** On `subprocess.TimeoutExpired` or non-zero exit: map to a reason code (not raw exception text) and construct a warning item. Full error details logged to `~/.claude/code-review/logs/session-errors.log`.

**Session state recovery:** At start of end mode, if session state file is missing or corrupted:
- Emit warning: "No active session found — was /stark-session start run?"
- Skip duration computation and naming (both require started_at)
- Still render receipt and next_up sections with available data

### 5. SKILL.md Integration

With `session_tui_cli.py` as the concrete executable, the SKILL.md changes are minimal:

**Start flow:**
1. Parse `$ARGUMENTS` for mode (`start`/`end`) and flags (`--plain`, `--no-color`)
2. Create/load session state (this sets `session_id`, `started_at`, `repo`, `branch`)
3. Record `start_head=$(git rev-parse HEAD 2>/dev/null)` and persist to session state
4. Run: `$PYTHON $SCRIPTS/session_tui_cli.py start --session-id "$session_id" --repo "$repo" --start-head "$start_head" --started-at "$started_at" [--plain] [--no-color]`
5. Print the output

The `started_at` timestamp comes from the session state (set when the session was created in step 2). The CLI needs it for the banner display (extracts HH:MM).

**End flow:**
1. Parse `$ARGUMENTS` for flags
2. Load session state to get `session_id`, `started_at`, `start_head`, `repo`
3. Agent chooses session name based on session activity (see naming algorithm above)
4. Run: `$PYTHON $SCRIPTS/session_tui_cli.py end --session-id "$session_id" --repo "$repo" --name "<name>" --start-head "$start_head" --started-at "$started_at" [--plain] [--no-color]`
5. Print the output
6. Persist `session_state.name = slugify(name)` via session_state.py save

Where `$PYTHON = ~/.claude/code-review/scripts/.venv/bin/python3` and `$SCRIPTS = ~/.claude/code-review/scripts`.

The SKILL.md remains the orchestrator for session lifecycle (creating/loading session state, choosing the name via LLM judgment). The CLI handles all rendering, data collection, and timeout enforcement.

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
| `scripts/session_tui.py` | New | Session-specific render functions (pure rendering) |
| `scripts/session_tui_cli.py` | New | CLI entry point: data collection, sanitization, rendering |
| `scripts/triage_tui.py` | Modified | Repoint imports to tui_core.py + add sanitize_text calls |
| `scripts/session_state.py` | Modified | Add `name` and `start_head` fields to SessionState |
| `skill/stark-session/SKILL.md` | Modified | Call session_tui_cli.py for rendering |
| `scripts/test_tui_core.py` | New | Tests for shared primitives (19 tests) |
| `scripts/test_session_tui.py` | New | Tests for session rendering (21 tests) |
| `scripts/test_triage_tui.py` | Modified | Import path updates after extraction |
| `scripts/test_session_state.py` | Modified | Add tests for name/start_head fields + unknown key compat |

**Post-change verification:** Run `./install.sh --status` to verify `tui_core.py`, `session_tui.py`, and `session_tui_cli.py` appear in the installed file list. If `install.sh` uses explicit file lists rather than directory symlinks, add the new modules. Also run `/stark-generate-docs --skill stark-session` to regenerate published skill documentation.

---

## Testing Strategy

### `test_tui_core.py` — 23 tests

| Test | What It Validates |
|------|-------------------|
| `test_make_config_detects_tty` | TTY → color=True, non-TTY → color=False (mock `sys.stdout.isatty`) |
| `test_make_config_respects_no_color` | NO_COLOR=1 → color=False |
| `test_make_config_respects_term_dumb` | TERM=dumb → color=False |
| `test_make_config_plain_forces_no_color` | plain=True → color=False regardless of TTY |
| `test_make_config_respects_stark_plain` | STARK_PLAIN=1 → plain=True |
| `test_ansi_wraps_when_color` | color=True → ANSI codes present |
| `test_ansi_skips_when_no_color` | color=False → no ANSI codes |
| `test_icon_emoji_vs_plain` | plain=False → emoji, plain=True → text |
| `test_strip_ansi_removes_codes` | ANSI-wrapped input → clean output |
| `test_sanitize_strips_control_chars` | Input with CSI/OSC sequences → stripped |
| `test_sanitize_preserves_newline_tab` | \\n and \\t preserved, other controls removed |
| `test_sanitize_strips_bidi_overrides` | U+202E and U+2066 removed from output |
| `test_sanitize_strips_zero_width_chars` | U+200B, U+FEFF removed from output |
| `test_truncate_short_text_unchanged` | Text shorter than max → no change |
| `test_truncate_long_text_with_ellipsis` | Text longer than max → truncated with … |
| `test_truncate_ignores_ansi_in_length` | ANSI codes not counted toward visible length |
| `test_slugify_basic` | "Feat/Session TUI (April)" → "feat-session-tui-april" |
| `test_slugify_max_len` | Long input truncated to 50 chars |
| `test_section_header_formats` | Correct em-dash format with title |
| `test_section_header_plain` | Plain mode → `=== [LABEL] Title ===` |
| `test_format_banner_box_drawing` | Full mode → ╔═╗║╚╝ borders |
| `test_format_banner_plain` | Plain mode → `=` dividers |
| `test_format_banner_truncates_long_lines` | Line > width-4 → truncated |

### `test_session_tui.py` — 21 tests

| Test | What It Validates |
|------|-------------------|
| `test_start_banner_contains_session_id` | Session ID appears in banner |
| `test_start_banner_contains_start_time` | Started time (HH:MM) in banner |
| `test_end_banner_contains_duration` | Duration and end time in banner |
| `test_end_banner_contains_session_name` | Session name in end banner |
| `test_end_banner_missing_optional_fields` | BannerData with mode='end' and no optional keys → no exception |
| `test_alerts_empty_returns_empty` | No alerts → empty string (section omitted) |
| `test_board_empty_returns_empty` | No board items → empty string |
| `test_next_up_ordering` | Actionable items before low priority |
| `test_no_color_strips_ansi` | NO_COLOR → zero ANSI in all output |
| `test_plain_mode_no_emoji` | plain=True → zero emoji characters |
| `test_pr_status_has_text_labels` | All PR statuses include text label, not just symbol |
| `test_receipt_all_passed` | All pass receipt |
| `test_receipt_mixed_status` | Mix of pass/fail/warn |
| `test_render_start_briefing_composition` | All sections concatenated in correct order |
| `test_render_start_briefing_git_none` | git=None → git section omitted, warning shown |
| `test_render_end_summary_composition` | Receipt + diff + next up concatenated in correct order |
| `test_uncommitted_files_capped_at_10` | >10 uncommitted → shows 10 + "N more" |
| `test_commits_capped_at_5` | >5 recent commits → shows 5 + "N more" |
| `test_health_empty_shows_message` | Empty health list → "No health checks configured." |
| `test_sanitization_strips_injected_escapes` | Branch name with ANSI → stripped in output |
| `test_error_item_renders_as_warning` | passed=None + "unavailable" detail → warning line |

### `test_triage_tui.py` — migration verification

After the pre-extraction scan and extraction: run all existing triage TUI tests with zero failures. The criterion is "zero failures in test_triage_tui.py" (not a fixed count — robust to test file growth). This is a required gate, not optional. See the migration parity gate in Component 1 for the full procedure.

### `test_session_state.py` — 3 additional tests

| Test | What It Validates |
|------|-------------------|
| `test_name_field_defaults_none_on_old_state` | Load a JSON file without `name` key → `SessionState.name == None` |
| `test_start_head_field_defaults_none_on_old_state` | Load a JSON file without `start_head` key → `SessionState.start_head == None` |
| `test_unknown_keys_ignored_on_load` | Load a JSON file with extra unknown keys → no exception (validates rollback safety) |

### Integration Gates

These gates must pass before the work is considered complete:

**Gate 1 — Pre-SKILL.md integration:** After all unit tests pass, call `render_start_briefing()` and `render_end_summary()` with real-repo data (actual git output, real PR data if available) and verify: no exceptions raised, all expected sections present, plain mode produces no ANSI or emoji.

**Gate 2 — Post-SKILL.md integration:** Invoke `/stark-session start` and `/stark-session end` in this repo. Verify:
1. No Python exceptions or tracebacks
2. Banner plus all expected sections appear
3. `--plain` flag produces no ANSI or emoji
4. With `GH_TOKEN` unset, degradation to warning items (no abort)
5. Both commands complete within 45 seconds

**Gate 3 — Soak:** Use `/stark-session start` and `/stark-session end` in at least 2 real sessions before closing this work. Any rendering defect observed during soak is a blocker.

---

## Phasing

Implementation is split into 4 independently deployable phases. Each phase has a required gate before proceeding. Phases 1 and 2 can be merged as separate PRs; Phase 4 requires all prior phases.

### Phase 1: Extract `tui_core.py` + migrate `triage_tui.py`

**Scope:** Create `tui_core.py`, update `triage_tui.py` imports, add sanitization to triage render paths, write `test_tui_core.py`.

**Gate:** Migration parity gate (byte-for-byte triage output match) + zero failures in `test_triage_tui.py` + all `test_tui_core.py` tests pass. Phase 2 is blocked until this gate passes.

**Rollback:** `git revert` the extraction commit. Triage_tui.py returns to self-contained. No data format changes, no state changes.

### Phase 2: Implement `session_tui.py` + `session_tui_cli.py`

**Scope:** Session render functions, CLI entry point with data collection/timeout/sanitization, `test_session_tui.py`. Also update `install.sh` if it uses explicit file lists (verify with `./install.sh --status`).

**Gate:** All 21 session TUI tests pass + Gate 1 (real-repo render verification). Phase 3 can proceed after this gate passes (not in parallel — Phase 3 changes session_state.py which Phase 2's CLI reads).

**Rollback:** Remove session_tui.py and session_tui_cli.py. No existing behavior affected — these are new files.

### Phase 3: Update `session_state.py`

**Scope:** Add `name` and `start_head` fields, `test_session_state.py` additions.

**Gate:** All 3 new tests pass, including unknown-key tolerance test (validates rollback safety).

**Rollback:** Revert session_state.py. Verify pre-Phase-3 `load()` handles files written by Phase 3 code (the unknown-key test validates this). Note: Phase 3 cannot be rolled back independently while Phase 4 is deployed — roll back Phase 4 first.

### Phase 4: Update `skill/stark-session/SKILL.md`

**Scope:** Wire SKILL.md to call `session_tui_cli.py`, add `--plain`/`--no-color` flag parsing, persist `start_head` at session start.

**Gate:** Gate 2 (end-to-end invocation). Then deploy and begin soak (Gate 3). Run `./install.sh --status` and `/stark-generate-docs --skill stark-session`. Gate 3 (soak) is completed asynchronously — work is merged after Gate 2 passes, soak confirms no issues over the next 2+ real sessions and must complete before declaring the feature stable.

**Rollback:** `git checkout` the previous SKILL.md. The rendering modules are inert without being called from SKILL.md. During soak, SKILL.md wraps the `session_tui_cli.py` call in a guard: if the CLI script exits non-zero (import failure, runtime error, etc.), fall back to plain-text output (the previous rendering) and log the error. This handles both import failures and runtime errors, not just import failures.

### Rollback Triggers

| Phase | Trigger | Action |
|-------|---------|--------|
| Phase 1 | Any `test_triage_tui.py` failure not fixed within 2h | Revert extraction |
| Phase 3 | `session_state.load()` raises on any existing state file | Revert Phase 3 |
| Phase 4 | Session start/end produces no section headers or empty output on 2 consecutive sessions | Revert SKILL.md |
| Phase 4 | Import failure causing skill crash | Revert SKILL.md |
