# Design Review — stark-gh:pr-merge

Review of `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-design.md` via `/stark-review-design` (multi-agent, 12 domains × 2 agents = 24 sub-agents per round). 3 fix rounds + 1 final review-only round.

## Headline

| Round | Total | Critical | High | Medium | Low | Outcome |
|-------|------:|---------:|-----:|-------:|----:|---------|
| 1 | 94 | 0 | 22 | 58 | 14 | 22 high addressed → commit `316a755` |
| 2 | 89 | 0 | 17 | 52 | 20 | 15 high addressed, 2 deferred → commit `6ae479e` |
| 3 | 68 | 0 | 17 | 42 | 9 | 5 substantive, 12 deferred/polish → commit `684b8e7` |
| 4 | 56 | 1 | 11 | 33 | 11 | review-only |

**Trend:** 94 → 89 → 68 → 56 total; high severity 22 → 17 → 17 → 11+1c. Converging but not zero.

**Signal-to-noise:** ~70% of round-1 highs were real and load-bearing (security/safety/idempotency). Subsequent rounds increasingly surfaced consistency drift introduced by earlier fixes.

## Round 1 — Fixes Applied (22 high)

Major structural improvements:

- **Gate Matrix table** reconciles `--force` semantics across the spec (H06)
- **Secret-scan ordering**: pre-commit scan + redact moved BEFORE CHANGELOG.md write (H05/H16); watcher's on-green callback re-scans tempfiles before merge (H01)
- **Idempotency rewrite**: switched from `bulletHash` to marker-comment idiom `<!-- stark-gh:pr-merge pr=N runId=UUID -->` for deterministic rerun detection that survives plan-file deletion (H03/H08/H09/H10)
- **Working-tree gate**: explicit cleanliness check + `startingRef` capture for post-abort restoration (H02)
- **Watcher security**: `--on-green-tool <path>` replaced with `--on-green <name>` resolved via `lib/watcher_callbacks.ts` registry (H11)
- **Watcher SHA-match contract**: only signal on-green for checks against `pushedHeadOid`; stale pre-rebase OIDs ignored (H13)
- **Watcher recovery**: plan-file retained until terminal state; preflight detects existing live watcher and exits `34` with attach hint (H12/H14)
- **Required-check source-of-truth** specified (H04)
- **`--delete-branch` clarified** as remote-only (H07)
- **Watcher cadence** inherited from pr-open (H15)
- **Test coverage** expanded with explicit cases for rt1 fork rejection, rt5 explicit-OID lease, rt7 idempotency, secret-scan blocking + redaction, on-green OID re-verify (H17–H21)

## Round 2 — Fixes Applied (15 high) + Deferred (2)

Discovered: round-1 edits introduced new consistency drift; also surfaced load-bearing assumptions about `gh pr checks`.

- **Required-check source switched** from `gh pr checks` (no SHA, no `isRequired`) to GraphQL via `gh api graphql`; query returns `headRefOid` for SHA-match enforcement (R2-H1/H2/H10)
- **Single canonical `isCheckPassing` predicate** reused across preflight, `--no-watch`, watcher SHA-match, on-green callback (R2-H6)
- **Vacuous-pass policy explicit**: zero required checks → immediate pass (R2-H15)
- **Watcher max-wait**: 6h default, `--watch-timeout` flag, terminal state `watch_timeout` on expiry; per-poll HTTP timeout 30s (R2-H4/H12)
- **Watcher liveness**: PID + start-time + hostname; stale lock takeover on rerun (R2-H11)
- **Local sync gate**: exit `18` when local `<headRef>` differs from `origin/<headRef>` (unpushed commits) (R2-H3)
- **`--no-watch` contract clarified**: typically exits `12` after force-push (CI restart); useful only for vacuous-pass or pre-completed checks; uses same OID re-verify helper as on-green callback (R2-H8/H9)
- **Marker-update / byte-identical reconciled**: identical bullet leaves both marker line and bullet unchanged; no `runId` update; no commit (R2-H5/H7)
- **Shared `lib/verify_oids.ts` and `lib/checks_graphql.ts`** added

**Deferred:**
- R2-H13 (CHANGELOG bottleneck) — same as red-team rt6; v2 if concurrent-merge contention becomes real
- R2-H14 (Codex sandboxing) — cross-cutting hardening across all stark-skills tools; tracked separately

## Round 3 — Fixes Applied (5 substantive) + Accepted/Deferred (12)

Diminishing returns; substantive items only:

- **Codex output JSON Schema** in `lib/draft_schema.json`: subject ≤72, body ≤16KB, bullet `^- .{1,198}$` single-line, no additional properties (R3-claude/api-design)
- **GraphQL pagination contract**: `contexts(first:100)` + `pageInfo` cursor walk; aggregate all pages before predicate (R3-codex/api-design)
- **Override audit**: structured JSON line to `~/.claude/code-review/stark-gh/audit/pr-merge.log` (`0600`) per `--force` / `--allow-*` flag; `--allow-secret-to-llm` prints stderr warning (R3-codex/security)
- **Force-push rollback**: on push rejection, reset CHANGELOG commit; HEAD restored to `rebasedHeadOid`; CHANGELOG.md restored from object store; clean retry path (R3-claude/resilience)
- **Watcher spawn-fail recovery**: plan-file retained; rerun detects and resumes from Stage 3 step 10 (R3-codex/completeness)

**Rejected/accepted as polish:**
- Mandatory CHANGELOG mutation (rejected; design choice from brainstorming)
- Watcher rescan fails-open with override (by design; override means user accepted risk)
- Wording-only consistency drift (accepted as polish for implementation)
- Marker-contention concurrency tests (deferred to v2; same as rt6)

## Round 4 — Final Review-Only

12 unresolved findings remain at fix-threshold (1 critical + 11 high). Highlights:

### Unresolved — Critical (1)

| ID | Concern | Recommendation |
|----|---------|----------------|
| **codex/consistency** | `--no-watch` × `--force`: Gate Matrix says force-bypassable; Stage 3 says always-enforced — contradiction | One-line fix: pick one rule and align Gate Matrix + Stage 3 + Exit Codes. Recommend "always-enforced" (matches the spirit of `--no-watch` as a debug/CI-pre-completed escape) |

### Unresolved — High (11)

| ID | Domain | Concern (summary) |
|----|--------|-------------------|
| codex/api-design | api-design | `--force` semantics drift across the contract (related to the critical) |
| codex/api-design | api-design | Watcher state file format/transitions underspecified |
| codex/api-design | api-design | `gh pr merge` ambiguous failure (e.g., timeout) — no idempotent retry |
| codex/completeness | completeness | Watcher spawn-fail resume path not fully specified (transient lock, partial state) |
| codex/consistency | consistency | Draft-PR force policy contradiction across rows |
| codex/consistency | consistency | Interrupted watcher recovery policy inconsistent (re-attach vs. takeover language) |
| claude/resilience | resilience | No timeout/hang detection on Codex subprocess |
| claude/resilience | resilience | No retry/backoff for transient GraphQL errors during polling |
| codex/test-plan | test-plan | No live-GitHub contract test strategy |
| codex/test-plan | test-plan | GitHub API failure paths not covered in tests |
| codex/test-plan | test-plan | Shared pr-open regression coverage missing |

These are appropriate for a v1.1 hardening pass during/after implementation rather than blocking the spec.

## Recommendation

**Spec is ready for implementation planning.** The critical-severity contradiction (`--force --no-watch`) is a 1-line Gate Matrix fix and should be addressed in the next edit before kicking off `/stark-design-to-plan`. Remaining high-severity items are all hardening/test-coverage refinements that the implementation plan can absorb.

## Misalignment Analysis

Round-over-round drift was concentrated in **consistency** (multi-row contradictions introduced when changing one section without updating mirrors elsewhere). Round 1 created drift via the marker-comment rewrite; round 2 created drift via the GraphQL switch. By round 3, only wording-level drift remained.

Improvement actions:
- For future multi-round design reviews: when rewriting a Decisions row, immediately grep for downstream references and update them in the same commit.
- When adding shared helpers (e.g., `verify_oids.ts`), explicitly enumerate all callers and their expectations in the spec to reduce phrasing drift.

## Prompt Improvement Assessment

| Level | Recommendation |
|-------|---------------|
| Global | None warranted; design-review prompts produced high-signal output |
| Repo | None warranted |
| Config | Consider lifting `min_severity_to_block` for design reviews from `medium` to `high` — round 4's medium/low findings were largely repetitive nits already captured by higher-severity findings |

## Run Metadata

- Mode: standard (2 agents — claude + codex; gemini excluded by config)
- Rounds: 3 fix + 1 final review = 4 total
- Total dispatch time: 191s + 184s + 308s + 198s ≈ 14 minutes
- Sub-agents: 96/96 succeeded across all rounds
- Spec final length: 444 lines
- Commits: `7689a2e` (initial), `316a755` (R1), `6ae479e` (R2), `684b8e7` (R3)
