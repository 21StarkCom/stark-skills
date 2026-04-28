# stark-gh:pr-merge Design Spec

## Overview

`/stark-gh:pr-merge` is the second command in the `stark-gh` plugin (after `/stark-gh:pr-open`). It rebases an open PR onto its base, drafts a squash commit message and a `CHANGELOG.md` entry via Codex, force-pushes the rebased branch with the changelog appended, then waits for CI and squash-merges once green.

The command builds on pr-open's three-stage TS pipeline (preflight → draft → execute) and reuses `gh_watch_runs.ts` with a new "on-green merge" callback. The slash command body has zero LLM logic — all drafting happens in the Stage 2 TS tool that subprocess-calls Codex.

Local cleanup (checkout main, delete local branch) is **not** automated by this command — it lives in a future `/stark-gh:cleanup` command. The watcher's final state file prints the cleanup commands for the user to run when they switch context.

## Decisions

| Decision | Choice |
|----------|--------|
| Command | `/stark-gh:pr-merge` |
| Pipeline | Three TS stages mirroring pr-open: preflight → draft → execute |
| Parent skill model | Sonnet 4.6 (Claude Code harness running `commands/pr-merge.md`); does not draft |
| Sub-agent | Codex (default `gpt-5.5`, reasoning effort `medium`); shared `lib/codex.ts` from pr-open |
| Target PR | Default: current branch's open PR (via `gh pr view`). `--pr N` flag overrides |
| PR identity (rt1) | Capture `headRepositoryOwner`, `headRepositoryName`, `headRefOid`, `isCrossRepository`. Reject cross-repo (fork) PRs in v1. Verify `origin/<headRef>` resolves to `headRefOid` before rebase/push. |
| Merge strategy | Squash-merge after rebase. No flag for alternative strategies |
| Rebase | Local rebase onto `origin/<baseRef>`; force-push with **explicit-OID** lease (rt5) |
| Force-push lease (rt5) | `git push --force-with-lease=refs/heads/<headRef>:<originalHeadOid>` where `originalHeadOid` is captured from the PR's pre-rebase head. Implicit `--force-with-lease` is forbidden — local tracking refs are mutable mid-flow |
| Drafting | Always-on. Stage 2 produces three artifacts: squash subject, squash body, single changelog bullet |
| Changelog write | Append bullet to `## [Unreleased]` → `### <Section>` in `CHANGELOG.md` on the PR branch *before* force-push, so the squash-merge contains both the change and the entry atomically |
| Changelog section | Default inferred from PR labels (`bug`/`fix` → Fixed; otherwise Added). `--changelog-section` flag overrides |
| Changelog file | Repo root `CHANGELOG.md`. Fail in preflight if absent |
| Fail-fast gates | See **Gate Matrix** below for authoritative semantics |
| Args policy | Slash body forwards `$ARGUMENTS` as one quoted `--raw-args` to preflight (same as pr-open) |
| Watcher | Background by default; `gh_watch_runs.ts` gains `--on-green <name>` flag where `name` is resolved against a registry in `lib/watcher_callbacks.ts` (whitelist; arbitrary tool paths forbidden). `--no-watch` requires checks already green at push time |
| Watcher cadence | Inherits pr-open's existing `gh_watch_runs.ts`: 15s × 5 → 30s → 60s → 120s → 240s, capped at 240s. No new cadence introduced for pr-merge |
| Watcher max-wait | Default 6h total wallclock from `--on-green` spawn, overridable via `--watch-timeout <hours>` (R2-H4/H12). On expiry: terminal state `watch_timeout` with last observed check states; plan-file unlinked; cleanup hint printed. Per-poll HTTP timeout: 30s |
| Watcher liveness | Lock format `{pid, startedAt, hostname, ownerToken}` (matches pr-open). On rerun, preflight (R2-H11): (a) read lock; (b) verify hostname matches; (c) `kill -0 <pid>` to confirm process alive; (d) verify process start-time matches `startedAt` (defends against PID reuse). If any check fails, treat lock as stale, log takeover, proceed. If all checks pass, exit `34` (watcher already running) |
| Watcher SHA filter | On-green is signaled only when (a) at least one check run targeting `pushedHeadOid` is observed, and (b) all required checks on `pushedHeadOid` are `success`. Stale check runs against pre-rebase OIDs are ignored |
| Watcher recovery | Plan-file is **not** unlinked when ownership passes to the watcher; persists until watcher writes terminal state (`merged`, `merge_failed`, `base_moved`, `head_moved`, `aborted`). On rerun, preflight detects existing watcher lock + state file and offers to attach (print state-file path) instead of starting a new run |
| Required-check source | **GraphQL** via `gh api graphql` (R2-H1/H2/H10): query `repository.pullRequest.commits(last:1).nodes.commit.statusCheckRollup.contexts` for the PR. The query returns per-check `name`, `conclusion` (CheckRun) or `state` (StatusContext), and `isRequired(pullRequestNumber:N)`. The query also returns `pullRequest.headRefOid`, which **must equal `pushedHeadOid`** before the rollup is consumed (SHA-match enforced at the source). `gh pr checks` is rejected — it omits both head SHA and `isRequired` |
| Required-check pass predicate | Single canonical predicate `isCheckPassing(c)` reused across preflight, `--no-watch`, watcher SHA-match, and on-green callback (R2-H6): `c.isRequired == true` AND (CheckRun: `conclusion ∈ {SUCCESS, NEUTRAL, SKIPPED}`; StatusContext: `state == SUCCESS`). NEUTRAL and SKIPPED count as passing per GitHub's branch-protection semantics. Failing: any required check whose conclusion/state is in the explicit failure set (FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE). Pending: required check that is neither passing nor failing |
| Vacuous-pass policy | If GraphQL returns zero contexts where `isRequired == true` for the PR, "all required checks pass" is **vacuously true** — preflight, `--no-watch`, and watcher all proceed (R2-H15). Watcher SHA-match contract is satisfied immediately when zero required checks exist |
| Local cleanup | Not automated. Watcher final state file prints `/stark-gh:cleanup --pr N` (rt3) — never raw shell containing untrusted ref names. Note: `gh pr merge --delete-branch` deletes the **remote** branch only; local branch cleanup is `/stark-gh:cleanup`'s job |
| Idempotency (rt7) | Plan-file holds `runId`, `originalHeadOid`, `changelogCommitOid`, `pushedHeadOid`. The CHANGELOG.md entry is wrapped in an HTML-comment marker `<!-- stark-gh:pr-merge pr=N runId=UUID -->` (sentinel-comment idiom) so reruns find the tool's own entry deterministically. **Canonical update algorithm (R2-H5/H7):** match marker by **PR number only** (`runId` is informational); locate the marker line and the **single bullet line immediately following it**; if the new bullet text is byte-identical to the existing bullet, **leave both lines unchanged** (no `runId` update, no commit); else replace the bullet line and update the marker's `runId` to current run |
| Local branch sync (R2-H3) | Preflight verifies that local `<headRef>` SHA equals `origin/<headRef>` SHA (no unpushed local commits). If divergent, exit `18` instructing user to push or reset. Rebases happen on the synced branch, never on a branch with unpushed local commits |
| `--no-watch` contract (R2-H8/H9) | After force-push, CI re-runs against `pushedHeadOid`; required checks for the new head are typically **pending**, not green. `--no-watch` therefore exits `12` in the common case. Useful only when (a) force-push is a no-op rebase (no SHA change — but explicit-OID lease still applies), (b) checks already complete on the new SHA before merge attempt, or (c) zero required checks (vacuous pass). Recommendation in user docs: prefer default-watch. The `--no-watch` path runs the **same OID re-verify helper** (R2-H9) used by the on-green callback before invoking `gh pr merge`; mismatches map to exit `30` (sync) instead of terminal state files |
| Secret scan | Reuse pr-open's two-point scan + override flags (`--allow-secret-commit`, `--allow-secret-to-llm`). Pre-commit scan runs over drafted subject + body + changelog bullet **before** the CHANGELOG.md write; on `--allow-secret-commit`, redact spans in all three artifacts and continue. Watcher's on-green callback re-runs the pre-merge scan over the same prose tempfiles before invoking `gh pr merge`; failure writes terminal state `secret_in_prose` (no merge) |
| State integrity | Preflight captures `baseOid`, `originalHeadOid`, and `rebasedHeadOid`. Execute re-verifies before force-push. Watcher on-green re-verifies `baseOid` and `pushedHeadOid` immediately before `gh pr merge` (rt4) |
| Working-tree cleanliness | Preflight refuses if `git status --porcelain` is non-empty or any in-progress git operation marker exists (`.git/rebase-*`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`). Records the user's starting ref (`HEAD` symbolic name) for restoration on rebase abort. Exit `13` |
| Runtime tempdir | Same as pr-open: `~/.claude/code-review/stark-gh/runtime/` |
| Output validation | TS validates Stage 2 output against fixed JSON Schema (R3-claude/api-design): `{ "subject": string ≤72, "body": string ≤16KB, "changelog_bullet": string matching `^- .{1,198}$` (single line, no embedded newlines) }`. No additional properties. Rejects `Closes`/`Refs` lines in any field (issue linking is pr-open's responsibility). Schema lives at `plugins/stark-gh/tools/lib/draft_schema.json` and is loaded by both `gh_pr_merge_draft.ts` (Codex prompt + post-validation) and tests |
| Override audit (R3-codex/security) | Each invocation of `--force`, `--allow-secret-commit`, or `--allow-secret-to-llm` writes a JSON line to `~/.claude/code-review/stark-gh/audit/pr-merge.log` (mode `0600`) with `{timestamp, runId, pr, flag, user, hostname, reason?}`. `--allow-secret-to-llm` additionally prints a stderr warning: "WARNING: secret material is being sent to an external LLM provider; review provider data-handling policies" |
| Pagination (R3-codex/api-design) | GraphQL check-rollup query requests `contexts(first:100)`. If `pageInfo.hasNextPage`, paginate via `after:` cursor. Aggregate all pages before applying `isCheckPassing` predicate. Tests assert correct multi-page handling |

## Gate Matrix

Authoritative table reconciling Decisions and Stage 1. `--force` only affects the third column.

| Condition | Always-enforced | Bypassable with `--force` | Exit code |
|-----------|:---------------:|:-------------------------:|:---------:|
| `state != OPEN` (closed / merged) | ✓ | | 11 |
| `isCrossRepository == true` | ✓ | | 17 |
| `origin/<headRef>` ≠ PR `headRefOid` | ✓ | | 17 |
| Local `<headRef>` ≠ `origin/<headRef>` (unpushed local commits) | ✓ | | 18 |
| `mergeable == CONFLICTING` | ✓ | | 13 |
| Working tree dirty / git op in progress | ✓ | | 13 |
| `CHANGELOG.md` missing or no `[Unreleased]` | ✓ | | 15 |
| `isDraft == true` | | ✓ | 11 |
| `reviewDecision == CHANGES_REQUESTED` | | ✓ | 11 |
| Any required check failing | | ✓ | 12 |
| `--no-watch` and not all required checks success | | ✓ | 12 |
| Secret in pre-LLM scan (no `--allow-secret-to-llm`) | ✓ | | 16 |
| Secret in pre-commit scan (no `--allow-secret-commit`) | ✓ | | 28 |

**`--force` never bypasses GitHub branch protection.** GitHub itself remains the authoritative trust boundary at the merge point.

## Command Surface

```
/stark-gh:pr-merge [--pr N]
                   [--changelog-section Added|Changed|Fixed|Removed|Deprecated|Security]
                   [--force]
                   [--no-watch]
                   [--allow-secret-commit]
                   [--allow-secret-to-llm]
```

## Pipeline Architecture

### Stage 1 — Preflight (`gh_pr_merge_preflight.ts`)

1. Parse `--raw-args` via shared `lib/shell_quote.ts`.
2. **Working-tree gate (H02):** verify `git status --porcelain` is empty AND no in-progress git operation markers exist (`.git/rebase-*`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`). Else exit `13`. Record `startingRef` (current symbolic ref of `HEAD`) for restoration on rebase abort.
3. Resolve target PR:
   - If `--pr N`, fetch by number.
   - Else `gh pr view --json number,headRefName,baseRefName,url,isDraft,state,mergeable,reviewDecision,labels,headRepositoryOwner,headRepository,isCrossRepository,headRefOid`.
   - Fail with exit `10` if no PR for current branch (when `--pr` not given).
4. **Watcher recovery check (H12/H14):** look for existing watcher state at `~/.claude/code-review/stark-gh/watchers/<host>/<owner>/<repo>/pr-<N>/latest.json`. If a non-terminal state file exists with a live lock, exit `34` (already-attached) and print the state-file path so the user can attach manually. Terminal states (`merged`, `merge_failed`, `base_moved`, `head_moved`, `aborted`, `secret_in_prose`) do not block.
5. **PR identity gate (rt1):** if `isCrossRepository == true`, exit `17` (fork PRs unsupported in v1). Capture `headRepositoryOwner`, `headRepositoryName`, and `headRefOid` (= `originalHeadOid`).
6. Apply gate matrix (see Gate Matrix above). Force-bypassable gates skipped if `--force`.
7. `git fetch --no-tags origin <baseRef> <headRef>`.
8. **Verify head identity (rt1):** `git rev-parse origin/<headRef>` must equal `originalHeadOid`. Else exit `17` (PR head moved or local fetch is stale).
8a. **Local sync gate (R2-H3):** verify `git rev-parse <headRef>` (local) equals `git rev-parse origin/<headRef>`. Else exit `18` — user has unpushed local commits on the PR branch and must push or reset before merging.
9. Capture `baseOid = origin/<baseRef> SHA`.
10. Local rebase: check out `headRef`, run `git rebase origin/<baseRef>`. On conflict: `git rebase --abort`, restore `startingRef`, exit `13`.
11. Capture `rebasedHeadOid = HEAD SHA`.
12. Verify `CHANGELOG.md` exists at repo root and contains `## [Unreleased]`. Else exit `15`.
13. Resolve changelog section: `--changelog-section` flag, else label-inferred (`bug`/`fix` label → Fixed; else Added).
14. Run pre-LLM secret scan (reuse pr-open's `lib/secret.ts`) over: PR title, PR body, commit messages on the rebased branch, diff vs base. Exit `16` if found and `--allow-secret-to-llm` not set.
15. Generate `runId` (UUIDv4) for idempotency keys (rt7).
16. Write plan-file to runtime dir, mode `0600`. Emit path on stdout.

### Stage 2 — Draft (`gh_pr_merge_draft.ts`)

1. Read plan-file.
2. Build prompt for Codex with `untrusted`-wrapped fields:
   - PR title, body, commit messages on rebased branch
   - Diff summary (file shortstat + change-type)
   - Target changelog section name
3. Subprocess-call `codex exec` (shared `lib/codex.ts`).
4. Parse JSONL response; expect `{ subject, body, changelog_bullet }`.
5. Validate output (caps + format rules above). Retry once on validation failure.
6. Write three tempfiles under runtime dir, mode `0600`.
7. Atomic-update plan-file with tempfile paths.

### Stage 3 — Execute (`gh_pr_merge_execute.ts`)

1. Read plan-file. Re-fetch `origin/<baseRef>` and `origin/<headRef>`.
2. Verify `baseOid` unchanged and `origin/<headRef>` still equals `originalHeadOid`; else exit `30`.
3. Verify local `HEAD` SHA matches `rebasedHeadOid`; else exit `30` (working tree moved).
4. **Pre-commit secret scan (H05/H16):** scan drafted subject + drafted body + drafted changelog bullet. Exit `28` if found and `--allow-secret-commit` not set; else if override set, redact matching spans in all three artifacts (rewrite tempfiles atomically) before any file mutation.
5. **Apply changelog edit via `lib/changelog.ts`** (canonical algorithm — single source of truth for the marker contract):
   - Read `CHANGELOG.md`.
   - Search for marker comment `<!-- stark-gh:pr-merge pr=<N> ` inside `## [Unreleased]` (match on PR number prefix; ignore `runId` for matching).
   - **If marker found** AND new bullet byte-identical to existing bullet: leave file unchanged (no `runId` update). Goto step 6.
   - **If marker found** AND new bullet differs: replace the single bullet line immediately following the marker; rewrite the marker line with current `runId`. Atomic write.
   - **If marker not found** (first run): locate or create `### <Section>` under `[Unreleased]`. Insert at top of subsection:
     ```
     <!-- stark-gh:pr-merge pr=<N> runId=<UUID> -->
     - <bullet text>
     ```
     Atomic write.
6. Stage and commit changelog: `git add CHANGELOG.md && git commit -m "chore(changelog): <bullet text>"`. Capture `changelogCommitOid`. If `git diff --cached` is empty (file byte-identical from step 5), skip the commit and reuse `changelogCommitOid` from the plan-file.
7. Verify origin URL matches PR's `nameWithOwner`; else exit `31`.
8. **Explicit-OID force-push (rt5):** `git push --force-with-lease=refs/heads/<headRef>:<originalHeadOid> origin HEAD:refs/heads/<headRef>`. **On rejection (R3-claude/resilience):** roll back the local changelog commit via `git reset --hard <originalHeadOid + rebase result>` (i.e., `rebasedHeadOid` captured in step 11 of preflight); restore CHANGELOG.md from object store; print rejection reason; exit `31`. Local branch is left in the rebased state without the changelog commit, so retry is clean.
9. Capture `pushedHeadOid = HEAD SHA` and atomic-update plan-file with `changelogCommitOid` and `pushedHeadOid` (rt7).
10. If `--no-watch` (R2-H8/H9):
    - Run shared OID re-verify helper (`lib/verify_oids.ts`): re-fetch `origin/<baseRef>`; `gh api graphql` for PR `headRefOid`; require `baseOid` and `pushedHeadOid` unchanged. Else exit `30`.
    - Query GraphQL rollup (per Required-check source decision); apply `isCheckPassing` predicate. Require all required checks passing (vacuous-true if zero required). Else exit `12`. **Note:** force-push typically restarts CI; `--no-watch` exits `12` in the common case. Use default-watch unless you have a specific reason.
    - Run `gh pr merge --squash --subject-file <f> --body-file <f> --delete-branch <pr#>`. Exit `32` on failure.
    - Print merge SHA + PR URL. `--delete-branch` deletes only the **remote** branch.
11. Else (default):
    - Spawn `gh_watch_runs.ts --on-green pr-merge-complete --plan-file <path>` in background. The `pr-merge-complete` callback name is resolved against the registry in `lib/watcher_callbacks.ts` (H11).
    - **Spawn-fail recovery (R3-codex/completeness):** if spawn fails, the force-push has already landed (post-rollback-window). Plan-file is retained on disk. Print: PR URL, plan-file path, and instruction "Watcher spawn failed; rerun `/stark-gh:pr-merge --pr <N>` to retry watcher-only (preflight detects the existing plan-file and resumes from Stage 3 step 10 with a fresh spawn attempt)." Exit `33`. Preflight resume path: if plan-file exists for this PR with `pushedHeadOid` set and no terminal watcher state, skip Stage 1 mutations and proceed directly to spawn.
    - On spawn success: print PR URL + watcher state-file path.
12. **Plan-file lifecycle (H14):** in `--no-watch` mode, unlink plan-file on success. In background mode, **plan-file is retained** until the watcher writes a terminal state; the watcher (or `gh_pr_merge_complete.ts`) is responsible for the final unlink.

### Watcher merge callback

Extend `gh_watch_runs.ts` with `--on-green <name>` flag (H11). `name` is resolved against a registry in `lib/watcher_callbacks.ts`:

```ts
// lib/watcher_callbacks.ts
export const WATCHER_CALLBACKS = {
  "pr-merge-complete": "gh_pr_merge_complete.ts",
  // Future: "pr-rebase-complete": "...", etc.
} as const;
```

Arbitrary tool paths are forbidden — the watcher refuses unknown names. This closes the unconstrained-subprocess-execution sink that an earlier `--on-green-tool <path>` flag would have created.

**Watcher SHA-match contract (H13):** the watcher only signals on-green when (a) at least one check run targeting `pushedHeadOid` (from plan-file) has been observed in the polled list, and (b) all required checks on `pushedHeadOid` are `success`. Stale check runs against pre-rebase head OIDs are filtered out and ignored.

For pr-merge, the on-green tool (`gh_pr_merge_complete.ts`) does:

1. Read plan-file.
2. **OID re-verify (rt4)** via shared `lib/verify_oids.ts` (R2-H9): re-fetch `origin/<baseRef>`; `gh api graphql` for PR `headRefOid`. If `baseOid` differs from plan, write terminal state `base_moved` and exit. If PR `headRefOid` differs from `pushedHeadOid`, write terminal state `head_moved` and exit. The same helper is invoked by Stage 3 step 10 (`--no-watch` path) — single canonical comparison logic.
3. **Pre-merge secret rescan (H01):** read drafted subject + body tempfiles and re-run `lib/secret.ts` over them. If a secret is found AND `--allow-secret-commit` was not set in the plan, write terminal state `secret_in_prose` and exit (no merge). With override, proceed (spans were already redacted in execute step 4).
4. Run `gh pr merge --squash --subject-file <f> --body-file <f> --delete-branch <pr#>`. Note this deletes only the **remote** branch.
5. Capture merge SHA.
6. Write final watcher state file with status `merged`, merge SHA, and a cleanup hint **using slash-command form (rt3)**:
   ```
   Merge complete. To clean up locally, run:
     /stark-gh:cleanup --pr <N>
   ```
   The hint never contains raw shell commands with untrusted ref names.
7. Unlink plan-file and prose tempfiles.

If merge fails post-green (e.g., branch protection blocks): write final state with status `merge_failed` and surface stderr verbatim. Branch is not deleted; plan-file and tempfiles are retained for diagnosis.

## Plan-File Schema

```json
{
  "version": 1,
  "command": "pr-merge",
  "runId": "uuid-v4",
  "pr": {
    "number": 123,
    "headRef": "feat/foo",
    "baseRef": "main",
    "url": "https://github.com/...",
    "nameWithOwner": "Evinced/stark-skills",
    "headRepositoryOwner": "Evinced",
    "headRepositoryName": "stark-skills",
    "isCrossRepository": false
  },
  "baseOid": "<sha>",
  "originalHeadOid": "<sha>",
  "rebasedHeadOid": "<sha>",
  "changelogCommitOid": "<sha or null until step 6>",
  "pushedHeadOid": "<sha or null until step 9>",
  "changelog": {
    "filePath": "/abs/path/CHANGELOG.md",
    "section": "Added",
    "markerComment": "<!-- stark-gh:pr-merge pr=123 runId=<UUID> -->"
  },
  "startingRef": "refs/heads/feat/foo",
  "stage2": {
    "skip": false,
    "subjectFile": "/runtime/.../subject.txt",
    "bodyFile": "/runtime/.../body.md",
    "changelogBulletFile": "/runtime/.../bullet.txt",
    "model": "gpt-5.5",
    "reasoningEffort": "medium"
  },
  "execute": {
    "watch": true,
    "force": false,
    "secretOverrides": { "commit": false, "toLlm": false }
  }
}
```

`runId`, `originalHeadOid`, `changelogCommitOid`, `pushedHeadOid`, and `changelog.markerComment` form the rt7 idempotency-key set. Reruns detect existing tool-created changelog entries by **marker comment** (matched on PR number) and update in place rather than appending duplicates. The marker is a stable sentinel embedded in `CHANGELOG.md` itself, so detection survives plan-file deletion.

The `lib/plan.ts` module gains a discriminator on `command` (`"pr-open"` vs `"pr-merge"`) and per-command field types.

## Exit Codes

Reuse pr-open's stable codes where applicable; merge-specific codes added:

| Code | Stage | Meaning |
|------|-------|---------|
| 0 | any | success |
| 10 | preflight | bad args / unknown PR / no PR for current branch |
| 11 | preflight | PR is draft, closed, or merged (no `--force` for draft) |
| 12 | preflight / execute | failing or missing required checks (no `--force`); or `--no-watch` with non-green checks |
| 13 | preflight | rebase conflict |
| 14 | preflight | base OID moved between fetch and plan write |
| 15 | preflight | CHANGELOG.md missing or has no `[Unreleased]` section |
| 16 | preflight | secret in pre-LLM scan, no `--allow-secret-to-llm` |
| 17 | preflight | cross-repository (fork) PR — unsupported in v1 (rt1); or `origin/<headRef>` != PR's `headRefOid` |
| 18 | preflight | local `<headRef>` has unpushed commits or diverges from `origin/<headRef>` (R2-H3) |
| 34 | preflight | watcher already running for this PR — liveness verified by PID + start-time + hostname; recovery hint printed |
| 20 | draft | codex error / invalid output after retry |
| 28 | execute | secret in pre-commit scan, no `--allow-secret-commit` |
| 30 | execute | base OID or rebased HEAD moved between push and merge |
| 31 | execute | force-push rejected, or origin URL mismatch |
| 32 | execute | gh merge failed (non-OID reason; e.g., branch protection) |
| 33 | execute | watcher spawn failed |

## Repository Structure

```
plugins/stark-gh/
├── commands/
│   ├── pr-open.md                    # existing
│   └── pr-merge.md                   # NEW
├── tools/
│   ├── gh_pr_merge_preflight.ts      # NEW Stage 1
│   ├── gh_pr_merge_draft.ts          # NEW Stage 2
│   ├── gh_pr_merge_execute.ts        # NEW Stage 3
│   ├── gh_pr_merge_complete.ts       # NEW watcher on-green callback
│   ├── gh_watch_runs.ts              # MODIFIED: add --on-green <name> registry-resolved flag, SHA-match filter
│   ├── lib/
│   │   ├── changelog.ts              # NEW: marker-comment insert/update under [Unreleased] → <Section>
│   │   ├── watcher_callbacks.ts      # NEW: registry of allowed --on-green callback names
│   │   ├── verify_oids.ts            # NEW: shared base/head OID re-verify helper (--no-watch + on-green)
│   │   ├── checks_graphql.ts         # NEW: GraphQL query for PR check rollup with isRequired + headRefOid
│   │   ├── plan.ts                   # MODIFIED: extend schema for pr-merge
│   │   └── (rest reused unchanged)
│   └── __tests__/
│       ├── changelog_lib.test.ts
│       ├── merge_preflight_args.test.ts
│       ├── merge_preflight_gates.test.ts
│       ├── merge_preflight_rebase.test.ts
│       ├── merge_preflight_watcher_recovery.test.ts
│       ├── merge_draft.test.ts
│       ├── merge_draft_validation.test.ts
│       ├── merge_execute_secret_scan.test.ts
│       ├── merge_execute_changelog.test.ts
│       ├── merge_execute_push.test.ts
│       ├── merge_execute_no_watch.test.ts
│       ├── merge_execute_idempotency.test.ts
│       ├── watcher_on_green.test.ts
│       ├── merge_complete_oid_reverify.test.ts
│       ├── merge_complete_secret_rescan.test.ts
│       └── integration_merge_happy.test.ts
└── README.md                         # MODIFIED: add pr-merge usage + smoke test
```

Also modified:
- `plugins/stark-gh/.claude-plugin/plugin.json` — register pr-merge
- `CLAUDE.md` — add command to Pipeline section

## Testing

Mirror pr-open's per-unit + per-stage + integration layout. **Every rt mitigation has explicit test coverage** (H17–H21).

### Unit
- `changelog_lib.test.ts` — `[Unreleased]` insertion / marker-update edge cases:
  - missing `[Unreleased]` section, empty section, multiple subsections, nested headers
  - first-run insert (no marker present): correct subsection placement, marker line above bullet
  - rerun update (marker present, same PR): bullet line replaced in place; marker line `runId` updated; no duplicate bullet
  - rerun update (marker present, different `runId`): match on PR number, replace
  - byte-identical rerun: no diff, no commit
  - marker comment with shell-meta in PR number is rejected (numbers only)

### Stage 1 — Preflight
- `merge_preflight_args.test.ts` — flag parsing, `--raw-args` round-trip
- `merge_preflight_gates.test.ts` — full gate matrix:
  - **rt1 fork rejection (H19):** `isCrossRepository=true` exits `17`
  - **rt1 head identity (H19):** `origin/<headRef>` SHA differs from PR `headRefOid` exits `17`
  - rt1 happy path: matching OIDs proceeds
  - draft × force: draft + no-force exits `11`; draft + `--force` proceeds
  - changes-requested × force: same matrix
  - failing-checks × force: same matrix
  - `state == OPEN` always-enforced even with `--force`
  - working-tree dirty → exits `13` (H02)
  - in-progress rebase/merge marker → exits `13`
  - `mergeable == CONFLICTING` always exits `13` even with `--force`
  - missing CHANGELOG.md → exits `15`; CHANGELOG without `[Unreleased]` → exits `15`
- `merge_preflight_rebase.test.ts` — rebase success + conflict abort + `startingRef` restoration
- `merge_preflight_watcher_recovery.test.ts` (H12/H14, R2-H11) — existing live watcher state exits `34`; terminal-state files do not block; stale lock (PID dead, hostname mismatch, or start-time mismatch) is treated as stale and run proceeds; takeover is logged
- `merge_preflight_local_sync.test.ts` (R2-H3) — exit `18` when local `<headRef>` SHA differs from `origin/<headRef>` SHA; happy path proceeds when synced
- `merge_preflight_secret_scan.test.ts` (R2-H17) — pre-LLM scan blocks on each input stream (PR title, PR body, commit messages, diff vs base) → exit `16`; `--allow-secret-to-llm` waives only the pre-LLM scan, not the pre-commit scan

### Stage 2 — Draft
- `merge_draft.test.ts` — codex stub, output validation, tempfile placement
- `merge_draft_validation.test.ts` (R3-claude/api-design) — JSON Schema validation: subject > 72 chars rejected; body > 16 KB rejected; bullet without `- ` prefix rejected; bullet with embedded newline rejected; bullet > 200 chars rejected; `Closes`/`Refs` lines rejected; additional properties rejected; retry-once on validation failure
- `checks_graphql_pagination.test.ts` (R3-codex/api-design) — 100+ contexts paginated correctly; `pageInfo.hasNextPage` followed; full aggregation before predicate evaluation
- `override_audit.test.ts` (R3-codex/security) — each override flag writes a structured audit line; `--allow-secret-to-llm` prints stderr warning; audit file mode `0600`

### Stage 3 — Execute
- `merge_execute_secret_scan.test.ts` (H18) — pre-commit scan blocking + redaction:
  - secret in subject → exits `28` without `--allow-secret-commit`
  - secret in body → exits `28`
  - secret in changelog bullet → exits `28`
  - with `--allow-secret-commit`: spans redacted in all three artifacts; tempfiles rewritten before any file mutation; CHANGELOG.md not touched until after redaction
- `merge_execute_changelog.test.ts` — covered by `changelog_lib.test.ts`; this asserts the call ordering (scan → redact → write → commit)
- `merge_execute_push.test.ts` (H20, R3-claude/resilience) — explicit-OID lease + rollback assertions:
  - push command literal-string-contains `--force-with-lease=refs/heads/<headRef>:<originalHeadOid>` with the captured pre-rebase OID
  - push rejected → exits `31`; CHANGELOG commit rolled back (HEAD == `rebasedHeadOid`); CHANGELOG.md content restored from object store
  - push rejected does NOT degrade to implicit lease
  - origin URL mismatch → exits `31` (no commit happens, no rollback needed)
- `merge_execute_spawn_fail.test.ts` (R3-codex/completeness) — watcher spawn failure:
  - simulate spawn failure post-push; assert exit `33`, plan-file retained, instruction message printed
  - rerun: preflight detects plan-file with `pushedHeadOid` set, skips Stage 1 mutations, proceeds to fresh spawn attempt
- `merge_execute_no_watch.test.ts` (R2-H8/H9) — `--no-watch` with non-green checks exits `12`; with green checks invokes `gh pr merge --squash --delete-branch` and exits `0`; OID re-verify helper invoked before merge — `baseOid` mismatch → exit `30`, `pushedHeadOid` mismatch → exit `30`; assertion that the same helper is shared with `gh_pr_merge_complete.ts`
- `merge_execute_idempotency.test.ts` (H21) — rt7 rerun safety:
  - rerun with same bullet text + existing marker: changelog unchanged, no new commit, plan retains `changelogCommitOid`
  - rerun with different bullet text + existing marker: bullet replaced in place; new commit
  - rerun matches by PR number even when `runId` differs

### Watcher mode
- `watcher_on_green.test.ts` (H13, R2-H15/H16) — callback name registry resolution + SHA-match states:
  - `--on-green pr-merge-complete` resolves and dispatches
  - `--on-green <unknown>` is rejected at parse time (no subprocess execution)
  - SHA-match contract three states: (a) only stale pre-rebase OID rows present → wait; (b) `pushedHeadOid` rows present with at least one pending → wait; (c) all required passing on `pushedHeadOid` → fire callback
  - Vacuous-pass: zero `isRequired==true` contexts → fires immediately (R2-H15)
  - `isCheckPassing` predicate: NEUTRAL and SKIPPED count as passing; FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE/STALE count as failing
- `watcher_max_wait.test.ts` (R2-H4/H12) — watcher exits with terminal state `watch_timeout` after `--watch-timeout` elapses; default 6h; per-poll HTTP timeout 30s
- `merge_complete_oid_reverify.test.ts` (rt4) — base/head re-verify in `gh_pr_merge_complete.ts`:
  - `baseOid` mismatch → terminal state `base_moved`, no merge invoked
  - PR `headRefOid` ≠ plan `pushedHeadOid` → terminal state `head_moved`, no merge invoked
  - both match → merge proceeds
- `merge_complete_secret_rescan.test.ts` (H01) — pre-merge secret rescan:
  - secret introduced in tempfile between execute and on-green → terminal state `secret_in_prose`, no merge
  - with `--allow-secret-commit` set in plan: rescan is informational; merge proceeds (already-redacted)

### Integration
- `integration_merge_happy.test.ts` — end-to-end with `gh` shim:
  - fakes green CI, asserts squash-merge call shape, final state-file content includes `/stark-gh:cleanup --pr N` (rt3)
  - asserts cleanup hint contains zero shell metacharacters and zero raw `git` commands

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Force-push triggers CI re-run; watcher polls stale checks from before force-push | Watcher polls by current head SHA; force-push changes the SHA, so old check runs are not picked up |
| Base moves during the wait window | Watcher's on-green callback re-verifies `baseOid` and `pushedHeadOid` (rt4); on mismatch, writes terminal state `base_moved` or `head_moved` and aborts merge |
| PR identity confused with branch name | rt1 mitigations: capture `headRefOid` + reject cross-repo PRs in v1; verify `origin/<headRef>` resolves to captured OID before rebase |
| Implicit `--force-with-lease` overrides collaborator commits | rt5: explicit-OID lease using `originalHeadOid` captured pre-rebase |
| Cleanup hint contains shell metacharacters from untrusted ref | rt3: cleanup hint uses slash-command form `/stark-gh:cleanup --pr N`, never raw shell with refs |
| Rerun creates duplicate changelog entries | rt7 marker-comment idiom: `<!-- stark-gh:pr-merge pr=N runId=UUID -->` embedded above the bullet in CHANGELOG.md. Reruns match on PR number and update the bullet line in place. Detection survives plan-file deletion |
| User edits CHANGELOG.md between preflight and execute | Stage 3 re-reads the file before mutation. Marker-based update is byte-exact; no overlap with manual edits unless user removes the marker line (treated as first-run) |
| Watcher dies mid-poll, merge never happens | rt7 + H14: plan-file retained until terminal state. Preflight (step 4) detects existing watcher state and exits `34` with state-file path so user can attach. v1 does not auto-resume the watcher process — that's v2 work |
| Branch protection blocks `gh pr merge` post-green | `gh_pr_merge_complete.ts` surfaces stderr; final state shows `merge_failed`; branch not deleted; plan-file retained for diagnosis |
| Secret in drafted prose | H05/H16: pre-commit scan runs *before* CHANGELOG.md write, with redact-on-override. H01: watcher's on-green callback re-scans tempfiles before merge; failure → terminal state `secret_in_prose`, no merge |
| Dirty working tree on rebase | H02: Stage 1 step 2 refuses non-empty `git status --porcelain` or any in-progress git op marker before any mutation; `startingRef` recorded for post-abort restoration |
| Unconstrained `--on-green-tool` subprocess sink | H11: replaced with `--on-green <name>` resolved against `lib/watcher_callbacks.ts` registry; arbitrary paths refused |
| Watcher signals on stale check runs from pre-rebase OID | H13: SHA-match contract — on-green only fires when checks targeting `pushedHeadOid` are observed and pass |

## Considered & Rejected (round 3, 2026-04-28)

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| R3-codex/scope | scope | Mandatory CHANGELOG mutation over-scopes the merge command; should be optional | **Rejected.** Fundamental design choice (B + Update ChangeLog) made in brainstorming. CHANGELOG entry is the value-add of pr-merge; making it optional reverts to plain `gh pr merge` |
| R3-codex/security | security | Watcher's secret rescan fails open with `--allow-secret-commit` set | **By design.** The override flag means the user has explicitly accepted the risk; rescan with override is informational only (logged to audit file) |
| R3 wording-only consistency drift | consistency | Multiple findings citing predicate-name drift / two-phrasings-of-same-rule | **Accepted as polish.** Substantive contradictions resolved in rounds 1–2; remaining items are wording-only and can be tightened during implementation |
| R3-claude/test-plan | test-plan | No load/concurrency test for changelog marker contention | **Deferred to v2** (same as R2-H13 / rt6 — concurrent-merge bottleneck) |

## Considered & Rejected (round 2, 2026-04-28)

Two findings deferred from the round-2 design review:

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| **R2-H13** | scalability | CHANGELOG.md is a serial merge bottleneck under concurrent pr-merge runs | **Deferred to v2.** Same as red-team rt6 — already deferred. If concurrent-merge contention becomes real, switch to per-PR fragment files. v1 acceptable for current usage |
| **R2-H14** | security | Codex subprocess boundary not sandboxed (env, FS, network) | **Deferred to v2.** Codex CLI invocation pattern is shared with pr-open and stark-review across the entire stark-skills repo; sandboxing is a cross-cutting hardening project, not pr-merge's scope. Tracked separately |

## Considered & Rejected (red-team v1, 2026-04-28)

Findings from `2026-04-28-stark-gh-pr-merge-design.red-team.md` reviewed and applied selectively. Applied: rt1, rt3, rt4, rt5, rt7. Deferred:

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| **rt2** | security-trust | Make draft + CHANGES_REQUESTED gates non-bypassable; `--force` should not exist | **Deferred.** `--force` retained as audited escape hatch. GitHub branch protection remains the authoritative trust boundary; the override never bypasses it. Non-bypassability is dogmatic for a single-user dev tool |
| **rt6** | data | Fragment-based per-PR changelog files instead of direct CHANGELOG.md edits | **Deferred to v2.** Direct CHANGELOG edit was the explicit design choice for atomic squash + entry. Fragment model is a defensible v2 if parallel-merge contention becomes real |
| **rt8** | product-dx | Default flow stops after Stage 2 with preview; require `--yes` for execute | **Deferred.** Inverts the happy path. Future enhancement: opt-in `--preview` flag |
| **rt9** | product-dx | Rebase in temp worktree; only update user's branch on success | **Deferred.** Worktree-mutation risk is contained: `git rebase --abort` restores. Temp-worktree complexity not justified for v1 |
| **rt10** | cost-ops | Use `gh pr merge --auto --squash` instead of local watcher | **Rejected.** Discussed in brainstorming and explicitly rejected — auto-merge would lose CI-failure visibility and may merge stale CI under our rebase + force-push timing |
| **rt11** | cost-ops | `--draft=template\|codex` flag; template default for automation | **Rejected.** A skip-draft flag was discussed in brainstorming and explicitly dropped (single-purpose command, drafting is the value-add) |

## Out of Scope (v1)

- Local cleanup (checkout, branch delete) — future `/stark-gh:cleanup`.
- Cross-repository (fork) PRs — rejected with exit `17` (rt1); future work.
- Resuming an interrupted watcher — v1 prints orphan hint only.
- Non-squash merge strategies.
- Multi-PR batch merge.
- Auto-rebase on `mergeable: BEHIND` without `--force` (v1 always rebases; no opt-out).
- Editing CHANGELOG.md format (always Keep a Changelog `## [Unreleased]` → `### <Section>`).
