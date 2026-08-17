---
name: stark-author
description: >-
  Stage 1 — human-gated spec+plan authoring in one session: tier check, time-boxed recon, structured interview, one self-contained doc, one zero-context advisory pass, human gate, commit-pinned handoff. No LLM review loops. Use for author, spec, plan a change.
argument-hint: '<intent | notes-path> [--tier skip|short|full] [--out PATH] [--no-advisory] [--ready]'
disable-model-invocation: true
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-author — Stage 1: spec+plan, one session, the human is the gate

One interactive session: interview the operator, author ONE self-contained
spec+plan doc, run at most one zero-context advisory pass, gate it on the human,
pin it, hand off. Replaces the write-spec → review-spec → spec-to-plan →
review-plan chain for new work.

Evidence base: [references/stage1-dossier.md](references/stage1-dossier.md)
(61 claims, 3-vote adversarial verification; `[RQn]` tags below cite it).

**Non-negotiables:**
- **No LLM-reviews-LLM loop.** One advisory pass per *body of text*; its findings
  die at the human. Never revise from them autonomously, never re-run a pass over
  text it already saw. [A1][A2] Text the gate ADDS is unreviewed — see Phase 4's
  expiry rule.
- **One writer.** This session authors everything; subagents only read. [A4]
- **Vacuous checks are YOUR defect to catch, not the operator's.** Every task
  carries a machine-checkable done-when that is also NON-VACUOUS — it must fail if
  the work were never done. Catching this is the authoring checklist's job (Phase
  3), not something you outsource to the gate. [A3][RQ3]
- **You are drafting for a fresh implementer session** that knows nothing the doc
  doesn't say. Pin decisions; leave the greppable out. [RQ8]

**Raw input:** `$ARGUMENTS`

## Phase 0 — Tier

Decide before any work; announce the tier and the trigger. Re-check once after
recon; refuse inflation (a Short change dressed in Full ceremony is a documented
failure). `--tier` overrides. [RQ7]

| Tier | Trigger | Artifact |
|---|---|---|
| **Skip** | Diff describable in one sentence | None — tell the operator to just do it (or do it if asked). Stop here. |
| **Short** | Single area, known shape, low uncertainty — but not one sentence | Intent + scope boundary + verification command, ~10–30 lines; interview ≤1 question call |
| **Full** | Uncertain approach · multiple files · unfamiliar code (any of the three) | Full template below; full interview |

## Phase 1 — Recon (time-boxed)

Read the repo map, root CLAUDE.md, and the files/interfaces plausibly touched.
**Hard budget: ~10–15 tool calls.** Everything else is looked up on demand while
authoring — recon is orientation, not an audit. Verify that every file/interface
you intend to name actually exists. [RQ6]

## Phase 2 — Interview

Question wording, coverage, and order are fixed here — do not improvise them
(unaided interviewers never improve on exactly these). [RQ1]

**Order:**
1. **Scope boundary** — what's in; what's explicitly OUT.
2. **Files & interfaces** — named, and verified to exist (Phase 1).
3. **Behavior + edge cases**, EARS-shaped — walk the *unwanted-behaviour* pattern
   explicitly: "what must NOT happen?"
4. **Verification** — "what command proves this works, end to end?"
5. **Tradeoffs the operator hasn't considered** — at least ONE adversarial probe
   with a concrete failure scenario. Don't ask obvious questions.

**Budgets:** 2–4 questions per `AskUserQuestion` call; ≤3 calls at Full tier, ≤1
at Short. [RQ1]

**Ambiguity rule — voice, never silently resolve.** The one way tacit knowledge
is lost is a silent wrong disambiguation. State your intended interpretation and
ask. A "whatever you think" answer gets ONE concrete A/B re-ask, then is marked.
**Max 3 open ambiguities**, inline:
`[NEEDS CLARIFICATION: <question> | default: <your default>]`. [RQ1]

**Stopping rule — all five, then stop asking:**
(a) files+interfaces named and verified · (b) OUT has ≥1 real entry · (c) every
task has a machine-checkable done-when · (d) open ambiguities ≤3 and marked ·
(e) the last question round produced zero new decisions. [RQ1][RQ3]

## Phase 3 — Author the doc

One self-contained markdown doc: `docs/specs/YYYY-MM-DD-<slug>-spec.md` (today's
date; `--out` overrides). [RQ2]

```
# <slug> — spec+plan            | header: date · author · accepted-base: (filled at gate)
## Intent                       | 1 short para: why + user-visible effect. No fluff.
## Scope boundary               | IN: bullets. OUT: bullets — mandatory, ≥1 real entry.
## Repo context (non-derivable) | pitfalls, rationale, divergent conventions, exact
                                | interface signatures + paths. Nothing greppable.
## Behavior contract            | EARS-patterned criteria; unwanted-behaviour mandatory.
## Tasks (DAG)                  | each: files · done-when (machine-checkable) · depends-on
                                | · sized in tens of human-minutes.
## Verification                 | closing command(s) proving the change end-to-end;
                                | declared fallback where no command exists.
## Open questions               | the ≤3 marked ambiguities, each with its default.
## Advisory findings (gate)     | filled by Phase 4; empty if --no-advisory.
## Deviations (append-only)     | empty at acceptance; implementer-only.
```

**EARS templates** (shapes for the behavior contract) [RQ3]:
- Ubiquitous: `The <system> shall <response>.`
- Event-driven: `WHEN <trigger>, the <system> shall <response>.`
- State-driven: `WHILE <state>, the <system> shall <response>.`
- Unwanted: `IF <unwanted trigger>, THEN the <system> shall <response>.`
- Optional: `WHERE <feature is present>, the <system> shall <response>.`

**Task sizing:** tens of human-minutes each — agent reliability decays
exponentially with task length, and the dependable horizon is 4–6× shorter than
the headline one. [RQ4] **Edges are author-declared**, default independent; add an
edge only when a named artifact forces it. A cycle is a defect — fix the
decomposition. [RQ4]

**Write checks the operator won't have to second-guess.** Before a task's file
set and done-when are final, run the
[authoring checklist](references/authoring-checklist.md): wiring-seam (does the
diff actually take effect at runtime), non-vacuous done-whens (would it pass on an
untouched repo), SIGPIPE-safe pipelines, the verification fallback ladder.
**This QA is yours.** What you catch, you fix. What you cannot fully resolve
becomes a flagged risk you carry to the gate in plain words — that honest list is
the most useful thing you hand the operator.

**Two files, one truth.** Alongside the spec, write the operator brief as a
sidecar: `docs/specs/YYYY-MM-DD-<slug>-spec.human.md`. NON-normative: on any
conflict the spec wins, and the gate (Phase 5) runs against the spec. Regenerate
it on every spec revision.

**The sidecar is your honest gate brief in plain English** — the same material
you present at Phase 5, Step A. Not a marketing summary; not a hedge. Fixed
sections:

| Section | Contents |
|---|---|
| What this does | 2–3 plain sentences |
| What it will NOT do | every OUT bullet, verbatim |
| What I verified myself | files exist · each done-when fails on an untouched repo · the closing command **verbatim** + what a real pass prints |
| Where I'm unsure | your flagged risks, one plain line each: weakest done-when, thinnest OUT boundary, any unresolved advisory finding, each defaulted ambiguity. Mandatory — "no residual risks" only if the authoring pass was genuinely clean |
| Open choices I made for you | each defaulted ambiguity as a question + the default you took |

**Verbatim wherever it is checkable.** Commands and interface signatures are
copied exactly, in code spans. Paraphrasing `go test ./... -run 'Docs'` into "runs
the docs tests" hides exactly the detail the operator would catch on.

**Budget: ≤40 lines Full, ≤15 Short.** Every line is brief material or a flagged
risk. Background, architecture narration, restated repo context live in the spec —
cut them here. If the mandatory sections alone blow the budget, the tier was wrong
or the scope is two changes.

**Length follows tier.** No doc-length quota; what's bounded is the gate read
(Phase 5). If the doc outgrows one gate sitting, the tier was wrong or the scope is
two changes. [RQ7]

**Intent read-back (mandatory; the last act of Phase 3).** With both files
written, tell the operator — in your own words, built from their interview
answers, never the doc's phrasing — what they are trying to accomplish: the
immediate deliverable AND the underlying goal it serves, layered if the interview
revealed layers. Close with one sentence naming the point of it all, then ask them
to confirm or correct. On confirm, fold the validated formulation into `## Intent`.
On correction, fix Intent and any section the correction invalidates before Phase
4. An intent you cannot state back convincingly is a doc defect, not an operator
problem. The folded Intent is narrative — it does not trigger the Phase 4 expiry
rule. (Origin: the 2026-08-07 alfred-foundation session, where the read-back
surfaced the real product the drafted Intent had understated.)

## Phase 4 — Advisory pass (one-shot; skip with `--no-advisory`)

Dispatch ONE read-only subagent with **zero shared context** — it receives only
the doc path and this contract, never your reasoning or the interview:

> Read <doc path>. Report ONLY gaps that affect correctness or the stated
> requirements — contradictions, criteria that cannot be checked as written, named
> files/interfaces that don't exist, tasks whose done-when is not machine-checkable,
> and tasks whose done-when is machine-checkable but VACUOUS (it would pass on an
> untouched repo — e.g. a test-filter matching zero tests, or a multi-file grep that
> exits 0 on a partial match). Run the done-when commands where you can rather than
> reasoning about them. Everything else is optional and unwanted. Zero findings is a
> valid, expected answer for a sound doc.

Append its findings verbatim under `## Advisory findings (gate)`. They are input
for the human, not for you. Do not act on them, reply to them, or re-run the pass
over text it already saw. [RQ5][A1][A2] Anything the pass surfaces that you agree
with, fold into your "Where I'm unsure" brief so the operator sees it framed
honestly rather than as a raw dump.

**Expiry — the pass covers the doc it read, not the doc you ship.** If the Phase 5
gate sends you back to Phase 2 and the operator's deltas ADD tasks or behavior
criteria, the shipped doc now contains material nothing has reviewed. Before
re-presenting, run ONE further pass **scoped to the added sections only** — name
them explicitly, tell the subagent to ignore the rest. This is a first review of
new text, not a re-review; findings still die at the human. A revision that only
edits or deletes existing text triggers no new pass.

## Phase 5 — Human gate

The gate is short by design: **one sitting, aim ~10 minutes, hard cap 60 minutes /
400 lines read.** [RQ5]

**You already did the mechanical QA** (files exist, checks are non-vacuous, seams
wired — the authoring checklist). The gate does not ask the operator to redo it. It
asks the operator only what the operator alone knows, and asks them to sanity-check
the risks you already found. The operator is the oracle, not the QA department.

**Step A — hand over your honest brief** (this is the `.human.md` sidecar). Before
any question, say plainly:
- the change in one sentence — your read of their intent;
- what you verified yourself: the named files exist; each done-when fails on an
  untouched repo (or which don't, and why); the closing command proves the behavior
  end-to-end;
- **where you are genuinely unsure** — your flagged risks, one plain sentence each.
  Do not soften them. The flagged risks are the point.

**Step B — ask only the operator-oracle questions.** Every answer states a value,
never yes/no [RQ5] — these are questions only the operator can answer, so there is
no rubber-stamp option to pick:

1. **Intent.** "Here's what I think you want: `<sentence>`. Right? Fix it if not."
   — you cannot supply this; the operator is the only oracle.
2. **Scope.** "What's the one thing most likely missing from the OUT list?" —
   domain knowledge only they hold.
3. **Decisions.** For each defaulted ambiguity: "I chose `<default>`. Keep it or
   change it?" — no silent defaults through the gate.
4. **Edge cases.** "Any unwanted-behaviour trigger I missed?" — domain knowledge.
5. **Validate my risks.** "These are the risks I flagged: `<list>`. Do you agree
   these are the real ones, or am I worried about the wrong thing?" — the operator
   judges your self-assessment; they don't hunt for it.

**Critical first:** items 1 and 5 carry the most weight — point the operator's
attention there. [RQ5]

**The one honest guard.** If the operator's restatement of intent just echoes your
sentence back, you learned nothing — ask once more, in their own words, with the
sidecar closed. Not a trap: you need to hear it from them to know you understood.
[RQ5] A fast accept is the operator's call to own; your duty was to point their
attention at items 1 and 5 and tell the truth in the brief.

**Offer the plain-language walk.** If the operator is not the coder — or asks to
have the gate "walked simply" — offer the **`simple-gate`** skill: it renders this
same brief and these same questions in plain, non-technical words with
multiple-choice + free-text. Same gate, made approachable, no trick answers.

Gate verdicts: **accept** → Phase 6 · **revise** → back to Phase 2 with the
operator's deltas (operator-driven; not a review loop) · **abandon** → stop.

## Phase 6 — Pin & land

On accept (all git via Bash; never touch the default branch):

1. `base=$(git rev-parse HEAD)` — stamp the doc header: `accepted-base: <base>`.
2. Branch `spec/<slug>` from the default branch; commit **both files** (the spec
   and its `.human.md` sidecar); push.
3. Open a **draft** PR. It must be authored by **`aryeh-stark`**, so this goes
   through `gh` — never `github_app.ts`, whose installation token authors as
   `app/stark-claude[bot]`. (`--ready` on the skill opts out of draft.)

```bash
gh pr create --head "spec/<slug>" --base main --draft \
  --title "spec: <slug>" \
  --body "Stage-1 authored spec+plan (stark-author). Gate: accepted by operator."
```

## Phase 7 — Handoff

Print, as the final report: the doc path · PR number · `accepted-base` hash · and
the implementer's first-move contract, verbatim [RQ8]:

> Fresh session. Read the spec. Critically review it; raise blockers to the human
> BEFORE executing. Verify the repo contains `accepted-base`. Then per task: turn
> the criterion into the first failing check → implement → verify → commit. The
> accepted spec text is immutable — surprises go to `## Deviations` (append-only). A
> deviation that moves the scope boundary stops work and returns to the gate as a
> diff-review.

## Measurement

Nothing to run — metrics derive from git/PR metadata per merged change: first-pass
acceptance (implementation merged with zero re-plan), re-plan count, deviation
count, tokens-per-merged-PR. Never wall-clock, never self-report. [RQ9]

## What this replaces

This single session replaced `/stark-write-spec`, `/stark-review-spec`,
`/stark-red-team-spec`, `/stark-spec-to-plan`, and `/stark-review-plan` — all five
deleted in the 2026-07-26 demolition. This is the authoring stage; `/stark-build`
is the implementation stage.
