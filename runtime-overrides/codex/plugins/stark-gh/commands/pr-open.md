---
name: pr-open
description: >-
  Open or update a PR with Codex-drafted prose, stage-all commit (default), push, and CI watcher. New PRs open as DRAFT by default (override --ready).
argument-hint: "[--title T] [--body B] [--body-file F] [--commit-message M] [--commit-message-file F] [--base BRANCH] [--reviewer LIST] [--label LIST] [--assignee LIST] [--staged-only] [--commit-all] [--full-context] [--no-watch] [--ready] [--allow-secret-commit] [--allow-secret-to-llm]"
allowed-tools: Bash, Read
model: sonnet
---

# pr-open

Open or update a GitHub pull request through a fixed three-stage pipeline:
preflight, draft, execute.

**Draft-by-default:** a newly created PR opens as a **draft** so target-repo CI
(guarded on `github.event.pull_request.draft == false`) stays idle while you
test locally. Pass `--ready` (alias `--no-draft`) to open it ready-for-review
instead. Un-drafting a WIP PR happens later through the explicit `pr-merge`
skill (`/stark-gh:pr-merge` on Claude Code, `$pr-merge` on Codex), which marks
it ready, waits for CI, then squash-merges — never in this command.
Updating an existing PR never changes its draft state.

YOU MUST NOT splice user input into shell syntax. Take the argument tail from
the current user request (everything after the explicit skill name) and pass it
to preflight as one safely shell-quoted `--raw-args` value. Do not parse raw
user input anywhere else. The `RAW_ARGS` marker below is an instruction-time
placeholder: replace it with that safely quoted value; never execute the marker
literally.

YOU MUST NOT draft PR prose. Stage 2 owns all drafting through the TypeScript
tool, which subprocess-calls `codex exec`.

## Run the three stages in one shell call

Shell variables do not persist across agent tool calls, so preflight, draft,
and execute MUST run in the same shell invocation.

The raw arg may be a bare PR number OR a flag list — the parser accepts both.

```bash
set -euo pipefail
TOOLS="${CLAUDE_PLUGIN_ROOT}/tools"
RAW_ARGS='<argument tail from the current user request, safely shell-quoted>'
PLAN_FILE="$(node --experimental-strip-types "$TOOLS/gh_pr_open_preflight.ts" \
  --raw-args "$RAW_ARGS" \
  --emit-plan-path)"
[ -n "$PLAN_FILE" ] && [ -f "$PLAN_FILE" ] || {
  echo "preflight did not return a readable plan file" >&2
  exit 1
}
node --experimental-strip-types "$TOOLS/gh_pr_open_draft.ts" --plan-file "$PLAN_FILE"
EXECUTE_OUT="$(node --experimental-strip-types "$TOOLS/gh_pr_open_execute.ts" --plan-file "$PLAN_FILE")"
printf '%s\n' "$EXECUTE_OUT"
```

On any nonzero exit, surface stderr verbatim and stop. Preflight prints only the
mode-`0600` plan-file path. The draft tool reads that plan, invokes `codex exec`
with its scrubbed environment, validates model output, writes prose tempfiles,
and atomically updates the plan. If `plan.stage2.skip` is true, it exits `0`
immediately. Do not construct prompts or invoke another agent directly.

Parse the result JSON and print `result.prUrl`.

If `result.watcherPid` is set, print:

```text
Watching CI in background (state file: <result.watcherStateFile>).
```

If `result.watcherAlreadyRunning` is true, print:

```text
CI watcher already running for this head; no new process spawned.
```
