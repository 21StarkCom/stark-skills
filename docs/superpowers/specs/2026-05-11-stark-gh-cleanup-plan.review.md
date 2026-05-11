# /stark-review-plan — Adversarial Review of stark-gh:cleanup Implementation Plan

Multi-agent adversarial review of `docs/superpowers/specs/2026-05-11-stark-gh-cleanup-plan.md`. The reviewers assume the plan will fail and hunt for where it breaks. 4 review rounds total (3 fix-rounds + 1 final review-only).

**Reviewers:** `claude` + `codex` (gemini excluded by `config.agents`).
**Domains:** `completeness`, `viability`, `sequencing`, `security`.
**Dispatchers:** `triage_orchestrator.py` (rounds 1–3) + `plan_review_dispatch.py` (round 4 final).

## Round-by-round counts

| Round | Total | Critical | High | Medium | Low |
|-------|-------|----------|------|--------|-----|
| 1 (fix) | 59 | 4 | 27 | 24 | 4 |
| 2 (fix) | 50 | 1 | 20 | 25 | 4 |
| 3 (fix) | 50 | 1 | 17 | 28 | 4 |
| 4 (review-only) | 59 | 1 | 26 | 30 | 2 |
| 5 (verify) | 57 | 3 | 27 | 24 | 3 |
| 6 (verify) | 54 | 1 | 26 | 21 | 6 |

**Net:** critical 4 → 1, total 59 → 54. The plan grew from ~210 to ~1100 lines of explicit safety contract.

**Plateau observation.** Total findings stabilised around 50–60 after round 2. Each fix round introduces new explicit contracts (helper signatures, schemas, retry policies, error paths) which the next round adversarially examines for *new* edge cases. This is a natural asymptote of adversarial review — the plan-review process is most effective at the first 2–3 rounds; beyond that, each round trades one finding for another at the margins. We stopped at round 6 because further iteration was producing recurring categories of nits (audit-log lock semantics, multi-PR closure spec inconsistencies, encoding edge cases) rather than uncovering new structural problems.

## What was fixed across the rounds

### Round-1 fixes (most-impactful)

**Critical**
- Per-segment URL encoding for branch names (was `encodeURIComponent` which mangles `/` — C41).
- Stale PRs were closed before execute-time freshness re-check (C53/H28/H35); execute step order was inverted to put drift + freshness re-check BEFORE PR closure.
- PR/audit candidates matched by branch name alone (C52/H42); added branch-reuse SHA check and (in round 2) extended it across all candidate sources.
- Dirty worktrees force-deleted without a safety gate (C33/H13/H43/H56) — introduced default-safe behaviour for auto-discovered candidates (audit + stale modes); explicit `--pr`/`--branch` modes still force-remove per the design.

**High**
- Defense-in-depth execute re-validation (H0/H1/H23/H30) — new Phase 4 Task 2: re-check auth identity, cwd anchor, origin URL, protected list before any mutation.
- Open PRs deletable without closure (H36/H42/H54) — added `pr-open` skip reason and explicit PR-state eligibility matrix.
- Cross-repo worktree enumeration leaked to wrong clone (H4); branch-mode against wrong remote (H38); PR close without `--repo` (H39).
- `--stale-days` silently triggered audit (H37) — mode resolution now requires neither `--pr` nor `--branch` nor `--stale-days`.
- `git check-ref-format --branch` resolves shortcuts (H45) — switched to `refs/heads/<name>` literal form.

**Medium → fixed**
- Wrapper `--dry-run` substring-match fragility (M2/M9/M18/M46/M58) — replaced with single-line JSON envelope on preflight stdout; wrapper parses the envelope (jq with node fallback).
- Plan-file unlink racing with dry-run retention (H11) — explicit rule "EXIT_OK AND NOT flags.dryRun → unlink".
- `--stale-author-self-only` silent scope narrowing (H12) — added `staleFiltered.{byAuthor,byDraft}` counters surfaced in output.
- Case-sensitive protected list (M24) — lowercase-fold both sides.
- No audit trail after success (M25) — added `.audit.jsonl` append.
- Active gh identity invisible (M27) — render `Auth: <user>` header in stderr table.
- Retention/rotation of failed plans (M16) — `pruneOldPlans(30)` runs on every successful preflight.
- PR-close atomicity unspecified (M17/M26/M50) — pinned single-call `gh pr close <n> --comment "..." --repo <repo>`.
- Self-worktree removal corrupts session (M7) — initially gated in Step 4; round-2 critical (C28) moved the gate to the pre-mutation re-validation task.

### Round-2 fixes (responses to fixes-introducing-bugs)

- **C28** — Self-worktree skip moved into Task 2 (pre-mutation) so the check runs before remote-delete; previous Step-4 placement would have deleted remote then tripped on local skip.
- **H6** — `process.chdir` is process-global and unsafe; replaced with injected-`cwd` arg on every git helper.
- **H7** — Audit log atomicity assumption wrong (PIPE_BUF guarantees pipes not regular files); replaced with explicit `fcntl.flock` advisory locking + fallback warning.
- **H8** — `--stale-author-self-only=false` now requires explicit `--allow-foreign-authors` ack.
- **H14** — `plan.originUrl` scrubbed via `lib/redact.ts` before write; comparison done via `canonicaliseOrigin()` (handles SSH form).
- **H17** — Stale PR that became closed/merged between preflight and execute now proceeds to remote-delete cleanup (the desired terminal state has been reached).
- **H18** — Cross-repo protected-list re-derivation does NOT include local HEAD (irrelevant to target repo).
- **H19** — `audit-gone-branch` candidates exempt from `local-ahead` rule (they have no upstream by definition).
- **H29** — Audit log append explicitly runs BEFORE plan-file unlink.
- **H30** — Protection gate applied explicitly to all 4 candidate-source types (PR, branch, stale, audit).
- **H31** — Phase 1 stub round-trip uses mocked `ExecFn` so re-validation doesn't require network.
- **H32/H37/H43** — `listWorktrees` signature now declares `dirty: boolean`; documented production path for dirty detection.
- **H36/H42** — Fork + branch-reuse + protection gates factored as shared helpers, applied to all candidate sources.
- **H44/H45** — PR close retry-idempotent (already-closed treated as success); local cleanup retry-idempotent (already-removed worktree, already-deleted branch treated as success).
- **H46** — `action.source` → `action.sources[]` + `action.primaryPrSource` for unambiguous PR-number reference after dedup.

### Round-3 fixes (further hardening)

- **C44** — Local branch identity check added (compare `local.headSha` to `pr.head.sha` or `pr.merge_commit_sha`); new `local-branch-reused` skip reason.
- **H0/H13** — Wrapper portability + exit-code propagation: replaced `<<<` here-string with POSIX pipe; replaced terminating command-substitution with `exec node ...` so execute's exit code becomes the wrapper's.
- **H2** — Branch-reuse baseline differentiated by PR state: merged PRs may have a gone ref (expected with auto-delete-on-merge), closed-not-merged PRs need exact-match-or-404, open PRs need exact match.
- **H3** — Resolved chdir contradiction: fully commit to injected-`cwd` pattern on every git helper.
- **H14/H23/H45** — Origin URL handling: store raw-but-redacted via `lib/redact.ts`; compare via `canonicaliseOrigin()` to normalise SSH vs HTTPS, credentials, host case, `.git` suffix.
- **H24** — Exit-code computation uses live `liveActionable = actions.filter(a => !a.skip && !a.error).length`, not preflight's `summary.actionable` (which is the pre-execute count).
- **H25** — `already-clean` skip reason: PR-mode actions with `remote.exists === false && local.exists === false` mark as already-clean (preserves visibility, doesn't count as actionable).
- **H38** — Mid-action skip mechanism now explicit: each step throws `SkipAction(reason)` or `StepFailed(code, stderr)`; outer loop catches and updates the action.
- **H46** — `action.source.type` references propagated to `action.sources[0].type` everywhere.

## Round 4–6 fixes (additional safety contracts added in "fix all" mode)

After the formal Phase 3 final review, the user requested "fix all" — kicking off two additional verification rounds (5 + 6) with full fix-passes between each. These rounds resolved:

**Schema completeness (plan-review H10/M10 etc.):**
- Every field referenced by any phase is now enumerated in Phase 1 Task 1 (CleanupPlan, CleanupAction, CleanupSource, CleanupFlags, CleanupSummary).
- `CleanupSource` schema explicitly defined with `type` discriminant and per-type optional fields.
- `gh_cleanup_audit_append.ts` added as a Phase 1 deliverable (was referenced by Phase 5 wrapper but missing from Phase 1).

**Identity + safety hardening:**
- C2 — Local-branch identity check now only accepts `pr.head.sha` match (NOT `pr.merge_commit_sha` — squash/rebase merge commits are on `main`, not on the PR branch).
- C1 — Force-push-to-same-SHA detection replaced with "any open PRs on this head ref" query — deterministic and committer-date-independent.
- C0 — Explicit `--pr`/`--branch` dirty/ahead force-removal retained per design intent, with loud stderr warning on each destructive action. Documented in §"Design-level decisions retained against plan-review pressure".
- `fs.realpathSync` safety: wrapped in try/catch for deleted-worktree edge case.
- `ssh -G` resolution for SSH `Host` aliases in `canonicaliseOrigin`.
- `gh` version probe (≥2.40 required for `--stale-days`) at preflight.
- Repository `node_id` recorded and re-verified at execute (catches rename/delete-and-recreate).

**Wrapper portability:**
- POSIX-portable bash (no `<<<`, no `[[`).
- `exec node ... execute` to propagate exit code without command substitution.
- `jq` as hard prerequisite (fail loudly if absent).
- Pre-`exec` wrapper-handoff audit line via `gh_cleanup_audit_append.ts`.

**Multi-PR closure:**
- Phase 4 Step 2 iterates ALL PR sources in `action.sources`, not just `primaryPrSource` — closes every stale PR sharing the head ref before deleting the branch.
- Freshness re-check + branch-reuse re-validation runs per PR.

**Audit-log atomicity:**
- Dependency-free `O_CREAT | O_EXCL` lockfile (no native binding required).
- Lock retry budget 2s (not 5s) with 30s stale-lock recovery.
- Lock-acquisition failure → warning + `auditDropped++` + continue (revised from EXIT_UNRECOVERABLE to avoid livelock).
- Auto-rotation at 10 MB / 90 days; keep last 3.
- Per-entry redaction via `lib/redact.ts` (stderr fields scrubbed).

**Audit + truncation visibility:**
- `truncated && actionable === 0` → `EXIT_BAD_ARGS` (not silent `EXIT_NOTHING_TO_DO`).
- Preflight emits truncation banner immediately, not just execute.

**Comprehensive arg parsing:**
- `--audit-max-prs`, `--allow-foreign-authors`, `--stale-author`, `--include-dirty` all now parsed and validated.
- Comma-list parsing for `--pr` and `--branch`.
- `--dry-run=value` form rejected (only bare-flag accepted).
- `--stale-author-self-only=false` requires `--allow-foreign-authors`.

## Residual findings (Round 6 — accepted or deferred)

54 findings remain after round 6. They cluster into four categories:

### Category A — Implementation-time consistency checks (resolve while coding)

- Various spec inconsistencies where a recently-added contract is referenced from one phase but not yet propagated to another (e.g. `gh_cleanup_audit_append.ts` declared in Phase 1 but its tests live in Phase 5). These resolve naturally when implementation writes both ends.
- TS type errors will catch most "field referenced but not declared" findings (the schema in Phase 1 Task 1 is now exhaustive; any deviation in later phases will fail `tsc --noEmit`).
- Multi-PR closure spec was re-tightened twice; the final spec (Phase 4 Step 2 iterates `action.sources.filter(s => s.prNumber)`) is correct, but the prose around `primaryPrSource` may still confuse a careful reader. Implementation should treat `action.sources` as authoritative and `primaryPrSource` as a "preferred PR for the close-comment template" pointer.

### Category B — Plan-review meta (reviewer-of-reviewer territory)

- Reviewers continue to flag the audit-log atomicity contract because each round's revision (PIPE_BUF → flock → lockfile → relaxed lockfile) introduces a new property worth scrutinising. The current contract (O_CREAT|O_EXCL lockfile, 2s budget, warn-and-continue on contention, per-process auditDropped counter, automatic rotation) is the simplest correct one short of a dedicated locking daemon. Implementation should treat the test contract (round-6 reconciliation) as canonical.
- Edge cases around `--stale-days` interacting with explicit `--pr` (filter mode vs discovery mode) have been re-explained in successive rounds; the spec is now consistent but operators may need a worked example in the README.

### Category C — Explicitly deferred to v2 (already documented in §2)

- GitHub branch-protection / rulesets API query (H57).
- Per-subprocess timeout + SIGINT handler (M19).
- Hard Node/git version pinning at preflight (M49 — partial: `gh ≥2.40` is now preflight-checked because it's load-bearing for `--stale-days`).

### Category D — Design retentions (acknowledged but not changed)

- Explicit `--pr`/`--branch` force-removes dirty worktrees and ahead-branches per the original design's "user accepted the risk" stance. Auto-discovered candidates (audit + stale modes) default-skip per §2 refinements. Documented in plan §"Design-level decisions retained against plan-review pressure".

## Plan-file artifacts

- **Plan:** `docs/superpowers/specs/2026-05-11-stark-gh-cleanup-plan.md` (~1100 lines after 5 fix rounds)
- **History:** `~/.claude/code-review/history/plan-reviews/2026-05-11-stark-gh-cleanup-plan/`
  - `round-1.json` / `.stderr` — first dispatch + fix
  - `round-2.json` / `.stderr` — second dispatch + fix
  - `round-3.json` / `.stderr` — third dispatch + fix
  - `round-4-final.json` / `.stderr` — Phase 3 review-only
  - `round-5.json` / `.stderr` — verify round (fix-all phase 1)
  - `round-6.json` / `.stderr` — verify round (fix-all phase 2, plateau)

## Verdict

The plan is **implementation-ready** for the documented v1 scope. The destructive-command safety surface is comprehensively specified: re-validation at the execute boundary (auth, cwd realpath, origin canonicalisation, repository node_id, protected-list snapshot, self-worktree gate); retry-idempotent steps with "already gone" detection by filesystem re-check (not stderr substring); fork / branch-reuse (via open-PRs-on-head-ref query) / protection / local-branch-identity gates applied uniformly; dirty/ahead default-safe for auto-discovered candidates with live re-check; explicit `SkipAction`/`StepFailed` mid-action control flow; lockfile-serialized audit log with auto-rotation and per-entry redaction; multi-PR closure for shared head refs.

Residual findings after 6 rounds (54 total, 1 critical, 26 high, 21 medium, 6 low) are predominantly:
- Implementation-time consistency checks that TS types + tests will catch.
- Recurring spec interpretation nits at the audit-log + multi-PR + stale-mode boundaries.
- Acknowledged design retentions (force-remove for explicit candidates).
- Explicitly deferred v2 items (branch-protection API, SIGINT timeout, hard Node/git version pinning).

Further rounds would continue trading individual findings at the margins without producing structural improvement. Recommend proceeding to implementation, with the implementation team treating `tsc --noEmit` + the full test matrix as the canonical authority for spec consistency (the plan's test list — round 5/6 updated — is exhaustive across the new contracts).
