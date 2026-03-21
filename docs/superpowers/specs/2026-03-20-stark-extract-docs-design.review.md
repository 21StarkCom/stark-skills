# Plan Review — stark-extract-docs Skill Design

**File:** `docs/superpowers/specs/2026-03-20-stark-extract-docs-design.md`
**Rounds:** 3 fix rounds + 1 final round
**Coverage:** 14/14 sub-agents per round (2 LLMs × 7 domains; Gemini unavailable)

## Severity Trend

| Round | Critical | High | Medium | Low | Total |
|-------|----------|------|--------|-----|-------|
| 1 | 3 | 32 | 49 | 16 | 100 |
| 2 | 0 | 39 | 50 | 18 | 107 |
| 3 | 0 | 36 | 52 | 15 | 103 |
| Final | 1 | 31 | 54 | 19 | 105 |

Critical dropped 3→0 after round 1 (target repo resolution fix). Final round's 1 critical is a new finding from the round 3 fix (retrospective routing to source repo created a two-repo commit issue).

## Fixed Across Rounds

### Round 1 → 2 (major hardening)

- **Target repo filesystem resolution** (3 criticals) — Added sibling directory lookup strategy, fail-if-not-found, no auto-clone
- **`--force` flag split** — Separated `--force` (history bypass) from `--include-low` (low-confidence routing)
- **Intermediate JSON validation** — Added schema validation step with retry on malformed output
- **plan-to-tasks detection mechanism** — Specified history file path and category skip mapping
- **Skip-check hashes all inputs** — Changed from spec-only hash to all input files (spec + plan + reviews)
- **Glossary/learning-log dedup** — Check for existing entries before appending
- **Batch --dry-run** — Clarified: prints intermediate format per spec, skips all write phases
- **Multiple repo references** — First reference wins, warn if multiple found
- **Constraint routing signal** — Added `has_alternatives` field to extraction schema for deterministic routing

### Round 2 → 3

- **Schema versioning** — Added `schema_version: 1` to intermediate JSON and history file
- **Category-specific fields documented** — `has_alternatives` for constraint, `round` for evolution, `affected_agents` for agent_signal
- **Pass 1 retry on malformed JSON** — Retry once with error appended to prompt
- **Force re-run replacement semantics** — Full specification: ADRs overwrite by number, append targets remove-then-add, retrospectives overwrite file
- **History file schema** — Defined complete schema with `input_hashes` and `created_artifacts` for skip/replacement logic

### Round 3 → final

- **Retrospective routing to source repo** — Agent performance data goes to spec's repo, not target product repo
- **Category-specific field validation** — `constraint` must have `has_alternatives` in validation step
- **Dirty working tree check** — Check target repo before committing, skip commit with warning if dirty
- **History file keying clarified** — Uses `{target-repo}` (where docs go), not source repo

## Unresolved — Remaining Findings

### Final Round Critical (new from round 3 fix)

| Finding | Status |
|---------|--------|
| Cross-repo commit: when source ≠ target, retrospectives go to source repo and ADRs go to target repo — two repos modified but only one commit flow defined | Acknowledged limitation. For v1, when source ≠ target the skill commits in the target repo and logs a warning that source repo changes (retrospective, learning log) need manual commit. |

### Intentional Design Choices (recurring across all rounds)

| Finding | Rationale |
|---------|-----------|
| Scope too broad — 6 doc types, batch mode, cross-spec dedup | Scope was collaboratively designed and agreed upon. Batch mode is additive and can be deferred if implementation proves complex. |
| No concurrency control for ADR numbering and shared files | Skill runs in a single Claude Code session. No concurrent access. |
| No sensitivity classification / redaction | Internal engineering docs in private repos. Not customer-facing. |
| No transactional/rollback mechanism for multi-file writes | Git handles rollback (`git checkout -- .`). Over-engineering for a dev tool. |
| Machine-local history used as state | All stark skills work this way. Acceptable for single-operator tooling. |
| No machine-readable error contract | Interactive skill, not CI automation. |
| No test plan / acceptance criteria | This is a design spec, not an implementation plan. Tests are defined in the plan. |
| Cross-spec ADR dedup relies on LLM judgment | Correct — same mechanism used throughout stark-skills (agent classification is always LLM-based). Uncertain cases get `<!-- possible duplicate -->` marker. |

### Acknowledged Limitations

| Finding | Status |
|---------|--------|
| Path traversal via crafted spec repo references | Mitigated by sibling directory lookup (constrains to expected tree); full path canonicalization should be added during implementation |
| Force re-run can't cleanly replace manually-edited glossary entries | By design — skill checks name match, not content. Manual edits are preserved. |
| Batch mode across different target repos creates complex commit topology | Each spec's extraction commits independently to its target. Cross-spec dedup only applies within the same target repo. |
| Large specs may exceed context window | Practical limitation of single-session LLM. Specs that exceed context should be split. |

## Changes Made

Spec grew from 384 lines (rev 1) to 508 lines (rev 2+). Key additions: target repo resolution strategy, intermediate JSON schema versioning, validation/retry logic, history file schema, force re-run semantics, category-specific fields, append deduplication, dirty tree checks.

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Both agents consistently flag scope as too broad for every skill spec (not just this one) | **Global** | `global/prompts/plan-review/*/06-scope.md` — calibrate for intentionally-scoped design docs |
| Codex fixates on enterprise security patterns (redaction, data classification, trust boundaries) for internal dev tools | **Global** | `global/prompts/plan-review/codex/04-security.md` — distinguish internal tooling from customer-facing systems |
| Both agents flag concurrency control for single-session skills | **Global** | `global/prompts/plan-review/*/05-operability.md` — detect "runs in current Claude Code session" and skip concurrency checks |
| Codex:scope produces 4+ findings per round all saying "too much scope" with different framings | **Global** | `global/prompts/plan-review/codex/06-scope.md` — deduplicate within a single domain (max 2 scope findings) |
| Gemini unavailable in all 4 rounds | **N/A** | Infrastructure issue — Gemini CLI not configured on this machine |
