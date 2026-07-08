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

## Phase 2: Relocate legacy path, detect/open PR + provision token

**Every review's findings land on a PR — so if none exists, this skill opens
one.** It also retires the legacy `docs/superpowers/` tree: a spec under
`docs/superpowers/**` is moved to `docs/specs/` before the PR is opened.

Provision a stark-claude installation token only when `GH_TOKEN` is unset
(never overwrite a caller-provided token). Token failure is non-fatal — the
dispatcher then runs without GitHub posting.

```bash
if [ -z "${GH_TOKEN:-}" ]; then
    if GH_TOKEN_TMP=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token 2>/dev/null); then
        export GH_TOKEN="$GH_TOKEN_TMP"
    fi
fi

DEST_DIR="docs/specs"   # specs live here — never docs/superpowers/
pr_number=$(gh pr view --json number --jq .number 2>/dev/null || true)

# ensure_branch: guarantee we are on a feature branch (branch + PR for
# everything — never commit spec-review changes onto the default branch).
ensure_branch() {
    DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)
    CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ "$CUR_BRANCH" = "$DEFAULT_BRANCH" ] || [ -z "$CUR_BRANCH" ] || [ "$CUR_BRANCH" = "HEAD" ]; then
        CUR_BRANCH="review-spec/$(basename "$DOC" .md)"
        git switch -c "$CUR_BRANCH" 2>/dev/null || git switch "$CUR_BRANCH"
    fi
}
```

**Relocate out of `docs/superpowers/`** (skip under `--dry-run`): move the spec
into `docs/specs/` on a feature branch and commit the move so the new location
is what gets reviewed and lands on the PR.

```bash
if [ -z "${DRY_RUN:-}" ] && printf '%s' "$DOC" | grep -q 'docs/superpowers/'; then
    ensure_branch
    NEW_DOC="$DEST_DIR/$(basename "$DOC")"
    mkdir -p "$DEST_DIR"
    git mv "$DOC" "$NEW_DOC" && DOC="$NEW_DOC"
    git commit -m "docs: move $(basename "$NEW_DOC") to $DEST_DIR (retire docs/superpowers/)" -- . 2>/dev/null || true
fi
```

**Open a PR when none exists** (skip under `--dry-run`): create/seed a feature
branch, push, and open a PR authored by `stark-claude` so Phase 5 can post all
findings onto it. A `--allow-empty` seed commit guarantees the branch is ahead
of base even when the spec is already committed and unchanged.

```bash
if [ -z "$pr_number" ] && [ -z "${DRY_RUN:-}" ]; then
    ensure_branch
    git add -- "$DOC" 2>/dev/null || true
    git commit -m "docs(review): stage $(basename "$DOC") for spec review" 2>/dev/null \
        || git commit --allow-empty -m "chore(review): open PR to host spec-review findings for $(basename "$DOC")"
    git push -u origin "$CUR_BRANCH" 2>/dev/null || git push origin "$CUR_BRANCH" || true
    CREATE_OUT=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr create \
        --head "$CUR_BRANCH" --base "$DEFAULT_BRANCH" \
        --title "Spec review: $(basename "$DOC")" \
        --body "Opened by \`/stark-review-spec\` to host review findings for \`$DOC\`." 2>/dev/null || true)
    pr_number=$(printf '%s' "$CREATE_OUT" | sed -n 's/^Created PR #\([0-9]*\).*/\1/p')
fi
```

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

If a PR was detected or opened in Phase 2 and `--dry-run` was not set, push
any dispatcher fix commits and post the findings onto it:

```bash
git push 2>/dev/null || true
```

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
