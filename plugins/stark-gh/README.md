# stark-gh

Claude Code plugin housing GitHub workflow slash commands.

- v1: `/stark-gh:pr-open`
- v1: `/stark-gh:pr-merge`
- v1: `/stark-gh:cleanup`

Design specs:
- `docs/superpowers/specs/2026-04-28-stark-gh-pr-open-design.md`
- `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-design.md`
- `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-plan.md`

## /stark-gh:pr-merge — disposable-PR smoke runbook

**Destructive: rebases, force-pushes, and merges. Use a fixture branch in this
repo or a sandbox repo, not main.**

1. Pre-checks: `gh auth status` (must be authenticated).
2. Create a disposable PR:
   ```bash
   git checkout -b smoke/pr-merge-$(date +%s)
   echo "smoke" >> docs/SMOKE.md && git add docs/SMOKE.md
   git commit -m "smoke: disposable pr-merge target"
   git push -u origin HEAD
   gh pr create --base main --title "smoke: pr-merge" --body "Disposable smoke target"
   ```
3. From the PR's checkout, run `/stark-gh:pr-merge`.
4. Expect: rebase, codex draft, force-push, watcher spawn, eventual squash-merge.
5. Inspect terminal state:
   ```bash
   cat ~/.claude/code-review/stark-gh/watchers/github.com/<owner>/<repo>/pr-<N>/<sha>.json
   ```
   Expect `status: merged`, a `mergeSha`, and a `runbook` block with operator
   recovery hints.
6. Cleanup: `/stark-gh:cleanup --pr <N>` — deletes head branch (local + remote),
   removes any worktree on it, clears the watcher state dir.

## /stark-gh:pr-merge — post-merge recovery

Squash-merge produces a single-parent commit on the base branch; the original
PR commit graph is **not** linked from the squash. Recovery procedure:

- Capture `mergeSha` from the watcher's terminal state file.
- Open a revert PR: `git revert <mergeSha>` on a branch off `baseRef`, then
  `gh pr create`.
- The original PR branch is **the only post-merge path back to original
  commits** until `/stark-gh:cleanup` deletes it. Operators who anticipate
  needing the original branch must capture it before invoking pr-merge.

## Manual smoke test (pr-open, unchanged)

In a throwaway feature branch in this repo:

1. `git checkout -b smoke/1-test-stark-gh`
2. `echo "x" > scratch.md && git add scratch.md`
3. In Claude Code: `/stark-gh:pr-open --no-watch`
4. Expect: a single commit with Codex-drafted message; branch pushed; PR created;
   PR URL printed.
5. Clean up: `gh pr close <N>`, then `/stark-gh:cleanup --pr <N>` to delete
   the head branch (local + remote) and clear leftovers.

## /stark-gh:cleanup — what it does

Single TypeScript stage (`tools/gh_cleanup.ts`). Full-sweep mode:

- `git fetch --all --prune --prune-tags`
- Writes linear-tree git config (`pull.rebase=true`, `rebase.autoStash=true`,
  `branch.autoSetupRebase=always`, `rerere.enabled=true`, `fetch.prune=true`,
  `fetch.pruneTags=true`) — opt out with `--no-config`.
- Rebases the current feature branch onto its upstream (or fast-forwards default).
- Deletes local branches whose PR merged, whose upstream is gone, or whose tip
  is reachable from `origin/<default>`. Unmerged branches are skipped unless
  `--force` is set.
- Deletes the matching remote branches via `gh api -X DELETE`.
- Removes worktrees pinned to deleted branches; prunes broken entries.
- Removes `~/.claude/code-review/stark-gh/watchers/<host>/<owner>/<repo>/pr-N/`
  dirs for PRs GitHub reports as MERGED/CLOSED.

Single-PR mode (`--pr N`) — narrows everything above to one PR's head ref +
watcher state. Refuses if the PR is still open, on the default branch, or
cross-repo.

`--dry-run` prints the plan and exits without mutating anything. Working tree
must be clean (exit 12 otherwise). Run from any branch in the repo.

If anything goes wrong, every TypeScript tool prints stable exit codes and stderr.
See the design specs for the exit-code tables.
