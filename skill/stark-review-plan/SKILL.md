---
name: stark-review-plan
description: >-
  Multi-domain execution plan review with lead/wing fix loop. Codex (gpt-5.6-sol,
  xhigh reasoning) reviews 5 adversarial domains in parallel; Claude (opus-4-8)
  wing fixes findings. Use for review plan, audit deployment plan.
argument-hint: "<path> [--rounds N] [--dry-run] [--force] [--ready] [--codex-concurrent N] [--fable] [--lead-agent codex|claude] [--lead-model ID] [--wing-agent claude|codex] [--wing-model ID]"
disable-model-invocation: true
model: opus
revision: 7d4eb375d131624ff59927945d448856858d621c
revision_date: 2026-05-18T16:33:25Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

Thin wrapper. All review/fix logic lives in `tools/stark_review_doc.ts`. The
skill captures the path, validates basics, delegates to the TS dispatcher with
`--prompts-dir plan-review`, and surfaces failures from the JSON receipt.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review-plan`.

# stark-review-plan

Lead/wing multi-round execution plan review:

- **Lead reviewer** dispatches 1 review per domain in parallel — 5 adversarial
  domains by default for plan review (`completeness`, `security`, `sequencing`,
  `viability`, `ssot`). Default agent is codex (gpt-5.6-sol,
  `model_reasoning_effort=xhigh`); `--lead-agent claude` (or `--fable`) runs it
  on a Claude model (defaults to `claude-fable-5`). Concurrency capped via
  `--codex-concurrent N` (default 3).
- **Wing fixer** receives the plan + classified `fix` findings and emits a JSON
  patch block; the dispatcher validates each patch's `old` text is unique and
  applies surgically. Default agent is claude (opus-4-8); `--wing-agent codex`
  runs the fixer on codex (gpt-5.6-sol at xhigh). Lead and wing agents are
  independent.
- Each fix round commits the patched plan to git for traceability.
- A single **coherence pass** (wing dispatch) runs after the fix loop, before
  the final review: it hunts contradictions, repetitions, fluff, and leftovers
  the fix rounds introduced, and may only shrink the document (a growing result
  is rejected wholesale). Disable with `--no-coherence`.
- A final review-only round captures unresolved findings after the last fix
  round.
- **Process analytics + circuit breakers:** every run computes per-round
  metrics (doc growth, findings trajectory, recurring share, patch failures)
  and a health grade (`healthy`/`degraded`/`runaway`), written to
  `analytics.json` in the history dir, a `<plan>.review-analytics.md` sidecar
  next to the doc, and the receipt's `analytics` block. Inline guards stop the
  loop early when the doc grows past `analytics.max_doc_growth_ratio` (default
  2x the original) or findings fail to decline for
  `analytics.non_convergent_rounds` consecutive rounds — no more 200-line plans
  ballooning through 10 rounds.

**This skill assumes the plan will fail and hunts for where it will break.**

Answers the question: **"Can this plan actually be carried out safely?"**

For domain definitions and finding-classification criteria, see
[references/domain-definitions.md](references/domain-definitions.md).

## Arguments

- `<path>` — path to plan markdown file (required)
- `--rounds N` — max fix cycles (default: from config `plan_review.max_rounds`, ceiling 10)
- `--dry-run` — review only, no wing fixes, no commits
- `--force` — proceed even if the plan file has uncommitted changes
- `--no-coherence` — skip the post-fix-loop coherence pass (default: runs; also gated by config `coherence_pass`)
- `--ready` (alias `--no-draft`) — when this run **opens** a PR to host findings, open it ready-for-review. By default an auto-opened PR is a **draft** so the target repo's draft-guarded CI stays idle until it's marked ready.
- `--codex-concurrent N` — cap on concurrent codex dispatches (default: 3)
- `--lead-agent codex|claude` — which agent runs the lead review (default: `codex`). Use `claude` to run the lead on a Claude model (e.g. Fable). The wing/fixer stays `claude`/opus-4-8 regardless.
- `--lead-model ID` — override the lead reviewer model (default: `gpt-5.6-sol` for codex, `claude-fable-5` for claude)
- `--fable` — shorthand for `--lead-agent claude --lead-model claude-fable-5`: run the lead review on Fable 5. Only when explicitly requested.
- `--wing-agent claude|codex` — which agent runs the wing/fixer (default: `claude`/opus-4-8). `codex` runs the fixer on gpt-5.6-sol at `model_reasoning_effort="xhigh"`.
- `--wing-model ID` — override the wing/fixer model (default: `claude-opus-4-8` for claude, `gpt-5.6-sol` for codex)

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
PROMPTS_BASE="${STARK_REVIEW_PROMPTS_BASE:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/prompts}"
```

## Phase 1: Parse arguments + validate

Parse `$ARGUMENTS` for `<path>` (first non-flag positional) and flags
`--rounds N`, `--dry-run`, `--force`, `--codex-concurrent N`,
`--lead-agent AGENT`, `--lead-model ID`, `--fable`, `--wing-agent AGENT`,
`--wing-model ID`, and `--ready` (alias `--no-draft`) → set `READY=1` (used
only when this run **opens** a PR). `--fable` sets
`LEAD_AGENT=claude` (leave `LEAD_MODEL` unset so the dispatcher defaults to
`claude-fable-5`); explicit `--lead-agent`/`--lead-model` take precedence.
`--wing-agent`/`--wing-model` set `WING_AGENT`/`WING_MODEL` (leave `WING_MODEL`
unset for the agent default — `gpt-5.6-sol` at xhigh for codex). Bind the path to
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
    ready_flag=(); [ -n "${READY:-}" ] && ready_flag=(--ready)
    CREATE_OUT=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr create "${ready_flag[@]}" \
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
    ${LEAD_AGENT:+--lead-agent "$LEAD_AGENT"} \
    ${LEAD_MODEL:+--lead-model "$LEAD_MODEL"} \
    ${WING_AGENT:+--wing-agent "$WING_AGENT"} \
    ${WING_MODEL:+--wing-model "$WING_MODEL"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force} \
    ${NO_COHERENCE:+--no-coherence})
TS_EXIT=$?
set -e
```

Exit codes:
- `0` — ok: every domain completed a review at least once (transient dispatch
  failures that recovered in a later round no longer fail the run)
- `1` — terminal failure OR coverage gap (`coverage_gaps` nonempty: ≥1 domain
  never completed a review in any round — its zero findings mean "never ran",
  not "clean")
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
GAPS=$(parse 'out.push((d.coverage_gaps||[]).join(", "));')
TRANSIENT=$(parse '
const gaps=new Set(d.coverage_gaps||[]);
for (const r of (d.rounds||[]))
  for (const f of (r.failed_results||[]))
    if (!gaps.has(f.domain)) out.push(`round ${r.round}: ${f.agent}/${f.domain} — ${f.error}`);
')
WING_ERRORS=$(parse '
for (const r of (d.rounds||[])) {
  const fix=r.fix||{};
  if (fix.wing_error) out.push(`round ${r.round}: wing_error=${fix.wing_error}`);
  for (const pf of (fix.patch_failures||[]))
    out.push(`round ${r.round}: patch failure on finding ${pf.finding_id} — ${pf.reason}`);
}
')

PERSIST_ERRS=$(parse 'out.push(...(d.persistence_errors||[]));')

failed=0
if [ "$OK" = "false" ]; then error "Review failed: $ERR_CODE — $ERR_MSG"; failed=1; fi
if [ -n "$GAPS" ]; then error "COVERAGE GAP — these domains never completed a review in any round: $GAPS"; failed=1; fi
if [ -n "$TRANSIENT" ]; then printf 'WARN: transient lead dispatch failures (domain recovered in another round):\n' >&2; printf '  %s\n' "$TRANSIENT" >&2; fi
if [ -n "$PERSIST_ERRS" ]; then printf 'WARN: history persistence errors (run records may be incomplete):\n' >&2; printf '  %s\n' "$PERSIST_ERRS" >&2; fi
if [ -n "$WING_ERRORS" ]; then error "Wing fixer issues:"; printf '  %s\n' "$WING_ERRORS" >&2; failed=1; fi
[ "$failed" -ne 0 ] && exit 1
```

Blocking = `ok=false`, a coverage gap, or wing-fixer errors. Transient lead
dispatch failures (the domain recovered in another round) are a **warning,
not an abort** — do not soften the coverage-gap stop, and do not escalate
transient warnings into one.

## Phase 5: Post every finding, fix it, resolve its thread

**Contract: every finding lands on the PR as its own resolvable thread, every
finding gets fixed, and each thread is resolved with the fix.** The dispatcher
already ran the lead/wing loop and auto-fixed what it could; this phase posts
*all* findings, closes the loop on whatever the wing didn't resolve, and
resolves each thread. Nothing is dropped and nothing is left open.

Skip this whole phase under `--dry-run` or when no PR was detected/opened in
Phase 2 (there is nowhere to post). First always print the human summary:

```text
Plan Review Complete — {doc}
─────────────────────────────────
Rounds: {len(rounds)}
  round 1: {findings} findings (fix={fix} noise={noise} ignored={ignored}) — {duration}s
    fix: {applied}/{attempted} patches applied
  ...
  final-review: {findings} findings, {unresolved} unresolved
Fixes committed: {fixes_committed}
Coherence: {coherence.patches_applied} patches ({coherence.chars_delta} chars)
Analytics: {analytics.grade} — growth {analytics.growth_ratio}x, flags [{analytics.flags}]
Coverage: {all N domains completed | ⚠️ GAP: {coverage_gaps} never completed a review}
History: {history_dir}
```

### 5a. Post every finding as a resolvable thread

Write the receipt to a temp file and run the findings poster. For **every**
distinct finding across every round it opens a file-level (resolvable) review
thread on the plan; for findings the wing already fixed it replies + resolves
the thread immediately. **Each thread is authored by the reviewing LLM's App**
(the finding's `agent`: codex→stark-codex, claude→stark-claude,
gemini→stark-gemini) so PR comment authorship attributes findings to the
reviewer for analytics — `--app` below is only the fallback for reads +
unmapped agents. It prints the still-open findings (your work list) and
writes a map file (each entry records its authoring App, so 5c resolves under
the same one). Re-running is idempotent (findings already posted are
skipped via an HTML marker).

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "")
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
RECEIPT_FILE=$(mktemp -t stark-review-receipt-XXXXXX)
MAP_FILE=$(mktemp -t stark-review-map-XXXXXX)
printf '%s' "$RECEIPT_JSON" > "$RECEIPT_FILE"

POST_OUT=$(node --experimental-strip-types "$TOOLS/review_doc_findings.ts" post \
    --receipt "$RECEIPT_FILE" --doc "$DOC" --repo "$REPO" --pr "$pr_number" \
    --map "$MAP_FILE" --app stark-claude ${HEAD_SHA:+--commit-sha "$HEAD_SHA"})
printf '%s\n' "$POST_OUT"
```

The `open` array in `$POST_OUT` (re-readable any time via
`review_doc_findings.ts list --map "$MAP_FILE"`) is the set of findings you must
still fix by hand.

### 5b. Fix every open finding — ask when unclear

For **each** finding in the `open` list, in order:

1. Read the finding (`title`, `severity`, `domain`, `section`, `description`,
   `suggestion`) and the plan section it points at.
2. Decide the fix:
   - If the fix is clear, apply it to `$DOC` with `Edit`.
   - **If the fix is ambiguous, has multiple reasonable options, or needs a
     scope/sequencing decision, STOP and ask the operator** via the
     `AskUserQuestion` tool with the concrete options — never guess. Apply the
     operator's choice. ("Ask me" is part of the contract.)
   - Below-threshold / low-severity findings still get fixed. If, when asked,
     the operator decides a finding shouldn't be actioned, that decision is a
     valid resolution — resolve the thread noting why.
3. Commit the fix(es) to the feature branch and push (**push all commits**):

```bash
git add -- "$DOC"
git commit -m "docs(review-plan): fix <finding title> (<domain>/<severity>)"
git push
FIX_SHA=$(git rev-parse HEAD)
```

4. Resolve the finding's thread with a one-line summary of what changed:

```bash
node --experimental-strip-types "$TOOLS/review_doc_findings.ts" resolve \
    --map "$MAP_FILE" --finding-id "<id>" \
    --reply "<what you changed>" --commit-sha "$FIX_SHA"
```

You may batch several related fixes into one commit and then resolve each of
their threads against that commit's sha. When done, run
`review_doc_findings.ts list --map "$MAP_FILE"` and confirm it reports
`count: 0` — no finding left open.

### 5c. Post the run-summary comments

Retain the two consolidated summary comments for at-a-glance context (these are
non-resolvable, in addition to the per-finding threads above): the codex raw
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
