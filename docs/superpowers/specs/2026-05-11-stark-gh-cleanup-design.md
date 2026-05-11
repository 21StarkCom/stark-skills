# stark-gh:cleanup Design Spec

## Overview

`/stark-gh:cleanup` removes finished or abandoned work from a repository so that the main worktree stays linear and clean. Given PR numbers, raw branch names, a target repo, or no arguments at all (audit mode), it resolves a deletion plan and then deletes remote refs, local branches, and attached worktrees in a single pass. It is the third command in the `stark-gh` family, after `/stark-gh:pr-open` and `/stark-gh:pr-merge`, and follows the same two-stage TypeScript pipeline shape (preflight + execute) — minus the LLM "draft" stage that destructive deletion does not need.

The README for `stark-gh` already anticipates this command (`plugins/stark-gh/README.md:35-39`) as the canonical successor to the manual `gh api -X DELETE … + git branch -D …` recipe documented as a placeholder. Cleanup also shares territory with `/stark-housekeeping` Phase 2 and `/clean_gone`, but neither covers the targeted, PR-driven case: `/clean_gone` only handles `[gone]` local branches, and `/stark-housekeeping` is an audit-style sweep with broader (and slower) scope. Cleanup is the fast, targeted lever.

## Decisions

| Decision | Choice |
|----------|--------|
| Command name | `/stark-gh:cleanup` |
| Pipeline shape | Two TS stages: preflight (parse + resolve + plan) → execute (delete). No draft/LLM stage. |
| Input modes | `--pr N[,N,...]`, `--branch NAME[,NAME,...]`, `--repo OWNER/NAME`, and no-args audit. All combinable. |
| Cleanable PR states | Merged, closed-not-merged, open-stale (gated by `--stale-days N`), draft-stale (additionally gated by `--include-drafts`). |
| Safety model | "Just do it" — print the plan, execute, summarize. No interactive prompts. `--dry-run` for preview. Destructive failures are recorded per-action; the run does not abort early. |
| Worktree handling | Always `git worktree remove --force`, mirroring `/clean_gone`. The user accepted this risk; documented in the README. |
| Protected branches | Hardcoded `main`, `master`, `develop` + repo default branch (from `gh.ts:repoView()` → `defaultBranchRef`) + currently-checked-out HEAD (when HEAD is a branch — detached HEAD has no name to protect). Never overridable. |
| No `--force` flag | Git refuses to `branch -D` a checked-out branch regardless of any flag we'd pass, so a `--force` to "override HEAD protection" would do nothing useful. Omitted to keep the surface honest. To clean the branch you're on, switch off it first. |
| Fork PRs | Any PR whose `head.repo.full_name` differs from `base.repo.full_name` is skipped with `skipReason: "fork"`. We don't have permission to delete refs on contributor forks, and we don't want to. |
| Cross-repo | When `--repo OWNER/NAME` differs from cwd's `origin` (detected via `gh.ts:repoView()` + `gh.ts:originMatches()`), only remote-side actions run. Local branch and worktree actions are skipped — we don't operate on a checkout we don't have. |
| State integrity | Preflight records each remote head's current SHA. Execute re-fetches via `gh api repos/<r>/git/ref/heads/<branch>` immediately before the delete; if the SHA has moved, the action is skipped with `skipReason: "head-sha-drift"`. Prevents deleting a branch that someone just pushed to. |
| Args policy | Skill body forwards `$ARGUMENTS` verbatim to preflight as a single quoted `--raw-args` value. Preflight is the only parser. (Same rule as `pr-open` / `pr-merge`.) |
| Plan-file location | `~/.claude/code-review/stark-gh/cleanup/<ts>-<rand>.json`, mode `0600` (dir mode `0700`). Mirrors existing stark-gh runtime layout. |
| Plan-file lifecycle | Written by preflight; consumed by execute; `unlink`ed on execute success. Left on disk if execute fails (for debugging). |
| Exit codes | `0` success / `2` bad args / `3` nothing-to-do / `4` partial failure / `5` unrecoverable / `64` preflight bug. |
| Stdout contract | Human table to stderr; final `{"event":"cleanup-complete",...}` JSON on stdout. Matches `output.ts` convention. |
| TS runtime | `node --experimental-strip-types` (stark plugin convention). |
| Install | No install.sh change — plugin loop already discovers new commands under `plugins/stark-gh/commands/`. |

## Repository Structure

```
plugins/stark-gh/
├── commands/
│   ├── pr-open.md
│   ├── pr-merge.md
│   └── cleanup.md                      # NEW — slash-command wrapper
├── tools/
│   ├── gh_cleanup_preflight.ts         # NEW — Stage 1
│   ├── gh_cleanup_execute.ts           # NEW — Stage 2
│   ├── lib/                            # (existing, reused as-is)
│   │   ├── branch.ts                   # branch-name validation, local-branch ops
│   │   ├── gh.ts                       # gh CLI helpers
│   │   ├── git.ts                      # git plumbing (execFileSync)
│   │   ├── plan.ts                     # plan-file read/write + schema validation
│   │   ├── runtime.ts                  # tempdir helper (0700/0600)
│   │   ├── shell_quote.ts              # POSIX --raw-args tokenizer
│   │   ├── output.ts                   # printJson() / printErr()
│   │   ├── exit.ts                     # numbered exit codes
│   │   ├── redact.ts                   # used by error reporter to scrub tokens
│   │   └── types.ts                    # extended with CleanupPlan types
│   └── __tests__/
│       └── cleanup/                    # NEW — jest suites
│           ├── preflight_pr.test.ts
│           ├── preflight_branch.test.ts
│           ├── preflight_audit.test.ts
│           ├── preflight_protected.test.ts
│           ├── preflight_cross_repo.test.ts
│           ├── preflight_stale.test.ts
│           ├── execute_happy.test.ts
│           ├── execute_partial_failure.test.ts
│           ├── execute_dry_run.test.ts
│           ├── execute_worktree.test.ts
│           └── integration.test.ts
└── README.md                           # updated: cleanup section, smoke test
```

No new `lib/` files. No `config.json` schema change.

## Argument Surface

| Flag | Default | Description |
|------|---------|-------------|
| `--pr N[,N,...]` | — | Cleanup specific PRs by number. Comma-separated list, no spaces. |
| `--branch NAME[,NAME,...]` | — | Cleanup branch(es) directly by name. Bypasses PR lookup. |
| `--repo OWNER/NAME` | cwd's `origin` | Target a non-current repo. Combinable with `--pr` / `--branch`. Triggers cross-repo mode (remote-only actions). |
| `--stale-days N` | off | Also include open PRs idle for ≥ N days (compared against `updated_at`). Closes the PR before deleting the head ref. `N` must be a positive integer; `--stale-days 0` is rejected at parse time. |
| `--include-drafts` | false | When `--stale-days` is set, also include stale drafts. Otherwise drafts are skipped. |
| `--stale-author-self-only` | **on** | Restrict stale-PR closure to PRs authored by the current `gh` user. Opt out (`--stale-author-self-only=false`) to act on others' PRs. Conservative-by-default: closing another author's PR posts a public comment under the operator's identity. |
| `--dry-run` | false | Preflight runs to completion; execute is skipped. Plan-file path is printed; no mutations. |
| `--allow-no-pr-match` | false | If a `--pr N` cannot be resolved (404, wrong repo), warn and continue instead of exiting `2`. |
| `--audit-max-prs N` | `500` | In audit mode, stop paginating closed PRs after N. Prevents unbounded run time on large repos. Emits a `truncated` warning in the plan if the cap is hit. |
| `--no-color` | false | Disable ANSI color in the human table. |

`--branch` accepts literal branch names only (no globs in v1). Reserved git names (`HEAD`, `@`, `-`, names starting with `-`, names containing `..`) are rejected at parse time. Unicode and slash characters are allowed (`feat/some-thing-ñ` is valid).

`--pr` values must be positive integers (regex `^[1-9][0-9]*$`). Invalid values (`0`, negative, non-numeric, empty) exit `2` with the offending token in stderr.

**Input mode resolution:**

1. If `--pr` is set → add each PR's head branch to the candidate set.
2. If `--branch` is set → add each name to the candidate set directly.
3. If `--stale-days` is set → add open PRs in the target repo idle ≥ N days (filtered by `--include-drafts`).
4. If none of (1)/(2)/(3) is set → **audit mode**: include all merged + closed-not-merged PRs (paginated) and all `[gone]` local branches.

Modes are additive. `--pr 569 --branch feat/orphan --stale-days 30` produces a union.

## Action Semantics

The unit of work is a **branch-cleanup action**. Each action has up to five ordered steps:

0. **Eligibility gate** (preflight only, recorded on the action). Three reasons can short-circuit an action to `skip: true` before any step runs:
   - `"protected"` — branch is in the protected list.
   - `"fork"` — the source PR's head is on a contributor fork (`head.repo.full_name` ≠ `base.repo.full_name`).
   - `"not-found"` — neither remote nor local branch exists.
1. **PR closure** (only for stale-open / stale-draft sources). `gh pr close <N> --comment "Closed by /stark-gh:cleanup — stale for <N> days (no activity since <date>)."` Records the comment URL.
2. **HeadSha drift re-check** (execute only, only when `remote.exists` and the source recorded a `headSha`). `gh api repos/<r>/git/ref/heads/<branch>` → if SHA ≠ preflight-recorded SHA, the action is skipped with `skipReason: "head-sha-drift"` and no further steps run. Protects against someone pushing to the branch between preflight and execute.
3. **Remote ref delete.** `gh api -X DELETE /repos/<owner>/<repo>/git/refs/heads/<headRef>`. Treats 404 as success (idempotent). 422 with body matching "Reference does not exist" is also treated as success. All other non-2xx is a step failure.
4. **Worktree removal** (skipped in cross-repo mode). For each worktree on this branch found by `git worktree list --porcelain`: `git worktree remove --force <path>`. Multiple worktrees per branch is rare but supported. If worktree removal fails, step 5 is skipped for this action (a still-attached worktree would block `branch -D` and produce noise).
5. **Local branch delete** (skipped in cross-repo mode). `git branch -D <name>`. `git branch -D` is used (not `-d`) because the remote is already gone by this point and `-d` would refuse on unmerged commits — the user has opted into destruction by invoking the command. Git refuses to delete a checked-out branch; HEAD-protection in step 0 catches that case earlier.

**Ordering rationale.** Remote-first, then local. If a step fails mid-action, partial deletion is still recoverable: a leftover remote ref can be re-deleted, a leftover local branch can be re-deleted, but a deleted local branch with an orphaned remote ref is harder to spot. Remote ref disappears = the GitHub PR view stops listing it as recoverable.

**Failure isolation.** A failed step records `error: { code, stderr }` on the action and aborts only that action's remaining steps. Other actions in the plan continue. Final exit code reflects the worst per-action outcome.

## Plan-file Schema

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-05-11T12:34:56Z",
  "command": "stark-gh:cleanup",
  "repo": {
    "owner": "GetEvinced",
    "name": "stark-skills",
    "nameWithOwner": "GetEvinced/stark-skills",
    "defaultBranch": "main"
  },
  "cwdRepo": "GetEvinced/stark-skills",
  "crossRepo": false,
  "mode": "pr" | "branch" | "audit" | "mixed",
  "flags": {
    "dryRun": false,
    "staleDays": null,
    "includeDrafts": false,
    "allowNoPrMatch": false,
    "auditMaxPrs": 500
  },
  "protected": {
    "branches": ["main", "master", "develop"],
    "defaultBranch": "main",
    "currentHead": "feat/some-branch"   // null if detached HEAD or cross-repo
  },
  "actions": [
    {
      "id": "act-001",
      "source": {
        "type": "pr" | "branch" | "audit-pr" | "audit-gone-branch",
        "prNumber": 569,
        "prState": "merged" | "closed" | "open" | "draft",
        "prUpdatedAt": "2026-04-30T10:00:00Z"
      },
      "branchName": "feat/x",
      "needsPrClose": false,
      "remote": { "exists": true },
      "local": { "exists": true, "ahead": 0, "behind": 5, "headSha": "abcd1234..." },
      "worktrees": [
        { "path": "/abs/path", "dirty": false }
      ],
      "skip": false,
      "skipReason": null
    }
  ],
  "summary": {
    "candidates": 7,
    "actionable": 5,
    "skipped": 2,
    "skipReasons": { "protected": 1, "fork": 1 },
    "truncated": false
  }
}
```

`needsPrClose` is true only for stale-open / stale-draft actions; execute calls `gh pr close` before the remote ref delete in that case.

`skip: true` entries are kept in the plan (not filtered out) so the execute summary can faithfully report what was considered and why each was skipped. `skipReasons` is an open map (any string key with a count); known reasons today are `protected`, `fork`, `not-found`, `pr-not-found`, `head-sha-drift`, `cross-repo-no-checkout`.

**Mode resolution:** `pr` when only `--pr` is set; `branch` when only `--branch` is set; `audit` when no input flags are set; `mixed` when two or more of `--pr` / `--branch` / `--stale-days` are set. `--repo` does not change the mode (it changes `crossRepo`).

## Command File (cleanup.md)

The wrapper is intentionally minimal. Pseudo-shape:

```markdown
---
name: cleanup
description: >-
  Delete finished or abandoned PR branches (remote + local + worktrees)
  to keep the main worktree linear. Accepts PRs, branch names, a target
  repo, or no args for audit mode.
argument-hint: "[--pr N[,N,...]] [--branch NAME[,NAME,...]] [--repo OWNER/NAME] [--stale-days N] [--include-drafts] [--dry-run] [--force] [--allow-no-pr-match] [--no-color]"
allowed-tools: Bash, Read
model: sonnet
---

# /stark-gh:cleanup

Destructive: deletes remote refs, local branches, and worktrees.

YOU MUST NOT splice user input into shell commands. Forward $ARGUMENTS
verbatim as a single quoted --raw-args value to preflight.

## Constants
TOOLS="$HOME/.claude/plugins/stark-gh/tools"

## Stage 1 — Preflight
PLAN_FILE=$(node --experimental-strip-types "$TOOLS/gh_cleanup_preflight.ts" \
  --raw-args "$ARGUMENTS" \
  --emit-plan-path)

If preflight exits non-zero, surface stderr verbatim and stop.

## Stage 2 — Execute
node --experimental-strip-types "$TOOLS/gh_cleanup_execute.ts" \
  --plan-file "$PLAN_FILE"

Parse the final JSON {"event":"cleanup-complete",...} and print a
human summary.
```

No bash logic past plumbing. No LLM dispatch. No drafting.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0`  | Success — every actionable item completed (or `--dry-run`). |
| `2`  | Invalid arguments — unknown flag, malformed PR list, conflicting flags. |
| `3`  | Nothing to do — no candidates resolved (e.g., audit mode found no leftover branches). |
| `4`  | Partial failure — at least one action failed; details in JSON summary on stdout. |
| `5`  | Unrecoverable — `gh` auth failure, `git` not on PATH, repo lookup failed, plan-file write failed. |
| `64` | Preflight bug — unhandled exception. |

`--allow-no-pr-match` downgrades unresolved `--pr` numbers from a `2` to a warning recorded in the plan.

## Stdout / Stderr Contract

- **Human table** → stderr (so it can be silenced with `2>/dev/null` without losing the machine summary).
  - Columns: `# | source | branch | remote | local | worktree | action | status`.
- **Machine summary** → stdout, single line: `{"event":"cleanup-complete","exitCode":N,"counts":{...},"actions":[{id,branch,status,error?},...]}`.
- **Errors** → stderr, prefixed with `stark-gh:cleanup: error:`. Tokens scrubbed via `redact.ts` before emission.

`--dry-run` prints the plan-file path on stdout as a second line; execute is not invoked.

## Cross-repo Mode

Triggered when `--repo OWNER/NAME` is set and `OWNER/NAME` does not match cwd's `origin` (parsed by `gh.ts:detectRepo()`).

In cross-repo mode:

- **Active steps:** PR closure, remote ref delete.
- **Skipped steps:** worktree removal, local branch delete. Each carries `skipReason: "cross-repo (no local checkout)"`.
- **Protection list:** loses `currentHead` (HEAD is in a different repo). `main`/`master`/`develop`/`defaultBranch` still apply, sourced from the target repo's `gh repo view`.

This keeps the command safe to run from anywhere: deleting a stranger repo's leftover branches never touches your current checkout.

## Audit Mode (no input flags)

When neither `--pr` nor `--branch` is given, preflight runs:

1. `gh api --paginate "/repos/<owner>/<name>/pulls?state=closed&per_page=100"` → all closed PRs (merged + closed-not-merged).
2. Filter to head refs that still exist on `origin` (intersect with `git ls-remote --heads origin`).
3. `git branch -vv | grep ': gone]'` → all local branches whose upstream is gone (covers branches whose PR was deleted entirely). **Only runs when cwd's repo matches the target repo** — cross-repo audits skip this step because `[gone]` is a local concept.
4. If `--stale-days N`: also pull open PRs idle ≥ N days, optionally including drafts. Filtered by `--stale-author-self-only` (default on) to PRs authored by the current `gh` user.

Each candidate becomes one action. The plan retains the source metadata (`audit-pr` vs. `audit-gone-branch`) so the summary table is informative.

**Pagination guard:** if the repo has more than `--audit-max-prs` (default `500`) closed PRs, preflight stops paginating, sets `summary.truncated: true`, prints a warning, and proceeds with what it has. The warning suggests using `--pr` for specific PRs beyond the cap. Avoids unbounded run time on large repos.

## Failure Modes & Recovery

| Failure | Behavior |
|---------|----------|
| `gh pr view <N>` returns 404 | Skip action with `skipReason: "pr-not-found"`. Exit `2` unless `--allow-no-pr-match`. |
| Source PR is from a fork | Skipped at preflight with `skipReason: "fork"`. Recorded in `summary.skipReasons.fork`. |
| Detached HEAD at preflight | `protected.currentHead: null`. Nothing extra to protect. |
| HeadSha drift between preflight and execute | Step 2 skips the action with `skipReason: "head-sha-drift"`. No exit-failure escalation — user can re-run cleanup; the new SHA will be picked up. |
| Remote ref delete returns 422 ("Reference does not exist") | Treated as success. |
| Remote ref delete returns 422 (other, e.g. branch protection rule) | Step failure; record stderr; continue with other actions. |
| Remote ref delete returns 404 | Treated as success (already gone). |
| `git worktree remove --force` fails (path locked, FS error) | Step failure; record; do NOT proceed to `git branch -D` for this action. |
| `git branch -D` fails | Step failure; recorded. Usually means an attached worktree we missed. |
| `gh pr close` fails on stale-open action | Step failure; do NOT proceed to remote ref delete (the PR is still open; we don't strand it). |
| Plan-file write fails | Exit `5`; nothing was mutated. |
| Network failure mid-run | Per-step recording; exit `4`. Plan-file is preserved for re-run. |

Re-running the same command after a partial failure is idempotent: remote/local "already gone" is success; remaining failures will reproduce until fixed.

## Testing Strategy

Tests live under `tools/__tests__/cleanup/` using the existing jest harness.

**Preflight (mocked `gh.ts` + `git.ts`):**

- `preflight_pr.test.ts` — merged PR → action; closed-not-merged → action; open non-stale → no action; open stale (`--stale-days 7`, `updated_at` = 30 d ago) → action with `needsPrClose: true`; draft stale without `--include-drafts` → skipped; draft stale with `--include-drafts` → action.
- `preflight_branch.test.ts` — existing local + remote → action covers both; nonexistent both sides → skipped with `"not-found"`; whitespace / comma parsing; reserved-name rejection (`HEAD`, `@`, `-`, `..`); unicode + slash branch names accepted (`feat/something-ñ`).
- `preflight_audit.test.ts` — merged PR head refs intersected with `git ls-remote` → actions; `[gone]` local branches → actions in same-repo mode, absent in cross-repo mode; pagination cap (`--audit-max-prs`) triggers `truncated: true` warning.
- `preflight_protected.test.ts` — `main`/`master`/`develop`/default/HEAD never produce actionable entries; detached HEAD yields `currentHead: null`; protected branches still appear in the plan as `skip: true`.
- `preflight_fork.test.ts` — PR with `head.repo.full_name` ≠ `base.repo.full_name` → skipped with `"fork"`; same-repo head → not skipped.
- `preflight_cross_repo.test.ts` — `--repo X/Y` with cwd at `A/B` produces `crossRepo: true`; actions have `local: null`; worktree/branch-delete steps absent; audit mode produces only `audit-pr` (no `audit-gone-branch`).
- `preflight_stale.test.ts` — `updated_at` boundary handling using a fixed-clock fixture (mock `Date.now()` to a known UTC value); exactly N days; ±1 second; `--stale-days 0` rejected; `--stale-author-self-only` filters foreign-author PRs by default and includes them when opted out.
- `preflight_args.test.ts` — `--pr 0`, `--pr -5`, `--pr abc`, empty `--pr`/`--branch`, unknown flag → exit 2 with offending token in stderr.

**Execute (mocked `gh.ts` + `git.ts`):**

- `execute_happy.test.ts` — 3 actions all succeed → exit `0`, JSON summary lists all 3.
- `execute_partial_failure.test.ts` — middle action fails on remote delete → first and third succeed; exit `4`; failed action carries `error`.
- `execute_dry_run.test.ts` — `flags.dryRun: true` → no mutation calls happen; plan-file path printed.
- `execute_worktree.test.ts` — branch with one clean and one dirty worktree → both removed with `--force`; both succeed; `git branch -D` runs after. Worktree-remove failure → `branch -D` skipped for that action.
- `execute_cross_repo.test.ts` (in `preflight_cross_repo.test.ts` group) — remote delete runs; `git` calls do not.
- `execute_pr_close_failure.test.ts` — stale-open action where `gh pr close` fails → remote ref delete is NOT attempted; action fails cleanly.
- `execute_head_sha_drift.test.ts` — execute re-fetches `git/ref/heads/<branch>`; if SHA differs from preflight's record, action skipped with `"head-sha-drift"`; remaining actions proceed.

**Integration:**

- `integration.test.ts` — preflight → plan-file → execute round-trip against mocked gh/git. Validates schema, stable exit codes, JSON contract.

## Smoke Test (README)

Add this section to `plugins/stark-gh/README.md`:

```
## /stark-gh:cleanup — smoke runbook

In a sandbox repo with a disposable PR:

1. Merge or close a disposable PR via the GitHub UI (head ref will linger).
2. From any worktree in the repo, run:
   /stark-gh:cleanup --pr <N> --dry-run
3. Inspect the printed plan-file. Expect one action with the leftover
   branch and the planned remote+local+worktree deletes.
4. Re-run without --dry-run. Expect remote ref gone, local branch gone,
   worktree removed (if any).
5. Re-run a third time. Expect exit 3 (nothing to do).

## /stark-gh:cleanup — squash-merge note

For squash-merged PRs, the local feature branch holds commits that no
longer exist on `main` (the squash created a single new commit). Once
cleanup deletes that branch, the original commits survive only in
`git reflog` (~30 days) — there is no PR-side path back to them. If
you anticipate needing the original commit graph, capture a backup
ref (`git update-ref refs/keep/<name> <branch>`) before invoking cleanup.
```

Replaces the manual `gh api -X DELETE` recipe currently in the README.

## Out of Scope (Explicit Non-goals)

- **Tag cleanup.** `/stark-gh:cleanup` operates on branches/refs/heads only. Tag cleanup belongs to a future `/stark-gh:tag-cleanup` if needed.
- **Issue cleanup.** Already handled by `/stark-housekeeping` Phase 1. Cleanup will not close issues.
- **Label cleanup.** Same reasoning.
- **Reflog / packed-refs garbage collection.** `git gc` is a different tool with different blast radius.
- **Recovery / undo.** Once a remote ref is deleted, only GitHub's 90-day branch-restore window or local reflog can recover it. Cleanup does not provide a "restore last run" command.
- **Closed-not-merged backup.** The user explicitly opted into destruction by including `closed-not-merged` PR cleanup; we do not auto-tag a backup ref before deletion. (Future enhancement candidate; not in v1.)
- **Multi-repo at once.** A single invocation targets one repo. Loop externally for batch operations.

## Auth & Identity

Cleanup runs under the gh user identity active at invocation time. If `/stark-gh-user` has swapped to a secondary user, ref deletes and PR closures run as that user — failures appear as 403/422 from gh and are recorded as per-step failures, not crashes. The plan-file records the auth user resolved at preflight time for postmortem clarity.

Cleanup does not unset `GH_TOKEN` (unlike `/stark-housekeeping`). The default `gh` resolution is appropriate: cleanup is destructive against repos the operator already has write access to.
