---
name: stark-review-plan
description: >-
  Multi-domain execution plan review with lead/wing fix loop. Codex (gpt-5.5,
  xhigh reasoning) reviews 4 adversarial domains in parallel; Claude (opus-4-8)
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
  per domain in parallel — 4 adversarial domains by default for plan review
  (`completeness`, `security`, `sequencing`, `viability`). Concurrency capped
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
TOOLS="${STARK_REVIEW_TOOLS:-$HOME/.claude/code-review/tools}"
PROMPTS_BASE="${STARK_REVIEW_PROMPTS_BASE:-$HOME/.claude/code-review/prompts}"
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
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

## Phase 2: Detect PR + provision token (optional)

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)

if [ -z "${GH_TOKEN:-}" ]; then
    if GH_TOKEN_TMP=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token 2>/dev/null); then
        export GH_TOKEN="$GH_TOKEN_TMP"
    fi
fi
```

Token failure is non-fatal: the dispatcher runs without GitHub posting.

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
WING_ERRORS=$(parse '
rounds = d.get("rounds") or []
items = []
for r in rounds:
    fix = r.get("fix") or {}
    we = fix.get("wing_error")
    if we:
        items.append("round {}: wing_error={}".format(r.get("round"), we))
    for pf in (fix.get("patch_failures") or []):
        items.append("round {}: patch failure on finding {} — {}".format(
            r.get("round"), pf.get("finding_id"), pf.get("reason"),
        ))
print("\n".join(items))
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

If a PR was detected and `--dry-run` was not set, post the codex raw findings
under `stark-codex[bot]` and the wing summary under `stark-claude[bot]`:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-codex pr review $pr_number \
    --comment --body "$codex_findings_md"
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number \
    --comment --body "$summary_md"
```

If posting fails for either identity, warn and continue.

## Observability

For task templates, log line formats, checkpoint timing, and metrics block
format, see [references/observability.md](references/observability.md).

## Debugging Dispatch Failures

For dispatch troubleshooting (CLI flags per agent, error detection, smoke
tests), see [references/debugging-dispatch.md](references/debugging-dispatch.md).
