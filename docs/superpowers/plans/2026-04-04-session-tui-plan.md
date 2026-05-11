# Implementation Plan: Session TUI

**Source design:** `docs/superpowers/specs/2026-04-04-session-tui-design.md`
**Author:** Generated from design, 2026-04-04
**Status:** Ready for execution

---

## 1. Overview

The implementation refactors `triage_tui.py` to extract shared rendering primitives into a new `tui_core.py`, then builds `session_tui.py` on top of that foundation to replace the plain-text session briefing with structured, color-coded terminal output. The work is sequenced so that each phase delivers a working, testable increment before the next one begins.

**Key architectural decisions:**
- Phase 1 is a pure refactor: behavior of triage rendering does not change. The existing 4 triage tests serve as the regression gate before any new code is written.
- `session_tui.py` is a pure rendering module — no subprocess calls, no I/O. The SKILL.md remains the orchestrator.
- `sanitize_text()` is added as a new primitive in `tui_core.py`, not present in the original. Every render function in `session_tui.py` must call it on externally-sourced strings.
- `format_banner()` is a new abstraction in `tui_core.py` that subsumes the per-line `_format_banner_line()` logic from `triage_tui.py`. `triage_tui.render_banner()` is updated to call `format_banner()` from core.
- The `name` field on `SessionState` uses `.get("name", None)` in the `load()` classmethod — no migration script needed, old JSON files remain valid.

**Total phases:** 4, plus a cross-cutting verification phase.

---

## 2. Prerequisites

**Must exist before starting:**
- Python 3.11+ in the scripts environment (needed for `datetime.fromisoformat()` to parse `Z`-suffix ISO8601 strings; verify with `python3 --version`)
- `pytest` available at `scripts/` directory level (used by all test gates)
- Current triage tests pass: `cd scripts && python3 -m pytest test_triage_tui.py -x -q` — must show 4 passed before touching any code

**Can run in parallel with Phase 1:**
- Drafting `test_tui_core.py` (write the 17 test stubs while Phase 1 extraction is in progress)

---

## 3. Phases

---

## Phase 1: Extract `tui_core.py` and Migrate `triage_tui.py`

**Goal:** Create `scripts/tui_core.py` with all shared primitives. Update `triage_tui.py` to import from it. Create `test_tui_core.py`. All 4 existing triage tests must still pass.

**Dependencies:** None (first phase)

**Estimated effort:** M

### Tasks

1. **Create `scripts/tui_core.py`**
   - What: New file. Contains the following public API (all taken from `triage_tui.py` with renames, plus new additions):

     **Move from `triage_tui.py` with renames:**
     - `_ANSI_RE` → `_ANSI_RE` (keep private, used by `strip_ansi()` and `sanitize_text()`)
     - `_BANNER_WIDTH` → becomes the default `width=72` parameter on `format_banner()` and `section_header()`
     - `_BANNER_INNER_WIDTH` → becomes `width - 4` computed inside `format_banner()`
     - `TUIConfig` dataclass → `TUIConfig` (identical)
     - `make_config()` → `make_config()` with added `TERM=dumb` detection:
       ```python
       def make_config(no_color: bool = False, plain: bool = False, json_mode: bool = False) -> TUIConfig:
           tty = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
           no_color_env = bool(os.environ.get("NO_COLOR"))
           term_dumb = os.environ.get("TERM") == "dumb"
           color = bool(tty and not no_color and not no_color_env and not plain and not term_dumb)
           return TUIConfig(color=color, plain=plain, json_mode=json_mode)
       ```
     - `_ansi()` → `ansi()` (public, same signature)
     - `_plain_text()` → `strip_ansi()` (renamed for clarity)
     - `_icon()` → `icon()` (public, same signature)
     - `_section_header()` → `section_header()` (public, gains `width: int = 72` param):
       ```python
       def section_header(config: TUIConfig, title: str, emoji: str, plain_label: str, width: int = 72) -> str:
           if config.json_mode:
               return ""
           if config.plain:
               return f"=== [{plain_label}] {title} ==="
           header = f"── {emoji}  {title} "
           return header + "─" * max(0, width - len(header))
       ```
       Note: the plain format changes from `=== plain_text title ===` to `=== [PLAIN_LABEL] title ===` to match the design spec. This is a minor deviation from the existing `_section_header()` which uses `plain_text` directly. Update `triage_tui.py` callers accordingly.
     - `_format_banner_line()` → internalized into `format_banner()` (not exported separately)

     **New in `tui_core.py`:**
     - `sanitize_text(text: str) -> str` — strips C0/C1 control codes except `\n` (0x0A) and `\t` (0x09):
       ```python
       _CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
       
       def sanitize_text(text: str) -> str:
           return _CONTROL_RE.sub("", text)
       ```
     - `truncate(text: str, max_width: int) -> str` — truncates on visible length:
       ```python
       def truncate(text: str, max_width: int) -> str:
           visible = strip_ansi(text)
           if len(visible) <= max_width:
               return text
           return visible[:max_width - 1] + "…"
       ```
     - `format_banner(config: TUIConfig, lines: list[str], width: int = 72) -> str`:
       ```python
       def format_banner(config: TUIConfig, lines: list[str], width: int = 72) -> str:
           inner = width - 4
           def _fmt_line(text: str) -> str:
               visible = strip_ansi(text)
               if len(visible) > inner:
                   text = visible[:inner]
                   visible = text
               if config.plain:
                   return visible
               padding = " " * (inner - len(visible))
               return f"║ {text}{padding} ║"
           if config.plain:
               divider = "=" * width
               body = [_fmt_line(ln) for ln in lines]
               return "\n".join([divider, *body, divider])
           top = "╔" + ("═" * (width - 2)) + "╗"
           bottom = "╚" + ("═" * (width - 2)) + "╝"
           body = [_fmt_line(ln) for ln in lines]
           return "\n".join([top, *body, bottom])
       ```
     - `render_checklist_item(config: TUIConfig, passed: bool | None, label: str, detail: str, duration: float | None = None) -> str`:
       ```python
       _CHECK_STYLE = {
           True:  ("32", "✅", "[OK]"),
           False: ("31", "❌", "[FAIL]"),
           None:  ("33", "⚠️",  "[WARN]"),
       }
       
       def render_checklist_item(config, passed, label, detail, duration=None):
           color, emoji, plain = _CHECK_STYLE[passed]
           ic = ansi(color, icon(emoji, plain, config), config)
           dur = f" ({duration:.0f}s)" if duration is not None else ""
           return f"{ic} {label}  {detail}{dur}"
       ```
     - `render_kv_line(config: TUIConfig, key: str, value: str, color: str | None = None) -> str`:
       ```python
       def render_kv_line(config, key, value, color=None):
           v = ansi(color, value, config) if color else value
           return f"  {key}: {v}"
       ```

   - Files affected: `scripts/tui_core.py` (new)
   - Acceptance criteria: `python3 -c "from tui_core import TUIConfig, make_config, ansi, icon, strip_ansi, sanitize_text, truncate, section_header, format_banner, render_checklist_item, render_kv_line; print('ok')"` exits 0

2. **Update `scripts/triage_tui.py` imports**
   - What: Replace all local definitions that moved to `tui_core` with imports. The following changes are mechanical:
     ```python
     # Remove these lines from triage_tui.py (they move to tui_core.py):
     # _BANNER_WIDTH, _BANNER_INNER_WIDTH, _ANSI_RE
     # TUIConfig dataclass, make_config()
     # _ansi(), _plain_text(), _icon(), _format_banner_line(), _section_header()
     
     # Add at top of triage_tui.py:
     from tui_core import (
         TUIConfig,
         make_config,
         ansi as _ansi,
         icon as _icon,
         strip_ansi as _plain_text,
         section_header as _section_header_core,
         format_banner,
         render_checklist_item,
     )
     _BANNER_WIDTH = 72  # keep local for render_banner width arithmetic
     ```
   - Update `render_banner()`: replace the inline banner-building logic with a call to `format_banner(config, [line_one, line_two])`. The existing per-line width math is now inside `format_banner()`.
   - Update all 6 `_section_header()` call sites to pass `plain_label` matching the new signature. Map current `plain_text` args: `"[TRIAGE]"` → label `"TRIAGE"`, `"[SUMMARY]"` → `"SUMMARY"`, `"[INSIGHTS]"` → `"INSIGHTS"`. (The displayed format changes from `=== [TRIAGE] Triage` — verify this is acceptable; it matches the design spec's required format.)
   - Files affected: `scripts/triage_tui.py`
   - Acceptance criteria: `python3 -m pytest scripts/test_triage_tui.py -x -q` — 4 passed, 0 failed. No import errors.

3. **Create `scripts/test_tui_core.py`**
   - What: 17 tests as specified in the design. Full list:

     ```python
     # test_make_config_detects_tty — mock sys.stdout.isatty → True, assert color=True
     # test_make_config_no_tty — mock isatty → False, assert color=False
     # test_make_config_respects_no_color — patch os.environ NO_COLOR=1, assert color=False
     # test_make_config_respects_term_dumb — patch os.environ TERM=dumb, assert color=False
     # test_ansi_wraps_when_color — TUIConfig(color=True, plain=False, json_mode=False), check \033 present
     # test_ansi_skips_when_no_color — color=False, check no \033
     # test_icon_emoji_vs_plain — plain=False → emoji, plain=True → text
     # test_strip_ansi_removes_codes — input "\033[32mhello\033[0m" → "hello"
     # test_sanitize_strips_control_chars — input "foo\x1b[1mbar\x07baz" → "foobar\x1b[1mbaz" ... wait
     ```
     
     Important: `sanitize_text()` strips C0/C1 except `\n` and `\t`. It does NOT strip ANSI sequences (those are multi-char, not raw control codes in the C0 range that match `[\x00-\x08\x0b-\x1f]`). Actually `\x1b` (ESC, 0x1B) IS in the C0 range 0x00-0x1f, so `sanitize_text()` DOES strip ANSI escape sequences. `strip_ansi()` also strips them via regex. Both serve different purposes: `sanitize_text()` is for untrusted input (strips all control chars including ESC that starts ANSI sequences); `strip_ansi()` is for visible-length calculation (strips complete ANSI sequences while preserving other content).

     Correct test for `test_sanitize_strips_control_chars`:
     - Input: `"branch\x00name"` (null byte) → `"branchname"`
     - Input: `"msg\x07bell"` (BEL) → `"msgbell"`
     - Input: `"tab\there"` (\t preserved) → `"tab\there"`
     
     Test for `test_sanitize_preserves_newline_tab`:
     - Input: `"line1\nline2\ttab"` → unchanged

     Full test for `truncate`:
     ```python
     # test_truncate_short_text_unchanged — len <= max → same string returned
     # test_truncate_long_text_with_ellipsis — "abcde" with max=4 → "abc…"
     # test_truncate_ignores_ansi_in_length — "\033[32mhello\033[0m" with max=5 → unchanged (visible=5)
     ```
     
     Format tests:
     ```python
     # test_section_header_formats — color config, title="Triage", emoji="🎯", plain_label="TRIAGE"
     #   → result starts with "── 🎯  Triage "
     # test_section_header_plain — plain config → "=== [TRIAGE] Triage ==="
     # test_format_banner_box_drawing — color config, lines=["hello"] → contains ╔ and ╚
     # test_format_banner_plain — plain config → starts and ends with "=" * 72
     # test_format_banner_truncates_long_lines — line of 80 chars, width=72 → visible content ≤ 68 chars
     ```

   - Files affected: `scripts/test_tui_core.py` (new)
   - Acceptance criteria: `python3 -m pytest scripts/test_tui_core.py -x -q` — 17 passed

### Risks

- **`section_header()` plain format changed:** The existing `triage_tui._section_header()` renders `=== plain_text title ===`, but the new `section_header()` renders `=== [PLAIN_LABEL] title ===`. Triage tests currently test `test_plain_mode_strips_emojis` and `test_plain_mode_ascii_borders` — neither asserts the exact section header text, so this should not break tests. Confirm by running triage tests after the change.
  *Mitigation:* If a triage test does assert exact plain section header text, add a compatibility shim or adjust the test to match the new canonical format.

- **`render_banner()` delegation to `format_banner()`:** The existing triage `render_banner()` handles its own line-building. Moving this to `format_banner()` changes the internal implementation path. The `test_plain_mode_ascii_borders` test asserts `"=" * 72` is present — `format_banner()` in plain mode emits `"=" * width` as the divider, so this should still pass.
  *Mitigation:* Run `test_triage_tui.py` immediately after the delegation change; fix before proceeding.

### Verification

```bash
cd /Users/aryeh/Code/Playground/stark-skills/scripts
python3 -m pytest test_triage_tui.py -x -q     # MUST show: 4 passed
python3 -m pytest test_tui_core.py -x -q       # MUST show: 17 passed
python3 -c "from tui_core import make_config, format_banner; c = make_config(plain=True); print(format_banner(c, ['hello', 'world']))"
```

**This is a hard gate.** Phase 2 does not start until both test suites pass.

---

## Phase 2: Implement `session_tui.py` and Tests

**Goal:** Create `scripts/session_tui.py` with all TypedDicts, render functions, and composition helpers. Create `scripts/test_session_tui.py` with 18 tests.

**Dependencies:** Phase 1 complete (tui_core.py must exist and tests must pass)

**Estimated effort:** L

### Tasks

1. **Create `scripts/session_tui.py`**
   - What: New file. Full structure:

     **Imports:**
     ```python
     from __future__ import annotations
     import re
     from typing import Literal
     from typing_extensions import TypedDict  # or typing.TypedDict if Python 3.11+
     from tui_core import (
         TUIConfig, ansi, icon, strip_ansi, sanitize_text, truncate,
         section_header, format_banner, render_checklist_item, render_kv_line,
     )
     ```

     **TypedDicts:** Implement all 11 TypedDicts exactly as specified in the design:
     `CommitInfo`, `PRInfo`, `HealthCheck`, `AlertInfo`, `BoardItem`, `FileChange`,
     `NextUpItem`, `GitState`, `DiffSummary`, `_BannerRequired`, `BannerData`.
     
     Use `from __future__ import annotations` and `TypedDict` from `typing` (Python 3.11+) or `typing_extensions`.
     `BannerData` must use `total=False` for optional fields per the design spec.

     **Color/style maps** (module-level dicts):
     ```python
     _SECTION_STYLES: dict[str, tuple[str, str, str]] = {
         "git":     ("36", "🔀", "GIT"),
         "prs":     ("35", "📋", "PRS"),
         "health":  ("32", "🏥", "HEALTH"),
         "alerts":  ("33", "⚠️",  "ALERTS"),
         "board":   ("34", "📌", "BOARD"),
         "receipt": ("32", "📊", "RECEIPT"),
         "diff":    ("34", "📈", "DIFF"),
         "next":    ("33", "👉", "NEXT"),
     }
     
     _PR_STATUS_STYLE: dict[str, tuple[str, str, str]] = {
         "ready":            ("32", "✅", "[OK]"),
         "review_requested": ("2",  "··", "[REVIEW]"),
         "draft":            ("2",  "○",  "[-]"),
         "merged":           ("35", "🟣", "[MERGED]"),
     }
     
     _BOARD_STATUS_STYLE: dict[str, tuple[str, str, str]] = {
         "in_flight": ("32", "▶", "[ACTIVE]"),
         "blocked":   ("31", "⏸", "[BLOCKED]"),
         "clarify":   ("33", "?", "[?]"),
     }
     
     _PRIORITY_STYLE: dict[str, tuple[str, str]] = {
         "action": ("33", "●", "*"),
         "low":    ("2",  "○", "-"),
     }
     ```

     **`render_session_banner(config, data)`:**
     - Extracts `HH:MM` from `data["started_at"]` using `datetime.fromisoformat(data["started_at"]).strftime("%H:%M")`
     - For `"start"` mode: banner lines are repo/branch/session-id/start-time, persona if present
     - For `"end"` mode: same plus session name, end time, duration
     - All string values passed through `sanitize_text()` before formatting
     - Line content is passed through `truncate(line, width - 4)` before passing to `format_banner()`
     - Calls `format_banner(config, lines)` from core
     - Start banner uses ANSI 32 (green), end banner ANSI 34 (blue) for the intro icon

     **`render_git_state(config, git)`:**
     - Section header: `section_header(config, "Git", "🔀", "GIT")`
     - Branch line: `render_kv_line(config, "Branch", sanitize_text(git["branch"]))` with ahead/behind info appended
     - If `git["ahead"] > 0 or git["behind"] > 0`: append `(+{ahead}/-{behind})`
     - Uncommitted files: list up to 10, then `"  + {N} more"` if truncated
     - Recent commits: list up to 5 (sha, message first 60 chars, age) — `sanitize_text()` on each message

     **`render_prs(config, prs)`:**
     - If empty: return `section_header(...) + "\n  No open PRs."`
     - For each PR (up to 10): `{icon} {text_label} #{number} — {title_truncated_to_50}`
     - `sanitize_text()` on each `pr["title"]`
     - Status text labels are always rendered alongside the symbol (never symbol-only)

     **`render_health(config, checks)`:**
     - If empty: return `section_header(...) + "\n  No health checks configured."`
     - For each check: `render_checklist_item(config, check["passed"], check["name"], check["detail"], check.get("duration"))`

     **`render_alerts(config, alerts)`:**
     - If empty: **return `""`** (section omitted entirely — no header)
     - For each alert: color by level (`"critical"` → ANSI 31, `"warning"` → ANSI 33)
     - `sanitize_text()` on each alert message and context

     **`render_board(config, items)`:**
     - If empty: **return `""`** (section omitted entirely)
     - For each item: `{status_icon} {text_label} #{issue_number} — {title}`
     - `sanitize_text()` on each title

     **`render_receipt(config, items)`:**
     - Reuses `HealthCheck` TypedDict (same schema)
     - For each item: `render_checklist_item(config, item["passed"], item["name"], item["detail"], item.get("duration"))`

     **`render_diff_summary(config, diff)`:**
     - `+{added}/-{removed} across {file_count} files`
     - List key files: `{status_icon} {path}` (up to 5 notable files)
     - `sanitize_text()` on each file path
     - `status` values: `"new"` → `+`, `"modified"` → `M`, `"deleted"` → `-`, `"renamed"` → `R`

     **`render_next_up(config, items)`:**
     - Sort: `"action"` items first, then `"low"` (preserve insertion order within each group)
     - For each: `{priority_icon} {label}` with optional `{issue}` suffix
     - `sanitize_text()` on label

     **`render_start_briefing(config, banner, git, prs, health, alerts, board, next_up)`:**
     ```python
     def render_start_briefing(...) -> str:
         parts = [
             render_session_banner(config, banner),
             render_git_state(config, git),
             render_prs(config, prs),
             render_health(config, health),
             render_alerts(config, alerts),    # empty → ""
             render_board(config, board),      # empty → ""
             render_next_up(config, next_up),
         ]
         return "\n".join(p for p in parts if p)
     ```

     **`render_end_summary(config, banner, receipt, diff, next_up)`:**
     ```python
     def render_end_summary(...) -> str:
         parts = [
             render_session_banner(config, banner),
             render_receipt(config, receipt),
             render_diff_summary(config, diff),
             render_next_up(config, next_up),
         ]
         return "\n".join(p for p in parts if p)
     ```

   - Files affected: `scripts/session_tui.py` (new)
   - Acceptance criteria: `python3 -c "from session_tui import render_start_briefing, render_end_summary; print('ok')"` exits 0

2. **Create `scripts/test_session_tui.py`**
   - What: 18 tests as specified in the design. Key implementation notes:

     **Fixtures:**
     ```python
     @pytest.fixture
     def color_config():
         return TUIConfig(color=True, plain=False, json_mode=False)
     
     @pytest.fixture
     def plain_config():
         return TUIConfig(color=False, plain=True, json_mode=False)
     
     @pytest.fixture
     def no_color_config():
         return TUIConfig(color=False, plain=False, json_mode=False)
     ```

     **Sample data helpers:**
     ```python
     def _banner_start() -> BannerData:
         return {
             "mode": "start", "repo": "org/repo", "branch": "main",
             "session_id": "abc123", "started_at": "2026-04-04T13:55:00+03:00",
             "persona_name": "The Architect",
             "persona_catchphrase": "Design before code.",
         }
     
     def _banner_end() -> BannerData:
         return {
             **_banner_start(),
             "mode": "end",
             "ended_at": "2026-04-04T16:42:00+03:00",
             "duration": "2h 47m",
             "session_name": "feat-session-tui",
         }
     ```

     **Test list:**
     - `test_start_banner_contains_session_id` — `"abc123"` in `render_session_banner(color_config, _banner_start())`
     - `test_start_banner_contains_start_time` — `"13:55"` in output
     - `test_end_banner_contains_duration` — `"2h 47m"` in `render_session_banner(color_config, _banner_end())`
     - `test_end_banner_contains_session_name` — `"feat-session-tui"` in end banner
     - `test_alerts_empty_returns_empty` — `render_alerts(config, []) == ""`
     - `test_board_empty_returns_empty` — `render_board(config, []) == ""`
     - `test_next_up_ordering` — mix of action/low items, verify action items appear before low in output
     - `test_no_color_strips_ansi` — `render_start_briefing(no_color_config, ...)` → no `\033[` in output
     - `test_plain_mode_no_emoji` — `render_start_briefing(plain_config, ...)` → no emoji chars (use `EMOJI_RE = re.compile(r"[\u2600-\u27BF\U0001F300-\U0001FFFF]")`)
     - `test_pr_status_has_text_labels` — for each status, verify the text label string appears in output (not just symbol)
     - `test_receipt_all_passed` — all `passed=True` items → output contains no `[FAIL]` or `[WARN]`
     - `test_receipt_mixed_status` — `passed=True`, `passed=False`, `passed=None` → all three status strings in output
     - `test_render_start_briefing_composition` — call `render_start_briefing()` with non-empty args for all sections; verify output contains content from each section (check for unique strings like branch name, session ID, PR number)
     - `test_render_end_summary_composition` — call `render_end_summary()` with non-empty args; verify receipt items, diff stats, and next-up items appear
     - `test_uncommitted_files_capped_at_10` — `GitState` with 15 uncommitted files → only 10 shown + `"5 more"` in output
     - `test_health_empty_shows_message` — `render_health(config, [])` → `"No health checks configured."` in output
     - `test_sanitization_strips_injected_escapes` — branch name containing `"\x1b[31mevil\x1b[0m"` → no ANSI codes in `render_git_state()` output (even with color enabled)
     - `test_error_item_renders_as_warning` — `HealthCheck(passed=None, detail="unavailable: gh offline")` → `"[WARN]"` or `"⚠"` in output

   - Files affected: `scripts/test_session_tui.py` (new)
   - Acceptance criteria: `python3 -m pytest scripts/test_session_tui.py -x -q` — 18 passed

### Risks

- **`datetime.fromisoformat()` with `+03:00` timezone offset:** Python 3.11+ handles this correctly. Python 3.9/3.10 do not handle `+HH:MM` offsets. Since `started_at` in the existing `session_state.py` is stored as `"2026-04-04T13:55:00Z"` (not `+03:00`), both formats must be handled. Use `datetime.fromisoformat(ts.replace("Z", "+00:00"))` for compatibility.
  *Mitigation:* Add a small private helper `_parse_iso(ts: str) -> datetime` at the top of `session_tui.py` that normalizes `Z` → `+00:00` before parsing.

- **TypedDict import:** `TypedDict` is in `typing` since 3.8 but `total=False` on inheritance requires care. Use `class BannerData(_BannerRequired, total=False): ...` which is valid Python 3.8+.
  *Mitigation:* Add a quick `python3 -c "from session_tui import BannerData; print('ok')"` check after creating the file.

- **Emoji character detection in tests:** The `EMOJI_RE` pattern `[\u2600-\u27BF\U0001F300-\U0001FFFF]` may miss some emoji used in the color map (e.g., `"⏸"` is U+23F8, outside the range). Use a broader pattern or explicitly check that `plain_config` output contains only ASCII and box-drawing chars.
  *Mitigation:* In `test_plain_mode_no_emoji`, also check that no multi-byte non-ASCII chars matching `[\x80-\xff]{3}` (emoji are multi-byte in UTF-8) appear, or import the same `EMOJI_RE` from `test_triage_tui.py` for consistency.

### Verification

```bash
cd /Users/aryeh/Code/Playground/stark-skills/scripts
python3 -m pytest test_session_tui.py -x -q     # MUST show: 18 passed
# Smoke test the composition helpers:
python3 -c "
from session_tui import render_start_briefing, render_end_summary
from tui_core import make_config
c = make_config(plain=True)
banner = {'mode': 'start', 'repo': 'org/repo', 'branch': 'main', 'session_id': 'test', 'started_at': '2026-04-04T10:00:00Z'}
print(render_start_briefing(c, banner, {'branch': 'main', 'ahead': 0, 'behind': 0, 'uncommitted': [], 'recent_commits': []}, [], [], [], [], []))
"
```

---

## Phase 3: Update `session_state.py` and Tests

**Goal:** Add `name: str | None = None` field to `SessionState`. Ensure backward compatibility with old JSON files. Add one test.

**Dependencies:** Phase 1 (session_state.py doesn't depend on tui_core, but keeping phases in order avoids merge conflicts)

**Estimated effort:** S

### Tasks

1. **Add `name` field to `SessionState`**
   - What: In `scripts/session_state.py`, update the `SessionState` dataclass:
     ```python
     @dataclass
     class SessionState:
         session_id: str
         started_at: str
         branch: str
         repo: str
         tasks_completed: list[str] = field(default_factory=list)
         last_checkpoint: str | None = None
         context: dict[str, Any] = field(default_factory=dict)
         name: str | None = None   # meaningful name, set at session end
     ```
   - Update the `load()` classmethod to include `name` in deserialization:
     ```python
     return cls(
         session_id=data.get("session_id", session_id),
         started_at=data.get("started_at", ""),
         branch=data.get("branch", ""),
         repo=data.get("repo", ""),
         tasks_completed=data.get("tasks_completed", []),
         last_checkpoint=data.get("last_checkpoint"),
         context=data.get("context", {}),
         name=data.get("name", None),   # new field — defaults None for old JSON files
     )
     ```
   - No other changes to `session_state.py`.
   - Files affected: `scripts/session_state.py`
   - Acceptance criteria: Loading a JSON file without a `name` key produces `SessionState.name == None` without raising.

2. **Add backward-compat test to `test_session_state.py`**
   - What: Add one test to the `TestSaveAndLoad` class:
     ```python
     def test_name_field_defaults_none_on_old_state(self, isolated, sessions_dir):
         """Loading an old JSON file without 'name' key must not raise and must return name=None."""
         old_data = {
             "session_id": "old-session",
             "started_at": "2026-01-01T00:00:00Z",
             "branch": "main",
             "repo": "org/repo",
             "tasks_completed": [],
             "last_checkpoint": None,
             "context": {},
             # 'name' key intentionally absent
         }
         (sessions_dir / "old-session.json").write_text(json.dumps(old_data))
         loaded = session_state.SessionState.load("old-session")
         assert loaded is not None
         assert loaded.name is None
     ```
   - Files affected: `scripts/test_session_state.py`
   - Acceptance criteria: `python3 -m pytest scripts/test_session_state.py -x -q` — all existing tests pass plus new test

### Risks

- **`asdict()` serialization:** `dataclasses.asdict()` automatically includes all fields including `name`. Sessions saved after this change will have `"name": null` or `"name": "feat-xyz"` in JSON. Old code (e.g., other scripts that parse session JSON) must tolerate the new key — but since they're `dict.get()`-based, this is safe.
  *Mitigation:* Grep for any code that reads session JSON directly and verify it uses `.get()` patterns:
  ```bash
  grep -r "session_id.*json\|\.json.*session" scripts/ --include="*.py" -l
  ```

- **`get_current()` has `@lru_cache(maxsize=1)` — the cache holds a `SessionState` instance.** If the field is added correctly at the dataclass level, `get_current()` will return instances with `name=None` by default. Setting `session.name = "foo"` on the cached instance and calling `save()` will persist it. No issues.

### Verification

```bash
cd /Users/aryeh/Code/Playground/stark-skills/scripts
python3 -m pytest test_session_state.py -x -q   # ALL tests pass (new + existing)
```

---

## Phase 4: Update `skill/stark-session/SKILL.md`

**Goal:** Integrate `session_tui.py` rendering into the start and end flows of the SKILL.md. Replace the plain-text briefing (Phase 5) and flat summary (Phase 6 end) with calls to the composition helpers.

**Dependencies:** Phases 1, 2, and 3 must be complete and verified.

**Estimated effort:** M

### Tasks

1. **Add TUI rendering imports/setup block to SKILL.md**
   - What: Add a new section near the top of SKILL.md (after the Preflight block, before Start Mode) that the agent uses to set up rendering:

     ```
     ## TUI Setup
     
     Before rendering any output in start or end mode, determine the TUI config:
     
     ```python
     import sys
     sys.path.insert(0, str(Path.home() / ".claude/code-review/scripts"))
     from tui_core import make_config
     from session_tui import render_start_briefing, render_end_summary
     
     # Detect rendering mode from user invocation context:
     # - If the user said "no color" or "--no-color": no_color=True
     # - If the user said "plain" or "--plain": plain=True
     # - Otherwise: use defaults (auto-detect TTY, NO_COLOR env, TERM=dumb)
     config = make_config(no_color=False, plain=False)  # adjust flags as detected
     ```
     ```

   - Files affected: `skill/stark-session/SKILL.md`

2. **Replace Phase 5 (start briefing) plain text with `render_start_briefing()`**
   - What: The current Phase 5 in Start Mode says "Present a concise briefing: Branch: ..., PRs: ..., Health: ...". Replace with:

     ```
     ### Phase 5 — Briefing (TUI)
     
     Assemble the data collected in phases 2–4b into TypedDicts and print the structured briefing:
     
     ```python
     from session_tui import (
         GitState, PRInfo, HealthCheck, AlertInfo, BoardItem, NextUpItem,
         BannerData, render_start_briefing,
     )
     from datetime import datetime, timezone
     
     # Build banner
     banner: BannerData = {
         "mode": "start",
         "repo": session_state.repo,
         "branch": session_state.branch,
         "session_id": session_state.session_id,
         "started_at": session_state.started_at,
         # Optional: include persona_name and persona_catchphrase if persona selection succeeded
     }
     
     # Build git state from Phase 2 results
     git: GitState = {
         "branch": current_branch,
         "ahead": ahead_count,
         "behind": behind_count,
         "uncommitted": uncommitted_lines,  # from git status --short
         "recent_commits": [{"sha": sha, "message": msg, "age": age} for ...],
     }
     
     # Build PR list from gh pr list output
     prs: list[PRInfo] = [...]  # map reviewDecision → "ready"|"review_requested"|"draft"
     
     # Build health checks from Phase 3 results
     health: list[HealthCheck] = [...]  # one per check + telemetry check
     
     # Build alerts from Phase 2b results (empty list if none)
     alerts: list[AlertInfo] = [...]
     
     # Build board items from Phase 2 project board query (empty list if not configured)
     board: list[BoardItem] = [...]
     
     # Build next_up from Phase 6 task list logic
     next_up: list[NextUpItem] = [...]
     
     print(render_start_briefing(config, banner, git, prs, health, alerts, board, next_up))
     ```
     
     If any data source failed (gh unavailable, git not a repo, etc.), pass an empty list for that section or a single HealthCheck with passed=None and detail="unavailable: <reason>". Never let a failed section abort the briefing.
     ```

   - **What NOT to change:** Phase 6 (task list + "go" prompt) stays as-is — it follows the briefing and is already well-structured prose. The `next_up` items in the TUI render are built from the same Phase 6 sources and serve as a visual preview before the prose list.

3. **Replace Phase 6 end-mode summary with `render_end_summary()`**
   - What: The current "Phase 6 — Summary" in End Mode shows a flat checklist. Replace with:

     ```
     ### Phase 6 — Summary (TUI)
     
     Choose a session name (in priority order):
     1. PRs merged during session → slug like "pr-142-feat-session-tui"
     2. Issues closed → "issues-228-238-feat-xyz"
     3. Branch name → strip "feature/" prefix, max 50 chars
     4. Most common commit prefix (from git log) → "triage-engine-and-tests"
     Fallback: "session-{session_id}"
     
     Set and save: `session_state.name = chosen_name; session_state.save()`
     
     ```python
     from datetime import datetime, timezone
     
     ended_at = datetime.now(timezone.utc).astimezone().isoformat()
     started = datetime.fromisoformat(session_state.started_at.replace("Z", "+00:00"))
     ended = datetime.fromisoformat(ended_at)
     elapsed = ended - started
     total_minutes = int(elapsed.total_seconds() / 60)
     duration_str = f"{total_minutes // 60}h {total_minutes % 60}m" if total_minutes >= 60 else f"{total_minutes}m"
     
     banner: BannerData = {
         "mode": "end",
         "repo": session_state.repo,
         "branch": session_state.branch,
         "session_id": session_state.session_id,
         "started_at": session_state.started_at,
         "ended_at": ended_at,
         "duration": duration_str,
         "session_name": session_state.name,
     }
     
     # receipt: one HealthCheck per end-mode action
     receipt: list[HealthCheck] = [
         {"name": "Tests",     "passed": test_passed,   "detail": test_detail,    "duration": test_duration},
         {"name": "Build",     "passed": build_passed,  "detail": build_detail,   "duration": build_duration},
         {"name": "PRs",       "passed": prs_passed,    "detail": prs_detail,     "duration": None},
         {"name": "Docs",      "passed": docs_passed,   "detail": docs_detail,    "duration": None},
         {"name": "Push",      "passed": push_passed,   "detail": push_detail,    "duration": None},
         {"name": "Telemetry", "passed": telem_passed,  "detail": telem_detail,   "duration": None},
     ]
     
     # diff summary from git diff --stat between session start and HEAD
     diff: DiffSummary = {
         "added": lines_added,
         "removed": lines_removed,
         "file_count": files_changed,
         "key_files": [...],
     }
     
     # next_up: suggestions for next session
     next_up: list[NextUpItem] = [...]
     
     print(render_end_summary(config, banner, receipt, diff, next_up))
     ```
     ```

   - **Diff collection** — add a new step before Phase 6 in end mode to collect the diff summary:
     ```bash
     # Get session-level diff stats (compare to branch base or just HEAD~5 as approximation)
     git diff --stat HEAD~5 HEAD 2>/dev/null | tail -1 || echo "0 files changed"
     git diff --name-status HEAD~5 HEAD 2>/dev/null | head -10 || true
     ```
     If the diff collection fails, use `DiffSummary(added=0, removed=0, file_count=0, key_files=[])`.

   - Files affected: `skill/stark-session/SKILL.md`
   - Acceptance criteria: Running `/stark-session start` in a repo produces structured color output with section headers. Running `/stark-session end` produces an end banner with receipt checklist and diff summary.

### Risks

- **SKILL.md is interpreted by an LLM agent, not executed as a script.** The Python code blocks in SKILL.md are instructions to the agent. The agent must correctly import and call the Python modules at the right point in the workflow. If the agent hallucinates or skips the rendering step, the output will degrade to prose — not a crash.
  *Mitigation:* Keep the SKILL.md instructions explicit: "Call `render_start_briefing()` and `print()` its return value. Do not summarize the output in prose."

- **Session start currently outputs all phases separately; the TUI call must come at the right point.** The existing Phase 5 prose says "Condense or omit empty sections" — with the TUI this is automatic. The briefing call must happen after all data is collected (after phases 2–4b) and before the Phase 6 task list prompt.
  *Mitigation:* Add explicit ordering notes in the SKILL.md: "Phase 5 (TUI render) executes after phases 2, 2b, 3, 4, 4b are complete. Do not print partial output — collect all data first, then render once."

- **`started_at` format in `session_state.py`** is `"%Y-%m-%dT%H:%M:%SZ"` (no timezone offset). The `render_session_banner()` function must handle this via the `_parse_iso()` helper (see Phase 2 risks). Both SKILL.md and session_tui.py will see `"Z"` suffix — verify the helper normalizes it.

### Verification

Manual test in the stark-skills repo:
```
/stark-session start
```
Expected: Structured output with section headers (── 🔀  Git ──────────...etc.), color-coded status, no plain-text briefing fallthrough.

```
/stark-session end
```
Expected: End banner with session name, receipt checklist with ✅/❌/⚠️ items, diff summary, next-up suggestions.

---

## 4. Integration Points

| Contract | Between | Shape |
|----------|---------|-------|
| `tui_core → triage_tui` | Phase 1 | `tui_core` exports `TUIConfig`, `make_config`, `ansi`, `icon`, `strip_ansi`, `section_header`, `format_banner`, `render_checklist_item`, `render_kv_line` |
| `tui_core → session_tui` | Phase 2 | Same exports |
| `session_tui → SKILL.md` | Phase 4 | `render_start_briefing()` and `render_end_summary()` take TypedDicts assembled by agent |
| `session_state → SKILL.md` | Phase 3+4 | `session_state.name` (new field) written at end mode, read for end banner |
| `session_state.started_at → session_tui` | Phase 4 | ISO8601 string with `Z` or `+HH:MM` suffix; normalized via `_parse_iso()` helper in session_tui |

**Shared state:** `TUIConfig` is the only shared object passed between `tui_core` and the domain modules. It is a frozen-ish dataclass (no mutation after creation). Both `triage_tui.py` and `session_tui.py` create their own `TUIConfig` instances via `make_config()`.

**Data format contracts for TypedDicts:**
- `PRInfo.status` values: `"ready"`, `"review_requested"`, `"draft"`, `"merged"` — agent must map GitHub's `reviewDecision` field to these strings
- `AlertInfo.level` values: `"warning"`, `"critical"` — agent maps from alert delivery JSON
- `BoardItem.status` values: `"in_flight"`, `"blocked"`, `"clarify"` — agent maps from GitHub Projects status field
- All timestamps: ISO8601 strings parseable by `datetime.fromisoformat()` after `Z`→`+00:00` normalization

---

## 5. Testing Strategy

**Run order matters:** Always run in this sequence to catch regressions early:

```bash
cd /Users/aryeh/Code/Playground/stark-skills/scripts

# Phase 1 gate:
python3 -m pytest test_triage_tui.py -x -q      # 4 tests — must pass before proceeding
python3 -m pytest test_tui_core.py -x -q         # 17 tests

# Phase 2:
python3 -m pytest test_session_tui.py -x -q      # 18 tests

# Phase 3:
python3 -m pytest test_session_state.py -x -q    # all existing + 1 new

# Full suite regression check (after all phases):
python3 -m pytest test_triage_tui.py test_tui_core.py test_session_tui.py test_session_state.py -v
```

**What each test layer covers:**

| Layer | Tests | What it validates |
|-------|-------|-------------------|
| `test_tui_core.py` | 17 | Config detection, ANSI logic, sanitization, truncation, banner/header rendering |
| `test_session_tui.py` | 18 | Session-specific rendering, composition, empty-section omission, accessibility text labels |
| `test_triage_tui.py` | 4 | Regression: zero behavior change after extraction |
| `test_session_state.py` | existing + 1 | Backward compat with old JSON files missing `name` field |

**What's not covered by unit tests (manual only):**
- SKILL.md integration (agent interprets the SKILL.md — no automated test)
- Actual terminal color rendering in a real TTY
- Persona catchphrase truncation in the banner (truncation logic is tested in `test_tui_core.py` but not the banner-level composition with a long catchphrase)

---

## 6. Rollback Plan

Each phase is independently reversible:

**Phase 1 (tui_core extraction):**
- Git revert `scripts/tui_core.py` (delete), `scripts/triage_tui.py` (restore original)
- Run `python3 -m pytest test_triage_tui.py` to confirm triage is restored
- `test_tui_core.py` becomes dead code — delete it

**Phase 2 (session_tui):**
- Git revert `scripts/session_tui.py` (delete), `scripts/test_session_tui.py` (delete)
- No impact on triage or session state

**Phase 3 (session_state name field):**
- Git revert `scripts/session_state.py` to remove the `name` field and its `load()` deserialization
- Existing session JSON files with `"name": null` will have an unrecognized key — harmless (ignored by old code)
- Revert the new test in `test_session_state.py`

**Phase 4 (SKILL.md):**
- Git revert `skill/stark-session/SKILL.md` to the pre-TUI version
- The TUI Python modules remain installed but are simply not called
- Session behavior returns to plain-text output immediately

**Full rollback:** `git revert` the commits from each phase in reverse order (4 → 3 → 2 → 1). Each phase should be committed separately to make targeted rollback possible.
