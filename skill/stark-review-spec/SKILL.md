---
name: stark-review-spec
description: >-
  Multi-domain spec review with lead/wing fix loop. Codex (gpt-5.5, xhigh
  reasoning) reviews 9 domains in parallel; Claude (opus-4-8) wing fixes findings.
  Use for review spec, review architecture.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--codex-concurrent N]"
disable-model-invocation: true
model: opus
revision: 7d4eb375d131624ff59927945d448856858d621c
revision_date: 2026-05-18T16:33:25Z
---

Thin wrapper. All review/fix logic lives in `tools/stark_review_doc.ts`. The
skill captures the path, validates basics, delegates to the TS dispatcher with
`--prompts-dir spec-review`, and surfaces failures from the JSON receipt.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review-spec`.

# stark-review-spec

Lead/wing multi-round spec review:

- **Lead (codex, gpt-5.5, model_reasoning_effort=xhigh)** dispatches 1 review
  per domain in parallel — 9 domains by default for spec review
  (`completeness`, `security`, `scope`, `api-design`, `data-modeling`,
  `consistency`, `accessibility`, `test-plan`). Concurrency is capped via
  `--codex-concurrent N` (default 3, raises the safe per-agent ceiling for
  this skill above the global stark-review cap of 1).
- **Wing (claude, opus-4-8)** receives the document + classified `fix` findings
  and emits a JSON `{patches: [{old, new}], skipped: [...]}` block. The
  dispatcher validates each patch (`old` must occur exactly once) and applies
  it surgically; on partial failure it retries the wing once with the failures
  attached.
- Each fix round commits the patched document to git so the spec's evolution
  is traceable.
- After the last fix round (or early termination on zero findings), a
  **final review-only round** captures unresolved findings.

Answers the question: **"Is this the right system?"**

## Arguments

- `<path>` — path to spec/architecture markdown file (required)
- `--rounds N` — max fix cycles (default: from config `spec_review.max_rounds`, ceiling 10)
- `--dry-run` — review only, no wing fixes, no commits
- `--force` — proceed even if the spec file has uncommitted changes
- `--codex-concurrent N` — cap on concurrent codex dispatches (default: 3)

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
PROMPTS_BASE="${STARK_REVIEW_PROMPTS_BASE:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/prompts}"
```

To call the dispatcher:

```bash
node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir spec-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${CODEX_CONCURRENT:+--codex-concurrent "$CODEX_CONCURRENT"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force}
```

## Phase 1: Parse arguments + validate

Parse `$ARGUMENTS` for the leading `<path>` (first non-flag positional) and
flags `--rounds N`, `--dry-run`, `--force`, `--codex-concurrent N`. Bind the
path to `DOC` — **never `path`**: under zsh the lowercase `path` parameter is
tied to `$PATH`, so `path=…` silently clobbers the command search path and
every dispatched `codex`/`node`/`gh` call dies with `agent_unavailable`.

- If no `DOC`: error "Usage: /stark-review-spec <path>" and abort.
- If `DOC` looks like a partial name (no `/`), `find docs/ -name "*${DOC}*"
  -o -name "*${DOC}*.md" 2>/dev/null | head -5` to suggest matches.
- Repo dir defaults to the current working directory. Capture it BEFORE
  delegating — keeps prompt resolution anchored to the operator's checkout.

```bash
DOC="<first non-flag positional from $ARGUMENTS>"
REPO_DIR="$(pwd)"
```

## Phase 2: Detect PR + provision token (optional)

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

If on a feature branch with an open PR, provision a stark-claude installation
token only when `GH_TOKEN` is unset (never overwrite a caller-provided token):

```bash
if [ -z "${GH_TOKEN:-}" ]; then
    if GH_TOKEN_TMP=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token 2>/dev/null); then
        export GH_TOKEN="$GH_TOKEN_TMP"
    fi
fi
```

Token failure is non-fatal: the dispatcher runs without GitHub posting.

## Phase 3: Run dispatch

Invoke the TS tool. Capture stdout (receipt JSON) and the exit code; stderr
already streams human progress to the terminal.

```bash
set +e
RECEIPT_JSON=$(node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir spec-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${CODEX_CONCURRENT:+--codex-concurrent "$CODEX_CONCURRENT"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force})
TS_EXIT=$?
set -e
```

Exit codes:
- `0` — `ok=true` AND no `failed_results` in any round
- `1` — `ok=false` (dispatch failure) OR partial failure (failed lead dispatches, wing errors, unparseable findings)
- `2` — bad CLI arguments

## Phase 4: Surface failures

Parse the receipt JSON. Every failure surface independently forces a non-zero
exit so the user can act.

```bash
parse() { printf '%s' "$RECEIPT_JSON" | jq -r "$1"; }

OK=$(parse '(.ok // false) | tostring')
ERR_CODE=$(parse '.error.code // ""')
ERR_MSG=$(parse '.error.message // ""')
FAILED_LIST=$(parse '
  (.rounds // [])[] as $r
  | ($r.failed_results // [])[]
  | "round \($r.round): \(.agent)/\(.domain) — \(.error)"
')
WING_ERRORS=$(parse '
  (.rounds // [])[] as $r
  | ($r.fix // {}) as $fix
  | ( if $fix.wing_error then "round \($r.round): wing_error=\($fix.wing_error)" else empty end ),
    ( ($fix.patch_failures // [])[]
      | "round \($r.round): patch failure on finding \(.finding_id) — \(.reason)" )
')

failed=0
if [ "$OK" = "false" ]; then error "Review failed: $ERR_CODE — $ERR_MSG"; failed=1; fi
if [ -n "$FAILED_LIST" ]; then error "Lead dispatch failures:"; printf '  %s\n' "$FAILED_LIST" >&2; failed=1; fi
if [ -n "$WING_ERRORS" ]; then error "Wing fixer issues:"; printf '  %s\n' "$WING_ERRORS" >&2; failed=1; fi
[ "$failed" -ne 0 ] && exit 1
```

## Phase 5: Success summary + PR posting

On success, print the human summary using fields from the receipt:

```text
Spec Review Complete — {doc}
─────────────────────────────────
Rounds: {len(rounds)}
  round 1: {findings} findings (fix={fix} noise={noise} ignored={ignored}) — {duration}s
    fix: {applied}/{attempted} patches applied, {skipped} skipped by wing, {failures} failed
  ...
  final-review: {findings} findings, {unresolved} unresolved
Fixes committed: {fixes_committed}
History: {history_dir}
```

If a PR was detected (Phase 2) and `--dry-run` was not set, post:

- **Codex raw findings** under the `stark-codex[bot]` identity — one comment summarizing the lead reviewer's findings (table of severity / domain / section / title from the first review-fix round and the final round).
- **Wing summary** under the `stark-claude[bot]` identity — the consolidated summary above plus the per-round `git diff` of the spec file.

Use the existing `tools/github_app.ts` helper:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-codex pr review $pr_number \
    --comment --body "$codex_findings_md"
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number \
    --comment --body "$summary_md"
```

If posting fails for either identity, warn and continue.

## Debugging Dispatch Failures

For dispatch troubleshooting (CLI flags per agent, error detection, smoke
tests), see [references/debugging-dispatch.md](references/debugging-dispatch.md).
