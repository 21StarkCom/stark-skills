# Retro — The Two-Stage Rebuild and the Great Demolition

**Span:** 2026-07-25 → 2026-07-26 (roughly 36 hours) ·
**Outcome:** the 8-stage LLM-review pipeline replaced by a two-stage
human/check-gated pipeline; **46,046 lines of loop machinery deleted**;
33 → 22 skills; three evidence dossiers in the vault; every number in this
document is measured, not remembered.

This retro is the durable memory of the journey: what was broken, how we
proved it, what we built, what we killed, what we learned about the method
itself. The companion artifacts (dossiers, briefs, memory files, PRs) are
indexed in §10.

---

## 1. Why — the burn

On 2026-07-25 the fleet's daily numbers forced the question:

- **2,837,675,947 Claude billable tokens in one day** (96.6% cache reads,
  13,233 requests, 51% of tokens in subagent sidechains). Codex, for
  contrast: ~31M.
- The day produced 67 merged PRs org-wide — so "we got nothing" was refuted;
  the problem was **yield per token**, not output.
- One 1M-context daemon session (kotodama) alone consumed 343M tokens — 12%
  of the day — by driving long-running work through a single conversation.

A 9-agent forensic workflow (Opus 5 / Fable 5 only, every figure re-derived
from raw billing/telemetry) produced the autopsy. Its verdict became the
constitution for everything that followed.

## 2. The autopsy — root causes and the kill/keep verdict

**Root causes (all measured):**

1. **LLM-reviews-LLM loops are structurally non-convergent.** The flagship
   exhibit: one spec (uma) went through 11 review runs, ~117 dispatches,
   grew 72KB → 168KB (2.32×) — and the unresolved-findings count was
   identical in run 1 and run 9. Per-run growth breakers all passed
   (every run ≤1.08×) while the cross-run ratchet compounded; the breakers
   measured the wrong window.
2. **The copilot implementation fix loop paid for work it threw away.**
   36/36 rounds on the atlas run ended `test_passed=false` (the wing sandbox
   could not run vitest) and 9 steps merged anyway on reviewer taste. Diffs
   grew 1.5–2.9× across fix rounds with ~zero deletions — additive-only
   fixes. One approved 203KB diff was never applied (wave-apply geometry).
   Goal-driven fix rounds re-explored the repo with a fresh $10 budget each
   time — work paid 2–5×.
3. **The suppression stack billed twice.** The red-team committee inflated
   severity (84% inflation upstream), then a paid refutation pass un-did it;
   68/68 unquoted injection findings across 201 runs were critical false
   positives.
4. **Orchestration ceremony with no runs.** `/stark-forge`, the 8.7k-LOC
   crash-resumable pipeline state machine: **zero real runs, ever.**
5. **The session layer**: 1M-context daemon driving is a behavior bug, not a
   code bug — no PR fixes it; it lives in memory as a standing rule.

**The verdict:** replace the chain
`write-spec → review-spec → red-team-spec → spec-to-plan → review-plan →
plan-to-tasks → copilot/phase-execute (→ forge)` with **two stages**:

- **Stage 1 — `/stark-author`:** human-gated spec+plan, one session, no LLM
  review loops. The human is the gate.
- **Stage 2 — `/stark-build`:** autonomous implementation gated by checks
  the agent cannot edit. The check is the gate. The human gates the merge.

Keep: single-agent `/stark-review`, copilot plumbing (`copilot_land`),
deterministic state libs, per-run telemetry. Kill: everything loop-shaped
(~35k LOC estimated; 46,046 measured when the axe actually fell).

## 3. The method — "the drill"

Every build in this journey ran the same evidence pipeline, and the pipeline
itself is a finding:

1. **Author a research brief** against a 9-check rubric (substrate named;
   axioms vs guesses-to-falsify separated; contradiction logging; 2
   calibration cases; source tiers with vendor-efficacy demoted to Tier C;
   MEASURED > OBSERVED > OPINION; traceability backrefs; bounded
   deliverable; anti-goals). Rubric applied at draft time — one draft.
2. **One zero-context fresh-eyes pass** — a subagent with no shared context
   re-verifies every checkable claim by a **different method** (recount
   recursively, recompute from raw sources, resolve paths). Findings return
   once; never a round 3.
3. **`/deep-research` run** (operator-executed) → a dossier with 3-vote
   adversarial claim verification, verbatim quotes, access dates, a refuted
   do-not-cite list.
4. **Distill ≤25 lines** to the operator; **build** from the blueprint;
   vendor the dossier with the artifact.

Proof the rubric works: the pre-rubric stage-1 prompt needed 2 review rounds
(8 defects, then 3). With the rubric at draft time, stage-2 needed one pass
(2 defects) and the code-review brief one pass (8 findings — but see §7:
one was a blocker my own two same-method checks had missed twice).

Fresh eyes work through **method difference, not repetition** — the
canonical lesson: two prior checks "confirmed" a 34/35 view-file count by
re-reading; the zero-context reviewer counted recursively and got 39.

## 4. Stage 1 — `/stark-author` (PR #796, merged 2026-07-25)

**Evidence base:** stage-1 dossier — 61 claims through 3-vote adversarial
verification: 58 confirmed (57 unanimous, 1 split 2-1), 3 refuted.

**Shape:** one interactive session — tier check (skip/short/full, by
uncertainty not size) → time-boxed recon (~10–15 tool calls) → structured
interview (fixed question order, EARS-shaped behavior contract, voiced
ambiguities capped at 3, five-part stopping rule) → **one self-contained
doc** `docs/specs/YYYY-MM-DD-<slug>-spec.md` (intent, IN/OUT boundary,
non-derivable repo context, EARS criteria, task DAG sized in tens of
human-minutes with machine-checkable done-whens, closing verification
command, append-only Deviations) → at most ONE zero-context advisory pass
(findings die at the human) → 8-item value-stating human gate (<60 min,
<400 lines, rubber-stamp tripwires) → `accepted-base` pin → draft PR →
fresh-session handoff contract.

**The sidecar contract** (operator request, folded in the same PR): a
NON-normative plain-English digest `<spec>.human.md`, ≤50 lines, short
sentences — what it does / won't do / how we prove it / what was decided
for you / one line per task. Regenerated on every revision; spec wins on
conflict; the gate still runs on the spec.

Zero new TypeScript. Pure protocol skill. `docs/plans/` is dead for new
work — spec+plan is one file.

## 5. Stage 2 — `/stark-build` (PR #797, merged 2026-07-25)

**Evidence base:** stage-2 dossier. The measured anti-cheat core:

- Agents fake completion at scale: **100% submitted / 44% resolved**
  (GPT-5 on SWE-bench Verified). "Done" claims are noise.
- Agents attack the harness: evaluator patching, hardcoded outputs,
  `time.time()` overwrites (METR). Anti-cheat **prompting** fails — 80–95%
  still hacked under explicit instructions. **Structure over prompts.**
- An explicit **abort option cuts cheating ~5×** (54% → 9%). "Log a
  deviation and stop" must be a first-class successful exit.
- Read-only tests are the measured balance (hidden tests kill legitimate
  performance; agent-editable tests get patched).

**Shape:** the interactive session is the RUNNER; one fresh headless
`claude -p` session per spec task, gated by checks the agent cannot edit:

- **PreToolUse path-deny** (`protect-paths.sh`) write-protects the spec,
  gated existing tests, harness scripts, CI config.
- **Stop-hook gate** (`stop-gate.sh`): a red done-when check blocks
  turn-end; a logged deviation opens the gate (abort is success); at 7
  consecutive blocks the **harness writes the deviation itself** so Claude
  Code's 8-block override never lands a silent green.
- Runner verifies every task deterministically: re-runs the check itself,
  diff-vs-protected-list tamper check, diff-vs-declared-file-set scope
  check, commit per green task; crash = ONE resume from committed state.
- The spec's closing verification command is a **held-out e2e gate** —
  task-green/e2e-red divergence is the gaming/mis-decomposition signal.
- ONE cross-vendor advisory review (codex, read-only, diff+spec); findings
  die at the human. Sequential single writer (the 203KB-never-applied
  wave-apply failure killed parallel-by-default).

Two POSIX hook scripts, dry-fired on all paths before merge. Zero new TS.

## 6. Publishing, surgery, and the marketplace gotcha

- **bifrost v0.6.0** (#110): publishing the two skills surfaced a standing
  gotcha — the auto `marketplace-sync` reported "already in sync" because
  `stark sync` only pulls skills **declared in a `bundle.yaml`**; the
  coverage gate that catches unmapped skills lives only in the manual
  `publish.sh` path. New skill ⇒ manual membership PR. (Saved to memory.)
  Placement: authoring → `stark-plan`, implementation → `stark-implement`.
- **Copilot surgery** (#798) — the four autopsy cuts on the surviving
  legacy implementer: `DEFAULT_MAX_ROUNDS` 4 → 1 (retry budget past
  first-failure bought churn, not fixes); goal mode round-1 only (fix
  rounds never `/goal`-loop); tests auto-detect from the trusted repo root
  and **a wing approve over red/never-ran tests returns
  `approved_but_tests_red`** — the runnable check outranks the verdict;
  `--diff-out` writes the final diff to disk so sequential mode stops
  round-tripping hundreds of KB through model context.

## 7. The code-review drill (PRs #799, #800; bifrost v0.7.0)

The same drill, pointed at `/stark-review`'s prompts — with the fleet's own
telemetry as calibration:

**Mining the history** (30 PRs, 39 rounds, 349 findings, per-finding human
disposition labels): fix 216 · noise 28 · false-positive 1 · ignored 2 ·
unclassified 102. Of the classified: **87% acted on, 12.5% noise-band**.
Severity: 51% medium / 33% high / 15% low / **1.4% critical** — textbook
ordinal central-tendency compression.

**`/stark-fresh-eyes` was born here** (#799) — the operator observed the
fresh-eyes pass "should be a skill." Built as a pure protocol skill (one
zero-context different-method pass per document revision, findings
dispositioned once, never a round 2). **Its first live run caught a blocker
in my own brief:** I had claimed per-domain noise labels didn't exist; the
reviewer recomputed from the raw JSONs and found they did — and that they
flipped the picture: **ssot held 18 of all 28 noise labels (45% noise among
its classified findings)**, while security ran 25 fix / 1 noise. Noise was
one bad lens, not a system property. It also exposed that the corpus mixed
two regimes (25 single / 14 team rounds, 3.6× yield gap), that the 87%
precision was codex-only, and that 14 paired codex-vs-claude same-diff
rounds existed (1.12 vs 0.51 findings/call — local dialect data).

**The dossier verdict** (5-angle sweep, 96 claims extracted, 25 top claims
through 3-vote verification: 23 confirmed, 2 refuted): precision is the
binding constraint (devs tolerate ≤5–15% FP; "misses bugs" ranks 14th of 15
pain points); a false positive is whatever the developer doesn't act on;
raw LLM review is presumptively half noise (best benchmarked F1 ≈19%;
ByteDance's filter discarded 55%); 48% of measured FPs are
missing-context; taxonomy-anchored generation beats "find issues" (BitsAI:
219 curated rules → 75% deployed precision); severity self-rating is
intrinsically compressed and exemplars contaminate; **key order silently
disables chain-of-thought** (verdict-before-reasoning = answer-first 100%
of the time; the scarier "structured output hurts reasoning" headline was
REFUTED 0-3).

**The rewrite** (#800): 7 → 5 domains (behavior absorbed type-safety's
runtime-affecting cases; spec-conformance absorbed a narrowed ssot that
must name **both the copy and the owner**); every domain file a
failure-mode rubric (5–9 named modes seeded from the fleet's own 216
fix-labeled findings + per-lens noise-attractor bans), **byte-identical
across the three agent dirs**; `agent.md` = ≤15-line dialect header +
shared 90-line core (mission/zero-findings-is-success, scope, playground
guard, context duty, evidence contract — quoted span + concrete failure
scenario or don't emit, deterministic consequence-anchored severity ladder,
emission order evidence-before-severity, dedup, large-diff ladder). No
model ids in prompts (drift rot — the claude preamble still pinned
`claude-sonnet-4-6`). Projection if ssot-noise dies as measured: noise-band
12.5% → ~5%.

**stark-ssot realignment** (#801): the skill still taught the pre-dossier
shape. Answering the operator's "is ssot why I've been suffering?" —
measured yes: added 2026-07-07 as an **auto-fired** domain on every
PR/spec/plan review (the textbook "wrong checks on by default"), it
produced 64% of all review noise (worst day: 8 of 12 noise findings in one
round), while its 22 real fixes all had a nameable owner. The skill got the
owner-naming bar; the auto-fire framing died.

## 8. The demolition (PRs #802–#804; bifrost v0.8.0)

Operator waived the "after author+build land real changes" gate
(`/goal` autopilot). Three sequential delete-PRs, each leaving the suite
green; **the planned order was swapped mid-flight when the import graph
said so** (`forge_state` imported doc-review persistence helpers;
`plan_dispatch` imported `forge_state_lib` — importers die first, so every
intermediate merge compiles):

| PR | Tier | Files | Deletions | Suite after |
|---|---|---|---|---|
| **#802** | red-team: 3 skills, 12 tool modules + 5 test files, personas/prompts, config section + locked-fields machinery, 2 preflight checks + the Responses-API key resolver | 41 | **13,086** | 1803 / 0 fail |
| **#803** | orchestrators: forge (0 runs ever), phase-execute, plan-to-tasks (+dedup/validate), spec-to-plan (+plan_dispatch), multi_review, 3 dead config sections | 42 | **16,373** | 1498 / 0 fail |
| **#804** | doc-review: stark_review_doc + its breakers/coherence/convergence machinery, review_doc_findings, write-spec (all 4 tools), plan_review_dispatch, spec_review_summary, cost_lib, dispatcher_base_lib, 3 prompt trees | 81 | **16,587** | 1223 / 0 fail |

**Total: 164 files, 46,046 deletions, 87 insertions.** Skills 33 → 22.
Kept deliberately: `stark_review_doc_analytics_lib` (live import from
`stark_review.ts` — the per-run-telemetry keep-list item; `DomainCoverage`
inlined so it stands alone), all `docs/specs`/`docs/plans`/ADRs (records,
not machinery), copilot (post-surgery) for plan-file legacy work.

**bifrost v0.8.0** (#115): 11 skills pulled from 3 bundles — stark-analyze
0.5.0 (−7), stark-plan 0.3.0 (`stark-author` alone), stark-implement 0.4.0
(`stark-build` + `stark-copilot`). Signed release auto-cut on merge.

**The epilogue that proved the thesis** (#805): within an hour of #804, the
SSOT skill — the drift-prevention skill — was found naming
`cost_lib.computeDispatchCost()` as a canonical owner. The module no longer
existed. Fixed; and logged as the standing argument for shrinking the
skill's hand-maintained owner table if it ever goes stale again.

## 9. Operational lessons (the ones that don't live in code)

- **`/login` mid-flight kills background workflows** (first autopsy launch
  died 0/9). Workflow `resumeFromRunId` replays cached agents — the retry
  re-ran only the one failed agent.
- **API stream stalls are survivable**: a stalled background agent resumed
  via `SendMessage` with its context intact and finished the job.
- **Subagent model policy** (operator directive, standing): Opus 5 or
  Fable 5 only — Fable for judgment-heavy, Opus otherwise.
- **Chat output ≤30 lines** (operator directive, standing): long content
  goes to files/artifacts; chat gets the distillate.
- **The 1M-context daemon habit is the un-PR-able root cause** — fresh
  sessions per task, progress files + git as memory. It regresses silently;
  it lives in memory and in this retro as the guard.
- **Marketplace membership is manual** — a merged skill is not a published
  skill until a `bundle.yaml` names it.
- **gh's `--watch` can hang past CI completion** — poll `--json state`
  with an until-loop instead of trusting the watcher.

## 10. Artifact index

**PRs (stark-skills):** #796 author · #797 build · #798 copilot surgery ·
#799 fresh-eyes · #800 review-prompts rewrite · #801 ssot realignment ·
#802/#803/#804 demolition · #805 dead-owner fix.
**PRs (bifrost):** #110 v0.6.0 (author+build) · #112 v0.7.0 (fresh-eyes) ·
#115 v0.8.0 (demolition); sync PRs #111/#113/#114.
**Releases:** v0.6.0 (2026-07-25) · v0.7.0 · v0.8.0 (2026-07-26), all
signed.

**Dossiers (vault, `30_Research/`):** `stage1-spec-authoring-dossier` ·
`stage2-autonomous-implementation-dossier` · `codereview-prompts-dossier`.
Vendored copies: `skill/stark-author/references/stage1-dossier.md`,
`skill/stark-build/references/stage2-dossier.md`.
**Briefs (scratch):** `~/Code/.scratch/{stage1,stage2,codereview}.research.md`.
**Autopsy:** memory `stark-fleet-burn-autopsy-2026-07-25` + the findings
artifact (permanent URL in that memory).

## 11. What's deliberately open

1. **The A/B** (~20 changes, git/PR metadata only): first-pass acceptance,
   re-plan count, deviation count, tokens-per-merged-PR; for review
   prompts — noise-band share of classified + span-in-diff rate (odd/even
   PR parity). No dashboards; the human labels stay the only truth.
2. **Cheapest data buy:** label the 50 unclassified claude findings —
   unlocks the dialect question (RQ7) for free.
3. **Dossier-flagged unknowns:** test-first *ordering* (check-existence is
   proven; failing-check-first is not) · benchmark→codebase transfer of
   cheating rates · per-task budget sizing (30 turns/$5 is a guess to
   tune) · the advisory-review skip threshold.
4. **Axiom tension, logged not adopted:** the best-measured precision
   levers (a ReviewFilter verify stage, +12.6pp; multi-sample self-
   aggregation, +43.67% relative F1) are LLM-verifies-LLM machinery —
   barred by A1. If a local A/B ever shows one bounded feedback round
   beating advisory-only on merged-PR quality per dollar, A1 is the axiom
   it would change.
5. **stark-ssot tripwire:** if the next ~20 changes never invoke it, kill
   it on that data; if its owner table drifts again, shrink the skill to
   the transferable method and let CLAUDE.md be the only owner map.
6. **First real `/stark-author` → `/stark-build` run** — the moment the
   A/B clock actually starts.

## 12. The one-paragraph version

The fleet was spending billions of tokens a day paying LLMs to argue with
LLMs, and the loops never converged — the reviewer's approval was the exit
condition, and approval is not evidence. In 36 hours, backed by three
adversarially-verified research dossiers and the fleet's own telemetry, the
pipeline was rebuilt around two gates that cannot be argued with — a human
who read the plan, and a check the implementer cannot edit — and everything
that existed to contain the arguing (46,046 lines of it) was deleted. The
method that did it (rubric-authored brief → one zero-context
different-method pass → verified dossier → build) is now itself a skill,
and it caught its own author's blocker on first use. Evidence over
argument, checks over verdicts, one pass and stop.
