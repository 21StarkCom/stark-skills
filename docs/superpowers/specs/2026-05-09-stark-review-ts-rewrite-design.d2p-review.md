# Design-to-Plan Cross-Review

**Spec:** [`2026-05-09-stark-review-ts-rewrite-design.md`](2026-05-09-stark-review-ts-rewrite-design.md)
**Plan:**  [`2026-05-09-stark-review-ts-rewrite-plan.md`](2026-05-09-stark-review-ts-rewrite-plan.md)
**Date:** 2026-05-09
**Agents:** claude + codex (gemini failed — trust-dir error)
**Reviews completed:** 2/4 (gemini's two reviews failed)

## Scorecard

| Plan author | Completeness | Feasibility | Phasing | Risk Coverage | Testability | Avg | |
|-------------|--------------|-------------|---------|---------------|-------------|-----|--|
| codex       | 8            | 8           | 9       | 7             | 8           | **8.0** | ★ Winner |
| claude      | 6            | 5           | 6       | 6             | 6           | 5.8     |          |

**Margin:** 2.2 points — decisive, no tie.

## Per-plan reviews

### codex's plan — reviewed by claude

**Strengths:**
- Phasing cleanly mirrors the spec's V1/V1.1 split with explicit
  stub-then-implement sequence for Claude/Gemini ports (Phase 3 → Phase 8).
  Dependency graph is accurate.
- Phase 4 task 8 correctly captures the spec's `--input -` requirement and
  inline-vs-body demotion for unchanged files / cross-cutting findings.
- Phase 9 task 1 codifies the fix-loop authorization gate as a pure function
  with all six inputs from the spec's Trust section, making the
  soft-skip vs terminal-deny distinction testable.

**Weaknesses (5 — all incorporated into the synthesis):**

1. Phase 4 task 9 (idempotency lock) didn't explicitly state lock ordering.
   **Synthesis fix:** added explicit `acquire → GET → check → POST → release`
   sub-steps to Phase 4 task 9.
2. Phase 4 task 8 omitted the requirement that file-anchored findings whose
   `file` is not in the PR's changed-file set must be DEMOTED to top-level
   body items (not dropped). **Synthesis fix:** rewrote Phase 4 task 8 with
   explicit "demote to body, do not drop" routing rule.
3. The `run` hash composition was underspecified ("config snapshot" was
   ambiguous). **Synthesis fix:** Phase 4 task 9 now enumerates exactly
   `{domains, agents_resolved, severity_overrides, fix_threshold}`.
4. Phase 1 verification only checked JSON parses + `config_loader.py` ran;
   didn't verify Python's deep-merge accepts new fields end-to-end without
   warning. **Synthesis fix:** verification now exercises `multi_review.py`
   and asserts every new field is present in the merged config.
5. Phase 9 task 5 fork-push didn't specify how to construct the authed
   clone URL or that it must never be logged. **Synthesis fix:** added
   explicit `https://x-access-token:${GH_TOKEN}@github.com/<full_name>.git`
   construction with mandatory token redaction in logs and a Phase 9
   verification test asserting the authed URL never appears in stderr or
   audit log.

### claude's plan — reviewed by codex

**Strengths:**
- V1/V1.1 split matches design intent.
- Strong unit + mocked-stage testing coverage for config, dispatch, parsing,
  posting, locks, and fix-loop authorization.
- REST posting correctly includes stdin JSON payloads, pagination intent,
  retry intent, idempotency marker, per-PR locking.

**Weaknesses (5 — all reasons not to use as base):**

1. Phase 3 task 3 omitted PR context block from spec Pipeline step 3 —
   `gh pr view title/body` + `gh pr diff` must be appended to every
   rendered domain prompt. (Codex's plan handles this in Phase 2 task 7.)
2. Phase 1 task 3 introduced `loadAndMergeConfig(configRoot, repoRoot)` but
   the CLI only passes `--config-root` and `--worktree`, leaving repo root
   undefined and risking accidentally reading PR-head `.code-review`.
   (Codex's plan resolves this with explicit `git -C $configRoot rev-parse
   --show-toplevel` derivation.)
3. Added extra production modules (`tools/stark_review_types.ts`,
   `tools/stark_review_post.ts`, `tools/stark_review_fix.ts`) plus possible
   Zod, contradicting the approved 6-file architecture. (Codex's plan stays
   within the approved file count.)
4. Verification commands assumed infrastructure not established in the plan:
   bare `tsc --noEmit`, `npm test`, line coverage thresholds, Zod validation —
   none of these are added as repo dependencies. (Codex's plan uses the
   existing `node --test --experimental-strip-types` pattern.)
5. Phase 4 idempotency conflicted with Phase 3 history numbering: a second
   identical invocation becomes round 2 and misses round 1's marker,
   contradicting the requirement that a duplicate live run posts zero
   reviews. (Codex's plan separates rerun identity from history round via
   the run hash.)

## Synthesis decisions

| Element | Source | Reason |
|---------|--------|--------|
| 9-phase structure | codex | Cleaner V1/V1.1 split, accurate dependency graph |
| File layout (6 new files) | codex | Matches approved design; no extra modules |
| Config schema additions | codex | Concrete defaults table |
| Library helpers (Phase 2) | codex | Pure functions with explicit signatures |
| Agent ports (Phase 3) | codex | Clean stub-then-implement sequence |
| CLI surface | codex | All required + optional flags from spec |
| GitHub REST endpoints | codex | Explicit `gh api --paginate` calls |
| Failure tier model | codex | Encodes spec's 3-tier semantics |
| Classifier failure handling | codex | Fail-safe default + 5-error abort |
| Inline-vs-body routing | **claude critique → patched into codex** | Codex omitted demotion rule |
| Lock ordering | **claude critique → patched into codex** | Made explicit in plan |
| Run hash field list | **claude critique → patched into codex** | Enumerated explicitly |
| Phase 1 verification (multi_review.py) | **claude critique → patched into codex** | Exercise the real consumer |
| Fork-remote authed URL | **claude critique → patched into codex** | Mandatory token redaction |
| Test command trust | codex | "Never read from CLAUDE.md or package.json" |
| Path validation (realpath ancestors) | codex+ | Hardened beyond either plan |
| Rollback table | codex | Per-phase, executable |
| Verification commands | codex | Realistic node:test usage |

## Net result

Codex's plan as base, with 5 surgical patches from claude's review fixing
specific gaps. No structural changes; ~20 LOC of additions across Phase 1,
Phase 4, and Phase 9. Approved file count and dependency-free toolchain
preserved.

## Synthesis quality check

- ✅ Every section of the design has corresponding plan tasks
- ✅ No phase depends on a later phase (Phase 9 lists Phase 7 as required, Phase 8 as helpful)
- ✅ Verification criteria exist for every phase
- ✅ Rollback procedure exists for every phase
- ✅ No orphaned tasks
