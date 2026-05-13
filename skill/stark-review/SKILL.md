---
name: stark-review
description: >-
  Single-agent PR review. Uses triage-selected PR review domains by default,
  or one forced agent via `--agent`.
argument-hint: "[PR_NUMBER] [--agent claude|codex|gemini] [--quick] [--domains a,b,c] [--dry-run] [--repo ORG/REPO]"
disable-model-invocation: false
model: opus[1m]
revision: 10cf64168d96fde54c2af16f434e31a4d296f97b
revision_date: 2026-05-13T07:18:37Z
---

Single-agent PR review path. Keep this skill thin: do preflight, capture the
trusted config root, set up the worktree, then hand off to the TS dispatcher
(`tools/stark_review.ts`). All review logic — domain selection, agent dispatch,
finding parsing, classification, posting, history — lives in the TS tool. Read
its `--json` receipt and surface failures.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review`.

## Arguments

Raw input: `$ARGUMENTS`

- `PR_NUMBER` — optional; detect from current branch with `gh pr view --json number --jq .number`
- `--agent <name>` — force a single agent (claude|codex|gemini) across every selected domain
- `--repo ORG/REPO` — override repo detection
- `--quick` — use the `quick_domains` list from `config.json` (small fast subset). Errors out if `quick_domains` is empty in the resolved config
- `--domains a,b,c` — escape hatch: explicit comma-separated domain slugs. Beats `--quick`. Use this when you want a surgical review on specific domains (e.g. `--domains security,test-coverage`)
- `--dry-run` — run the full pipeline but skip GitHub posting; the receipt records what would have been posted

If PR detection fails, list open PRs and ask:

```bash
gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'
```

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
TOOLS="${STARK_REVIEW_TOOLS:-$HOME/.claude/code-review/tools}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
```

## Configuration

When `--agent` is not supplied, `domain_agents` in `config.json` chooses the
default agent per domain. Example:

```json
{
  "domain_agents": {
    "architecture": "codex",
    "behavior": "codex",
    "type-safety": "codex",
    "security": "codex",
    "test-coverage": "codex",
    "spec-conformance": "codex"
  }
}
```

This follows the standard config hierarchy (repo > org > global). The TS
dispatcher reads it from `--config-root`.

`--quick` reads the optional `quick_domains` array from the same config. If
that list is empty or absent, the TS tool exits with `bad_args` rather than
silently dispatching every domain.

## Setup

### 1. Capture trusted config root FIRST

Capture the config root from the **current** working directory **before any
worktree setup runs**. The TS dispatcher uses this path to resolve `config.json`
and prompt files; if you capture it after `cd`-ing into the worktree it will
read prompts from inside the PR head, which is an injection vector.

```bash
CONFIG_ROOT="$(pwd)"
```

### 2. Provision a GitHub token (only if unset)

The TS tool authenticates via `gh api`, which uses `GH_TOKEN` if set. Provision
a stark-claude installation token only when the caller has not already supplied
one — never overwrite a caller-provided token.

```bash
if [ -z "${GH_TOKEN:-}" ]; then
    if GH_TOKEN_TMP=$("$PYTHON" "$SCRIPTS/github_app.py" --app stark-claude token 2>/dev/null); then
        export GH_TOKEN="$GH_TOKEN_TMP"
    else
        if [ -n "${DRY_RUN:-}" ]; then
            warn "GH_TOKEN not set and github_app.py token failed; --dry-run continues without posting auth"
        else
            error "GH_TOKEN not set and github_app.py token failed; cannot post review"
            exit 1
        fi
    fi
fi
```

### 3. Verify gh and provision the worktree

```bash
if [ -n "${GH_TOKEN:-}" ]; then
    gh auth status
elif [ -n "${DRY_RUN:-}" ]; then
    warn "skipping 'gh auth status' (no GH_TOKEN provisioned; --dry-run continues)"
else
    gh auth status
fi

SETUP_JSON=$(node --experimental-strip-types "$TOOLS/review_setup_worktree.ts" \
    --pr "$PR_NUM" --repo "$REPO" --mode single --json)
WORKTREE_PATH=$(printf '%s' "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["worktreePath"])')
HEAD_SHA=$(printf '%s'   "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pr"]["headSha"])')
BASE=$(printf '%s'        "$SETUP_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pr"]["base"])')
IS_FORK=$(printf '%s'     "$SETUP_JSON" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["pr"]["isFork"]).lower())')
```

`review_setup_worktree.ts` runs `gh pr view` to resolve `branch`, `headSha`,
`base`, `isFork`, `maintainerCanModify`; cross-checks the current checkout
matches `--repo`; force-fetches the base branch and the PR head ref; and
creates (or validates-and-reuses) `/tmp/review-<repo-slug>-pr<N>-single`.

Exit codes (skill must surface the message and stop on any non-zero):
`2` gh-cli-failure, `3` repo-mismatch, `4` worktree-dirty,
`5` worktree-head-mismatch, `6` git-failure.

## Phase 1: Run Review

Invoke the TS dispatcher with the captured `--config-root` and the worktree
path. Always pass `--json` so the wrapper can parse the receipt; use shell
parameter expansion `${X:+--x}` so missing optional flags don't expand to empty
arguments.

```bash
review_args=(
    --pr "$PR_NUM"
    --repo "$REPO"
    --base "$BASE"
    --worktree "$WORKTREE_PATH"
    --config-root "$CONFIG_ROOT"
    --json
)
[ -n "${AGENT:-}"   ] && review_args+=(--agent "$AGENT")
[ -n "${QUICK:-}"   ] && review_args+=(--quick)
[ -n "${DOMAINS:-}" ] && review_args+=(--domains "$DOMAINS")
[ -n "${DRY_RUN:-}" ] && review_args+=(--dry-run)

set +e
RECEIPT_JSON=$(node --experimental-strip-types "$TOOLS/stark_review.ts" "${review_args[@]}")
TS_EXIT=$?
set -e
```

The TS tool emits the receipt as a single JSON object on **stdout** and a
human summary on **stderr** (terminal-friendly). It exits:

- `0` — `ok=true` AND no failed results AND no unposted reviews
- `1` — `ok=false` (terminal failure) OR `ok=true` with non-empty
  `failed_results` / `unposted_reviews` (partial failure)

## Phase 2: Surface failures from the receipt

Parse the receipt JSON. Each failure condition below independently
forces a non-zero exit. Print specifics for each so the user can act.

```bash
parse() { printf '%s' "$RECEIPT_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

OK=$(parse 'print(str(d.get("ok")).lower())')
ERR_CODE=$(parse 'e=d.get("error") or {}; print(e.get("code","") or "")')
ERR_MSG=$(parse 'e=d.get("error") or {}; print(e.get("message","") or "")')
FAILED_LIST=$(parse '
rounds = d.get("rounds") or []
items = []
for r in rounds:
    rd = r.get("round")
    for f in (r.get("failed_results") or []):
        items.append("round {}: {}/{} — {}".format(rd, f.get("agent"), f.get("domain"), f.get("error")))
print("\n".join(items))
')
PARSE_ERROR_LIST=$(parse '
import re
def clean(v):
    return re.sub(r"[\x00-\x1f\x7f]", "", str(v or ""))[:160]
rounds = d.get("rounds") or []
items = []
for r in rounds:
    rd = r.get("round")
    for e in (r.get("parse_errors") or []):
        items.append("round {}: {} — {}".format(rd, clean(e.get("reason")), clean(e.get("line"))))
print("\n".join(items))
')
UNPOSTED_LIST=$(parse '
items = []
for u in (d.get("unposted_reviews") or []):
    items.append("round {}: {} status={}".format(u.get("round"), u.get("reason"), u.get("status","")))
print("\n".join(items))
')

failed=0

# (a) terminal failure
if [ "$OK" = "false" ]; then
    error "Review failed: $ERR_CODE — $ERR_MSG"
    failed=1
fi

# (b) any round had failed_results
if [ -n "$FAILED_LIST" ]; then
    error "Some domain/agent dispatches failed:"
    printf '  %s\n' "$FAILED_LIST" >&2
    failed=1
fi

# (c) any agent output had parser errors
if [ -n "$PARSE_ERROR_LIST" ]; then
    error "Some domain/agent outputs had parser errors:"
    printf '  %s\n' "$PARSE_ERROR_LIST" >&2
    failed=1
fi

# (d) any review failed to post
if [ -n "$UNPOSTED_LIST" ]; then
    error "Some reviews could not be posted:"
    printf '  %s\n' "$UNPOSTED_LIST" >&2
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi
```

If the TS tool's exit code is non-zero but none of (a)/(b)/(c) is parseable
(e.g. malformed JSON or empty stdout), treat it as a hard failure: print the
captured stderr and exit non-zero.

## Phase 3: Success summary

On success, print the human-readable summary using the receipt fields. Do not
re-derive counts the TS tool already computed.

```text
Review Complete - {repo} PR #{pr}
---------------------------------
Domains reviewed: {len(domains)}
Rounds: {len(rounds)}
  round 1: {findings} findings (fix={fix} noise={noise} fp={false_positive}) — {duration_ms}ms
  ...
Comments posted: {comments_posted}
Fixes pushed: {fixes_pushed}
History: {len(history_files)} round file(s)
```

Findings classification (`fix` / `noise` / `false_positive` / `ignored`) is
performed by the TS tool's classifier stage. The wrapper does not re-classify.

## Phase 4: Fix Loop

The TS dispatcher runs the fix loop between review rounds when the
authorization gate allows it (Phase 9 — see `tools/stark_review_lib.ts`
`evaluateFixLoopGate`). The wrapper does not orchestrate the loop itself;
it surfaces what the TS tool reports in the receipt (`fixes_pushed`,
audit-log entries under `~/.claude/code-review/history/<org>/<repo>/<pr>/`).

### Authorization

The gate allows the fix loop when ALL of:

- `config.test_command` is non-empty (sourced from trusted config only — never
  CLAUDE.md or package.json or any PR-controlled file).
- The PR is same-repo, OR fork-with-`maintainerCanModify`, OR the operator
  passed `--allow-untrusted-fix-loop` AND `config.untrusted_fix_loop=true`
  (both opt-ins required for untrusted fork pushes).
- `--no-fix-loop` was not passed.

If any condition fails, the review still posts; the fix loop is soft-skipped
with an audit-log `reason` (`no_test_command`, `fork_no_mcm`, `no_fix_loop`)
or surfaces a terminal `auth_denied` when CLI opt-in conflicts with config.

### Severity threshold

`config.fix_threshold` filters which findings the fixer attempts. Severity
ladder (high → low): `critical` > `high` > `medium` > `low`. Setting
`fix_threshold: "low"` includes every severity through nits; `"medium"`
excludes nits. The default in `global/config.json` is `"low"` — every
classified `fix` finding from Critical down to nits enters the loop.

### Step sequence (per round, after review POST lands)

1. Filter `pass.allFindings` to `classification === "fix"` AND severity ≥ `fix_threshold`.
2. Resolve and validate the push target (`resolvePushTarget` — bails terminally if
   the flow can't push, BEFORE the fixer touches files).
3. Run the fixer agent (Codex by default) with the filtered findings against the
   review worktree.
4. Stage the fixer's `modified_files` via `stageFiles` (explicit paths only —
   never `git add -A`).
5. Run the trusted `test_command` with a sandboxed env allowlist (`stark_review_lib.ts`
   `runTrustedTest`). Non-zero exit → terminal `test_failure`.
6. Commit + push to the resolved push target. Commit SHA + audit entry land in
   the receipt; the next round re-runs the review against the new HEAD.

`--max-rounds` caps the loop. Resolution order: explicit `--max-rounds` →
`config.max_rounds` (global/org/repo merge) → built-in default `3`. The hard
ceiling `MAX_ROUNDS_CEILING` in `stark_review.ts` (currently `10`) rejects
larger values from either source to prevent runaway sessions.

For fork PRs without `maintainerCanModify`, the loop is read-only unless both
`--allow-untrusted-fix-loop` (CLI) and `config.untrusted_fix_loop=true` are
set — see Authorization above.

## Phase 5: Persist History

The TS dispatcher writes history JSON to
`~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json` itself. The
receipt's `history_files` field lists the paths written. The wrapper does not
manage history.

## Phase 6: Cleanup

```bash
cd - >/dev/null

node --experimental-strip-types "$TOOLS/review_cleanup_worktree.ts" \
    --worktree "$WORKTREE_PATH" --head-sha "$HEAD_SHA" --json
```

The cleanup tool refuses to delete the worktree on unstaged changes, staged
changes, or HEAD drift. The `head-drift` check guards against fix commits that
were never pushed. Receipt: `{ removed, reason: removed | no-such-worktree |
unstaged-changes | staged-changes | head-drift, worktreePath, expectedHead,
observedHead }`.

The tool always exits 0; a `removed: false` receipt is a deliberate safety
decision, not a tool failure. Skip cleanup on dispatch failure or unpushed
state — surface the path and let the user inspect.

## Observability

Standard observability applies: timestamped progress logs, metrics block
(PR number, agents used, domains succeeded/failed, findings by severity,
duration), and completion event via `emit_queue.py`.

See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure                                          | Recovery |
|--------------------------------------------------|----------|
| Receipt `ok=false`                               | Print `error.code` + `error.message`, exit non-zero |
| Receipt has `failed_results` non-empty           | Print round/agent/domain/error list, exit non-zero |
| Receipt has `parse_errors` non-empty             | Print round/reason/line snippet, exit non-zero |
| Receipt has `unposted_reviews` non-empty         | Print round/reason/status, exit non-zero |
| TS tool exits non-zero with unparseable stdout   | Print stderr, exit non-zero |
| `--quick` with empty `quick_domains` in config   | TS tool exits with `bad_args`; surface the message |
| PR not found                                     | Print `PR #{n} not found. Check --repo or run from the correct directory.` |
| Worktree creation fails                          | Stop; do not fall back to the main checkout |
| Repo mismatch                                    | Stop and ask to run from the matching local checkout |
| Fork PR                                          | Review-only; no fix-loop |
| `GH_TOKEN` unset and `github_app.py token` fails | `--dry-run` continues with a warning; otherwise stop |
