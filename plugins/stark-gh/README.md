# stark-gh

Claude Code plugin housing GitHub workflow slash commands.

- v1: `/stark-gh:pr-open`
- v1: `/stark-gh:pr-merge`

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
6. Cleanup (once /stark-gh:cleanup ships): `/stark-gh:cleanup --pr <N>`. For now:
   ```bash
   gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<headRef>
   git checkout main && git branch -D smoke/pr-merge-<timestamp>
   ```

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
5. Clean up: `gh pr close <N>`, `git push origin :smoke/1-test-stark-gh`,
   `git checkout main`, `git branch -D smoke/1-test-stark-gh`.

If anything goes wrong, every TypeScript tool prints stable exit codes and stderr.
See the design specs for the exit-code tables.
