# stark-write-spec — contract-bounded spec authoring

- **Date:** 2026-07-16
- **Status:** draft
- **Scope:** new `skill/stark-write-spec/` + `tools/write_spec.ts` + `tools/write_spec_lib.ts` + `global/prompts/write-spec/` + `stark_config_lib.ts` (new section)
- **Pipeline position:** the missing **stage 0** — before `/stark-review-spec`.

## Problem

The pipeline starts at *review*: `stark-review-spec → stark-spec-to-plan →
stark-plan-to-tasks → phase-execute`. Nothing owns spec **authoring**, so
whatever enters review is thin, hand-written intent — and review-spec's 9
adversarial domains fill the gaps by inventing content. That is the root of
the inflation this repo has spent weeks building breakers against:

- 200-line docs ballooning toward 80k lines over 10 rounds (the reason
  `analytics.max_doc_growth_ratio` / `hard_doc_growth_ratio` exist).
- The **invent-then-condemn** breaker (#676): the review manufactures scope
  it later flags as over-engineering.
- Growth-ack gates, rollback-on-hard-growth, coherence passes — all
  *downstream damage control* for a document that was born incomplete.

The structural cause: **completeness is defined implicitly as "whatever the
adversarial reviewers can still find"** instead of explicitly by a contract.
An adversarial critic loop is unbounded by construction — there is always one
more angle, so the doc ratchets. Feeding review a spec that is already
complete *against a fixed contract* removes the legitimate gaps; the existing
playground-scope guards (#675–#678) then handle the illegitimate ones.

`stark-write-spec` is that authoring stage: it turns intent (an inline
prompt, a rough notes file, and/or decisions distilled from the current
conversation) into a spec that satisfies a **fixed Spec Contract**, then
hands off to the (still mandatory) `/stark-review-spec` gate.

## Design

### Shape

A thin skill + a lead/wing TS dispatcher, deliberately mirroring
`tools/plan_dispatch.ts` (the closest sibling — lead drafts text, wing
returns a JSON verdict, bounded revise loop, no worktree, no tool use):

```
/stark-write-spec <path|"intent">
  └─ SKILL.md (interactive layer — the only place that can see the chat)
       ├─ assemble intent brief  (prompt + doc + chat context + constraints)
       ├─ AskUserQuestion         (load-bearing gaps only, one round max)
       └─ tools/write_spec.ts     (headless lead/wing loop)
            round 1..N:
              lead   — draft/revise spec against the Spec Contract
              wing   — verify: per-contract-item status JSON (NOT findings)
            exit: all items satisfied|n_a  → done
                  else revise only the non-satisfied items
       ├─ git branch + commit + draft PR (stark-claude App)
       └─ print handoff: /stark-review-spec <spec>
```

**Why this cannot ratchet like review-spec:** the wing does not emit
free-form findings. It returns one status per contract section from a closed
enum, and the host parser **drops any section id not in the contract** — the
wing structurally cannot ask for a 10th section, so the *number* of sections
is fixed by construction. The per-item `note` is advisory prose scoped to its
section's contract criteria (not a new requirement), and the revise step acts
only on the named non-satisfied sections; a note that strays beyond its
section's done-when bar is discretionary input the lead may decline, not a
mandatory finding. Growth in *section count* is bounded absolutely; growth in
*section depth* is bounded by the contract's per-section done-when bar plus
the `over_scoped` cut path — no growth breakers, coherence passes, or
rollback machinery are needed here.

**Loop vs single pass:** the loop degrades to exactly one verify pass when
the first draft is clean (early exit on `done`), so a bounded loop costs the
same as single-pass in the good case and self-heals in the bad one.
`max_rounds` defaults to **3** (vs the siblings' 4): drafting against a fixed
checklist converges faster than open review; if 3 rounds can't satisfy the
contract, the *intent* is missing information and a human answer — not a 4th
round — is the fix (see Gap resolution).

### The Spec Contract

The heart of the design. Completeness = **these slots are filled**, not
"nothing left for a reviewer to find". The sections are the review-spec
domains **inverted** — author against the exact rubric review will judge by:

| # | Section | Done when | Review domain it pre-empts |
|---|---------|-----------|---------------------------|
| 1 | Intent & Problem | user need + why-now stated, with evidence if it exists | completeness |
| 2 | Scope & Non-Goals | explicit in-scope + out-of-scope; **declares playground/single-user scope when true** | scope |
| 3 | Interfaces & Contracts | Consumes/Produces signatures, data shapes, CLI surfaces | api-design, data-modeling |
| 4 | Behavior & Flows | concrete flows, states, error paths, termination conditions | consistency |
| 5 | SSOT & Dependencies | names the existing owners it consumes; never re-derives a rule or hardcodes a literal an owner already owns | ssot |
| 6 | Security & Failure Modes | scope-proportional threats + enumerated failure modes | security |
| 7 | Test Plan / DoD | a **named proving test** per behavior change + success criteria | test-plan |
| 8 | Accessibility | addressed, or an explicit justified **N/A** | accessibility |
| 9 | Open Questions | genuine unknowns listed (allowed to remain — an honest gap beats invented content) | — |

Contract rules:

- **`n_a` is a first-class status for `n_a`-eligible sections** — a section
  may be marked not-applicable *with a stated reason*, but **four sections are
  mandatory and reject `n_a`** (normalization degrades an `n_a` on them to
  `underspecified`): Intent & Problem (1), Scope & Non-Goals (2), Behavior &
  Flows (4), and Test Plan / DoD (7) — every artifact this tool authors has an
  intent, a scope, a behavior, and a way to prove it, so an all-`n_a` verdict
  can never vacuously satisfy the contract. The remaining five (Interfaces,
  SSOT, Security, Accessibility, Open Questions) accept a reasoned `n_a`. This
  is what keeps the contract from becoming its own inflation vector: a CLI
  tool writes "Accessibility: N/A — terminal output only" instead of
  manufacturing an accessibility program, but it can never wave off its own
  intent or scope.
- **The Scope declaration is the anti-inflation anchor.** Because the spec
  declares single-user/playground scope up front, every downstream
  playground-scope guard (review preambles, wing fixer contract, red-team
  personas, plan-to-tasks passes) sees the declaration and stands down.
  Specs are *born scoped* instead of being de-scoped in every review round.
- **The contract is a prompt asset, not config.** It lives at
  `global/prompts/write-spec/contract.md` and is resolved via
  `assetPromptsDir()`. Repo/org config overrides cannot add, remove, or
  weaken sections — deliberately, and without needing the red-team
  locked-fields machinery (that enforcement is `getRedTeamConfig`-specific
  and stays that way). Config carries knobs only (models, rounds, timeouts).
  The contract is encoded in four places that must move together —
  `contract.md`, the parser's canonical nine-id list in
  `normalizeContractVerdict`, the agent prompts, and the review-spec domains
  it inverts. A generated registry is over-scoped for a playground (rule of
  three); instead a **single regression test** (`test_asset_contract`, below)
  binds `contract.md`'s section ids to the parser set and to the domain names
  review-spec judges by, so a renamed/added section fails CI loudly instead
  of being silently dropped as unknown.

### Wing verdict schema

The wing's entire output contract (extracted with the existing
`extractVerdictJson` fence parser; normalized by a new
`normalizeContractVerdict` — `normalizeVerdict` is the approve/revise/block
shape and does not apply):

```json
{
  "items": [
    { "section": "scope", "status": "satisfied", "note": "" },
    { "section": "test-plan", "status": "underspecified",
      "note": "no named test for the revise path" }
  ],
  "done": false,
  "summary": "one line"
}
```

- `section` ∈ the 9 fixed ids (`intent`, `scope`, `interfaces`, `behavior`,
  `ssot`, `security`, `test-plan`, `accessibility`, `open-questions`).
  Unknown ids are **dropped by the parser** (logged in the receipt) — the
  structural bound.
- `status` ∈ `satisfied | underspecified | missing | over_scoped | n_a`.
  `over_scoped` is the bidirectional-gate lesson from #677: the wing must be
  able to say "this section manufactures ceremony beyond the declared scope
  — cut it", not only demand more. The revise step **removes** content for
  `over_scoped` items. An **unknown status string fails safe to
  `underspecified`** (toward another round, never toward a false `done`).
- `done` is **host-recomputed, never trusted from the wing.** The parser
  first normalizes `items` into a **fixed nine-section map keyed by the
  canonical ids, every slot initialized to `missing`**; each returned item
  overwrites its slot. **Duplicate ids fail closed** — the more-severe status
  wins (`missing` > `underspecified`/`over_scoped` > `n_a` > `satisfied`), so
  a conflicting duplicate can never upgrade a section to done. When a section's duplicates carry **both** equal-rank-but-opposite statuses (`underspecified` *and* `over_scoped` — add-detail vs cut-content), the tie breaks **toward `missing`** (the most-severe rank): the wing contradicted itself about that section, so it is left unresolved — forcing another revise round rather than an arbitrary add-or-cut — and both notes are concatenated so the lead sees the conflict (the conflicting-duplicate row of `test_done_fails_closed` proves it). An `n_a` slot
  is honored **only with a non-empty `note`** (the stated reason); a
  reason-less `n_a` degrades to `underspecified`. `done = true` **only when
  all nine slots are present and every one is `satisfied` or a valid `n_a`** —
  an empty or partial `items` array therefore leaves ≥1 slot `missing` and
  can never vacuously satisfy the contract.
- A malformed verdict gets **one** retry with a format reminder (same
  pattern as `plan_dispatch.ts`); a second failure terminates the run as
  `wing_unparseable` with the current draft preserved.

### Lead revise semantics

On a non-`done` round the lead receives: its prior draft, **only** the
non-satisfied items (with notes), and the revise prompt. It revises those
sections and returns the full document. The revise prompt carries the same
playground-scope discipline block as the #677 spec-to-plan prompts, plus:
"an unknown you cannot resolve from the intent brief goes under Open
Questions — never invent an answer."

### Intent brief

The dispatcher is headless; the skill layer is what can see the
conversation. It assembles a single markdown brief (written to the session
scratchpad, passed as `--intent-brief PATH`):

```
## Ask            — the user's prompt, verbatim
## Source material — referenced doc contents (if a path was given)
## Conversation context — decisions already made in chat, distilled by the skill
## Constraints    — repo, doc conventions pointer, scope declaration, language prefs
## Target         — out path + topic slug
```

Interactive gap-fill happens **before** dispatch, via one `AskUserQuestion`
round (≤4 questions) covering only load-bearing unknowns the brief cannot
answer: topic/slug, scope declaration if not inferable, out path if
non-standard. Everything else the lead resolves or parks under Open
Questions. Brief size is capped at `write_spec.max_input_chars` (default
200 000, measured in **Unicode code points** of the fully-assembled brief; the
cap is **also** re-checked in **UTF-8 bytes** of the actual dispatched payload
before spawn, since the transport is byte-bounded) via **deterministic
per-section budgeting**:
1. Reserve Ask + Constraints + Target in full (protected, never truncated).
   If they **alone** exceed the cap, fail fast with `brief_too_large` (a
   preflight `error`) — never truncate protected content.
2. `remaining = cap − reserved`, split **60 % Source material / 40 %
   Conversation context** (favoring the referenced doc).
3. **Spillover:** if either section is shorter than its share, its unused
   budget is handed to the other **before** any truncation — so a tiny notes
   file lets the whole conversation through, and vice-versa.
4. A section still overflowing its post-spillover share is truncated at a
   **code-point boundary** and gets a one-line marker
   (`… [truncated N code points]`) whose own length is **counted against that
   section's share**, so the emitted section never exceeds it. Source is
   truncated before conversation.
The assembled brief is thus a pure function of its inputs — every
implementation produces identical output.

### Termination & gap resolution

The dispatcher owns an **immutable `dispatch_verdict`** (never rewritten
downstream) ∈ `contract_satisfied | max_rounds_unsatisfied | lead_empty_draft
| unchanged_revision | wing_unparseable | dispatch_error` (naming parity with
`plan_dispatch.ts`'s `FinalVerdict`), extended with `dispatch_error`.
`dispatch_error` is the fail-fast terminus for any agent-execution or
resolution failure the loop cannot recover from — an agent process that
fails to start, exits non-zero, or times out; a disabled/unavailable
requested agent; or a model- or prompt-asset resolution failure — surfaced
**before any verdict is computed**. `wing_unparseable` is distinct: it applies
**only after a wing process returned successfully** but its output failed the
single format retry. `unchanged_revision` = a revise round
returned a byte-identical document — the lead is stuck, stop paying. The
**skill** owns the enclosing `workflow_outcome`: for a clean run it equals the
`dispatch_verdict`; on a `max_rounds_unsatisfied` dispatch the skill sets it to
`accepted_with_gaps` or `aborted` (see the terminal-state machine below). The
top-level `final_verdict` in the receipt **is the `workflow_outcome`** — the
dispatcher's `dispatch_verdict` is preserved alongside it, never overwritten,
and a single receipt-finalization function derives `ok`, exit status, and
`error.code` from the outcome table below. Two components decide two distinct
fields, not one.

**Canonical outcome table** (authoritative for `ok` / exit / `error.code` /
landing / persistence; every skill- and dispatcher-level terminus appears
exactly once):

| final_verdict / terminus | ok | exit | error.code | landing | on-disk |
|---|---|---|---|---|---|
| `contract_satisfied` | true | 0 | — | branch/commit/PR | spec + finalized receipt |
| `accepted_with_gaps` | true | 0 | — | branch/commit/PR | spec + finalized receipt |
| `aborted` | false | ≠0 | `gap_aborted` | none | spec + receipt (no branch) |
| `max_rounds_unsatisfied` (dispatch verdict; `--json`/non-interactive surfaces it as `result_type:needs_input` / `stage:post_dispatch`, `dispatch_verdict` preserved) | false | ≠0 | `needs_input` | none | spec + receipt |
| `lead_empty_draft` | false | ≠0 | `lead_empty_draft` | none | receipt (+ empty/partial draft) |
| `unchanged_revision` | false | ≠0 | `unchanged_revision` | none | spec + receipt |
| `wing_unparseable` | false | ≠0 | `wing_unparseable` | none | spec + receipt |
| `dispatch_error` (agent process start/exit/timeout, disabled/unavailable agent, model- or prompt-resolution failure — fail-fast, no verdict) | false | ≠0 | `dispatch_error` | none | receipt + any prior-round spec |
| core history-write failure (`rounds.json`/`receipt.json`/`dispatch-spec.md`/`final-spec.md` atomic write or rename fails) | false | ≠0 | `history_core_write` | none | best-effort via stderr (the persisted-receipt guarantee is what failed, so it is not falsely asserted) |
| landing failure (verdict was `contract_satisfied`/`accepted_with_gaps`, push/PR failed) | false | ≠0 | `git` \| `push` \| `pr` | partial | spec + finalized receipt |
| `dry_run` (sentinel, dispatcher or skill) | true | 0 | — | none | scratchpad brief only (no `run_id`) |
| `needs_input` (`--json` pre-dispatch preflight — missing input) | false | ≠0 | `needs_input` | none | none (no `run_id`/history) |
| `brief_too_large` (`--json` pre-dispatch preflight; `result_type:error`) | false | ≠0 | `brief_too_large` | none | none (no `run_id`/history) |

`dry_run` and `needs_input`/pre-dispatch validation (`brief_too_large`,
missing input) are the **explicit exceptions** to "every non-crash exit writes
the spec + receipt": they exit **before dispatch**, so no spec and no `run_id`
exist. The spec + receipt guarantee therefore applies to every non-crash exit
**that entered dispatch**.

Every non-crash exit **that entered dispatch** (dry-run and pre-dispatch
validation failures excluded per the outcome table above) **still writes the
spec file and the receipt**. On `max_rounds_unsatisfied` the skill (not the
dispatcher) offers, via `AskUserQuestion`, a bounded terminal-state machine —
each branch defines its own finalized receipt, `ok`, and exit status:

1. **Answer the gaps** — operator fills the missing information; skill
   enriches the brief and re-dispatches **once** (hard bound: one retry). The
   retry is a new dispatcher `run_id` whose receipt records `parent_run_id`;
   its terminal verdict is the run's outcome (`contract_satisfied` →
   `ok:true`; another `max_rounds_unsatisfied` does **not** recurse and falls
   through to Accept-with-gaps / Abort).
2. **Accept with gaps** — only `missing`/`underspecified` items are appended
   to the spec's Open Questions section verbatim (genuine unknowns), honest
   and visible to review-spec; **`over_scoped` items are never questions** —
   they are cut from the draft, or (if the lead couldn't cut them) listed in
   the receipt as `unresolved_over_scoped`, not parked in Open Questions. The
   skill records `gap_resolution:"accepted"` + `accepted_items[]`, sets
   `final_verdict:"accepted_with_gaps"`, lands the spec normally
   (branch/commit/PR), and exits **0** — an intentional, review-visible
   outcome is a success.
3. **Abort** — no PR and no branch (branch creation is part of landing, which
   never runs here); only the scratchpad brief and the already-written spec +
   receipt are left for inspection. Receipt records `gap_resolution:"aborted"`,
   `ok:false`, exit non-zero.

The finalized receipt (after any branch) is the single authoritative record
and matches the committed spec + PR status table.

### Output & landing

**Landing owner = the skill layer, not the dispatcher.** The dispatcher is
pure author: it runs the lead/wing loop and writes the authored document into
its **run-history dir** as **`dispatch-spec.md`** (the immutable dispatcher
output) plus the run record, emitting a receipt with `pr: null` — it does
**not** write the target `spec_path`. The skill resolves the landing state
first (checks out an existing `write-spec/<slug>` branch if one exists), then
**applies any gap resolution** (Accept-with-gaps appends Open Questions / cuts
`over_scoped` content) to produce **`final-spec.md`** — written atomically to
the run dir, hashed, and copied **byte-for-byte** into `spec_path` — then
commits, pushes, and opens/edits the PR. `dispatch-spec.md` is never mutated;
`final-spec.md` is the sole landed artifact, so its hash, the committed blob,
and `commit_sha` are guaranteed identical on every successful outcome (a clean
run with no gap resolution copies `dispatch-spec.md` into `final-spec.md`
unchanged). A rerun never leaves uncommitted output blocking the checkout, and
never carries one branch's draft onto another. All git + GitHub work (branch, commit, push,
PR) is the skill's, via the `github_app.ts` CLI; the skill then **finalizes
the receipt** — rewriting the persisted `receipt.json` with the `pr` result
and the landing-aware `ok` — so the on-disk record matches the committed spec
and PR. `--ready`/`--no-pr` are skill-only flags (the dispatcher never opens
a PR). The dispatcher's `prCreate`/`getToken` dependency below is consumed by
this skill layer, not the headless loop.

- Spec at `docs/specs/YYYY-MM-DD-<topic>-spec.md` **by default** (repo doc
  conventions; slug via `sanitizeSlug` from `stark_handover_lib.ts`). `--out
  PATH` overrides this default with an operator-supplied path, still
  **host-validated** (must resolve inside the repo; slug/branch are derived
  from its basename). "Host-computed, never model-chosen" means the *model*
  never picks the path, not that the operator can't — the choice is the
  operator's flag or the default, never the LLM's.
- One final commit on branch `write-spec/<slug>` (round drafts are noise for
  a *new* document — unlike review-spec, whose per-round commits trace an
  existing doc's evolution; the per-round story lives in the receipt and PR
  body instead).
- **Draft PR** via the lead's GitHub App (`prCreate`, `draft ?? true` —
  repo-wide draft-by-default policy), body carrying the final contract-status
  table + per-round summary. `--ready` opts out, `--no-pr` skips.
- **Re-run on an existing slug:** the canonical spec path (including its
  date) is recorded in the run history the first time a slug is authored; a
  rerun **reuses that exact path** rather than minting a new dated filename.
  If `write-spec/<slug>` (and its PR) already exist, check the branch out, copy
  the regenerated spec onto the recorded path, commit **on top**, and push
  normally — never force-push (workspace rule: review threads must survive),
  never mint a parallel branch. The PR trail keeps every generation.
  **Landing state table:** branch + open PR → reuse both; branch present,
  no/closed PR → reuse branch, open a fresh PR; neither → create branch +
  draft PR; `spec_path` exists but **no matching branch** (a hand-authored
  file or an aborted prior run) → fail fast and require an explicit
  rerun/overwrite rather than silently clobbering it. **Byte-identical
  regeneration** (the regenerated spec equals the branch version) is a
  **successful no-op**: the skill diffs before committing and, on no change,
  reuses the existing commit + PR (verdict `contract_satisfied`, `ok:true`)
  rather than issuing an empty commit that would fail.
- Handoff line: `next: /stark-review-spec <spec-path>`. Review-spec's
  existing "reuse a PR if one exists" behavior picks up the write-spec PR —
  author and review share one branch/PR trail end to end.

### Run record

Per the fleet's analytics bar (every run leaves a crash-proof record):
history at `~/.claude/code-review/history/write-spec/<slug>/<run-id>/` with
`rounds.json` (the **canonical** per-round record; `RoundRecord` schema
below) + `receipt.json` written
**incrementally after every round** — the receipt's `rounds` summary and
`contract_status` are **derived from `rounds.json`** (regenerated/validated
against it when a run is read), so a torn write never leaves two records that
silently disagree. Each round's canonical `RoundRecord` in `rounds.json` =
`{round, draft_chars, verify (the normalized verdict), applied_revision_sections
(sections the lead revised to produce **this** round's draft — empty on round
1, the initial draft), next_revision_sections (the non-satisfied ids **this**
round's verdict routes to the next revise), dropped_sections (unknown ids seen
this round), duration_s}`; every receipt `rounds` summary and its
`dropped_sections` are derived from these fields, so per-round provenance
survives a receipt regeneration.
The run dir also holds `brief.md` (the assembled intent brief, copied in at
dispatch) and `resolved.json` (the effective config, resolved model ids, and
the content-hash + version of every prompt asset used — `contract.md`,
`generate`/`verify`/`revise` — plus the tool git sha), a `latest` pointer, and
`history_keep_runs` retention (default 20) — reusing
`stark_review_doc_lib.ts`'s exported `writeJsonAtomic` /
`updateLatestPointer` / `pruneRunDirs`. Receipt
includes per-round durations, `cost_usd` via `cost_lib.computeDispatchCost`,
and `persistence_errors`. The **round / receipt / `dispatch-spec.md` /
`final-spec.md` writes are the crash-proof core** (atomic tmp+rename,
incremental after every round). A **core write or rename that fails**
(permissions, disk exhaustion) is **fatal**: the run terminates with
`error.code:"history_core_write"` and a non-zero exit, reporting through stderr
rather than claiming a persisted receipt — the spec+receipt guarantee cannot
be honored, so it is never falsely asserted; the prior atomic file is left
intact. Only *ancillary* writes — the `latest` pointer and retention pruning
— are best-effort and, on failure, land in `persistence_errors` (surfaced by
the skill as warnings, never silently) rather than aborting a run that already
produced its spec. The run dir retains **`dispatch-spec.md`** (the immutable
dispatcher output) and, after gap resolution, **`final-spec.md`** — the exact
bytes landed at `spec_path` — plus its content hash and (once landing
succeeds) the landed `commit_sha` in the receipt, so a later same-slug rerun
that overwrites the shared `spec_path` never erases what an earlier run
produced. With `resolved.json` capturing config + prompt hashes + tool sha
alongside the brief, and `dispatch-spec.md`/`final-spec.md` + hash +
`commit_sha` capturing the output, a run is **auditable and diagnosable from
its record alone** — the exact inputs, asset versions, and produced document are known.
This is deliberately *not* a byte-exact replay guarantee (model sampling is
nondeterministic).

## Interfaces

Skill:

```
/stark-write-spec [<path|"intent">] [--source PATH] [--intent TEXT]
  [--out PATH] [--lead claude|codex|gemini] [--wing claude|codex|gemini]
  [--lead-model ID] [--wing-model ID] [--max-rounds N] [--parent-run-id ID]
  [--dry-run] [--ready] [--no-pr] [--json]
```

The positional argument is a convenience: treated as `--source` **iff it
resolves to an existing readable file**, else as `--intent` prose. Explicit
`--source`/`--intent` override the positional and disambiguate the corner
cases (an intended-but-missing path, or intent text that matches a filename);
both may be supplied together (source doc + extra intent), and supplying
neither is an error.

```
```

Dispatcher (`node --experimental-strip-types tools/write_spec.ts`):

```
--intent-brief PATH --out PATH [--lead A --wing A --lead-model ID
  --wing-model ID --max-rounds N --parent-run-id ID --timeout N --wing-timeout N --dry-run --json]
```

`--dry-run` (both layers): assemble the brief, resolve config/models/prompts,
print the planned dispatch, and exit — no LLM calls, no file writes outside
the scratchpad, no git (sibling parity with spec-to-plan/review-spec).
**Dry-run is explicitly exempt from the "every non-crash exit writes the
spec + receipt" and "every run leaves a history record" rules** — it writes
nothing but the scratchpad brief and produces no `run_id`/history dir; its
JSON output is the resolved plan (agents, models, out path, brief size) with
`result_type:"success"`, `ok:true`, and a dry-run-only
`final_verdict:"dry_run"` sentinel (outside the run-verdict enum).

**`--json` is non-interactive:** the skill's `AskUserQuestion` gap-fill and
the `max_rounds_unsatisfied` resolution are suppressed; instead of pausing,
the skill emits a structured object on stdout and exits non-zero, so a
headless caller can answer and re-invoke. stdout carries only the final JSON
object; all diagnostics go to stderr.

The `--json` result is a **discriminated union on `result_type`** ∈
`success | needs_input | error`; the `success` shape is the receipt above,
and both non-`success` shapes carry a canonical error envelope
`{code, message, hint}`. The `needs_input` shape:

```json
{ "result_type": "needs_input", "ok": false,
  "stage": "preflight" | "post_dispatch",
  "run_id": null,            // null at preflight; the dispatcher run id post-dispatch
  "parent_run_id": null,
  "questions": [ { "id": "topic-slug", "type": "text" | "choice",
                   "prompt": "…", "choices": [], "missing_brief_field": "target" } ],
  "unresolved_items": [ { "section": "…", "status": "…", "note": "…" } ],
  "error": { "code": "needs_input", "message": "…",
             "hint": "post_dispatch: re-invoke with --parent-run-id <run_id> plus --intent/--source answering the questions; preflight has no run_id — just re-run with the missing input" } }
```

`stage:"preflight"` `needs_input` fires **before** dispatch for missing input;
an oversize protected brief is instead a preflight `error` result_type
(`error.code:"brief_too_large"`), not `needs_input` — answering a question
cannot shrink a protected section. Both exit before dispatch: no `run_id`, no
history dir, exempt from the persistence guarantee.
`stage:"post_dispatch"` fires on a `--json` `max_rounds_unsatisfied`: it carries
the dispatcher `run_id` + `unresolved_items`. A re-invocation passing
**`--parent-run-id <that run_id>`** (plus the answering `--intent`/`--source`)
is what threads `parent_run_id`: the host loads the parent run's recorded
brief, enriches it with the answers, and validates that the parent ended
`max_rounds_unsatisfied` **with no prior retry child** (an unknown or
already-retried parent is rejected deterministically) — this is what enforces
the one-retry bound. Question `id`s are stable slugs; the parent `run_id` *is*
the continuation token — a re-invocation **without** `--parent-run-id` is an
independent run, not a continuation, and threads no lineage. The `error`
envelope is identical for every non-`needs_input` failure, its `code` drawn
from the outcome table's `error.code` column.

Receipt (single stdout JSON object, parity with sibling dispatchers):

```json
{
  "result_type": "success",
  "ok": true,
  "final_verdict": "contract_satisfied",
  "dispatch_verdict": "contract_satisfied",
  "spec_path": "docs/specs/2026-07-20-example-spec.md",
  "slug": "example", "run_id": "…",
  "rounds": [ { "round": 1, "draft_chars": 9412,
                "verify": { "items": [
                  {"section":"intent","status":"satisfied","note":""},
                  {"section":"scope","status":"satisfied","note":""},
                  {"section":"interfaces","status":"satisfied","note":""},
                  {"section":"behavior","status":"satisfied","note":""},
                  {"section":"ssot","status":"satisfied","note":""},
                  {"section":"security","status":"satisfied","note":""},
                  {"section":"test-plan","status":"underspecified","note":"no named test for the revise path"},
                  {"section":"accessibility","status":"n_a","note":"terminal output only"},
                  {"section":"open-questions","status":"satisfied","note":""}
                ], "done": false, "summary": "…" },
                "applied_revision_sections": [], "next_revision_sections": ["test-plan"],
                "dropped_sections": [], "duration_s": 210 } ],
  "contract_status": [ { "section": "…", "status": "…", "note": "…" } ],
  "dropped_sections": [],
  "models": { "lead": "…", "wing": "…", "lead_agent": "claude", "wing_agent": "codex" },
  "cost_usd": 0.0, "pr": null, "persistence_errors": []
}
```

`ok`, exit status, and `error.code` for **every** terminal outcome are
defined by the single canonical outcome table in *Termination & gap
resolution* — that table is authoritative. In summary: `contract_satisfied`
and `accepted_with_gaps` are the successful outcomes (`ok:true`, exit 0)
provided the requested landing succeeded; `dry_run` is `ok:true` by definition
(it lands nothing); every other verdict is `ok:false`, non-zero exit, with
`error.code` set — and a `contract_satisfied`/`accepted_with_gaps` run whose
push or PR failed is also `ok:false` with `error.code` naming the failed
landing stage (git/push/pr). The spec + receipt are written on every non-crash
exit **that entered dispatch** (dry-run and pre-dispatch validation failures
excepted). Fields beyond the core set are **outcome-conditional** (the receipt
is effectively a discriminated union on `result_type` + `final_verdict`):
`dispatch_verdict` is always present; `parent_run_id` appears on **any child
retry** (a run launched with `--parent-run-id`) whatever its terminal verdict
— including `contract_satisfied`; `gap_resolution` appears on both
`accepted_with_gaps` (`"accepted"`) and `aborted` (`"aborted"`), and
`accepted_items` only on `accepted_with_gaps`; `unresolved_over_scoped` only
when the lead couldn't cut an `over_scoped` item; `error` (`{code, message,
hint}`) on every `ok:false` receipt; `pr` is non-null only after a successful
landing — an absent field is inapplicable to that outcome. **`final_verdict`
carries the authoring/workflow outcome, not landing success**: a
`contract_satisfied`/`accepted_with_gaps` run whose push/PR failed keeps that
verdict but is discriminated as a failure by `ok:false` + `error.code` ∈
{`git`,`push`,`pr`} — consumers read `ok`+`error`, never `final_verdict`
alone, to decide landing.

Config (`write_spec` section, `DEFAULT_WRITE_SPEC` + `getWriteSpecConfig()`
following the existing section-accessor pattern):

```json
{
  "lead_agent": "claude", "wing_agent": "codex",
  "wing_reasoning_effort": "xhigh",
  "max_rounds": 3, "timeout_s": 900, "wing_timeout_s": 600,
  "max_input_chars": 200000, "history_keep_runs": 20, "open_pr": true
}
```

Models resolve through `resolveModel()`/`getModelId()` — never hardcoded ids.
The wing runs codex at `xhigh` (unlike spec-to-plan's `medium` wing —
deliberate: this wing is the pre-gate whose misses become review-spec
findings, exactly where the inflation risk lives; a few extra cents at
authoring buy quiet reviews downstream).

Prompts (`global/prompts/write-spec/`):

```
contract.md                      — the Spec Contract (shared SSOT, all agents)
{claude,codex,gemini}/generate.md — draft against the contract
{claude,codex,gemini}/verify.md   — contract check → verdict JSON (NOT a review)
{claude,codex,gemini}/revise.md   — revise non-satisfied sections only
```

`generate`/`revise` match the spec-to-plan naming; `verify.md` (not
`review.md`) is a deliberate divergence — the name encodes that this prompt
checks a checklist and must never drift into a critic prompt. All three
agent dirs ship at v1 (cheap adaptations, parity with every sibling). All
prompt resolution goes through `assetPromptsDir()` — never a hardcoded
`~/.claude/code-review` path.

## SSOT & Dependencies

| Consumes | From | For |
|----------|------|-----|
| `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `shouldFallbackToApiKey`, `releaseAgentTempDir`, `parseCodexJsonl`, `parseGeminiJson`, `extractVerdictJson`, `isPlainObject`, `resolveModel`, `isAgentEnabled`, `VALID_AGENTS`, `AgentName` | `tools/copilot_dispatch.ts` | subprocess dispatch, env isolation, output parsing — `plan_dispatch.ts`'s import set minus `normalizeVerdict` (that normalizer is the approve/revise/block shape; write-spec ships its own `normalizeContractVerdict`, which uses `isPlainObject`) |
| `DEFAULT_*` + section accessor pattern, `getModelId` | `tools/stark_config_lib.ts` | `write_spec` config section |
| `assetPromptsDir`, `stateRoot` | `tools/asset_root_lib.ts` | prompt + history resolution (plugin seam) |
| `prCreate` (draft-by-default), `getToken` | `tools/github_app_lib.ts` | draft PR authored by the lead's App |
| `sanitizeSlug` | `tools/stark_handover_lib.ts` | topic slug → filename/branch |
| `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs` (all already exported) | `tools/stark_review_doc_lib.ts` | per-run history record |
| `computeDispatchCost` | `tools/cost_lib.ts` | receipt `cost_usd` |
| `standards/help.md`, `tools/preflight.ts` | repo standards | skill Help block + preflight phase |

The lead/wing loop itself is **mirrored from `plan_dispatch.ts`, not
extracted**: two consumers (spec-to-plan, write-spec) don't yet justify a
shared abstraction — rule of three; see Open Questions.

## Security & Failure Modes

Scope-proportional — single-user local tooling on the operator's machine:

- **Trust boundaries (named, not gated):** the intent brief (prompt, notes,
  distilled chat) crosses three boundaries — the LLM provider (Claude/Codex/
  Gemini) at dispatch, GitHub at PR time, and the local run-history record.
  All three are the operator's own accounts on their own machine, so the
  handling rule is disclosure, not enforcement: the skill echoes the resolved
  provider + target repo before dispatch/push, and the run-history dir (brief
  + `resolved.json`) is written user-only under `stateRoot()`. No
  credential-scan or sensitive-data confirmation gate is added — that is the
  red-team injection machinery, deliberately out of scope for an
  operator-authored brief (see the injection-gate note below).
- **Subprocess isolation is inherited, not new:** agents dispatch through
  `buildAgentEnv` (allowlisted env) **and the same no-tool invocation
  `plan_dispatch.ts` uses** — Claude runs with a `--disallowedTools` set that
  disables Bash/Edit/Write/Read/WebFetch/WebSearch/Task/NotebookEdit
  (mirroring the fold decider's `DECIDER_DISALLOWED_TOOLS`), codex runs
  `-s read-only`, gemini runs in plan mode, and the prompt+brief reach the
  agent via **stdin / a process-scoped temp file** — never argv (which is
  byte-bounded and would fail at spawn on a large brief) and never a repo path
  the agent must open. **No agent mutates the repo** (Claude has no
  write/edit tool, codex is read-only, gemini is plan-mode); only the host
  writes files. `test_agent_no_repo_mutation` (Test Plan) drives a mutation
  attempt through each adapter and asserts the workspace is byte-unchanged.
  **Honest limit:** codex's read-only sandbox and gemini's plan mode still
  permit *reads* — those two adapters can inspect repo files beyond the brief
  and surface them to their provider. This is accepted under the trust
  boundary above (the operator's own machine + provider accounts), not
  enforced away: the guarantee is *no mutation*, not *no read* — minimal-dir
  jailing per adapter would be production isolation this playground tool
  deliberately doesn't build.
- **The intent brief is operator-authored by definition** (their prompt,
  their notes, their conversation). It is *not* an adversarial artifact, so
  there is deliberately **no injection gate** — that machinery
  (`preDispatchSensitiveGate`) exists for red-team, which reviews documents
  of unknown provenance. Stated here so the review-spec security domain
  doesn't manufacture one (the known FP class from the red-team history).
- **Paths:** out path host-computed from sanitized slug; history under
  `stateRoot()`; brief under the session scratchpad. The model never picks a
  filesystem path. The run-history dir is created `0700` and
  `brief.md`/`rounds.json`/`receipt.json`/`resolved.json` (plus their atomic
  tmp files) `0600` — the repo's existing 0600 token-cache convention
  (`github_app_lib`) — so the brief's potentially-proprietary contents stay
  owner-only (`test_history_permissions`).
- **Failure modes:** wing JSON unparseable (retry once → terminate,
  preserve draft) · lead empty draft (terminate) · unchanged revision
  (terminate) · max rounds (skill-mediated gap resolution) · git/PR failure
  (spec + receipt already on disk; error surfaced, nothing lost) · **core**
  history write failure — `rounds.json`/`receipt.json`/`dispatch-spec.md`/
  `final-spec.md` (fatal, `error.code:"history_core_write"`, reported via
  stderr, prior atomic file preserved) · **ancillary** history write failure —
  `latest` pointer / retention pruning only (`persistence_errors`, never fatal).

## Test Plan

Named proving tests (`tools/write_spec_lib.test.ts`):

- `test_parser_drops_unknown_sections` — verdict with a 10th section id →
  dropped + recorded in `dropped_sections`; `done` recomputed from the 9.
- `test_status_enum_rejects_unknown` — bad status → item treated as
  `underspecified` (fail-safe toward another round, never toward false-done).
- `test_done_recomputed_from_items` — wing `done:true` with an
  `underspecified` item → host says not done.
- `test_over_scoped_routes_to_revise` — `over_scoped` item appears in the
  revise payload with cut semantics.
- `test_early_exit_single_pass` — clean first draft → exactly 1 lead + 1
  wing call.
- `test_termination_{max_rounds,empty_draft,unchanged_revision,wing_unparseable}`
  — each exit path yields the right `final_verdict`, non-zero exit, spec +
  receipt on disk.
- `test_receipt_incremental_persistence` — receipt/rounds present after a
  simulated round-2 crash.
- `test_intent_brief_truncation` — table-driven: oversize source material
  truncates with marker; ask/constraints/target never truncated; **both**
  sections overflowing; one section underusing its share (spillover to the
  other); multibyte input truncated at a **code-point boundary**; exact-cap
  input; protected sections alone over cap → `brief_too_large`. Plus a
  **real-spawn probe** that dispatches a max-size payload through the transport
  (stdin/temp file) and asserts the subprocess is created (no argv byte-limit
  failure).
- `test_done_fails_closed` — table-driven over the nine ids: empty `items`,
  partial `items` (omitted ids), duplicate ids (conflicting statuses),
  reason-less `n_a`, an **all-`n_a` verdict**, and **`n_a` on each mandatory
  section** (intent/scope/behavior/test-plan) each leave ≥1 non-satisfied
  slot → `done:false`, never `contract_satisfied`.
- `test_revision_loop_converges` — scripted lead + wing doubles force
  draft → `underspecified` verdict → targeted revise → `satisfied`: asserts
  call order, full-document preservation, that only non-satisfied items reach
  the lead, `revised_sections`, per-round receipts, and the final written doc.
- `test_asset_contract` — the canonical section ids in `contract.md` equal
  the parser's exported id set and the referenced review-spec domain names,
  and every agent's `generate`/`verify`/`revise` prompt resolves and states
  the verdict schema + status enum.
- `test_cli_input_disambiguation` — table-driven over positional-as-source,
  positional-as-intent, explicit `--source`/`--intent` overrides, both
  together, neither (error), and an intended-but-missing path.
- `test_out_path_containment` — table-driven over `--out`: a valid normalized
  in-repo path lands; an absolute external path, a `../` traversal escape, and
  an in-repo symlink resolving **outside** the repo are all **rejected before
  dispatch**, creating no run history and no target file.
- `test_json_contract` — `--json` suppresses `AskUserQuestion`; the
  `needs_input` (preflight + post-dispatch) and `error` shapes match the
  discriminated schema; stdout carries only the final JSON object, diagnostics
  go to stderr, exit is non-zero on non-success.
- `test_agent_adapters` — a mocked subprocess runner exercises a lead and a
  wing case for **each** agent (claude/codex/gemini): resolved model,
  reasoning effort, env setup, parser selection, normalized output.
- `test_agent_no_repo_mutation` — a filesystem-mutation attempt driven through
  each agent adapter leaves the workspace byte-unchanged.
- `test_history_provenance_and_recovery` — the receipt summary regenerates
  from canonical `rounds.json` on a torn write (mismatch reconciled
  read-time); `resolved.json` carries config + prompt hashes + tool sha +
  final-spec hash; `latest` moves; retention prunes at the `history_keep_runs`
  boundary; an ancillary-write failure surfaces in `persistence_errors`.
- `test_core_write_fatal` — a fault injected into **each** core write/rename
  (`rounds.json`, `receipt.json`, `dispatch-spec.md`, `final-spec.md`, and the
  post-landing receipt finalization) is **fatal**: `error.code:"history_core_write"`,
  non-zero exit, the prior atomic file left intact, and **no false claim of a
  persisted receipt** — including when finalization fails *after* a
  commit/push/PR already succeeded.
- `test_history_permissions` — run dir `0700`; `brief.md` / `rounds.json` /
  `receipt.json` / `resolved.json` (and atomic tmp files) `0600`.
- `test_intent_fidelity` — canned semantic fixtures carry **required facts**,
  **prohibited invented claims**, and **explicit unknowns**; asserts every
  required fact survives generation **and** revision, no prohibited claim ever
  appears, and each seeded unknown lands under **Open Questions** (parked, not
  answered). This is the direct proof of the design's central promise
  (preserve supplied decisions, never invent), and it feeds the live gate.

Plus: `skill_smoke_test.test.ts` picks the skill up automatically
(frontmatter, `standards/help.md` reference, tool refs resolve,
`write_spec.ts --help` exits clean). A skill-behavior test in a temp git repo
(`test_skill_landing`) mocks `AskUserQuestion` + the `github_app` CLI and
covers the three gap-resolution choices + the one-retry bound (threaded via
`--parent-run-id`), `--dry-run` side-effect exclusion, `--ready`/`--no-pr`,
and is **table-driven over every row of the landing state table**: branch +
open PR (reuse both), branch present + no/closed PR (reuse branch, open fresh
PR), neither (create branch + draft PR), and `spec_path` present with no
matching branch (fail fast, no clobber). It also proves **non-force push**, PR
lookup-before-create, a **byte-identical rerun** (regenerated content equal to
the branch version → successful no-op reusing the existing commit + PR, never a
failed empty commit), a **later-day rerun** (advanced clock reuses the
recorded canonical dated path, never mints a parallel dated file), PR
body/status-table construction, and a **fault-injection pass** that fails each
landing stage (checkout / commit / push / PR) in turn and asserts the finalized
`ok:false` receipt, stage-specific `error.code`, preserved spec, and no
falsely-reported PR. Live e2e (playground rules — real surface, no ceremony): author
one real spec from a canned intent in this repo, then run `/stark-review-spec`
on it.

**Success criteria (DoD):**

1. Live-run receipt reaches `contract_satisfied` within 3 rounds.
2. `/stark-review-spec` on an authored spec produces fewer round-1 findings
   than hand-written specs against a **frozen, pinned baseline**: pick **3
   canned intents** matched to the scope of 3 recent hand-written specs. Review
   **both** each hand-written baseline spec **and** its authored counterpart
   **under the identical pinned stack** — the same review-spec config, model
   ids, and prompt-asset hashes (recorded in the ADR) — each **N=3 times,
   taking the median** of **unique round-1 findings at `medium`+ severity**
   (dedup by section+title) to damp model nondeterminism. Measuring both sides
   the same way removes reviewer-drift and sampling-variance confounds. Gate:
   each authored spec's median ≤ **50% of its paired baseline spec's** median.
   The canned intents, pinned config/model/asset hashes, **all raw receipts**,
   baseline+authored medians, and the paired mapping live in the ADR so the
   comparison is reproducible; a directional spot-check of the finding *text*
   stays supplementary, not the gate.
3. No growth breaker (`growth_ack_required`, hard cap, invent-then-condemn)
   trips when review-spec runs on an authored spec.
4. **Intent fidelity** (`test_intent_fidelity` fixtures, run as part of the
   live gate): every required fact from the canned intent survives into the
   authored spec, no fixture-prohibited invented claim appears, and every
   seeded unknown lands under Open Questions rather than being answered.
5. Docs updated in the same change: CLAUDE.md (pipeline list, TS tools,
   prompts layout), plus an ADR — adding a pipeline stage with a contract is
   architectural under the repo's tiering (`NNNN-spec-authoring-contract-bounded`).

## Accessibility

N/A — CLI + markdown output consumed in a terminal/editor by a single
operator; no UI surface. (Explicit per contract section 8.)

## Not doing

- **No brainstorming** — intent arrives already formed (chat, notes, or
  prompt). Divergent exploration stays in `superpowers:brainstorming`.
- **No adversarial critique** — the wing verifies a checklist. Adversarial
  review remains `/stark-review-spec` (mandatory) and red-team (optional).
- **No growth breakers / coherence pass / analytics grading** — the
  contract bounds the loop by construction; importing review-spec's damage
  control here would concede the design point.
- **No tournament / 3-agent modes** — the deleted
  `design_to_plan_dispatch.py` lesson: paired lead/wing is cheaper and
  lower-variance.
- **No config-overridable contract** — the template is versioned with the
  repo like every other prompt.

## Open Questions

1. **Shared lead/wing loop lib** — extract from
   `plan_dispatch.ts`/`write_spec_lib.ts` when a third consumer appears
   (rule of three).
2. **Contract tuning feedback loop** — review-spec analytics could reveal
   which contract sections' done-when bars are too weak (domains that still
   find real gaps) and feed `contract.md` revisions; manual for now.
3. **Brainstorm handoff** — should `superpowers:brainstorming`'s design-doc
   step hand its output to `/stark-write-spec` instead of writing the spec
   itself? Attractive, but touches a vendored plugin; revisit after v1.
