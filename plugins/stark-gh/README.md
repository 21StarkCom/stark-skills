# stark-gh

Claude Code plugin housing GitHub workflow slash commands. v1: `/stark-gh:pr-open`.

See `docs/superpowers/specs/2026-04-28-stark-gh-pr-open-design.md` for design.

## Manual smoke test

In a throwaway feature branch in this repo:

1. `git checkout -b smoke/1-test-stark-gh`
2. `echo "x" > scratch.md && git add scratch.md`
3. In Claude Code: `/stark-gh:pr-open --no-watch`
4. Expect: a single commit with Codex-drafted message; branch pushed; PR created;
   PR URL printed.
5. Clean up: `gh pr close <N>`, `git push origin :smoke/1-test-stark-gh`,
   `git checkout main`, `git branch -D smoke/1-test-stark-gh`.

If anything goes wrong, every TypeScript tool prints stable exit codes and stderr.
See the design spec's exit-code table.
