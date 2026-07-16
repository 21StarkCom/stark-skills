---
name: stark-review-spec
description: >-
  Multi-domain spec review with lead/wing fix loop. Codex (gpt-5.6-sol, xhigh
  reasoning) reviews 9 domains in parallel; Claude (opus-4-8) wing fixes findings.
  Use for review spec, review architecture.
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
`--prompts-dir spec-review`, and surfaces failures from the JSON receipt.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review-spec`.

# stark-review-spec

Lead/wing multi-round spec review:

- **Lead reviewer** dispatches 1 review per domain in parallel — 9 domains by
  default for spec review (`completeness`, `security`, `scope`, `api-design`,
  `data-modeling`, `consistency`, `accessibility`, `test-plan`). Default agent
  is codex (gpt-5.6-sol, `model_reasoning_effort=xhigh`); `--lead-agent claude`
  (or `--fable`) runs it on a Claude model (defaults to `claude-fable-5`).
  Concurrency is capped via `--codex-concurrent N` (default 3, raises the safe
  per-agent ceiling for this skill above the global stark-review cap of 1).
- **Wing fixer** receives the document + classified `fix` findings and emits a
  JSON `{patches: [{old, new}], skipped: [...]}` block. Default agent is claude
  (opus-4-8); `--wing-agent codex` runs the fixer on codex (gpt-5.6-sol at xhigh).
  The dispatcher validates each patch (`old` must occur exactly once) and applies
  it surgically; on partial failure it retries the wing once with the failures
  attached. Lead and wing agents are independent.
- Each fix round commits the patched document to git so the spec's evolution
  is traceable.
- A single **coherence pass** (wing dispatch) runs after the fix loop, before
  the final review: it hunts contradictions, repetitions, fluff, and leftovers
  the fix rounds introduced, and may only shrink the document (a growing result
  is rejected wholesale). Disable with `--no-coherence`.
- After the last fix round (or early termination on zero findings), a
  **final review-only round** captures unresolved findings.
- **Process analytics + circuit breakers:** every run computes per-round
  metrics (doc growth, findings trajectory, recurring share, patch failures)
  and a health grade (`healthy`/`degraded`/`runaway`), written to
  `analytics.json` in the history dir, a `<spec>.review-analytics.md` sidecar
  next to the doc, and the receipt's `analytics` block. Inline guards stop the
  loop early. **Soft growth** past `analytics.max_doc_growth_ratio` (default 2x)
  while findings decline only warns + requires an operator ack (#675). The
  **round-spike tripwire** halts on the FIRST round that grows the doc past
  `analytics.max_round_growth_ratio` (default 1.5x) while findings are not
  declining — a halt-for-ack (`analytics.growth_ack_required`), so a compounding
  balloon dies at round 1 instead of grinding to the cumulative breakers. Three
  signals hard-stop: **non-convergence** (findings fail to decline for
  `analytics.non_convergent_rounds` rounds), the **hard growth cap**
  (`analytics.hard_doc_growth_ratio`, default 3x — aborts on the round it's seen,
  before non-convergence is even measurable, catching a fast 4.5x balloon), and
  **invent-then-condemn** (the doc breached the soft limit AND the `scope` domain
  is raising high/critical over-engineering findings — the review manufactured
  scope it now condemns). The last two are unambiguous padding, so the doc is
  **rolled back to its pre-review state** (`analytics.rollback_on_hard_growth`,
  default true) instead of leaving you the bloat. A per-round variant guards each
  fix pass: a round that grows the doc **past the spike ratio** while the scope
  domain raised high/critical over-engineering findings is **discarded before
  commit** (receipt `fix.round_reverted` + `fix.discarded_finding_ids` — the
  discarded patches are never reported as applied). Growth ratios are measured against the
  **first-staged doc version** (pinned baseline — a re-run doesn't reset the
  ruler to already-grown content). Prevention lives upstream too: the review
  preambles + domains carry a **playground-scope guard** — a single-user/local/
  playground spec is not held to HA, audit-trail, migration, or adversarial-input
  standards — plus a **third scope tier**: a production system whose reviewed
  slice declares a V1 boundary ("What this is NOT" / "out of scope for V1" /
  "deferred to Phase 2" / "dark by default") has that boundary treated as
  **binding** — reviewers must not raise, and the wing skips (reason `author
  deferred to V1 boundary / out of scope`), findings that would add an
  explicitly-deferred concern. Each fix round is capped at
  `max_fixes_per_round` (default 8) patches, top-N by severity — the medium
  "add detail" overflow stays recorded, not patched — and reviewers receive the
  **prior rounds' applied patches** (accumulated) with an explicit anti-churn instruction
  (wrong fix text ⇒ "revert it", never "extend it"). Cross-domain
  **refractions of one root cause dedup into a single finding**
  (`cross_validated_by`) before counting and before the wing; **prior findings
  + dispositions** (fixed / skipped-as-trade-off) thread into later rounds so
  resolved concerns are not re-derived, while fix-cap overflow is re-queued
  host-side into the next round's batch; the wing fixes **deletion-first**,
  and a fix round growing the doc past `compress_retry_growth_ratio` (default
  1.15x) gets an in-round compress pass before commit — recorded in the
  receipt, with a survivor check that re-opens any fix the compress deleted. When the spec declares its bars (acceptance criteria /
  "Done when" / scope boundary), the review is **contract-anchored**: findings
  must name an unsatisfied bar or a genuine defect, and **zero findings is a
  valid output**. No more 200-line specs ballooning through rounds of invented
  production hardening.

Answers the question: **"Is this the right system?"**

## Arguments

- `<path>` — path to spec/architecture markdown file (required)
- `--rounds N` — max fix cycles (default: from config `spec_review.max_rounds`, ceiling 10)
- `--dry-run` — review only, no wing fixes, no commits
- `--force` — proceed even if the spec file has uncommitted changes
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

To call the dispatcher:

```bash
node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir spec-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${CODEX_CONCURRENT:+--codex-concurrent "$CODEX_CONCURRENT"} \
    ${LEAD_AGENT:+--lead-agent "$LEAD_AGENT"} \
    ${LEAD_MODEL:+--lead-model "$LEAD_MODEL"} \
    ${WING_AGENT:+--wing-agent "$WING_AGENT"} \
    ${WING_MODEL:+--wing-model "$WING_MODEL"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force} \
    ${NO_COHERENCE:+--no-coherence}
```

## Phase 1: Parse arguments + validate

Parse `$ARGUMENTS` for the leading `<path>` (first non-flag positional) and
flags `--rounds N`, `--dry-run`, `--force`, `--codex-concurrent N`,
`--lead-agent AGENT`, `--lead-model ID`, `--fable`, `--wing-agent AGENT`,
`--wing-model ID`, and `--ready` (alias `--no-draft`) → set `READY=1` (used
only when this run **opens** a PR). `--fable` sets `LEAD_AGENT=claude` (leave `LEAD_MODEL` unset
so the dispatcher defaults to `claude-fable-5`); explicit
`--lead-agent`/`--lead-model` take precedence. `--wing-agent`/`--wing-model`
set `WING_AGENT`/`WING_MODEL` (leave `WING_MODEL` unset for the agent default —
`gpt-5.6-sol` at xhigh for codex). Bind the
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
    ready_flag=(); [ -n "${READY:-}" ] && ready_flag=(--ready)
    CREATE_OUT=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr create "${ready_flag[@]}" \
        --head "$CUR_BRANCH" --base "$DEFAULT_BRANCH" \
        --title "Spec review: $(basename "$DOC")" \
        --body "Opened by \`/stark-review-spec\` to host review findings for \`$DOC\`." 2>/dev/null || true)
    pr_number=$(printf '%s' "$CREATE_OUT" | sed -n 's/^Created PR #\([0-9]*\).*/\1/p')
fi
```

## Phase 3: Run dispatch — in the background, always

Invoke the TS tool **as a background Bash task** (`run_in_background: true`),
never foreground: a multi-round run routinely exceeds the ~10-minute
foreground tool cap, and a killed foreground run loses the round in flight and
double-spends on the re-run. Redirect the receipt to a file, wait for the
background task to exit (BashOutput/task notification — do not poll in a busy
loop), then read the receipt and exit code from disk. stderr streams human
progress into the task output as it runs.

Shell state does not persist between Bash tool calls, so the receipt path
must be created and **printed** in a foreground call first, then substituted
**literally** into the background command and every later read:

```bash
RECEIPT_FILE=$(mktemp -t stark-review-receipt-XXXXXX); echo "RECEIPT_FILE=$RECEIPT_FILE"
```

```bash
# Run via the Bash tool with run_in_background: true, substituting the
# literal path printed above for $RECEIPT_FILE:
node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir spec-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${CODEX_CONCURRENT:+--codex-concurrent "$CODEX_CONCURRENT"} \
    ${LEAD_AGENT:+--lead-agent "$LEAD_AGENT"} \
    ${LEAD_MODEL:+--lead-model "$LEAD_MODEL"} \
    ${WING_AGENT:+--wing-agent "$WING_AGENT"} \
    ${WING_MODEL:+--wing-model "$WING_MODEL"} \
    ${DRY_RUN:+--dry-run} \
    ${FORCE:+--force} \
    ${NO_COHERENCE:+--no-coherence} > "$RECEIPT_FILE"; echo "TS_EXIT=$?"
```

When the background task completes (using the same literal receipt path), recover the results:

```bash
RECEIPT_JSON=$(cat "$RECEIPT_FILE")
# TS_EXIT comes from the background task's final "TS_EXIT=N" line.
```

Even if the session is interrupted mid-run, the dispatcher's per-round
persistence means `receipt.json` / `rounds.json` / `analytics.json` under the
run's history dir hold everything committed so far — check there before
re-running from scratch.

Exit codes:
- `0` — ok: every domain completed a review at least once (transient dispatch
  failures that recovered in a later round no longer fail the run)
- `1` — terminal failure OR coverage gap (`coverage_gaps` nonempty: ≥1 domain
  never completed a review in any round — its zero findings mean "never ran",
  not "clean")
- `2` — bad CLI arguments

## Phase 4: Surface failures

Parse the receipt JSON. Blocking = `ok=false`, a coverage gap, or wing-fixer
errors. Transient lead dispatch failures (the domain recovered in another
round) are a **warning, not an abort** — do not soften the coverage-gap stop,
and do not escalate transient warnings into one.

**Growth ack gate:** when the receipt has `analytics.growth_ack_required =
true`, the operator must judge the growth before findings are posted. Two
shapes fire it: cumulative growth past the ratio limit while findings kept
declining (the run completed — legitimate gap-filling on a thin spec looks
exactly like this), or the **round-spike halt** (a single round grew the doc
past `max_round_growth_ratio` while findings were not declining — the loop
stopped on that round; `analytics.flags` contains `round_spike_halt`). Ask via
`AskUserQuestion`: *"Doc grew {analytics.growth_ratio}× (limit
{config.analytics.max_doc_growth_ratio}×) — legitimate gap-filling or
padding?"* with options **Continue (growth is legitimate)** / **Stop here
(inspect the doc)**. On Continue: proceed and add `growth acked by operator`
to the 5c summary (after a spike halt, re-run with `--rounds` if more fix
rounds are actually wanted). On Stop — or when running headless with no
operator to ask — exit 1.

```bash
GROWTH_ACK=$(parse '(.analytics.growth_ack_required // false) | tostring')
```

```bash
parse() { printf '%s' "$RECEIPT_JSON" | jq -r "$1"; }

OK=$(parse '(.ok // false) | tostring')
ERR_CODE=$(parse '.error.code // ""')
ERR_MSG=$(parse '.error.message // ""')
GAPS=$(parse '(.coverage_gaps // []) | join(", ")')
TRANSIENT=$(parse '
  (.coverage_gaps // []) as $gaps
  | (.rounds // [])[] as $r
  | ($r.failed_results // [])[]
  | select(.domain as $d | ($gaps | index($d)) | not)
  | "round \($r.round): \(.agent)/\(.domain) — \(.error)"
')
WING_ERRORS=$(parse '
  (.rounds // [])[] as $r
  | ($r.fix // {}) as $fix
  | ( if $fix.wing_error then "round \($r.round): wing_error=\($fix.wing_error)" else empty end ),
    ( ($fix.patch_failures // [])[]
      | "round \($r.round): patch failure on finding \(.finding_id) — \(.reason)" )
')

PERSIST_ERRS=$(parse '(.persistence_errors // []) | join("\n")')

failed=0
if [ "$OK" = "false" ]; then error "Review failed: $ERR_CODE — $ERR_MSG"; failed=1; fi
if [ -n "$GAPS" ]; then error "COVERAGE GAP — these domains never completed a review in any round: $GAPS"; failed=1; fi
if [ -n "$TRANSIENT" ]; then printf 'WARN: transient lead dispatch failures (domain recovered in another round):\n' >&2; printf '  %s\n' "$TRANSIENT" >&2; fi
if [ -n "$PERSIST_ERRS" ]; then printf 'WARN: history persistence errors (run records may be incomplete):\n' >&2; printf '  %s\n' "$PERSIST_ERRS" >&2; fi
if [ -n "$WING_ERRORS" ]; then error "Wing fixer issues:"; printf '  %s\n' "$WING_ERRORS" >&2; failed=1; fi
[ "$failed" -ne 0 ] && exit 1
```

## Phase 5: Post every finding, fix it, resolve its thread

**Contract: every finding lands on the PR as its own resolvable thread, every
finding gets fixed, and each thread is resolved with the fix.** The dispatcher
already ran the lead/wing loop and auto-fixed what it could; this phase posts
*all* findings, closes the loop on whatever the wing didn't resolve, and
resolves each thread. Nothing is dropped and nothing is left open.

Skip this whole phase under `--dry-run` or when no PR was detected/opened in
Phase 2 (there is nowhere to post). First always print the human summary:

```text
Spec Review Complete — {doc}
─────────────────────────────────
Rounds: {len(rounds)}
  round 1: {findings} findings (fix={fix} noise={noise} ignored={ignored}) — {duration}s
    fix: {applied}/{attempted} patches applied, {skipped} skipped by wing, {failures} failed
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
thread on the spec; for findings the wing already fixed it replies + resolves
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
   `suggestion`) and the spec section it points at.
2. Decide the fix:
   - If the fix is clear, apply it to `$DOC` with `Edit`.
   - **If the fix is ambiguous, has multiple reasonable options, or needs a
     scope/product decision, STOP and ask the operator** via the
     `AskUserQuestion` tool with the concrete options — never guess. Apply the
     operator's choice. ("Ask me" is part of the contract.)
   - Below-threshold / low-severity findings still get fixed. If, when asked,
     the operator decides a finding shouldn't be actioned, that decision is a
     valid resolution — resolve the thread noting why.
3. Commit the fix(es) to the feature branch and push (**push all commits**):

```bash
git add -- "$DOC"
git commit -m "docs(review-spec): fix <finding title> (<domain>/<severity>)"
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
non-resolvable, in addition to the per-finding threads above):

- **Codex raw findings** under `stark-codex[bot]` — a table of severity /
  domain / section / title from the first review-fix round and the final round.
- **Wing summary** under `stark-claude[bot]` — the human summary above plus the
  per-round `git diff` of the spec file.

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-codex pr review $pr_number \
    --comment --body "$codex_findings_md"
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number \
    --comment --body "$summary_md"
```

If posting fails for any identity, warn and continue.

## Phase 6: Converge — review the delta of everything after the final review (ADR 0022)

Every mutation before this point was reviewed — except the 5b manual fixes
(the largest, least-constrained edits of the run). Phase 6 closes that hole
with a **delta-scoped convergence review** of `last_reviewed_sha..HEAD`, run
after all fixes are committed and pushed. This is the **terminal phase**:
nothing may mutate the spec after it except fixes to its own findings
(bounded below).

Skip only under `--dry-run` or when no PR exists (nowhere to post).

```bash
LAST_SHA=$(parse '.last_reviewed_sha // ""')
CONV_BASE_HEAD=$(git -C "$REPO_DIR" rev-parse HEAD)
set +e
CONV_RECEIPT=$(node --experimental-strip-types "$TOOLS/stark_review_doc.ts" \
    --doc "$DOC" --prompts-dir spec-review \
    --repo-dir "$REPO_DIR" --prompts-base "$PROMPTS_BASE" \
    ${LEAD_AGENT:+--lead-agent "$LEAD_AGENT"} \
    ${LEAD_MODEL:+--lead-model "$LEAD_MODEL"} \
    --converge --base "$LAST_SHA")
CONV_EXIT=$?
set -e
cparse() { printf '%s' "$CONV_RECEIPT" | jq -r "$1"; }
C_OK=$(cparse '(.ok // false) | tostring')
C_DELTA=$(cparse '(.converge.delta_chars // 0) | tostring')
C_FINDINGS=$(cparse '(.unresolved // []) | length')
```

Outcomes — post ONE convergence comment (stark-claude App, `github_app.ts pr
review $pr_number --comment`) carrying the exact claim, and print the same
line as the final operator message. **Silence is not a valid terminal state.**

- `CONV_EXIT != 0` or `C_OK != true` → **`⚠️ NOT converged — delta
  unreviewed`** (include the receipt `error`); exit 1. An unreviewed delta is
  a failed run.
- `C_DELTA = 0` → **`✅ Converged — empty delta`** (nothing changed since the
  final review round). Done.
- `C_FINDINGS = 0` → **`✅ Converged — delta reviewed, clean`**. Done.
- `C_FINDINGS > 0` → they are normal findings under the full contract. Write
  `CONV_RECEIPT` to a temp file and run the 5a → 5b loop over it (post as
  resolvable threads via `review_doc_findings.ts post` with a **fresh map
  file**; fix each — AskUserQuestion when ambiguous; commit + push; resolve
  each thread with the fix). Then:
  - if ANY convergence finding was `high`/`critical`: run **one** more
    convergence pass over the fixes themselves — `--converge --base
    "$CONV_BASE_HEAD"` — and handle its findings the same way. Never a third
    pass: post **`✅ Converged — delta reviewed, N findings (all resolved;
    second pass: M)`**, or **`⚠️ NOT converged — unresolved high-severity
    delta findings`** + exit 1 if the second pass still produced
    `high`/`critical`.
  - else post **`✅ Converged — delta reviewed, N findings (all resolved)`**.

## Debugging Dispatch Failures

For dispatch troubleshooting (CLI flags per agent, error detection, smoke
tests), see [references/debugging-dispatch.md](references/debugging-dispatch.md).
