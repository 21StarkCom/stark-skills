---
title: stark-forged-review — Implementation Plan
status: draft
design: docs/specs/2026-04-12-stark-forged-review-design.md
plan_slug: 2026-04-12-stark-forged-review
target_repo: GetEvinced/stark-skills
---

# stark-forged-review — Implementation Plan

This plan decomposes the [design spec](./2026-04-12-stark-forged-review-design.md) into
atomic build phases suitable for autopilot tournament execution.

Each phase builds on previous winners. The design spec is the source of truth for all
specifics (state schema, config keys, prompt schemas, failure modes, acceptance criteria).
Read it before implementing each phase.

**Branch:** `feat/stark-forged-review`
**Target:** `GetEvinced/stark-skills` main

## Shared Context (read before every phase)

- Design spec: `docs/specs/2026-04-12-stark-forged-review-design.md` — full architecture
- Repo layout: `CLAUDE.md` — scripts live in `scripts/`, prompts in `global/prompts/`, skills in `skill/stark-*/`
- Python: `~/.claude/code-review/scripts/.venv/bin/python3` (system Python lacks deps)
- Test command: `pytest scripts/tests/` (for script changes)
- Existing patterns to mirror: `scripts/forge_audit.py`, `scripts/forged_review.py` does NOT exist yet, `scripts/multi_review.py`, `scripts/triage_orchestrator.py`, `scripts/config_loader.py`

## Phase 1: Audit infrastructure

**What.** Extract shared audit primitives from `scripts/forge_audit.py` into a new
`scripts/audit_base.py`, refactor `forge_audit.py` to use the base, and create a new
`scripts/forged_review_audit.py` that also uses the base but with the forged-review-specific
schema (per-run, per-round, per-domain-call, per-finding-verdict tables).

**Files to create/modify.**
- Create `scripts/audit_base.py` — `init_db(path, schema)`, `record_call(...)`, `record_run(...)`, common SQLite helpers
- Modify `scripts/forge_audit.py` — refactor to import from `audit_base`; preserve public API and DB schema exactly (no migration needed; existing forge metrics DB must continue to work)
- Create `scripts/forged_review_audit.py` — tables: `runs`, `rounds`, `domain_calls`, `finding_verdicts`. DB path: `~/.claude/code-review/history/forged-review/forged_review_metrics.db`
- Create tests `scripts/tests/test_audit_base.py` and `scripts/tests/test_forged_review_audit.py`

**Acceptance.**
- Existing `forge_audit` tests (if any) still pass; manual import smoke test: `python3 -c "import forge_audit; import audit_base; import forged_review_audit"`
- New unit tests cover init, record_call, record_run, per-finding-verdict write+read
- No behavioral change to existing forge audit DB schema (read an existing DB file and confirm same columns)

## Phase 2: Prompts — triage, leader/second, forge-design

**What.** Create all 22 prompt files under `global/prompts/forged-review/` per the design
spec's Section 6 tree. Thin prompts: triage ~30 lines, leader ~40 lines, second ~30 lines,
forge-design ~50 lines. All with fixed JSON output contracts.

**Files to create.** (see design spec §6 for the full tree)
- `global/prompts/forged-review/triage/triage.md`
- `global/prompts/forged-review/claude/` — 6 files (3 leader + 3 second)
- `global/prompts/forged-review/codex/` — 6 files (3 leader + 3 second)
- `global/prompts/forged-review/gemini/` — 6 files (3 leader + 3 second)
- `global/prompts/forged-review/forge-design/claude.md`, `codex.md`, `gemini.md`

**Domain ownership (exact):** per design spec §5 `domain_pairs` config.
- claude: architecture-leader, correctness-second, accessibility-leader, spec-conformance-leader, ui-design-conformance-second, regression-prevention-second
- codex: architecture-second, correctness-leader, type-safety-leader, security-second, test-coverage-leader, spec-conformance-second
- gemini: type-safety-second, security-leader, test-coverage-second, accessibility-second, ui-design-conformance-leader, regression-prevention-leader

**JSON contracts.**
- Triage output: `{selected_domains: [...], rationale: {domain: one_line_why}}`
- Leader output: `[{id, severity, file, line, title, detail, suggestion}]`
- Second output: `{decisions: [{id, verdict: "confirmed|disputed|leader_only", reason}], second_only: [{severity, file, line, title, detail, suggestion}]}`

**Acceptance.**
- All 22 files exist and are non-empty
- Each prompt has a fenced JSON schema block
- A new utility `scripts/tests/test_forged_review_prompts.py` loads each prompt and validates line count + schema presence

## Phase 3: Pure engine (forged_review_engine.py)

**What.** All pure-logic primitives for forged-review as functions with no I/O. Unit-testable.

**Files to create.**
- `scripts/forged_review_engine.py`
- `scripts/tests/test_forged_review_engine.py`

**Functions (signatures).**
```python
def merge_findings(
    leader_json: list[dict],
    second_json: dict,
) -> dict:
    """Return {'confirmed': [...], 'disputed': [...], 'leader_only': [...], 'second_only': [...]}.
    Confirmed = leader finding with verdict=confirmed.
    Disputed = leader finding with verdict=disputed.
    Leader_only = leader finding with verdict=leader_only.
    Second_only = items from second.second_only."""

def compute_gate(
    actionable_findings: list[dict],
    forge_threshold: int,
    force_escalate: bool,
    no_escalate: bool,
) -> dict:
    """Return {'path': 'light'|'forge', 'reason': str, 'actionable_count': int, 'critical_count': int}.
    Raises ValueError if both force_escalate and no_escalate are true."""

def scope_delta_rereview(
    prior_round: dict,
    fix_commits: list[str],
    repo_root: Path,
) -> dict:
    """Return {'domains': [...], 'files': [...]}.
    Domains = any that had actionable findings last round.
    Files = git diff --name-only fix_commits[0]^..fix_commits[-1]."""

def select_domains_from_triage(
    triage_output: dict,
    always_on: list[str],
    all_domains: list[str],
) -> list[str]:
    """Return ordered list of selected domains, always including always_on,
    preserving config order. Raises ValueError if triage_output is malformed."""
```

**Acceptance.**
- All functions have unit tests covering happy path + 2 edge cases each
- No imports of subprocess, requests, sqlite3, or file I/O beyond `pathlib.Path` for scope_delta_rereview
- Running `pytest scripts/tests/test_forged_review_engine.py` exits 0

## Phase 4: Review dispatcher (leader-second topology)

**What.** Extend `scripts/multi_review.py` with a new `leader-second` topology mode that
runs leader then second-opinion per domain and merges results via `forged_review_engine.merge_findings`.

**Files to modify.**
- `scripts/multi_review.py` — add `--topology {single|team|leader-second}` argument (preserve existing `--single` as alias for `--topology single` for backward compatibility)
- In `leader-second` mode, for each selected domain:
  1. Dispatch leader agent with `forged-review/{leader}/{NN-domain}-leader.md`
  2. Parse leader JSON
  3. Dispatch second agent with `forged-review/{second}/{NN-domain}-second.md` — prompt receives diff + leader JSON
  4. Parse second JSON
  5. Call `forged_review_engine.merge_findings(leader, second)`
  6. Emit merged result with domain + leader agent + second agent recorded

**Files to create.**
- `scripts/tests/test_multi_review_leader_second.py` — fixture-based test with mock agent outputs

**Acceptance.**
- Existing `multi_review` single/team modes still work (smoke test)
- New mode runs on a fixture diff and produces confirmed+second_only findings
- `--topology` argument added to `--help` output

## Phase 5: Orchestrator (forged_review.py)

**What.** The top-level Python orchestrator invoked by the skill's single bash line.
This is the main entry point. Thin — delegates to engine, audit, dispatchers.

**Files to create.**
- `scripts/forged_review.py` — main orchestrator
- `scripts/tests/test_forged_review_orchestrator.py` — integration test with mocked subprocess calls

**Responsibilities.**
1. Parse args (PR number, --dry-run, --repo, --resume, --no-escalate, --force-escalate)
2. Preflight check (reuse `preflight.py --workflow stark-forged-review`)
3. Detect PR, branch, base, repo via `gh pr view`
4. Create worktree at `.worktrees/forged-review-pr<num>-<ts>` (fail fast on error, exit 2)
5. Initialize `.forged-review-state.json` (or load on --resume)
6. Phase 1: Triage — dispatch Claude on diff, parse selected_domains
7. Phase 2: Leader/second review — call `multi_review.py --topology leader-second` with selected domains
8. Phase 3: Gate — call `compute_gate`; log decision; emit event
9. Phase 4: Light or forge path (delegate to existing `design_to_plan_dispatch.py`, `plan_review_dispatch.py` for forge path); apply fixes
10. Phase 5: Delta re-review loop — call `scope_delta_rereview` then re-dispatch
11. Phase 6: Merge gate output — print JSON `{status, needs_merge_confirmation, pr_number, summary}` for SKILL.md to consume (the skill handles the interactive Y/n + `gh pr merge` call; orchestrator does NOT call `gh pr merge` itself)
12. Phase 7: Cleanup — save history, record audit run, emit completion, remove worktree

**Acceptance.**
- `--dry-run` on a fixture PR produces a valid `.forged-review-state.json` and exits 0
- Integration test (with mocked subprocess) exercises happy path for both light and forge paths
- Exit codes match 0/1/2/3 contract from design spec §9

## Phase 6: Config + triage integration

**What.** Add `forged_review` section to `global/config.json`, typed accessor in
`config_loader.py`, and a `--mode forged-review` routing branch in `triage_orchestrator.py`.

**Files to modify.**
- `global/config.json` — add `forged_review` section per design spec §5
- `scripts/config_loader.py` — add `get_forged_review_config()` returning a typed dataclass
- `scripts/triage_orchestrator.py` — add `--mode forged-review` that dispatches the triage prompt from `global/prompts/forged-review/triage/triage.md`

**Files to create.**
- `scripts/tests/test_forged_review_config.py`

**Acceptance.**
- `python3 -c "from config_loader import get_forged_review_config; print(get_forged_review_config().forge_threshold)"` prints `4`
- Repo-level config override tested
- `triage_orchestrator.py --mode forged-review --help` runs

## Phase 7: Skill surface (SKILL.md, README.md, preflight)

**What.** Create the skill directory with a lean SKILL.md (≤80 lines) and a detailed README.md.
Add preflight workflow mapping for `stark-forged-review`.

**Files to create.**
- `skill/stark-forged-review/SKILL.md` — frontmatter + preflight + arguments + run + merge confirmation + failure reporting (~60–80 lines total)
- `skill/stark-forged-review/README.md` — full architecture reference extracted from design spec (phases, state file, config, failure modes, observability)

**Files to modify.**
- `scripts/preflight.py` — add `stark-forged-review` workflow mapping (same checks as stark-review + stark-forge union)

**Acceptance.**
- `wc -l skill/stark-forged-review/SKILL.md` returns ≤80
- `python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json` runs and returns valid JSON
- SKILL.md frontmatter includes `name`, `description`, `argument-hint`, `disable-model-invocation: true`, `model: opus[1m]`

## Phase 8: Rollout artifacts (install.sh, CLAUDE.md, deprecation notice)

**What.** Wire the new skill into the install flow and update docs.

**Files to modify.**
- `install.sh` — add symlinks for `skill/stark-forged-review` → `~/.claude/skills/stark-forged-review` and for the new `global/prompts/forged-review/` directory
- `CLAUDE.md` (root `/Users/aryeh/git/Evinced/CLAUDE.md`) — add `/stark-forged-review` row to the Global Skills table; mark `/stark-review` as deprecated
- `stark-skills/CLAUDE.md` — add `/stark-forged-review` row to skills sections; mark `/stark-review` as deprecated
- `skill/stark-review/SKILL.md` — add a deprecation notice at the top pointing to `/stark-forged-review` (do NOT delete the skill; keep functional per rollout plan §11)

**Acceptance.**
- `./install.sh --status` shows `stark-forged-review` installed
- Both CLAUDE.md files render with the new row and deprecation notice
- `/stark-review` still functional (skill file present, just marked deprecated)

## Phase 9: Smoke test + PR

**What.** End-to-end smoke test and PR creation.

**Steps.**
1. Run `./install.sh --status` and confirm success
2. Run `python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json` and confirm `overall != blocked`
3. Run `python3 -c "from forged_review import main; print(main.__doc__)"` to confirm import chain works
4. Run `pytest scripts/tests/test_forged_review_engine.py scripts/tests/test_audit_base.py scripts/tests/test_forged_review_audit.py scripts/tests/test_forged_review_prompts.py`
5. Push feature branch: `git push -u origin feat/stark-forged-review`
6. Create PR: `unset GH_TOKEN && gh pr create --title "feat: stark-forged-review skill" --body "$(cat docs/specs/2026-04-12-stark-forged-review-design.md | head -60)"`
7. Wait for CI; fix any failures
8. Merge: `unset GH_TOKEN && gh pr merge --squash --delete-branch`

**Acceptance.**
- All smoke tests pass
- PR opened, CI green, merged to main
- Post-merge: `~/.claude/skills/stark-forged-review/SKILL.md` exists and `/stark-forged-review` is a valid slash command
