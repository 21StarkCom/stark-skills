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

`ticketKey` is **required** when `requireTicketScope` is on — enforcement anchors
on it, and a keyless scan would fabricate tickets out of version tokens like
`AWS-2`. With the gate on, preflight resolves the ticket from the branch name
(`stark-247`, `worktree-STARK-229`, `feat/STARK-7-thing`, `feature_STARK-247` —
matched case-insensitively against `ticketKey`, underscore counts as a
separator) and pins it, so the drafted title must come back as
`type(STARK-247): subject`. An **explicit `--title` is validated, never
rewritten** — for a new PR *and* when editing an existing one's title, since
pr-open writes `--title` onto an existing PR too. A title with no ticket, the
wrong ticket, or the right ticket in the wrong case exits **33**. If nothing can
be resolved and no `--title` was given on a *new* PR, preflight exits **33**
naming the remedy. An existing PR whose title is left alone is not gated.

Default is **off**: stark-gh also runs against repos where `STARK-` means
nothing, and a global default would block every one of them. But a
`.stark-gh.json` that is *present* yet broken — malformed JSON, wrong-typed
field, or `requireTicketScope` without a `ticketKey` — is a **fatal** config
error (exit 33), never a silent revert to off: a gate you opted into must fail
closed.

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
