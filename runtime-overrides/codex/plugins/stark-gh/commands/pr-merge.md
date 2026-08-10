---
name: pr-merge
description: >-
  Rebase a PR, draft squash-commit prose + CHANGELOG bullet via Codex
  (changelog step skipped when the repo keeps no root CHANGELOG.md),
  force-push, mark a draft PR ready-for-review, and squash-merge once CI is green.
argument-hint: "[--pr N] [--changelog-section Added|Changed|Fixed|Removed|Deprecated|Security] [--force --force-reason TEXT] [--no-watch] [--watch-timeout HOURS] [--allow-secret-commit] [--allow-secret-to-llm] [--allow-no-required-checks] [--allow-skipped-checks] [--ignore-repo-config]"
allowed-tools: Bash, Read
model: opus
---

# pr-merge

Open-PR squash-merge pipeline. Three TS stages: preflight, draft, execute.

YOU MUST NOT splice user input into shell syntax. Take the argument tail from
the current user request and pass it verbatim as one safely shell-quoted
`--raw-args` value to preflight. The `RAW_ARGS` marker below must be replaced
with that value; never execute the marker literally.

YOU MUST NOT draft any prose. Stage 2 owns drafting via the TypeScript draft
tool, which subprocess-calls `codex exec` with a scrubbed env.

## Per-repo defaults

A target repo may state its own defaults in a `merge` block of `.stark-gh.json`
at its root — the same file `$stark-gh:pr-open` reads for ticket enforcement:

```json
{ "merge": { "allowNoRequiredChecks": true, "noWatch": true } }
```

Keys: `allowNoRequiredChecks`, `allowSecretToLlm`, `allowSecretCommit`,
`noWatch`, `watchTimeoutHours` (≤168).

**Read from the merge BASE, never the working tree.** These settings waive the
gates that police the diff being merged, so a branch cannot ship the waivers
that would clear its own contents. A branch may propose a change; it takes
effect once merged.

**Config supplies defaults; the command line wins.** Since every key only turns
something on, there is no way to OR one back off — `--ignore-repo-config` drops
the file for a single run, and is also the way past a config that is committed
and broken.

You do not pass any of this yourself: preflight resolves it and prints
`in effect — <flag>: .stark-gh.json` for everything it picked up, gate waivers
included in the audit log with their provenance.

Why it exists: some of these flags describe a fact about the repo rather than a
choice about one run. A repo with no PR CI has no required checks to wait for,
so every merge stops after the 300s grace naming `--allow-no-required-checks` as
the remedy — and the operator retypes it forever for a fact that never changes.

## Constants

Every shell block below is a fragment of one stateful pipeline. Execute all
fragments together, in order, in one shell call so `TOOLS`, `PLAN_FILE`, the
restore trap, and the receipt variables cannot disappear between agent calls.

```bash
set -euo pipefail
TOOLS="${CLAUDE_PLUGIN_ROOT}/tools"
RAW_ARGS='<argument tail from the current user request, safely shell-quoted>'
```

## Stage 1 — Preflight

The raw arg may be a bare PR number OR a flag list — the parser accepts both.

```bash
if PREFLIGHT_OUT="$(node --experimental-strip-types "$TOOLS/gh_pr_merge_preflight.ts" \
  --raw-args "$RAW_ARGS" \
  --emit-plan-path)"; then
  :
else
  PREFLIGHT_RC=$?
  exit "$PREFLIGHT_RC"
fi
```

Preflight may emit a `STARK_GH_RESUME=<mode>` line BEFORE the plan-file path.
Parse both:

```bash
RESUME_MODE="$(printf '%s\n' "$PREFLIGHT_OUT" | sed -n 's/^STARK_GH_RESUME=\(.*\)$/\1/p')"
PLAN_FILE="$(printf '%s\n' "$PREFLIGHT_OUT" | grep -v '^STARK_GH_RESUME=' | tail -1)"
[ -n "$PLAN_FILE" ] || { echo "preflight did not return a plan path" >&2; exit 1; }
```

If `RESUME_MODE=attached`, a **merge-driver** watcher is already running. Print
the state-file path and stop — there's nothing more to do until it finishes:

```bash
if [ "$RESUME_MODE" = "attached" ]; then
  echo "Watcher already attached; state: $PLAN_FILE"
  exit 0
fi
```

A live **ci-observer** watcher (the one `$pr-open` spawns) does NOT
produce `attached` — preflight pre-empts it and proceeds, because the head it
is watching is about to be invalidated by the rebase + force-push. So
`pr-open --ready` immediately followed by `pr-merge` no longer fails with
exit 34. Pre-kind locks written by an older watcher still classify as `unknown`
and are treated as `attached`, conservatively.

## Cross-stage cleanup trap

After preflight succeeds and BEFORE Stage 2 / Stage 3 mutate further, install a
trap that calls `lib/restore_branch.ts` on any non-zero exit. Disarm the trap
once Stage 3 reports a successful push.

```bash
restore_on_failure() {
  restore_rc=$?
  trap - EXIT
  if [ "$restore_rc" -ne 0 ]; then
    node --experimental-strip-types "$TOOLS/lib/restore_branch.ts" "$PLAN_FILE" >&2 || true
  fi
  exit "$restore_rc"
}
trap restore_on_failure EXIT
```

## Stage 2 — Draft

If `RESUME_MODE=spawn-only`, skip drafting (already done in the prior run).

```bash
if [ "$RESUME_MODE" != "spawn-only" ]; then
  node --experimental-strip-types "$TOOLS/gh_pr_merge_draft.ts" --plan-file "$PLAN_FILE"
fi
```

The draft tool reads `$PLAN_FILE`, subprocess-calls `codex exec` with a scrubbed
env (no GitHub tokens), validates output against `lib/draft_schema.ts`, retries
once on validation failure, writes prose tempfiles, and atomic-updates the
plan-file.

**Ticket prefix inheritance.** When the PR title starts with a lower-case
`type(TICKET-<n>):` prefix (e.g. `feat(STARK-193):`), the squash subject must
carry that same prefix — otherwise the merged commit on main loses the ticket
trail. The drafter puts the requirement in the prompt and `validateDraft`
enforces it as a token: one space then a non-empty summary, no repeated prefix,
an added `!` breaking marker allowed, and the ≤72-char cap applies to the
summary after the prefix. A miss is retried once; a second miss aborts the merge
(`DRAFT_INVALID`) rather than landing a prefix-less commit. Titles with no such
prefix — including non-ticket scopes like `docs(adr-0007):` — impose nothing.

## Stage 3 — Execute

```bash
if [ "$RESUME_MODE" = "spawn-only" ]; then
  if EXECUTE_OUT="$(node --experimental-strip-types "$TOOLS/gh_pr_merge_execute.ts" \
    --plan-file "$PLAN_FILE" --resume-from-spawn)"; then
    EXECUTE_RC=0
  else
    EXECUTE_RC=$?
  fi
else
  if EXECUTE_OUT="$(node --experimental-strip-types "$TOOLS/gh_pr_merge_execute.ts" \
    --plan-file "$PLAN_FILE")"; then
    EXECUTE_RC=0
  else
    EXECUTE_RC=$?
  fi
fi
```

The push happens inside execute. Once force-push has succeeded, execute prints
a sentinel `{"event":"pushed",...}` line on stdout *before* the post-push
sanity check, --no-watch verify/merge, or watcher spawn run. The wrapper must
disarm the restore trap based on that sentinel — not on `EXECUTE_RC` — because
post-push failures (HEAD drift, --no-watch check failure, watcher spawn fail)
exit non-zero but the remote has already been force-pushed and `restore_branch`
would only roll back local state, re-creating divergence the user has to clean
up by hand:

```bash
case "$EXECUTE_OUT" in
  *'"event":"pushed"'*) trap - EXIT ;;
esac
printf '%s\n' "$EXECUTE_OUT"
exit "$EXECUTE_RC"
```

Parse the execute JSON for `prUrl`, `mergeSha` (sync mode), or `watcherStateFile`
+ `watcherPid` (default-watch mode), and report to the user.

### A skipped required check is not a green one

Both the `--no-watch` gate and the watcher **refuse to merge when a required
check reports `SKIPPED`**, naming it. This is deliberately stricter than GitHub,
which counts a skipped check as satisfying the requirement — the two are
indistinguishable in the merge box, which is how `stark-skills#877` merged with
its test suite never having run.

A skip is terminal, not pending: re-running the workflow replays the original
event payload (so a draft-guarded job skips again) and a `workflow_dispatch` run
never joins the PR's status rollup. **Push a commit to re-fire CI.** If the
target repo skips that check by design — a path-filtered required check —
re-run with `--allow-skipped-checks`.

Related: a workflow whose check is required must not carry a draft guard at all
(`standards/workflows/skip-draft-guard.md`).
