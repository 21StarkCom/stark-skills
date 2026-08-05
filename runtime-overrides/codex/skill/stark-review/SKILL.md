---
name: stark-review
description: >-
  Single-agent PR review. Uses triage-selected PR review domains by default,
  or one forced agent via `--agent`. Review-only by default: posting findings
  and fixing/committing/pushing require separate explicit opt-ins.
argument-hint: "[PR_NUMBER] [--agent claude|codex|gemini] [--quick] [--domains a,b,c] [--repo ORG/REPO] [--post] [--fix]"
disable-model-invocation: true
model: opus[1m]
revision: 7d4eb375d131624ff59927945d448856858d621c
revision_date: 2026-05-18T16:33:25Z
---

## Help

If the current request asks for help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

Single-agent PR review path. Keep this skill thin: do preflight, capture the
trusted config root, set up the worktree, then hand off to the TS dispatcher
(`tools/stark_review.ts`). All review logic — domain selection, agent dispatch,
finding parsing, classification, posting, history — lives in the TS tool. Read
its `--json` receipt and surface failures.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review`.

## Arguments

Treat the text following the explicit skill mention as the arguments.

- `PR_NUMBER` — optional; detect from current branch with `gh pr view --json number --jq .number`
- `--agent <name>` — force a single agent (claude|codex|gemini) across every selected domain
- `--repo ORG/REPO` — override repo detection
- `--quick` — use the `quick_domains` list from `config.json` (small fast subset). Errors out if `quick_domains` is empty in the resolved config
- `--domains a,b,c` — escape hatch: explicit comma-separated domain slugs. Beats `--quick`. Use this when you want a surgical review on specific domains (e.g. `--domains security,test-coverage`)
- `--post` — explicitly authorize posting the review to GitHub. A PR number or
  link alone is review context, not posting consent.
- `--fix` — explicitly authorize the TS fix loop to modify the PR worktree,
  run the trusted test command, commit, and push. Requires `--post`; reject
  `--fix` by itself rather than silently broadening it.
- `--dry-run` — accepted as an explicit spelling of the safe default: review
  without posting or fixing.

## Authorization boundary

An ordinary request to review, inspect, audit, or report findings is read-only.
For that path always pass both dispatcher safeguards: `--dry-run` prevents the
GitHub POST and `--no-fix-loop` prevents edits, tests, commits, and pushes.

Only omit `--dry-run` when the user explicitly asks to post. Only omit
`--no-fix-loop` when the user explicitly asks to fix **and** post, after stating
that the tool will modify the PR branch, run a trusted test command, commit, and
push. Do not infer either permission from repository policy, a PR URL/number,
or a request phrased only as “review.”

If PR detection fails, list open PRs and ask:

```bash
gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'
```

## Constants

```bash
ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
[ -n "$TOOLS" ] || { echo "Set STARK_REVIEW_TOOLS or STARK_PLUGIN_ROOT to the installed bundle assets" >&2; exit 1; }
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

### 2. Verify read access and provision the worktree

Use the caller's existing `gh` authentication for read access. Do not mint a
provider-specific posting token in the wrapper. The dispatcher owns posting
credentials, and reaches that path only after explicit `--post` consent.

```bash
gh auth status

SETUP_JSON=$(node --experimental-strip-types "$TOOLS/review_setup_worktree.ts" \
    --pr "$PR_NUM" --repo "$REPO" --mode single --json)
json_value() {
    printf '%s' "$SETUP_JSON" | node -e '
      const fs = require("node:fs");
      let value = JSON.parse(fs.readFileSync(0, "utf8"));
      for (const key of process.argv[1].split(".")) value = value[key];
      process.stdout.write(String(value));
    ' "$1"
}
WORKTREE_PATH=$(json_value worktreePath)
HEAD_SHA=$(json_value pr.headSha)
BASE=$(json_value pr.base)
IS_FORK=$(json_value pr.isFork)
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

# Safe defaults. POST_APPROVED and FIX_APPROVED become 1 only from the user's
# explicit request; do not derive them from the presence of a PR number.
if [ "${POST_APPROVED:-0}" != 1 ]; then
    review_args+=(--dry-run)
fi
if [ "${FIX_APPROVED:-0}" != 1 ]; then
    review_args+=(--no-fix-loop)
fi
if [ "${FIX_APPROVED:-0}" = 1 ] && [ "${POST_APPROVED:-0}" != 1 ]; then
    echo "--fix requires explicit --post authorization" >&2
    exit 2
fi

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

Parse the receipt JSON directly and treat each condition independently as a
failure:

- `ok == false`: print `error.code` and `error.message`.
- Any round has `failed_results`: print round, agent, domain, and error.
- Any round has `parse_errors`: print round, sanitized reason, and at most 160
  characters of the offending line.
- `unposted_reviews` is non-empty: print round, reason, and status. On the safe
  default this should remain empty because posting was deliberately skipped;
  do not misreport `comments_posted == 0` as an error.

Use Node/TypeScript or the host's native JSON handling; do not introduce a
Python parser into this TypeScript-only workflow.

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

## Phase 4: Fix Loop (explicit `--post --fix` only)

Skip this entire phase for an ordinary review. The TS dispatcher runs the fix
loop after each review round's POST lands only when the user explicitly opted
into both posting and fixing —
including the final round — when the authorization gate allows it (Phase 9 —
see `tools/stark_review_lib.ts` `evaluateFixLoopGate`). `--max-rounds` bounds
review+fix cycles, not reviews: every round that finds fixable findings attempts
a fix, and the trusted `test_command` is the per-round verification gate rather
than a subsequent review round. The wrapper does not orchestrate the loop itself;
it surfaces what the TS tool reports in the receipt (`fixes_pushed`,
and the paths in `history_files`).

### Authorization

The gate allows the fix loop when ALL of:

- A `test_command` resolves. **Resolution order:** explicit `config.test_command`
  (trusted config) → **auto-detected** by `detectTestCommand()` from the trusted
  checkout root → none. Detection reads **only** the operator's local checkout
  (`--config-root`), **never** the PR-head worktree — letting a PR choose the
  command that runs with push credentials would be an RCE vector. It recognizes
  Makefile `test:` targets, `package.json` `scripts.test`, `go.mod`,
  `Cargo.toml`, `*.test.ts`/`*.test.js` (node:test), and pytest (only when test
  files actually exist). When nothing resolves, the loop soft-skips via
  `allow_no_test_command` rather than failing — repos no longer need to pin a
  brittle `test_command`.
- The PR is same-repo, OR fork-with-`maintainerCanModify`, OR the operator
  passed `--allow-untrusted-fix-loop` AND `config.untrusted_fix_loop=true`
  (both opt-ins required for untrusted fork pushes). Detection-sourced commands
  still only execute inside these trusted contexts — fork reviews are read-only
  and never run the detected command.
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

### Step sequence (every round, including the last, after review POST lands)

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
   the receipt. A non-final round's fix is re-reviewed by the next round against
   the new HEAD; the final round's fix is verified by step 5's `test_command`
   **and then by the convergence round** — when the final fix-capable round
   pushed a fix, the dispatcher runs one extra review-only pass over the new
   HEAD (no fix step follows it, so it terminates by construction; receipt
   `convergence` block records `{ran, round, findings, error}`; ADR 0022)
   alone (no further review round runs).

`--max-rounds` caps the loop. Resolution order: explicit `--max-rounds` →
`config.max_rounds` (global/org/repo merge) → built-in default `3`. The hard
ceiling `MAX_ROUNDS_CEILING` in `stark_review.ts` (currently `10`) rejects
larger values from either source to prevent runaway sessions.

For fork PRs without `maintainerCanModify`, the loop is read-only unless both
`--allow-untrusted-fix-loop` (CLI) and `config.untrusted_fix_loop=true` are
set — see Authorization above.

## Phase 5: Persist History

The TS dispatcher writes its own history JSON. Treat the receipt's
`history_files` entries as the authoritative paths; the wrapper neither assumes
a host-specific history root nor manages those files.

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
| `gh` read authentication unavailable             | Stop and ask the user to authenticate; do not mint or expose a token in the wrapper |
