# Design-to-Plan Cross-Review — stark-gh:pr-merge

Source design: `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-design.md`
Synthesized plan: `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-plan.md`

## Scorecard

| Plan | Completeness | Feasibility | Phasing | Risk | Testability | Avg | |
|------|-:|-:|-:|-:|-:|-:|--|
| codex   | 8.5 | 8.5 | 8.5 | 8.0 | 8.5 | **8.4** | ★ winner |
| claude  | 8.5 | 7.5 | 8.0 | 8.0 | 9.0 | **8.2** | tied (within 0.5) |
| gemini  | 6.0 | 6.5 | 7.0 | 5.5 | 6.5 | **6.3** | |

**Result:** tie (codex 8.4, claude 8.2 — synthesizing both equally per skill rules). Codex base; claude high-impact merges in testability + Implementation Notes.

## Per-plan Strengths / Weaknesses

### Codex (winner)

**Strengths (multiple reviewers):**
- Phasing front-loads shared libraries (Phase 1–2) before any branch-mutating stage
- Phase 5 explicit rollback contract: reset to `rebasedHeadOid` + restore CHANGELOG.md from object store
- Test ordering (libs → stages → watcher → integration) mirrors dependency direction
- Maps every design exit code/gate matrix row to a concrete testable task
- Identifies subtle implementation risks not in the design (avoiding shell quoting on the explicit lease)

**Weaknesses applied to synthesis:**
- Gate Matrix rows under-enumerated → Phase 3 task 2 enumerates all always-enforced + force-bypassable rows explicitly
- pr-open watcher backward compat with new lock format absent → Phase 6 task 2 added
- `override_audit.test.ts` not in explicit verification → added to Phase 1 verification block
- `chore(changelog): <bullet text without "- ">` vs design's `<bullet text>` → reconciled in Implementation Notes #4 + tests
- Phase 8 `gh_runtime_maintenance.ts` is scope creep → moved to follow-up plan (Section 7)
- Spawn-fail resume entry point under-specified → Phase 3 task 4 + Phase 7 task 3 explicit
- `runId` generated after preflight override points → Phase 1 task 5 ordering invariant
- `verifyOids` signature missing PR identity → Phase 2 task 4 accepts full plan
- Exit `14` (base OID moved between fetch and plan write) had no implementation → Phase 3 task 9
- `--watch-timeout` not persisted in plan → Phase 1 task 2 includes `execute.watchTimeoutHours`
- `bun run install.sh --status` doesn't match repo command → Phase 8 task 3 uses `./install.sh --status`
- Phase 8 destructive smoke test against real PR → Phase 8 task 5 explicit disposable-PR with manual approval

### Claude (runner-up, tied)

**Strengths merged:**
- Phasing isolates synchronous `--no-watch` path (Phase 5) from async watcher (Phase 6/7) — proves merge-call shape end-to-end early
- Implementation Notes section catches design ambiguities (changelogCommitOid byte-identical first-run, SSH/HTTPS remote normalization, pagination edge cases) — synthesized into Section 8
- Strong testability: explicit `test file → rt mitigation` mapping — synthesized into Section 5

**Weaknesses discarded:**
- Phase 5 puts `head_moved` terminal state logic into generic `gh_watch_runs.ts` → kept generic per design; `head_moved` is callback-owned (Phase 7 task 1)
- Phase 4 captures pushed SHA from `git push --porcelain` → kept design's `git rev-parse HEAD` after successful push
- Resume detection in Phase 2 / spawn-fail in Phase 7 → grouped together in Phase 3 task 4 + Phase 7 task 3

### Gemini (not used as base)

Lowest scores across all dimensions. Major gaps: missing override-audit, `--watch-timeout`, several Gate Matrix rows; under-specified watcher SHA-match contract (only "ignore stale", missing two-part predicate); coarse testing strategy (5 test files vs design's ~17). Not synthesized into the final plan.

## Synthesis Decisions

1. **Base:** codex plan structure (Phases 1–8).
2. **Phase 5 ordering:** claude's "`--no-watch` path first" approach adopted — proves the merge-call shape before async watcher complexity.
3. **Implementation Notes:** claude's section adopted as Section 8; codex's "design gaps to close" merged in.
4. **Test mapping:** claude's `test file → rt mitigation` table adopted as Section 5.
5. **Out-of-Scope:** runtime maintenance moved out per double-flag from claude + gemini.
6. **All codex weaknesses addressed:** see "Net additions" in synthesis Section 9.

## Observability

- Plans generated: 3/3 (claude 488 lines, codex 442 lines, gemini 163 lines)
- Cross-reviews: 6/6 succeeded
- Generation time: claude 281s, codex 230s, gemini 36s
- Cross-review time: ~298s total
- Winner score gap: 0.2 (within tie threshold of 0.5)
- Output: `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-plan.md` (~430 lines)
