# stark-gh:cleanup — Design-to-Plan Cross-Review Summary

Two candidate plans were generated in parallel (`claude`, `codex`); each was reviewed by the other (`gemini` was excluded from `config.agents`). The higher-scoring plan became the synthesis base; superior elements from the runner-up were merged in.

## Scorecard

|        | Completeness | Feasibility | Phasing | Risk Coverage | Testability | **Avg** |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|
| **codex** | 8.0 | 8.0 | 9.0 | 7.0 | 8.0 | **8.0 ★** |
| **claude** | 7.0 | 6.0 | 6.0 | 7.0 | 8.0 | 6.8 |

**Winner:** `codex` (8.0 / 10). Gap of 1.2 is well above the 0.5 tie threshold.

## Per-plan strengths and weaknesses

### codex (winner) — reviewed by claude

**Strengths**

- §2 *Design gaps to resolve* explicitly flags the design's `--force`/`argument-hint` contradiction, `headSha` placement under `local` vs `remote`, missing `authUser` field, and the cross-repo skip-reason machine/human split.
- Phase 1 extends `types.ts`, `plan.ts`, `branch.ts`, `git.ts`, `gh.ts` additively — honours the design's "No new lib/ files" constraint while naming concrete helper signatures.
- Phase 3 task 1 captures non-obvious dedup semantics: same branch via multiple sources → preserve source metadata, OR `needsPrClose`.
- Phase 4 enforces strict ordering (PR close → SHA drift recheck → remote delete → worktree → local branch) with explicit guard that close failure must not proceed to remote delete.
- Audit mode in Phase 3 distinguishes same-repo (`[gone]` allowed) from cross-repo (only `audit-pr`).
- Rollback plan (§6) is concrete and ordered: remove `commands/cleanup.md` first to disable invocation before reverting TS.

**Weaknesses**

- Phase 3 task 4 dry-run stdout contract diverges from design (proposed sentinel `STARK_GH_CLEANUP_DRY_RUN=1` + summary JSON; design says path-only). → **fixed in synthesis**: dry-run is a wrapper-level substring short-circuit; execute is not invoked.
- `--no-color` flag absent from plan tasks. → **fixed**: threaded through `lib/output.ts` in Phase 4 task 5; `execute_no_color.test.ts` added.
- Concurrency scenario (two simultaneous runs) not addressed. → **fixed**: documented as safe-by-construction in Phase 4 risks and README.
- Phase 6 manual smoke not CI-verifiable. → **fixed**: split into 6a (automated regression, CI gate) and 6b (manual checklist, reviewer-attested precondition).
- `execute_cross_repo.test.ts` mentioned parenthetically in design but not in any verification block. → **fixed**: explicit file in Phase 4 verification.
- 8 new `gh.ts` helpers without specifying which are pure argv-builders vs shell-outs; no ref-path encoding test for `#`, Unicode, `?`. → **fixed**: `gh_ref_encoding.test.ts` added to Phase 1 verification.
- `authUser` resolution failure handling silently widened scope. → **fixed**: Phase 2 task 2 maps `authUser` resolution failure to `EXIT_UNRECOVERABLE` when `--stale-days` + `--stale-author-self-only=on`.

### claude (runner-up) — reviewed by codex

**Strengths**

- Maps the design's two-stage pipeline into concrete files, tests, stdout/stderr contracts, plan-file lifecycle.
- Phase 2 + 4 correctly prioritise the safety surface (arg validation, protected-branch gates, per-action isolation, exit codes, SHA drift).
- Testing strategy is concrete and mirrors the design's required mocked-gh/git suites; boundary tests for stale PRs and partial failures called out.
- Catches real design ambiguities (stray `--force` hint, missing `authUser`, `--stale-author-self-only` doc gap).

**Weaknesses**

- Dry-run semantics diverge (execute no-op vs design's "execute is not invoked"). → resolved in synthesis: wrapper short-circuits; execute also handles `dryRun: true` defensively for direct invocation.
- Phase 3 allows destructive delete before Phase 4 wires SHA-drift, violating state-integrity ordering. → resolved: synthesis follows codex's Phase 3 = preflight, Phase 4 = execute (which includes SHA drift from day one).
- Schema gap: Phase 4 compares `action.remote.headSha` but Phase 1 doesn't add it. → resolved: `remote.headSha` added to schema in Phase 1 task 1.
- Cross-repo phased too late (Phase 6); `--repo` affects PR/branch resolution from the start. → resolved: cross-repo detection lives in Phase 2 task 2; gating in Phase 4 task 3.
- Phase 2 proposes a new `lib/cleanup_args.ts` despite the design's "no new lib files". → **rejected**: synthesis keeps the parser inside `gh_cleanup_preflight.ts`.
- `--no-color` documented but unimplemented. → resolved: Phase 4 task 5.
- Exit-code precedence ambiguous (`EXIT_OK` listed before `EXIT_NOTHING_TO_DO`). → resolved: explicit precedence rule in Phase 1 task 2.
- `authUser` as optional rather than required from preflight. → resolved: `authUser: string` in `CleanupPlan` from Phase 1.

## Synthesis decisions

| Element | Came from |
|---------|-----------|
| 6-phase structure (vs 7) | codex |
| §2 *Design gaps to resolve* | codex (extended) |
| Additive-only `lib/` changes; no `lib/cleanup_args.ts` | codex |
| 8 new `gh.ts` helpers enumerated by name | codex |
| Centralised ref-path encoding + `gh_ref_encoding.test.ts` | claude review of codex |
| Dry-run = wrapper short-circuit + execute defensive no-op | claude (path-only stdout) + codex (preflight stays simple) |
| Clock-injection seam (`now: () => Date`) for stale tests | claude |
| `git check-ref-format --branch <name>` for reserved-name validation | claude |
| `--no-color` thread + dedicated test | claude review of codex |
| Exit-code precedence rule (unrecoverable → partial → nothing-to-do → ok) | codex review of claude |
| `authUser` resolution failure → `EXIT_UNRECOVERABLE` when stale safety filter required | claude review of codex |
| 6a/6b split: automated regression CI gate + manual smoke reviewer-attested | claude review of codex |
| Explicit `execute_cross_repo.test.ts` in verification block | claude review of codex |
| Snapshot stderr tables in tests | claude |
| §"Flagged Ambiguities" surfaced at top of plan, not at bottom | claude |
| Per-phase rollback narratives | both (merged) |
| `--stale-days` public-comment + concurrency notes in README | claude review of codex |

## Discarded elements (confirmed problems)

- claude's `lib/cleanup_args.ts` new file — violates design's "no new `lib/`" constraint (flagged by codex).
- claude's Phase 3-then-Phase 4 staging that allowed deletes before SHA-drift — violates state-integrity requirement (flagged by codex).
- codex's `STARK_GH_CLEANUP_DRY_RUN=1` sentinel — diverges from design's path-only stdout contract (flagged by claude).
- Both plans' implicit "test in CI but smoke is manual" stance — replaced with explicit 6a/6b split.
