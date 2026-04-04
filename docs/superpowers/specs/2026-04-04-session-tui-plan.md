# Implementation Plan: Session TUI

## 1. Overview

Extract shared rendering primitives from `triage_tui.py` into `tui_core.py`, migrate triage to consume it with zero behavior regressions, build `session_tui.py` on the shared foundation, extend `session_state.py` with the optional `name` field, and update `skill/stark-session/SKILL.md` to render structured start/end output through the new module.

Key constraints: zero triage rendering regressions, shared NO_COLOR/non-TTY/--plain parity, render-time sanitization of untrusted strings, and best-effort degradation when any non-critical data source fails.

**Total phases: 6**
- Phase 0: Extend Session State (parallel with Phase 1)
- Phase 1: Extract Shared TUI Core
- Phase 2: Implement Session Renderer
- Phase 3: Integrate Start-Mode Session TUI
- Phase 4: Integrate End-Mode Session TUI
- Phase 5: Final Regression and Release Gate

---

## 2. Prerequisites

- Python 3.11+ (uses `from __future__ import annotations`, `TypedDict`, `Literal`)
- Test harness: `pytest.ini` and `scripts/conftest.py` add `scripts/` to `PYTHONPATH`
- Dependencies: Python stdlib only — no new pip packages
- Baseline: `python3 -m pytest scripts/test_triage_tui.py -x -q` passes before any changes
- Infrastructure scope: local-rendering only. No Terraform, IAM, cloud resources, or new credentials. If implementation starts to require new infra, stop and split into a separate design.

---

## 3. Phases

## Phase 0: Extend Session State

**Goal:** Add optional `name` field to `SessionState` with backward compatibility.
**Dependencies:** None (parallel with Phase 1)
**Estimated effort:** S

### Tasks

1. **Add `name` to `SessionState` dataclass**
   - Add `name: str | None = None` to the dataclass
   - Update `load()` to use `data.get("name", None)` for backward compatibility
   - `save()` persists via `asdict` — no changes needed
   - Files: `scripts/session_state.py`
   - Done when: newly saved sessions include `name`, old JSON files without `name` load cleanly

2. **Normalize timestamp parsing for duration use**
   - Ensure `started_at` parsing accepts both `Z` suffix and offset forms (e.g., `+03:00`)
   - Files: `scripts/session_state.py` (if parsing logic exists there)
   - Done when: legacy sessions with UTC `Z` timestamps work with the new banner duration logic

3. **Add backward compatibility test**
   - Add `test_name_field_defaults_none_on_old_state` to `scripts/test_session_state.py`
   - Test: create JSON without `name` key → load → assert `name is None`
   - Files: `scripts/test_session_state.py`
   - Done when: test passes

### Risks
- Hidden coupling to `SessionState.asdict()` layout: mitigated by keeping field addition append-only and optional.

### Verification
```bash
python3 -m pytest scripts/test_session_state.py -x -q
```

---

## Phase 1: Extract Shared TUI Core

**Goal:** Create `tui_core.py` and migrate triage to import from it. Zero behavior change to triage rendering.
**Dependencies:** None (parallel with Phase 0)
**Estimated effort:** M

### Tasks

1. **Create `scripts/tui_core.py`**
   - Move from `triage_tui.py`: `TUIConfig`, `make_config()`, `_ansi` → `ansi()`, `_icon` → `icon()`, `_plain_text` → `strip_ansi()`, `_ANSI_RE`, `_BANNER_WIDTH` (as default param)
   - Move `_section_header` → `section_header()` (public, gains `width` param)
   - Move `_format_banner_line` → internal to new `format_banner()` function, with truncation for lines > width-4
   - Add new: `sanitize_text()` (strip C0/C1 control codes except \n and \t), `truncate()` (visible-length-aware), `render_checklist_item()`, `render_kv_line()`
   - Add `TERM=dumb` detection to `make_config()`
   - Files: `scripts/tui_core.py` (new)
   - Done when: module covers the full shared API from the design spec

2. **Refactor `scripts/triage_tui.py` to import core primitives**
   - Replace local primitive implementations with imports: `from tui_core import TUIConfig, make_config, ansi, icon, strip_ansi, section_header, format_banner`
   - **Add re-exports for compatibility:** `from tui_core import TUIConfig, make_config` at module level so existing callers importing `triage_tui.TUIConfig` or `triage_tui.make_config` continue to work
   - Keep all triage-specific label/style dicts and render functions in place
   - `render_banner` must use `format_banner()` from core for box-drawing (no duplicated banner logic)
   - Files: `scripts/triage_tui.py`
   - Done when: all 6 triage render functions produce identical output

3. **Add shared-core test suite**
   - Create `scripts/test_tui_core.py` with 17 tests from the design spec
   - Must cover: `TERM=dumb`, `NO_COLOR`, ANSI stripping, `sanitize_text` (control chars, preserves \n \t), visible-width truncation, plain headers, banner truncation, checklist items (pass/fail/warn)
   - Files: `scripts/test_tui_core.py` (new)
   - Done when: all 17 tests pass

### Risks
- Visual drift in triage due to padding/truncation changes: mitigated by keeping triage render functions untouched except for primitive imports, and by gating on existing triage tests.
- Breaking external callers that import `triage_tui.make_config`: mitigated by re-exporting compatibility names.

### Verification (required gate before Phase 2)
```bash
python3 -m pytest scripts/test_triage_tui.py -x -q  # existing 4 tests still pass
python3 -m pytest scripts/test_tui_core.py -x -q     # new 17 tests pass
rg -n "triage_tui\.(TUIConfig|make_config|_ansi|_icon|_section_header)" scripts tests skill  # no broken imports
```

---

## Phase 2: Implement Session Renderer

**Goal:** Add `session_tui.py` with pure render functions for start and end session output.
**Dependencies:** Phase 1
**Estimated effort:** M

### Tasks

1. **Create `scripts/session_tui.py`**
   - Define all TypedDict inputs from the design: `CommitInfo`, `PRInfo`, `HealthCheck`, `AlertInfo`, `BoardItem`, `FileChange`, `NextUpItem`, `GitState`, `DiffSummary`, `_BannerRequired`, `BannerData`
   - Implement all render functions: `render_session_banner`, `render_git_state`, `render_prs`, `render_health`, `render_alerts`, `render_board`, `render_receipt`, `render_diff_summary`, `render_next_up`
   - Implement composition helpers: `render_start_briefing`, `render_end_summary`
   - Sanitize every externally-sourced field via `sanitize_text()` before formatting
   - Cap: uncommitted files at 10 ("+ N more"), recent commits at 5, PRs at 10
   - PR status indicators must include text labels: `✅ ready to merge`, `·· review requested`, `○ draft`, `🟣 merged`
   - Board status indicators must include text labels: `▶ In Flight`, `⏸ Blocked`, `? Clarify`
   - Alerts section: conditional (empty list → return ""). Board: same.
   - Health/PR empty states: render section with "No health checks configured." / "No open PRs."
   - `render_kv_line()` from core is used by `render_git_state()` for `Branch:`, `Last:` lines
   - Files: `scripts/session_tui.py` (new)
   - Done when: pure rendering, never shells out, never raises on empty data, matches design

2. **Add session renderer test suite**
   - Create `scripts/test_session_tui.py` with 18 tests from the design spec
   - Must cover: banner identity (session ID, start time, duration, name), empty alerts/board omission, next-up ordering, no-color/plain behavior, PR text labels, sanitization, capped lists, warning items, composition
   - Files: `scripts/test_session_tui.py` (new)
   - Done when: all 18 tests pass

### Risks
- ANSI/emoji leakage in plain mode: mitigated by explicit tests for plain/no-color across full composed output.
- Terminal injection: mitigated by requiring `sanitize_text()` at every external-text boundary.

### Verification
```bash
python3 -m pytest scripts/test_session_tui.py -x -q
```

---

## Phase 3: Integrate Start-Mode Session TUI

**Goal:** Replace the plain-text start briefing in `skill/stark-session/SKILL.md` with structured rendering.
**Dependencies:** Phases 0, 1, 2
**Estimated effort:** L

### Tasks

1. **Rewrite start briefing section in SKILL.md**
   - Replace plain briefing template with instructions that build TypedDict payloads and call `render_start_briefing()`
   - Canonical render pattern (insert this into the skill):
     ```python
     import sys; sys.path.insert(0, str(Path.home() / ".claude/code-review/scripts"))
     from tui_core import make_config
     from session_tui import render_start_briefing, BannerData, GitState, PRInfo, HealthCheck, AlertInfo, BoardItem, NextUpItem
     config = make_config()  # auto-detects TTY, NO_COLOR, TERM
     # ... build payloads from collected data ...
     print(render_start_briefing(config, banner=banner, git=git, prs=prs, health=health, alerts=alerts, board=board, next_up=next_up))
     ```
   - `json_mode=False` always for sessions (document this explicitly)
   - Files: `skill/stark-session/SKILL.md`
   - Done when: skill directs agent to render through session_tui instead of free-form text

2. **Make data collection failure-safe and time-bounded**
   - For each source (git, gh, health, alerts, board, persona, suggestions): document 30s timeout
   - Required sources: session state + git (if git unavailable, degrade to banner-only with warning)
   - On failure: pass empty list or `HealthCheck(name="...", passed=None, detail="unavailable: reason", duration=None)`
   - One source failure never aborts the briefing
   - Files: `skill/stark-session/SKILL.md`

3. **Add flag detection instructions**
   - "no color" / "no-color" from user → `make_config(no_color=True)`
   - "plain" / "plain mode" from user → `make_config(plain=True)` (different from no_color — also strips emoji and box-drawing)
   - NO_COLOR, TERM=dumb, non-TTY → auto-detected by make_config()
   - Files: `skill/stark-session/SKILL.md`

### Risks
- SKILL.md is prompt orchestration, not executable Python — vague instructions regress to ad-hoc text. Mitigated by inserting a single canonical render step with concrete module imports and field names.

### Verification
```bash
python3 -m pytest scripts/test_session_tui.py scripts/test_session_state.py scripts/test_tui_core.py -x -q
```
Manual checks (required):
- `/stark-session start` in normal TTY → banner contains session ID, git section shows branch, health section shows pass/fail
- `/stark-session start` with "plain" → zero emoji, `===` dividers, text indicators like `[OK]`, `[SKIP]`
- PR section includes text labels ("ready to merge", "review requested") not just symbols
- Empty alerts → no Alerts section header rendered
- A failing `gh` command → warning item in PR section, briefing continues

---

## Phase 4: Integrate End-Mode Session TUI

**Goal:** Replace the flat end checklist with the structured receipt and persist session name.
**Dependencies:** Phases 0–3
**Estimated effort:** L

### Tasks

1. **Rewrite end summary flow in SKILL.md**
   - After existing end-mode operations (tests, build, push, merge, docs, telemetry), build receipt payloads and call `render_end_summary()`
   - Receipt items must include: Tests, Build, Push, PRs, Issues, Docs, Telemetry — one row each
   - Keep persona fun-fact/cleanup after the rendered summary (20% chance)
   - Files: `skill/stark-session/SKILL.md`

2. **Add session naming and duration persistence**
   - Derive session name using priority order:
     1. PRs merged during session → `"pr-142-domain-triage"`
     2. Issues closed → `"issues-228-238-domain-triage"`
     3. Branch name → `"feat-domain-triage"`
     4. Most common commit prefix → `"triage-engine-and-tests"`
     5. Fallback → `"session-{session_id}"` (never None)
   - Name is a slug: lowercase, hyphens, max 50 chars
   - Persist: `session_state.name = chosen_name; session_state.save()`
   - Compute: `ended_at = datetime.now(timezone.utc).astimezone().isoformat()`, `duration = ended - started` using timezone-aware datetimes
   - Format duration as "Xh Ym" or "Ym Zs" for < 1 hour
   - Files: `skill/stark-session/SKILL.md`, `scripts/session_state.py` (if helper added)

3. **Keep operational reporting explicit**
   - Retain existing end-mode checks (tests/build, PR merges, docs, project fields, push, telemetry)
   - Map each result into receipt rows — no existing operational step silently dropped
   - "Telemetry: buffered locally" as a warning path when sync fails
   - Files: `skill/stark-session/SKILL.md`

### Risks
- Session naming inputs ambiguous if no PRs merged and issue closure inferred from commit text: mitigated by preferring concrete end-flow outcomes, then branch name, then fallback.
- Timezone math can drift if `started_at` parsing inconsistent: mitigated by Phase 0's tolerant ISO parsing.

### Verification
```bash
python3 -m pytest scripts/test_session_tui.py scripts/test_session_state.py -x -q
```
Manual checks (required):
- `/stark-session end` on a disposable branch with no PRs → banner shows `session-{id}` as name, duration in "Xm Ys" format
- `/stark-session end` after successful test/build/push → receipt shows ✅ for each
- Receipt includes all 7 items (Tests, Build, Push, PRs, Issues, Docs, Telemetry)
- Diff summary shows +lines/-lines and key files
- Next Up shows carry-forward items

---

## Phase 5: Final Regression and Release Gate

**Goal:** Prove the new session TUI is safe to ship and did not regress triage.
**Dependencies:** Phases 0–4
**Estimated effort:** S

### Tasks

1. **Run the full targeted regression suite**
   ```bash
   python3 -m pytest scripts/test_tui_core.py scripts/test_session_tui.py scripts/test_triage_tui.py scripts/test_session_state.py -x -q
   ```
   If any triage test fails, stop and fix before shipping.

2. **Run the environment-behavior matrix**
   ```bash
   NO_COLOR=1 python3 -m pytest scripts/test_tui_core.py scripts/test_session_tui.py scripts/test_triage_tui.py -x -q
   TERM=dumb python3 -m pytest scripts/test_tui_core.py scripts/test_session_tui.py scripts/test_triage_tui.py -x -q
   ```

3. **Search for compatibility fallout**
   ```bash
   rg "from triage_tui import|triage_tui\._" scripts skill tests --type py --type md
   ```
   Update any callers that reference moved private names.

4. **Run install.sh and verify symlinks**
   ```bash
   ./install.sh && ./install.sh --status
   ```
   Verify `tui_core.py`, `session_tui.py` symlinked correctly.

### Verification
- All targeted tests pass in one run
- NO_COLOR and TERM=dumb runs pass
- No broken imports found by grep
- install.sh symlinks all new scripts

---

## 4. Integration Points

- `tui_core.py` is the shared contract. If Phase 1 ships incomplete, both renderers diverge.
- `triage_tui.py` must re-export `TUIConfig` and `make_config` for backward compatibility.
- `session_tui.py` is pure rendering. SKILL.md must normalize raw command output into TypedDict payloads before calling it.
- `session_state.py` supplies `session_id`, `started_at`, `branch`, `repo`, and now `name`. Name must be persisted before end-mode render.
- Start and end flows both go through `make_config()` for consistent environment behavior.

## 5. Testing Strategy

1. **Unit tests first:** `test_tui_core.py` (17) + `test_session_tui.py` (18) = 35 tests covering pure rendering
2. **Persistence tests:** `test_session_state.py` backward compat
3. **Regression gate:** `test_triage_tui.py` existing 4 tests must pass unchanged
4. **Manual integration:** smoke `/stark-session start` and `end` in normal + plain modes
5. **Test order:** Phase 1 gate → Phase 2 tests → Phase 0 tests → manual start → manual end → combined suite

## 6. Rollback Plan

- **Phase 0:** Revert `session_state.py` name field — old JSON remains readable (additive-only change)
- **Phase 1:** Revert `tui_core.py` + `triage_tui.py` import migration → rerun `test_triage_tui.py`
- **Phase 2:** Revert `session_tui.py` + tests — session falls back to plain-text skill behavior
- **Phase 3:** Revert start-mode SKILL.md edits only — keep renderer code for later retry
- **Phase 4:** Revert end-mode SKILL.md changes + naming helper — sessions with `name` remain harmless (optional field)
- **Phase 5:** If regression fails after merge prep, revert phase-specific commits in reverse until all tests green
