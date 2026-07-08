---
name: stark-review-plan
description: >-
  Multi-domain execution plan review with lead/wing fix loop. Codex (gpt-5.5,
  xhigh reasoning) reviews 5 adversarial domains in parallel; Claude (opus-4-8)
  wing fixes findings. Use for review plan, audit deployment plan.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--codex-concurrent N]"
disable-model-invocation: true
model: opus
revision: 7d4eb375d131624ff59927945d448856858d621c
revision_date: 2026-05-18T16:33:25Z
---

Thin wrapper. All review/fix logic lives in `tools/stark_review_doc.ts`. The
skill captures the path, validates basics, delegates to the TS dispatcher with
`--prompts-dir plan-review`, and surfaces failures from the JSON receipt.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review-plan`.

# stark-review-plan

Lead/wing multi-round execution plan review:

- **Lead (codex, gpt-5.5, model_reasoning_effort=xhigh)** dispatches 1 review
  per domain in parallel — 5 adversarial domains by default for plan review
  (`completeness`, `security`, `sequencing`, `viability`, `ssot`). Concurrency capped
  via `--codex-concurrent N` (default 3).
- **Wing (claude, opus-4-8)** receives the plan + classified `fix` findings
  and emits a JSON patch block; the dispatcher validates each patch's `old`
  text is unique and applies surgically.
- Each fix round commits the patched plan to git for traceability.
- A final review-only round captures unresolved findings after the last fix
  round.

**This skill assumes the plan will fail and hunts for where it will break.**

Answers the question: **"Can this plan actually be carried out safely?"**

For domain definitions and finding-classification criteria, see
[references/domain-definitions.md](references/domain-definitions.md).

## Arguments

- `<path>` — path to plan markdown file (required)
- `--rounds N` — max fix cycles (default: from config `plan_review.max_rounds`, ceiling 10)
- `--dry-run` — review only, no wing fixes, no commits
- `--force` — proceed even if the plan file has uncommitted changes
- `--codex-concurrent N` — cap on concurrent codex dispatches (default: 3)

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
PROMPTS_BASE="${STARK_REVIEW_PROMPTS_BASE:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/prompts}"
```

## Phase 1: Parse arguments + validate

Parse `$ARGUMENTS` for `<path>` (first non-flag positional) and flags
`--rounds N`, `--dry-run`, `--force`, `--codex-concurrent N`. Bind the path to
`DOC` — **never `path`**: under zsh the lowercase `path` parameter is tied to
`$PATH`, so `path=…` silently clobbers the command search path and every
dispatched `codex`/`node`/`gh` call dies with `agent_unavailable`.

- If no `DOC`: error "Usage: /stark-review-plan <path>" and abort.
- If `DOC` looks like a partial name (no `/`), `find docs/ -name "*${DOC}*"
  -o -name "*${DOC}*.md" 2>/dev/null | head -5` to suggest matches.
- Capture the repo root BEFORE delegating:

```bash
DOC="<first non-flag positional from $ARGUMENTS>"
REPO_DIR="$(pwd)"
```

## Phase 2: Relocate legacy path, detect/open PR + provision token

**Every review's findings land on a PR — so if none exists, this skill opens
one.** It also retires the legacy `docs/superpowers/` tree: a plan under
`docs/superpowers/**` is moved to `docs/plans/` before the PR is opened.

Provision a stark-claude installation token only when `GH_TOKEN` is unset
(never overwrite a caller-provided token). Token failure is non-fatal — the
dispatcher then runs without GitHub posting.

```bash
if [ -z "${GH_TOKEN:-}" ]; then
    if GH_TOKEN_TMP=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token 2>/dev/null); then
        export GH_TOKEN="$GH_TOKEN_TMP"
    fi
fi

DEST_DIR="docs/plans"   # plans live here — never docs/superpowers/
pr_number=$(gh pr view --json number --jq .number 2>/dev/null || true)

# ensure_branch: guarantee we are on a feature branch (branch + PR for
# everything — never commit plan-review changes onto the default branch).
ensure_branch() {
    DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)
    CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ "$CUR_BRANCH" = "$DEFAULT_BRANCH" ] || [ -z "$CUR_BRANCH" ] || [ "$CUR_BRANCH" = "HEAD" ]; then
        CUR_BRANCH="review-plan/$(basename "$DOC" .md)"
        git switch -c "$CUR_BRANCH" 2>/dev/null || git switch "$CUR_BRANCH"
    fi
}
```

**Relocate out of `docs/superpowers/`** (skip under `--dry-run`): move the plan
into `docs/plans/` on a feature branch and commit the move so the new location
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
of base even when the plan is already committed and unchanged.

```bash
if [ -z "$pr_number" ] && [ -z "${DRY_RUN:-}" ]; then
    ensure_branch
    git add -- "$DOC" 2>/dev/null || true
    git commit -m "docs(review): stage $(basename "$DOC") for plan review" 2>/dev/null \
        || git commit --allow-empty -m "chore(review): open PR to host plan-review findings for $(basename "$DOC")"
    git push -u origin "$CUR_BRANCH" 2>/dev/null || git push origin "$CUR_BRANCH" || true
    CREATE_OUT=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr create \
        --head "$CUR_BRANCH" --base "$DEFAULT_BRANCH" \
        --title "Plan review: $(basename "$DOC")" \
        --body "Opened by \`/stark-review-plan\` to host review findings for \`$DOC\`." 2>/dev/null || true)
    pr_number=$(printf '%s' "$CREATE_OUT" | sed -n 's/^Created PR #\([0-9]*\).*/\1/p')
fi
```

## Phase 3: Run dispatch

```bash
set +e
RECEIPT_JSON=$(node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir plan-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${CODEX_CONCURRENT:+--codex-concurrent "$CODEX_CONCURRENT"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force})
TS_EXIT=$?
set -e
```

Exit codes:
- `0` — ok and no failed results
- `1` — partial or terminal failure
- `2` — bad CLI arguments

## Phase 4: Surface failures

```bash
parse() { printf '%s' "$RECEIPT_JSON" | node --experimental-strip-types -e "
let raw=''; process.stdin.on('data',c=>raw+=c).on('end',()=>{
  const d=JSON.parse(raw); const out=[];
  $1
  process.stdout.write(out.join('\n'));
});"; }

OK=$(parse 'out.push(String(d.ok ?? null).toLowerCase());')
ERR_CODE=$(parse 'out.push((d.error||{}).code||"");')
ERR_MSG=$(parse 'out.push((d.error||{}).message||"");')
FAILED_LIST=$(parse '
for (const r of (d.rounds||[]))
  for (const f of (r.failed_results||[]))
    out.push(`round ${r.round}: ${f.agent}/${f.domain} — ${f.error}`);
')
WING_ERRORS=$(parse '
for (const r of (d.rounds||[])) {
  const fix=r.fix||{};
  if (fix.wing_error) out.push(`round ${r.round}: wing_error=${fix.wing_error}`);
  for (const pf of (fix.patch_failures||[]))
    out.push(`round ${r.round}: patch failure on finding ${pf.finding_id} — ${pf.reason}`);
}
')

failed=0
if [ "$OK" = "false" ]; then error "Review failed: $ERR_CODE — $ERR_MSG"; failed=1; fi
if [ -n "$FAILED_LIST" ]; then error "Lead dispatch failures:"; printf '  %s\n' "$FAILED_LIST" >&2; failed=1; fi
if [ -n "$WING_ERRORS" ]; then error "Wing fixer issues:"; printf '  %s\n' "$WING_ERRORS" >&2; failed=1; fi
[ "$failed" -ne 0 ] && exit 1
```

## Phase 5: Success summary + PR posting

On success, print the human summary:

```text
Plan Review Complete — {doc}
─────────────────────────────────
Rounds: {len(rounds)}
  round 1: {findings} findings (fix={fix} noise={noise} ignored={ignored}) — {duration}s
    fix: {applied}/{attempted} patches applied
  ...
  final-review: {findings} findings, {unresolved} unresolved
Fixes committed: {fixes_committed}
History: {history_dir}
```

If a PR was detected or opened in Phase 2 and `--dry-run` was not set, push any
dispatcher fix commits (`git push 2>/dev/null || true`), then post the codex raw
findings under `stark-codex[bot]` and the wing summary under `stark-claude[bot]`:

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
