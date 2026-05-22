---
name: cleanup
description: >-
  Sweep the local + remote repo for merged-PR branches, stale tracking refs,
  worktree leftovers (including detached-HEAD review worktrees), merged-PR
  watcher state, stale stashes, and loose objects. Rebases the current branch
  onto upstream and applies linear-tree git config so the history stays sharp.
argument-hint: "[--pr N] [--dry-run] [--keep-branch NAME ...] [--no-rebase] [--no-watcher-cleanup] [--no-config] [--no-gc] [--drop-stale-stashes] [--force] [--json]"
allowed-tools: Bash
model: sonnet
---

# /stark-gh:cleanup

One TypeScript stage. Reads state, optionally rebases, deletes merged branches
(local + remote), removes worktree leftovers, and clears watcher state files
for done PRs. Single source of truth: `plugins/stark-gh/tools/gh_cleanup.ts`.

YOU MUST NOT splice user input into shell commands. Forward the entire
`$ARGUMENTS` value as a single quoted `--raw-args` value to the tool.

## Constants

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT}/tools"
```

## Run

```bash
node --experimental-strip-types "$TOOLS/gh_cleanup.ts" --raw-args "$ARGUMENTS"
```

The tool handles its own preflight (in-repo, gh authed, clean tree), discovery,
and execution. It prints a human-readable plan followed by an execute receipt.
With `--dry-run`, only the plan is printed.

Exit codes (stable):

| Code | Meaning |
|-----:|---------|
| 0    | success |
| 1    | one or more execute errors (per receipt) |
| 10   | not inside a git repository |
| 11   | gh not authenticated |
| 12   | working tree dirty |
| 13   | unrecognized flag / bad arg |
| 15   | `--pr N` targets a non-MERGED/CLOSED PR |
| 16   | `--pr N` head ref equals default branch (refused) |
| 17   | `--pr N` is a cross-repo PR (refused) |

## Modes

**Full sweep (no `--pr`)** — fetches all remotes, prunes stale tracking refs,
applies linear-tree git config (`pull.rebase=true`, `rebase.autoStash=true`,
`branch.autoSetupRebase=always`, `rerere.enabled=true`, `fetch.prune=true`,
`fetch.pruneTags=true`), rebases current feature branch onto its upstream
(or fast-forwards default), deletes local branches whose PR merged or whose
upstream is gone, deletes the corresponding remote branches, removes worktrees
pinned to deleted branches **plus detached-HEAD review worktrees**
(`review-*-prN-*`) whose PR is MERGED/CLOSED, removes watcher state dirs for
PRs that GitHub reports as MERGED/CLOSED, surfaces stale stashes (base branch
gone), and runs `git gc` when loose objects pile up.

**Single PR (`--pr N`)** — narrow cleanup for one PR. Deletes its head branch
local + remote (if the PR is MERGED/CLOSED, not on the default branch, and not
cross-repo), removes any worktree on that branch (including a detached review
worktree for that PR), removes its watcher state.

## Worktrees, stashes, objects

- **Detached-HEAD review worktrees** — `/stark-review` provisions
  `review-*-prN-single` worktrees with no branch ref, so the branch-pinned
  sweep can't see them. The full sweep matches them by path, confirms the PR
  is MERGED/CLOSED, and removes them only when the tree is clean (a dirty one
  is reported and skipped unless `--force`).
- **Stale stashes** — a stash whose base branch no longer exists is *surfaced*
  in the plan but never dropped silently. Pass `--drop-stale-stashes` to drop
  them (highest index first).
- **Loose objects** — when `git count-objects` reports ≥ 50 loose objects, the
  sweep runs `git gc --quiet`. Skip with `--no-gc`.

## Safety

- Protected from deletion: current branch, default branch, `main`, `master`,
  anything passed via `--keep-branch`.
- Local branches with unmerged commits are skipped unless `--force` is passed
  (then `git branch -D` is used).
- Worktrees with uncommitted changes will refuse to remove unless `--force` is
  passed (which forwards `--force` to `git worktree remove`).
- Stale stashes are surfaced but never dropped without `--drop-stale-stashes`.
- Rebase failures auto-abort; the user lands back where they started.
- Dirty working tree blocks the whole run (exit 12) — commit/stash first.

## Flags

| Flag | Effect |
|------|--------|
| `--pr N` | Single-PR cleanup mode |
| `--dry-run` | Print plan, do not execute |
| `--keep-branch NAME` | Add NAME to the protected set (repeatable) |
| `--no-rebase` | Skip the rebase / fast-forward phase |
| `--no-watcher-cleanup` | Skip the `~/.claude/code-review/stark-gh/watchers/...` sweep |
| `--no-config` | Skip the linear-tree `git config` writes |
| `--no-gc` | Skip the `git gc` repack step |
| `--drop-stale-stashes` | Drop stashes whose base branch no longer exists (default: surface only) |
| `--force` | Use `git branch -D`, `git worktree remove --force`, and force-remove dirty review worktrees |
| `--json` | Emit plan + receipt as JSON (suitable for piping) |
