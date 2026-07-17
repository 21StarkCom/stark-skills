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
wing structurally cannot ask for a 10th section. A per-item `note` is
advisory and scoped to its section's done-when bar — the revise prompt
directs the lead to treat anything beyond that bar as non-binding. Growth is
bounded by construction; no growth breakers, coherence passes, or rollback
machinery are needed here.

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
  `contract.md` is the **canonical** encoding of the section-id list; the
  parser enum and agent prompts mirror it, and `test_contract_ids_match_asset`
  binds the mirrors to the asset so drift fails tests instead of silently
  dropping a renamed section as unknown.

- **Each done-when bar carries its review domain's concerns — bounded (#2).**
  A section's done-when bar is not just "present"; it enumerates *what that
  domain's reviewer looks for*, so the authoring agent knows what is expected
  before review sees it. `contract.md` gives each section a short **review
  lens** distilled from the corresponding `spec-review` domain prompt (e.g.
  Security's bar = "trust boundaries named, failure modes enumerated,
  scope-proportional" — the security domain's actual checklist, not its
  open-ended hunt). Critically this **sharpens the bar, it does not open a
  finding channel**: the wing still emits one status per section from the
  closed enum, never free-form findings. Folding review's concerns into a
  bounded checklist is the point — importing review's *unbounded critique*
  into authoring is explicitly forbidden (that is what `/stark-review-spec`
  is for, and why it stays mandatory).

- **The contract learns from review — the feedback loop (#1).** `contract.md`
  is the single interface between authoring and review, so it is where "what
  is expected" is defined and tuned. When `/stark-review-spec` keeps raising
  the *same class* of finding on write-spec-authored specs, that names a
  done-when bar too weak to pre-empt it — the fix is to tighten that section's
  lens in `contract.md`, not to make the wing a critic. The
  `<doc>.review-analytics.md` sidecars + per-run history are the evidence
  source (recurring-domain share per run). Tuning is **operator-driven and
  manual** for v1 (a versioned prompt-asset edit, its own PR) — no automated
  contract-rewrite loop. The consequence of authoring something review will
  flag is therefore not silently absorbed: it is either fixed downstream in
  the (now bounded) review, or, if recurring, promoted into the contract so
  the *next* spec is authored against it.

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
  `over_scoped` items.
- `done` = every item `satisfied | n_a`, recomputed by the host over the
  **full 9-id set** — never trusted from the wing. A known id **absent** from
  `items` is treated as `missing`, and an `n_a` without a reason string as
  `underspecified` — a partial or lazy verdict can only fail closed (another
  round), never produce a false `done`.
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
200 000); source material truncates with an explicit marker.

### Termination & gap resolution

`final_verdict` ∈ `contract_satisfied | max_rounds_unsatisfied |
lead_empty_draft | unchanged_revision | wing_unparseable` (naming parity
with `plan_dispatch.ts`'s `FinalVerdict`). `unchanged_revision` = a revise
round returned a byte-identical document — the lead is stuck, stop paying.

Every non-crash exit **still writes the spec file and the receipt**. On
`max_rounds_unsatisfied` the skill (not the dispatcher) offers, via
`AskUserQuestion`:

1. **Answer the gaps** — operator fills the missing information; skill
   enriches the brief and re-dispatches **once** (hard bound: one retry).
2. **Accept with gaps** — unsatisfied items are appended to the spec's Open
   Questions section verbatim, honest and visible to review-spec.
3. **Abort** — branch is left for inspection, no PR.

Terminal semantics live at the layer that owns them. The **dispatcher's**
exit contract is uniform and unchanged: `max_rounds_unsatisfied` → `ok=false`,
non-zero exit — acceptance never rewrites a dispatcher receipt. *Answer* →
the single re-dispatch's verdict is final. *Accept* is a **skill-layer**
resolution: the skill appends the parked items to the spec's Open Questions,
records `accepted_gaps[]` in its own summary (and the PR body), and exits 0 —
the pipeline outcome is "authored, with accepted gaps". *Abort* → skill exits
1. Headless/`--json` skill runs have no operator: gap-fill is skipped
(pre-dispatch unknowns go straight to Open Questions) and max-rounds
auto-resolves to *accept with gaps*, flagged in the skill output.

### Output & landing

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
  every generation. Landing is **create-or-adopt and idempotent**: a run that
  died after commit but before push (or before PR creation) is retried by
  re-invoking — it lands on the same branch and adopts any existing PR.
- Handoff line: `next: /stark-review-spec <spec-path>`. Review-spec's
  existing "reuse a PR if one exists" behavior picks up the write-spec PR —
  author and review share one branch/PR trail end to end.

### Run record

Per the fleet's analytics bar (every run leaves a crash-proof record):
history at `~/.claude/code-review/history/write-spec/<slug>/<run-id>/` with
`receipt.json` + `rounds.json` written **incrementally after every round**
plus `brief.md` (the assembled intent brief, copied in at dispatch so every
run is reproducible from its record alone), a `latest` pointer, and
`history_keep_runs` retention (default 20) — reusing
`stark_review_doc_lib.ts`'s exported `writeJsonAtomic` /
`updateLatestPointer` / `pruneRunDirs`. Receipt
includes per-round durations, `cost_usd` via `cost_lib.computeDispatchCost`,
and `persistence_errors` (surfaced by the skill as warnings, never silently).

## Interfaces

Skill:

```
/stark-write-spec <path|"intent"> [--out PATH] [--lead claude|codex]
  [--wing claude|codex] [--lead-model ID] [--wing-model ID]
  [--max-rounds N] [--dry-run] [--ready] [--no-pr] [--json]
```

Dispatcher (`node --experimental-strip-types tools/write_spec.ts`):

```
--intent-brief PATH --out PATH [--lead A --wing A --lead-model ID
  --wing-model ID --max-rounds N --timeout N --wing-timeout N --json]
```

`--dry-run` (both layers): assemble the brief, resolve config/models/prompts,
print the planned dispatch, and exit — no LLM calls, no file writes outside
the scratchpad, no git, and **no run record** (a dry run has no rounds, so
the incremental-persistence rule below never engages — no history dir is
created; sibling parity with spec-to-plan/review-spec).

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

`ok` = `final_verdict === "contract_satisfied"`; any other verdict exits
non-zero with `error.code` set, spec + receipt still written.

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
contract.md                — the Spec Contract (canonical SSOT, all agents)
{claude,codex}/generate.md — draft against the contract
{claude,codex}/verify.md   — contract check → verdict JSON (NOT a review)
{claude,codex}/revise.md   — revise non-satisfied sections only
```

`generate`/`revise` match the spec-to-plan naming; `verify.md` (not
`review.md`) is a deliberate divergence — the name encodes that this prompt
checks a checklist and must never drift into a critic prompt. Claude + codex
dirs ship at v1 — the default lead/wing pair; gemini prompts are deferred,
and until they ship `gemini` is **rejected at argument validation in both
layers** with a clear unsupported-agent error — the advertised CLI surface
matches what resolves. (The dispatcher core stays agent-generic via
`VALID_AGENTS`, so enabling gemini later is prompt files + lifting the guard;
three-way parity up front was premature — review scope finding, accepted.)
All prompt resolution goes through
`assetPromptsDir()` — never a hardcoded `~/.claude/code-review` path.

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

- **Subprocess isolation is inherited, not new:** agents dispatch through
  `buildAgentEnv` (allowlisted env). Lead and wing are text-in/text-out like
  `plan_dispatch.ts` — no tool use, no worktree, no repo mutation by agents;
  only the host writes files. The no-tool boundary is prompt- and flag-level
  discipline, not OS enforcement — accepted for single-user local scope.
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
- `test_partial_verdict_fails_closed` — a verdict omitting a known section id
  (or carrying a reason-less `n_a`) → item `missing`/`underspecified`, never
  a false `done`.
- `test_contract_ids_match_asset` — the parser's 9-id enum and the agent
  prompts stay bound to `contract.md`'s canonical section list.
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

Plus: `skill_smoke_test.test.ts` picks the skill up automatically
(frontmatter, `standards/help.md` reference, tool refs resolve,
`write_spec.ts --help` exits clean). Live e2e (playground rules — real
surface, no ceremony): author one real spec from a canned intent in this
repo, then run `/stark-review-spec` on it.

**Success criteria (DoD):**

1. Live-run receipt reaches `contract_satisfied` within 3 rounds.
2. `/stark-review-spec` on an authored spec produces **materially fewer
   round-1 findings** than the recent historical baseline for hand-written
   specs (compare against existing `review-analytics` sidecars/history;
   directional spot-check, not a stats regime).
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
2. **Automated contract tuning** — the feedback loop itself is now a stated
   design principle (see Contract rules #1/#2); what remains open is whether
   to *automate* it. A future pass could mine recurring-domain shares across
   `<doc>.review-analytics.md` sidecars and propose `contract.md` lens edits.
   Deferred: manual operator-driven tuning is the v1 contract.
3. **Brainstorm handoff** — should `superpowers:brainstorming`'s design-doc
   step hand its output to `/stark-write-spec` instead of writing the spec
   itself? Attractive, but touches a vendored plugin; revisit after v1.
