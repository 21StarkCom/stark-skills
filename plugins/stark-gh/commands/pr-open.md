---
name: pr-open
description: >-
  Open or update a PR with Codex-drafted prose, stage-all commit (default), push, and CI watcher. New PRs open as DRAFT by default (override --ready).
argument-hint: "[--title T] [--body B] [--body-file F] [--commit-message M] [--commit-message-file F] [--base BRANCH] [--reviewer LIST] [--label LIST] [--assignee LIST] [--staged-only] [--commit-all] [--full-context] [--no-watch] [--ready] [--allow-secret-commit] [--allow-secret-to-llm] [--allow-untracked-config]"
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
PLAN_FILE=$(node "$TOOLS/gh_pr_open_preflight.ts" \
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
node "$TOOLS/gh_pr_open_draft.ts" --plan-file "$PLAN_FILE"
```

The draft tool reads `$PLAN_FILE`, internally subprocess-calls `codex exec`
(default `gpt-5.6-sol`, reasoning effort `medium`, configurable via
`plugins/stark-gh/config.json`), validates model output, writes prose tempfiles,
and atomic-updates the plan-file.

If `plan.stage2.skip` is true, the draft tool exits `0` immediately.

You do NOT construct prompts. You do NOT invoke any LLM or Agent tool. You only
run the TypeScript subprocess.

On nonzero exit, surface stderr verbatim and stop.

## Untracked-file guard (`--commit-all`)

`--commit-all` runs `git add -A`, which stages **untracked** files as well as
modified ones. Before it does, the staging step lists what `-A` would newly add
(`git ls-files --others --exclude-standard`) and **refuses** if any of it looks
like local config or credential material: local environment and direnv files,
key and certificate material, SSH private keys, service-credential JSON,
Terraform state and variable files, and editor/agent/OS local state.

The exact pattern list lives in `tools/lib/untracked_guard.ts` and is not
duplicated here — a copy in prose drifts from the code it describes, and the
code is the thing that actually decides.

This is **path**-based on purpose, and complements the existing **content**-based
secret scan rather than duplicating it. On 2026-08-10 `git add -A` swept a repo's
`.envrc` into a PR and pushed it: the file held only paths and email subjects, so
every entropy and token rule passed it cleanly. The hazard was the file's
identity, not a string inside it.

The refusal happens **before** `git add`, so the index is never touched and there
is nothing to unstage. It names each file and both remedies:

- **Usually right:** add it to `.gitignore`. Verify with the exit code —
  `git check-ignore -q <path> && echo ignored || echo EXPOSED` — because a later
  negation in `.gitignore` can silently kill an earlier rule. A repo-level
  negation also overrides your **global** gitignore, which is how the 2026-08-10
  case happened: `.envrc` was covered globally, and a `!/*.*` line in the repo
  punched a hole straight through that cover.
- **If you mean it:** re-run with `--allow-untracked-config`, or stage the files
  yourself and use `--staged-only`.

Published example variants (the `.example` / `.sample` / `.template` forms),
public keys and `*pubkeys/` directories are never flagged — friction that stops ordinary work gets disabled, and then it
protects nothing. A repo whose `.gitignore` already covers these files sees no
behaviour change at all: `--exclude-standard` means the guard never sees them.

## Stage 3 - Execute

```bash
node "$TOOLS/gh_pr_open_execute.ts" --plan-file "$PLAN_FILE"
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
