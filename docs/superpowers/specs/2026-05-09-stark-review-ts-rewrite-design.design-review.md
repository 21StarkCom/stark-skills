# Design Review: TS rewrite of `/stark-review`

**Spec:** [`2026-05-09-stark-review-ts-rewrite-design.md`](2026-05-09-stark-review-ts-rewrite-design.md)
**Date:** 2026-05-09
**Mode:** standard, 3 fix rounds
**Agents:** claude + codex (gemini excluded by config)

## Headline

| Round | Findings | 🔴 Critical | 🟡 High | 🟠 Medium | ⚪ Low | Sub-agents |
|-------|----------|-------------|---------|-----------|---------|------------|
| 1 | 47 | 3 | 13 | 29 | 2 | 16/16 ✅ |
| 2 | 76 | 0 | 24 | 41 | 11 | 14/14 ✅ |
| 3 (review-only) | 52 | 0 | 14 | 30 | 8 | 16/16 ✅ |

**Trajectory:** Critical findings eliminated after round 1. High-severity
issues bumped in round 2 because the spec roughly doubled in size (300 → 600
lines) — bigger surface, more nits — then trended back down in round 3. The
design is converging; round-3 highs are predominantly contract-level pedantry
or items already deferred to the implementation plan, not design gaps.

## What changed across rounds

### Round 1 fixes (16 high-impact items)

**Critical security (3):**
- Trust model added: PR-controllable inputs (`.code-review/`, `CLAUDE.md`,
  `package.json`) are never sourced from the worktree for config or test
  command resolution. `--config-root` flag introduced for the trusted root.
- Fix-loop authorization gate defined (test_command + fork detection +
  explicit opt-in).
- Prompt-injection containment: PR diff/body excluded from the fix-loop
  prompt.

**High API/contract (5):**
- Failure receipt schema added (success vs failure shapes, error codes).
- Idempotency markers for review POSTs.
- REST pagination + retry/backoff for rate limits.
- `Finding.id` for stable cross-round identity.
- Cross-cutting findings (`file: null`) accepted and routed to body.

**High completeness/consistency (8):**
- Audit log path defined.
- Classifier failure → fail-safe (default to "fix"), not fail-closed.
- Default agent / `domain_agents` precedence rules disambiguated.
- File-layout count made consistent (6 new files).
- `quick_domains` default (empty) consistent across spec.
- Classifier prompt acknowledged as the only new prompt file.
- Test-plan covers REST regressions, fork-PR negative cases.

### Round 2 fixes (10 items)

- `--config-root` and `--allow-untrusted-fix-loop` added to the CLI surface.
- REST-only constraint clarified to permit `gh pr view`/`gh pr diff`
  (REST under the hood; rule is wire-protocol, not subcommand-shape).
- Parse-failure semantics rewritten as a 3-tier model resolving the
  fail-closed vs fail-safe contradiction.
- Fix loop reads `config.fix_threshold` instead of hardcoding "critical or
  high".
- Fork PR push targets the fork's `clone_url` via a transient remote, not
  `origin`.
- Non-fast-forward push: abort, do not force.
- Idempotency upgraded to flock + per-run hash to defeat the GET→POST race.
- V1.1 phasing: fix loop and `agent_claude` / `agent_gemini` deferred to
  V1.1; V1 ships dispatch + classify + post + history with codex only.
- Documented opt-out for users who relied on `--agent claude/gemini`.
- `Finding.id` derivation switched to `(domain, agent, normalized-title)` so
  rename + line-shift don't break the recurring-match logic.

### Round 3 fixes (3 items)

- Auth-denial behavior: soft skip vs terminal error depending on whether the
  user explicitly opted in.
- Per-domain agent resolution annotated with V1 stub-fail-fast behavior.
- Open-questions section split into "Deferred to implementation plan"
  (concrete items the plan owns) vs "Open" (none blocking).

## Remaining items, deliberately deferred

The following round-3 highs are recorded but were judged implementation-plan
detail rather than design gaps. The plan is responsible for resolving each:

| Item | Where it lands |
|------|----------------|
| Reviewer-prompt schema contract (explicit JSON snippet prepended at render time) | Plan §"Prompt rendering" |
| Fixer agent output contract (V1.1) | Plan §"Fix loop" (V1.1 milestone) |
| Subprocess sandbox depth (process-level vs unshare/firejail/docker) | Plan §"Subprocess isolation" |
| History writer Python-schema parity (fixture-based test) | Plan §"Tests > history schema" |
| GitHub Reviews API anchor edge cases (multi-line, deletions, position vs line) | Plan §"REST: post review" |
| Classifier abort threshold (5 errors — calibrated by domain count) | Plan §"Classify" |
| `history_retention_days` pruning ownership across skills | Plan §"History" |
| Symlink-resolution semantics (TOCTOU window) | Plan §"Path validation" |
| Dispatch contract assertions in tests | Plan §"Tests" |

These were marked `ignored` rather than `fix` because the spec already names
the constraint; the plan picks the implementation. Pulling them into the
spec would push it past the "what + why" boundary into "how".

## Cross-round noise / non-issues

A handful of round-2 and round-3 mediums duplicated each other across agents
or disagreed with each other. Examples:

- **"Total: 6 new files" miscount** — appeared in round 2 and reappeared in
  round 3 because the count is a sentence, not a list. Spec lists 6 files
  but the inline phrasing varied; not load-bearing.
- **Idempotency marker forgeable by PR author** — true in theory (PR author
  can post a comment containing the marker text), but PR comments and PR
  reviews are different objects; `GET /reviews` doesn't return them.
- **`--config-root` is itself an injection vector** — only if the skill is
  invoked with an attacker-controlled CWD, which is not in the threat model.

These were ignored without spec edits.

## Misalignment Analysis

| Round | Intent | Actual | Drift |
|-------|--------|--------|-------|
| 1 | Resolve criticals | 3/3 resolved | none |
| 2 | Tighten contracts | 10 highs fixed; spec grew by 95 lines | acceptable (added precision) |
| 3 | Final review | 3 highs fixed inline; rest deferred to plan with named ownership | none |

No behavior drift between intent and outcome.

## Prompt Improvement Assessment

| Pattern | Recommendation | Level |
|---------|----------------|-------|
| Multiple agents flagged "REST-only conflicts with `gh pr view`" — both rounds 2 and 3 | Add a one-liner in the design-review/consistency prompt: "Treat 'REST' as a wire-protocol constraint unless the spec says otherwise." | Global |
| "File count miscount" repeatedly raised by claude:consistency despite being stylistic | Add to design-review/consistency: "Skip purely numeric/count discrepancies if both numbers are explicit in the same section." | Global |
| Codex repeatedly flagged "history retention out of scope" while the spec keeps it justified | None — codex is correctly noticing scope creep; design appropriately decided to keep it. | n/a |

## Changes Made

```diff
$ git log --oneline docs/superpowers/specs/2026-05-09-stark-review-ts-rewrite-design.md
9116d56 docs: design review round 3 fixes (3 issues addressed)
6a06ff7 docs: design review round 2 fixes (10 issues addressed)
4bbd100 docs: design review round 1 fixes (16 issues addressed)
44fc5aa docs(stark-review): spec for TS-only rewrite with --quick mode
```

Net change: +431 / −81 lines across three review rounds. Spec went from
"sketch" to "engineering-ready" without scope expansion (all additions
clarify or constrain; no new features were added during review).

## Verdict

**Design is approved-pending-user-review.** The trust model, failure
contract, idempotency story, fork-PR handling, and V1/V1.1 phasing are now
explicit. Remaining open items belong to the implementation plan, which is
the next step.
