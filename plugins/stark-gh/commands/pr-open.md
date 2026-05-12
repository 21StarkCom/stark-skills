---
name: pr-open
description: >-
  Open or update a PR with Codex-drafted prose, staged-only commit, push, and CI watcher.
argument-hint: "[--title T] [--body B] [--body-file F] [--commit-message M] [--commit-message-file F] [--base BRANCH] [--reviewer LIST] [--label LIST] [--assignee LIST] [--commit-all] [--full-context] [--no-watch] [--draft] [--allow-secret-commit] [--allow-secret-to-llm]"
allowed-tools: Bash, Read
model: sonnet
---

# /stark-gh:pr-open

Open or update a GitHub pull request through a fixed three-stage pipeline:
preflight, draft, execute.

YOU MUST NOT splice user input into shell commands. Forward the entire
`$ARGUMENTS` value to preflight as one quoted `--raw-args` value. Do not parse
raw user input anywhere else.

YOU MUST NOT draft PR prose. Stage 2 owns all drafting through the TypeScript
tool, which subprocess-calls `codex exec`.

## Constants

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT}/tools"
```

## Stage 1 - Preflight

The raw arg may be a bare PR number OR a flag list — the parser accepts both.

```bash
PLAN_FILE=$(node --experimental-strip-types "$TOOLS/gh_pr_open_preflight.ts" \
  --raw-args "$ARGUMENTS" \
  --emit-plan-path)
```

On nonzero exit, surface stderr verbatim and stop. The command prints only the
plan-file path. The plan-file contains the full plan and lives under the
stark-gh runtime directory with mode `0600`.

## Stage 2 - Draft

```bash
node --experimental-strip-types "$TOOLS/gh_pr_open_draft.ts" --plan-file "$PLAN_FILE"
```

The draft tool reads `$PLAN_FILE`, internally subprocess-calls `codex exec`
(default `gpt-5.5`, reasoning effort `medium`, configurable via
`plugins/stark-gh/config.json`), validates model output, writes prose tempfiles,
and atomic-updates the plan-file.

If `plan.stage2.skip` is true, the draft tool exits `0` immediately.

You do NOT construct prompts. You do NOT invoke any LLM or Agent tool. You only
run the TypeScript subprocess.

On nonzero exit, surface stderr verbatim and stop.

## Stage 3 - Execute

```bash
node --experimental-strip-types "$TOOLS/gh_pr_open_execute.ts" --plan-file "$PLAN_FILE"
```

Parse the result JSON and print `result.prUrl`.

If `result.watcherPid` is set, print:

```text
Watching CI in background (state file: <result.watcherStateFile>).
```

If `result.watcherAlreadyRunning` is true, print:

```text
CI watcher already running for this head; no new process spawned.
```
