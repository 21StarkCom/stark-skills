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

- **`n_a` is a first-class status** — a section may be marked not-applicable
  *with a stated reason*. This is what keeps the contract from becoming its
  own inflation vector: a CLI tool writes "Accessibility: N/A — terminal
  output only" instead of manufacturing an accessibility program.
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
  a conflicting duplicate can never upgrade a section to done. An `n_a` slot
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
200 000) via **deterministic per-section budgeting**: Ask + Constraints +
Target are reserved first (never truncated); the remaining budget is split
between Source material and Conversation context, each truncated with an
explicit marker (source first, then conversation) when it overflows its
share. If the reserved sections **alone** exceed the cap, the run fails fast
with an explicit `brief_too_large` error rather than truncating protected
content.

### Termination & gap resolution

`final_verdict` (dispatcher-level) ∈ `contract_satisfied |
max_rounds_unsatisfied | lead_empty_draft | unchanged_revision |
wing_unparseable` (naming parity with `plan_dispatch.ts`'s `FinalVerdict`).
`unchanged_revision` = a revise round returned a byte-identical document —
the lead is stuck, stop paying. On a `max_rounds_unsatisfied` run the skill's
finalized receipt **overrides this with a skill-level outcome** —
`accepted_with_gaps` or `aborted` (see the terminal-state machine below).

Every non-crash exit (dry-run excepted) **still writes the spec file and the
receipt**. On `max_rounds_unsatisfied` the skill (not the dispatcher) offers,
via `AskUserQuestion`, a bounded terminal-state machine — each branch defines
its own finalized receipt, `ok`, and exit status:

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
pure author: it runs the lead/wing loop, writes the spec + run record, and
emits a receipt with `pr: null`. All git + GitHub work (branch, commit, push,
PR) is the skill's, via the `github_app.ts` CLI; the skill then **finalizes
the receipt** — rewriting the persisted `receipt.json` with the `pr` result
and the landing-aware `ok` — so the on-disk record matches the committed spec
and PR. `--ready`/`--no-pr` are skill-only flags (the dispatcher never opens
a PR). The dispatcher's `prCreate`/`getToken` dependency below is consumed by
this skill layer, not the headless loop.

- Spec at `docs/specs/YYYY-MM-DD-<topic>-spec.md` (repo doc conventions;
  slug via `sanitizeSlug` from `stark_handover_lib.ts` — the out path is
  **host-computed**, never model-chosen).
- One final commit on branch `write-spec/<slug>` (round drafts are noise for
  a *new* document — unlike review-spec, whose per-round commits trace an
  existing doc's evolution; the per-round story lives in the receipt and PR
  body instead).
- **Draft PR** via the lead's GitHub App (`prCreate`, `draft ?? true` —
  repo-wide draft-by-default policy), body carrying the final contract-status
  table + per-round summary. `--ready` opts out, `--no-pr` skips.
- **Re-run on an existing slug:** if `write-spec/<slug>` (and its PR)
  already exist, check the branch out, commit the regenerated spec **on
  top**, and push normally — never force-push (workspace rule: review
  threads must survive), never mint a parallel branch. The PR trail keeps
  every generation.
- Handoff line: `next: /stark-review-spec <spec-path>`. Review-spec's
  existing "reuse a PR if one exists" behavior picks up the write-spec PR —
  author and review share one branch/PR trail end to end.

### Run record

Per the fleet's analytics bar (every run leaves a crash-proof record):
history at `~/.claude/code-review/history/write-spec/<slug>/<run-id>/` with
`rounds.json` (the **canonical** per-round record) + `receipt.json` written
**incrementally after every round** — the receipt's `rounds` summary and
`contract_status` are **derived from `rounds.json`** (regenerated/validated
against it when a run is read), so a torn write never leaves two records that
silently disagree
plus `brief.md` (the assembled intent brief, copied in at dispatch) and
`resolved.json` (the effective config, resolved model ids, and the
content-hash + version of every prompt asset used — `contract.md`,
`generate`/`verify`/`revise` — plus the tool git sha), a `latest` pointer, and
`history_keep_runs` retention (default 20) — reusing
`stark_review_doc_lib.ts`'s exported `writeJsonAtomic` /
`updateLatestPointer` / `pruneRunDirs`. Receipt
includes per-round durations, `cost_usd` via `cost_lib.computeDispatchCost`,
and `persistence_errors` (surfaced by the skill as warnings, never silently).
With `resolved.json` capturing config + prompt hashes + tool sha alongside the
brief, a run is **auditable and diagnosable from its record alone** — the
exact inputs and asset versions are known. This is deliberately *not* a
byte-exact replay guarantee (model sampling is nondeterministic).

## Interfaces

Skill:

```
/stark-write-spec [<path|"intent">] [--source PATH] [--intent TEXT]
  [--out PATH] [--lead claude|codex|gemini] [--wing claude|codex|gemini]
  [--lead-model ID] [--wing-model ID] [--max-rounds N] [--dry-run] [--ready]
  [--no-pr] [--json]
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
  --wing-model ID --max-rounds N --timeout N --wing-timeout N --dry-run --json]
```

`--dry-run` (both layers): assemble the brief, resolve config/models/prompts,
print the planned dispatch, and exit — no LLM calls, no file writes outside
the scratchpad, no git (sibling parity with spec-to-plan/review-spec).
**Dry-run is explicitly exempt from the "every non-crash exit writes the
spec + receipt" and "every run leaves a history record" rules** — it writes
nothing but the scratchpad brief and produces no `run_id`/history dir; its
JSON output is the resolved plan (agents, models, out path, brief size) with
`ok:true` and a dry-run-only `final_verdict:"dry_run"` sentinel (outside the
run-verdict enum).

**`--json` is non-interactive:** the skill's `AskUserQuestion` gap-fill and
the `max_rounds_unsatisfied` resolution are suppressed; instead of pausing,
the skill emits a structured `{"ok":false,"needs_input":{...}}` object (typed
questions + missing brief fields) on stdout and exits non-zero, so a headless
caller can answer and re-invoke. stdout carries only the final JSON object;
all diagnostics go to stderr.

Receipt (single stdout JSON object, parity with sibling dispatchers):

```json
{
  "ok": true,
  "final_verdict": "contract_satisfied",
  "spec_path": "docs/specs/2026-07-20-example-spec.md",
  "slug": "example", "run_id": "…",
  "rounds": [ { "round": 1, "draft_chars": 9412,
                "verify": { "items": [], "done": false, "summary": "…" },
                "revised_sections": ["test-plan"], "duration_s": 210 } ],
  "contract_status": [ { "section": "…", "status": "…", "note": "…" } ],
  "dropped_sections": [],
  "models": { "lead": "…", "wing": "…", "lead_agent": "claude", "wing_agent": "codex" },
  "cost_usd": 0.0, "pr": null, "persistence_errors": []
}
```

`ok` = `final_verdict === "contract_satisfied"` **and** the requested landing
operation succeeded (a PR was opened, or `--no-pr`/`--dry-run` waived it): a
contract-satisfied run whose push or PR failed is finalized `ok:false` with
`error.code` naming the failed landing stage (git/push/pr). Any
non-`contract_satisfied` verdict also exits non-zero with `error.code` set.
The spec + receipt are still written on every non-crash exit (dry-run
excepted — see Interfaces).

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
  `buildAgentEnv` (allowlisted env). Lead and wing are text-in/text-out like
  `plan_dispatch.ts` — no tool use, no worktree, no repo mutation by agents;
  only the host writes files.
- **The intent brief is operator-authored by definition** (their prompt,
  their notes, their conversation). It is *not* an adversarial artifact, so
  there is deliberately **no injection gate** — that machinery
  (`preDispatchSensitiveGate`) exists for red-team, which reviews documents
  of unknown provenance. Stated here so the review-spec security domain
  doesn't manufacture one (the known FP class from the red-team history).
- **Paths:** out path host-computed from sanitized slug; history under
  `stateRoot()`; brief under the session scratchpad. The model never picks a
  filesystem path.
- **Failure modes:** wing JSON unparseable (retry once → terminate,
  preserve draft) · lead empty draft (terminate) · unchanged revision
  (terminate) · max rounds (skill-mediated gap resolution) · git/PR failure
  (spec + receipt already on disk; error surfaced, nothing lost) · history
  write failure (`persistence_errors`, never fatal).

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
- `test_intent_brief_truncation` — oversize source material truncates with
  marker, ask/constraints never truncated.
- `test_done_fails_closed` — table-driven over the nine ids: empty `items`,
  partial `items` (omitted ids), duplicate ids (conflicting statuses), and
  reason-less `n_a` each leave ≥1 non-satisfied slot → `done:false`, never
  `contract_satisfied`.
- `test_revision_loop_converges` — scripted lead + wing doubles force
  draft → `underspecified` verdict → targeted revise → `satisfied`: asserts
  call order, full-document preservation, that only non-satisfied items reach
  the lead, `revised_sections`, per-round receipts, and the final written doc.
- `test_asset_contract` — the canonical section ids in `contract.md` equal
  the parser's exported id set and the referenced review-spec domain names,
  and every agent's `generate`/`verify`/`revise` prompt resolves and states
  the verdict schema + status enum.

Plus: `skill_smoke_test.test.ts` picks the skill up automatically
(frontmatter, `standards/help.md` reference, tool refs resolve,
`write_spec.ts --help` exits clean). A skill-behavior test in a temp git repo
(`test_skill_landing`) mocks `AskUserQuestion` + the `github_app` CLI and
covers the three gap-resolution choices + the one-retry bound, `--dry-run`
side-effect exclusion, `--ready`/`--no-pr`, fresh-vs-existing branch/PR reuse
(non-force push, PR lookup-before-create), and PR body/status-table
construction. Live e2e (playground rules — real surface, no ceremony): author
one real spec from a canned intent in this repo, then run `/stark-review-spec`
on it.

**Success criteria (DoD):**

1. Live-run receipt reaches `contract_satisfied` within 3 rounds.
2. `/stark-review-spec` on an authored spec produces fewer round-1 findings
   than hand-written specs against a **frozen baseline**: take 3 recent
   hand-written specs from `history/spec-reviews/`, record their **unique
   round-1 findings at `medium`+ severity** (dedup by section+title) as the
   baseline set, and require an authored spec of comparable scope to land at
   **≤50% of that per-spec median**. The baseline numbers are stored in the
   ADR so the comparison is reproducible; a directional spot-check of the
   finding *text* stays as supplementary qualitative evidence, not the gate.
3. No growth breaker (`growth_ack_required`, hard cap, invent-then-condemn)
   trips when review-spec runs on an authored spec.
4. Docs updated in the same change: CLAUDE.md (pipeline list, TS tools,
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
