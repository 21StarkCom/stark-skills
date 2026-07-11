---
name: pr-merge
description: >-
  Rebase a PR, draft squash-commit prose + CHANGELOG bullet via Codex,
  force-push, mark a draft PR ready-for-review, and squash-merge once CI is green.
argument-hint: "[--pr N] [--changelog-section Added|Changed|Fixed|Removed|Deprecated|Security] [--force --force-reason TEXT] [--no-watch] [--watch-timeout HOURS] [--allow-secret-commit] [--allow-secret-to-llm] [--allow-no-required-checks]"
allowed-tools: Bash, Read
model: sonnet
---

# /stark-gh:pr-merge

Open-PR squash-merge pipeline. Three TS stages: preflight, draft, execute.

YOU MUST NOT splice user input into shell commands. Forward `$ARGUMENTS`
verbatim as a single quoted `--raw-args` value to preflight.

YOU MUST NOT draft any prose. Stage 2 owns drafting via the TypeScript draft
tool, which subprocess-calls `codex exec` with a scrubbed env.

## Constants

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT}/tools"
```

## Stage 1 — Preflight

The raw arg may be a bare PR number OR a flag list — the parser accepts both.

```bash
PREFLIGHT_OUT=$(node --experimental-strip-types "$TOOLS/gh_pr_merge_preflight.ts" \
  --raw-args "$ARGUMENTS" \
  --emit-plan-path)
PREFLIGHT_RC=$?
[ $PREFLIGHT_RC -eq 0 ] || exit $PREFLIGHT_RC
```

Preflight may emit a `STARK_GH_RESUME=<mode>` line BEFORE the plan-file path.
Parse both:

```bash
RESUME_MODE=$(printf '%s\n' "$PREFLIGHT_OUT" | sed -n 's/^STARK_GH_RESUME=\(.*\)$/\1/p' | head -1)
PLAN_FILE=$(printf '%s\n' "$PREFLIGHT_OUT" | grep -v '^STARK_GH_RESUME=' | tail -1)
```

If `RESUME_MODE=attached`, the watcher is already running. Print the state-file
path and stop — there's nothing more to do until it finishes:

```bash
if [ "$RESUME_MODE" = "attached" ]; then
  echo "Watcher already attached; state: $PLAN_FILE"
  exit 0
fi
```

## Cross-stage cleanup trap

After preflight succeeds and BEFORE Stage 2 / Stage 3 mutate further, install a
trap that calls `lib/restore_branch.ts` on any non-zero exit. Disarm the trap
once Stage 3 reports a successful push.

```bash
trap 'node --experimental-strip-types "$TOOLS/lib/restore_branch.ts" "$PLAN_FILE" >&2 || true' EXIT
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

## Stage 3 — Execute

```bash
if [ "$RESUME_MODE" = "spawn-only" ]; then
  EXECUTE_OUT=$(node --experimental-strip-types "$TOOLS/gh_pr_merge_execute.ts" \
    --plan-file "$PLAN_FILE" --resume-from-spawn)
else
  EXECUTE_OUT=$(node --experimental-strip-types "$TOOLS/gh_pr_merge_execute.ts" \
    --plan-file "$PLAN_FILE")
fi
EXECUTE_RC=$?
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
if printf '%s' "$EXECUTE_OUT" | grep -q '"event":"pushed"'; then
  trap - EXIT
fi
exit $EXECUTE_RC
```

Parse the execute JSON for `prUrl`, `mergeSha` (sync mode), or `watcherStateFile`
+ `watcherPid` (default-watch mode), and report to the user.
