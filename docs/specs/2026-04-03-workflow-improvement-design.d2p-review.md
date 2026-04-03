# Design-to-Plan Cross-Review — Workflow Improvement

**Date:** 2026-04-03
**Design:** `docs/specs/2026-04-03-workflow-improvement-design.md`
**Plans generated:** 3 (claude, codex, gemini)
**Reviews completed:** 6/6

---

## Cross-Review Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         8.0       7.0      7.5     8.0    7.5      7.6 ★
  claude        7.0       6.5      7.5     7.0    8.0      7.2
  gemini        6.0       5.5      6.0     5.0    6.0      5.7
```

**Winner:** codex (7.6/10)
**Runner-up:** claude (7.2/10)

---

## Per-Plan Strengths

### Codex (winner)
- Proactively identifies design gaps before coding: event schema v1/v2 migration, session ID sourcing, lock TTL config key
- Concrete verification bash scripts for every phase using realistic project tooling
- Comprehensive rollback strategies using feature flags and backward-compatible schemas
- Strong integration points section documenting 6 cross-module contracts and partial-ship failure modes
- Rollback is phase-specific and actionable — names exact config flags or modules to disable

### Claude (runner-up)
- Acceptance criteria are exceptionally concrete: executable bash/python one-liners per task
- Excellent config deprecation strategy distributed across phases (add P0, warn P1, remove P2)
- Nuanced rollback plans distinguishing git reverts, state directory deletions, and config flag toggles
- Good test-first ordering (runtime_env → classifier fixtures → healer guards)
- Measurable acceptance criteria make most individual tasks executable and reviewable

### Gemini
- Parallel phase structure (2||3 and 5||6) correctly mirrors dependency graph
- Lock mechanism correctly placed after classification exists
- Anti-spam enforcement (2 suggestions cap, 7-day cooldown) explicitly carried through
- Gemini disposition resolved correctly: unified config with `enabled: false`

---

## Per-Plan Weaknesses

### Codex
- **Missing TypeScript healer patterns** for `design-system-core` specified in design §5 (gemini review)
- **Strictly linear phases** miss obvious parallelization within phases (gemini review)
- **Phase 3 verification has broken commands**: `python3 scripts/register_triggers.sh` is a shell script; `curl http://localhost:7420/events` references a non-existent REST service (claude review)
- **Backfill ordering wrong**: Phase 2 Task 4 (backfill) runs after skill router (Task 3), but router needs historical data. Backfill must come first (claude review)
- **Missing approach contract wiring** for CCR automation triggers running non-interactively (claude review)
- **Missing stark-persona trigger** in skill router implementation scope (claude review)
- **Phase 2 Task 3 done-when** has no verification command (claude review)

### Claude
- **Missing exclusive write locks** for `stark-autopilot` specified in design §4 (gemini review)
- **Task 1.5 wires validation into SKILL.md** but code generation happens inside Python dispatchers — should wire there (gemini review)
- **Approach contract not wired** to all required skill entry points from `runtime.approach_contract_skills` (codex review)
- **Missing skill activation surfaces** beyond `session_start` and `housekeeping`: post-merge, post-SKILL.md-edit, autopilot contradiction, learning-driven triggers (codex review)
- **Task 3.8 treats `automation/triggers/*.md` as archiveable logs** but they're active trigger definitions (codex review)
- **Telemetry migration underspecified**: adding new fields won't work without migrating validator rules, accepted event enums, and `drain_to_buffer` field mapping (codex review)
- **Category-to-pattern mapping** not defined between classifier and healer (codex review)

### Gemini
- **Config migration phasing absent**: never implements deprecation warnings or old key removal (claude review)
- **Learning capture signal sources truncated**: only 2 of 6 signal types from design §8 (claude review)
- **Lock type conflicts with design**: uses SQLite locks vs. JSON lease files specified in design §4 (claude review)
- **Phase 2 verification is destructive**: "remove GitHub token from Keychain" breaks live credentials (codex review)
- **Missing event_schema.json unification** with emit_queue.py (claude review)
- **Missing backfill** from existing history files (claude review)
- **7 phases vs design's 4** — introduces artificial dependencies (codex review)
- **Incorrect file paths**: references `scripts/automation_render_reports.py` instead of actual `scripts/automation/render_reports.py` (codex review)
- **Missing critical test scenarios** from design §11 (claude review)
- **Install.sh bootstraps wrong queue.db schema**: simplified `events` table vs real `pending`/`dead_letter`/`inflight` tables (codex review)

---

## Synthesis Decisions

Elements merged from non-winner plans into the codex base:

| Section | Source | Reason |
|---|---|---|
| Per-task acceptance criteria format | Claude | Both reviewers praised Claude's executable one-liner acceptance criteria |
| Config deprecation strategy (add/warn/remove) | Claude | Codex plan had no deprecation path; Claude's 3-phase approach is cleaner |
| Test-first ordering priorities | Claude | Codex had no test sequencing guidance |
| Granular rollback specifics (config vs code vs data) | Claude | Claude distinguished 3 rollback dimensions per phase |
| Backfill ordering (before skill router) | Claude review feedback | Codex had wrong ordering; Claude reviewer caught it |
| Complete skill activation trigger list (all 12) | Claude | Codex only had 3 trigger surfaces; Claude's design §8 coverage was complete |
| Parallelization opportunities | Gemini | Gemini's parallel phase structure for independent work |
| TypeScript healer patterns in P2 | Gemini/Claude | Both mentioned; codex plan omitted entirely |

Cross-review weaknesses addressed in synthesis:
- Fixed Phase 3 verification commands (codex weakness from claude review)
- Fixed backfill task ordering to precede skill router (codex weakness from claude review)
- Added approach contract wiring for all `approach_contract_skills` entry points (both codex + claude weakness)
- Added exclusive write locks with JSON lease files matching design §4 (claude weakness from gemini review)
- Wired validation gate into Python dispatchers, not just SKILL.md (claude weakness from gemini review)
- Added all 6 learning capture signal sources from design §8 (gemini weakness from claude review)
- Added category-to-pattern mapping contract between classifier and healer (claude weakness from codex review)
- Fixed install.sh to use real queue.db schemas (gemini weakness from codex review)
- Added critical test scenarios from design §11 (gemini weakness from claude review)
- Added stark-persona trigger to skill router (codex weakness from claude review)
- Archive run artifacts only, not active trigger definitions (claude weakness from codex review)
