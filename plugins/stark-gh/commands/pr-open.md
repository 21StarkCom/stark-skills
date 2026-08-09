---
name: pr-open
description: >-
  Open or update a PR with Codex-drafted prose, stage-all commit (default), push, and CI watcher. New PRs open as DRAFT by default (override --ready).
argument-hint: "[--title T] [--body B] [--body-file F] [--commit-message M] [--commit-message-file F] [--base BRANCH] [--reviewer LIST] [--label LIST] [--assignee LIST] [--staged-only] [--commit-all] [--full-context] [--no-watch] [--ready] [--allow-secret-commit] [--allow-secret-to-llm]"
allowed-tools: Bash, Read
model: opus
---

# /stark-gh:pr-open

Open or update a GitHub pull request through a fixed three-stage pipeline:
preflight, draft, execute.

**Draft-by-default:** a newly created PR opens as a **draft** so target-repo CI
(guarded on `github.event.pull_request.draft == false`) stays idle while you
test locally. Pass `--ready` (alias `--no-draft`) to open it ready-for-review
instead. Un-drafting a WIP PR happens later via `/stark-gh:pr-merge` (which
marks it ready, waits for CI, then squash-merges) — never in this command.
Updating an existing PR never changes its draft state.

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

**Ticket-scoped titles (opt-in, per repo).** A repo that keeps a
`type(TICKET-<n>):` title convention declares it in `.stark-gh.json` at the repo
root:

```json
{ "requireTicketScope": true, "ticketKey": "STARK" }
```

With it on, preflight resolves the ticket from the branch name (`stark-247`,
`worktree-STARK-229`, `feat/STARK-7-thing` — matched case-insensitively against
`ticketKey`) and pins it, so the drafted title must come back as
`type(STARK-247): subject`. An explicit `--title` is validated, never rewritten:
one without a ticket, or naming a different ticket than the branch, exits **33**.
If nothing can be resolved and no `--title` was given, preflight exits **33**
naming the remedy — open a ticket and put it in the branch name or the title.
Existing PRs are never gated (their title is not being written here).

Default is **off**: stark-gh also runs against repos where `STARK-` means
nothing, and a global default would block every one of them. A malformed
`.stark-gh.json` warns on stderr and falls back to off. Without `ticketKey`,
only an UPPER-CASE key is recognised in a branch, so `feat/fix-2-things` cannot
be mistaken for ticket `FIX-2`.

This is the front half of the rule `/stark-gh:pr-merge` enforces on the squash
subject — the title is where the ticket trail starts.

## Stage 2 - Draft

```bash
node --experimental-strip-types "$TOOLS/gh_pr_open_draft.ts" --plan-file "$PLAN_FILE"
```

The draft tool reads `$PLAN_FILE`, internally subprocess-calls `codex exec`
(default `gpt-5.6-sol`, reasoning effort `medium`, configurable via
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
