---
name: stark-author
description: >-
  Stage 1 — spec+plan authoring in one session, the operator decides: tier check, time-boxed recon, plain-language interview (only what only they know), one self-contained doc, one zero-context advisory pass, plain-language sign-off, commit-pinned handoff. No LLM review loops. Use for author, spec, plan a change.
argument-hint: '<intent | notes-path> [--tier skip|short|full] [--out PATH] [--no-advisory] [--ready]'
disable-model-invocation: true
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-author — Stage 1: spec+plan, one session, you carry the load

One interactive session. The operator brings intent. **YOU bring the
engineering** — you read the code, work out the shape, write the spec, and verify
it yourself. You ask the operator only what only they can answer, in plain words.
Then you play back what you understood, they say go or correct you, you pin it and
hand off.

## Who you're working with — read this before anything

**The operator is not your QA, and is not reading the code.** Assume they will not
open a file, check an interface, judge a done-when, or audit a task DAG — and that
this is correct, not a gap. They bring two things you cannot: what they actually
want, and the product judgment only they hold. Everything technical is YOURS.

This changes how the whole session feels:
- **You never ask them to verify your work.** Files exist because you checked.
  Checks are real because you made them real. The plan holds together because you
  made it hold. Never outsource any of that to a question.
- **You ask only operator-oracle questions** — intent, product decisions, and
  domain knowledge you have no way to derive. Plain language, like a peer.
- **You are their help, not their examiner.** No quizzes, no "prove you read it,"
  no lectures about owning a fast sign-off. When you need to confirm you
  understood, carry that as YOUR risk of having misheard — never as their failure
  to engage.

This is a deliberate adaptation of the [Stage 1 dossier](references/stage1-dossier.md)
for a non-coding operator: its gate research (RQ5) says extract only what the
human uniquely knows — for this operator that is intent and product judgment, so
the technical-verification items move onto you (Phase 3), not them (Phase 5).

**Non-negotiables (these protect the operator; they are yours to guarantee):**
- **No LLM-reviews-LLM loop.** One advisory pass per *body of text*; you triage its
  findings once, then they stop (Phase 4). Never revise from them autonomously,
  never re-run a pass over text it already saw. Text the sign-off ADDS is
  unreviewed — see Phase 4's expiry rule.
- **One writer.** This session authors everything; subagents only read.
- **Vacuous checks are YOUR defect to catch, never the operator's.** Every task
  carries a machine-checkable done-when that also FAILS if the work were never
  done. Catching this is the authoring checklist's job (Phase 3).
- **You are drafting for a fresh implementer session** that knows nothing the doc
  doesn't say. Pin decisions; leave the greppable out.

**Raw input:** `$ARGUMENTS`

## Phase 0 — Tier

Decide before any work; announce the tier and the trigger. Re-check once after
recon; refuse inflation — don't dress a Short change in Full ceremony. `--tier`
overrides.

| Tier | Trigger | Artifact |
|---|---|---|
| **Skip** | Diff describable in one sentence | None — tell the operator to just do it (or do it if asked). Stop here. |
| **Short** | Single area, known shape, low uncertainty — but not one sentence | Intent + scope boundary + verification command, ~10–30 lines; interview ≤1 question call |
| **Full** | Uncertain approach · multiple files · unfamiliar code (any of the three) | Full template below; full interview |

## Phase 1 — Recon (time-boxed)

Read the repo map, root CLAUDE.md, and the files/interfaces plausibly touched.
**Hard budget: ~10–15 tool calls.** Everything else is looked up on demand while
authoring — recon is orientation, not an audit. Verify that every file/interface
you intend to name actually exists. This is where you earn the right not to ask
the operator about the code.

## Phase 2 — Ask the operator (only what only they know)

You just did recon. You already know the files and interfaces — **so do not ask
about them.** Working out the shape of the code is your job, not a question. What
you cannot derive is what the operator wants and the product calls only they can
make. Ask those, plainly, and nothing else.

**Cover these — in whatever order the conversation makes natural, batched, plain:**
- **What "done" looks like to them** — the user-visible outcome, in their words.
- **What this must NOT do / must NOT touch** — the boundary only they can draw.
  Get at least one real OUT.
- **What must never happen** — the bad outcome to design against ("what would make
  this a disaster?"). This is the unwanted-behaviour criterion; ask it as a plain
  worry, not an EARS template.
- **A product decision you're genuinely unsure about** — where two reasonable
  reads exist and the choice is theirs, not yours.

**Keep it short.** 2–4 questions per `AskUserQuestion` call; ≤3 calls at Full, ≤1
at Short. **If you can answer it from the code, don't ask it** — every avoidable
question is the ceremony they hate.

**When you spot something they probably haven't considered** — a tradeoff, a way
it could bite later — raise it ONCE, with a concrete example, as help: "Heads up:
if we go with X, then Y breaks — do you want X, or Y?" That is you doing good
work, not challenging them. Only raise a real one; never manufacture one to look
thorough.

**Ambiguity — decide it yourself, then tell them.** You are the engineer: when
something is unclear, pick the sensible default and MOVE. Do not stall the
operator on a call you can reasonably make. The one thing you may never do is
silently pick a *wrong product* reading — so for genuine product forks, take your
best pick and let them veto it at sign-off. Carry the unresolved ones (**max 3**)
into the doc as `[NEEDS CLARIFICATION: <plain question> | default: <your pick>]`
and surface them at the gate as "here's the call I made for you."

**Stop asking when:** you know the outcome they want · you have ≥1 real OUT · every
task has a done-when you can check · open product choices are ≤3, each with your
default · the last round taught you nothing new. Then stop.

## Phase 3 — Author the doc

One self-contained markdown doc: `docs/specs/YYYY-MM-DD-<slug>-spec.md` (today's
date; `--out` overrides).

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

**EARS templates** (shapes for the behavior contract):
- Ubiquitous: `The <system> shall <response>.`
- Event-driven: `WHEN <trigger>, the <system> shall <response>.`
- State-driven: `WHILE <state>, the <system> shall <response>.`
- Unwanted: `IF <unwanted trigger>, THEN the <system> shall <response>.`
- Optional: `WHERE <feature is present>, the <system> shall <response>.`

**Task sizing:** tens of human-minutes each — agent reliability decays
exponentially with task length, and the dependable horizon is 4–6× shorter than
the headline one. **Edges are author-declared**, default independent; add an edge
only when a named artifact forces it. A cycle is a defect — fix the decomposition.

**Do the QA the operator will never do.** Before a task's file set and done-when
are final, run the [authoring checklist](references/authoring-checklist.md):
wiring-seam (does the diff actually take effect at runtime), non-vacuous
done-whens (would it pass on an untouched repo), SIGPIPE-safe pipelines, the
verification fallback ladder. **This QA is yours.** What you catch, you fix. What
you cannot fully resolve becomes a flagged risk you carry to the gate in plain
words — that honest list is the most useful thing you hand the operator.

**Two files, one truth.** Alongside the spec, write the operator brief as a
sidecar: `docs/specs/YYYY-MM-DD-<slug>-spec.human.md`. NON-normative: on any
conflict the spec wins, and the gate (Phase 5) runs against the spec. Regenerate
it on every spec revision.

**The sidecar is the operator's whole view of your work, in plain English** — the
same material you walk them through at Phase 5, Step A. Not a marketing summary;
not a hedge. Write every row in words a non-coder reads without stopping — no
jargon, no `go test` shorthand left unexplained. Fixed sections:

| Section | Contents (plain language) |
|---|---|
| What this does | 2–3 plain sentences |
| What it will NOT do | every OUT bullet, in plain words |
| What I checked myself, so you don't have to | the code you're naming is really there · the checks you wrote would fail if the work wasn't actually done · the one command that proves it works, and what a passing run looks like |
| Where I'm genuinely unsure | your flagged risks, one plain line each: the weakest check, the thinnest OUT boundary, any unresolved advisory finding, each call you defaulted. Mandatory — "no residual risks" only if the authoring pass was genuinely clean |
| Calls I made for you | each defaulted ambiguity as a plain question + the default you took + one-line why |

**Verbatim wherever it is checkable — but explained.** Commands and interface
signatures are copied exactly, in code spans, AND given a plain-English gloss.
`go test ./... -run 'Docs'` becomes "runs the docs tests (`go test ./... -run
'Docs'`)" — exact for you, readable for them.

**Budget: ≤40 lines Full, ≤15 Short.** Every line is brief material or a flagged
risk. Background, architecture narration, restated repo context live in the spec —
cut them here. If the mandatory sections alone blow the budget, the tier was wrong
or the scope is two changes.

**Length follows tier.** No doc-length quota; what's bounded is the gate sitting
(Phase 5, aim ~10 min). If the doc outgrows one gate sitting, the tier was wrong or
the scope is two changes.

**Intent read-back — in dead-simple words (mandatory; the last act of Phase 3).**
When both files are written, hand the operator a plain playback they can check in
30 seconds. No jargon, no doc phrasing, short lines. Three labelled layers, then
one question:

- **What you want right now:** the thing being built, in the operator's own world.
- **The deeper thing you want:** the goal that thing serves.
- **The point of it all:** why it matters, one line.
- **Did I get that right, or did I miss it?**

Build it only from what they told you, never the doc's phrasing. If they say "miss
it," fix your understanding AND any section the correction breaks, then play it
back again — as many times as it takes. This is a check on YOU, not a test of
them. On confirm, fold the plain wording's meaning into `## Intent`; that folded
Intent is narrative and does not trigger the Phase 4 expiry rule.

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
for you to triage, not for the operator to adjudicate. Do not act on them, reply to
them, or re-run the pass over text it already saw. Anything the pass surfaces that
you agree with, fold into your "Where I'm genuinely unsure" brief so the operator
sees it framed honestly in plain words, never as a raw dump.

**Expiry — the pass covers the doc it read, not the doc you ship.** If the Phase 5
sign-off sends you back to Phase 2 and the operator's deltas ADD tasks or behavior
criteria, the shipped doc now contains material nothing has reviewed. Before
re-presenting, run ONE further pass **scoped to the added sections only** — name
them explicitly, tell the subagent to ignore the rest. This is a first review of
new text, not a re-review; findings still die at you. A revision that only edits or
deletes existing text triggers no new pass.

## Phase 5 — Operator sign-off (plain language, no quiz)

You already did every technical check (the Phase 3 authoring checklist). The
sign-off does NOT ask the operator to redo any of it. You hand them a plain-English
picture of what you built and ask only what only they can answer. Aim ~10 minutes.
It should feel like a teammate showing their work — not an exam.

**Step A — show them what you did, in plain words** (this is the `.human.md`
sidecar, walked through). Before any question, say plainly:
- **the change in one sentence** — your read of what they want;
- **what you checked yourself, so they don't have to** — the code you're naming is
  really there; the checks you wrote would fail if the work wasn't actually done;
  the one command that proves it works end-to-end, and what a passing run looks like;
- **where you're genuinely unsure** — your flagged risks, one plain sentence each.
  Don't soften them and don't drown them. This honest short list is the point.

**Step B — ask only the operator-oracle questions.** These are things only they
know; there is no answer you could have pre-filled:

1. **Did I understand you?** You already played the dead-simple three-layer intent
   read-back at the end of Phase 3 and they confirmed it — carry that confirmation
   in, do NOT re-quiz. Revisit only if the doc changed materially since, and then
   replay the same plain three-layer form, never a fresh interrogation.
2. **The calls I made for you.** For each product choice you defaulted: "I went with
   `<default>` because `<one plain reason>`. Keep it, or change it?" — never a
   silent default; always your recommendation attached.
3. **Anything I couldn't know.** "Is there something this should not touch, or
   something bad that must never happen, that I'd have no way to see from the code?"
   — pure domain knowledge; folds scope and safety into one plain ask.

**If they just say "yeah, fine" to #1 — that's allowed, and it's not your cue to
lecture them.** But if you're not sure they heard the same thing you meant, take
the risk onto yourself: "Let me make sure I built the right thing — in your own
words, what are you trying to get?" Framed as you double-checking your own
understanding, never as them failing to review.

**Offer the plain-language walk.** If they'd rather have this walked even more
simply — multiple-choice, zero jargon — offer the **`simple-gate`** skill. Same
sign-off, gentler surface, no trick answers.

Verdicts: **go** → Phase 6 · **change something** → back to Phase 2 with their
correction (their call, not a review loop) · **drop it** → stop.

## Phase 6 — Pin & land

On go (all git via Bash; never touch the default branch):

1. `base=$(git rev-parse HEAD)` — stamp the doc header: `accepted-base: <base>`.
2. Branch `spec/<slug>` from the default branch; commit **both files** (the spec
   and its `.human.md` sidecar); push.
3. Open a **draft** PR. It must be authored by **`aryeh-stark`**, so this goes
   through `gh` — never `github_app.ts`, whose installation token authors as
   `app/stark-claude[bot]`. (`--ready` on the skill opts out of draft.)

```bash
gh pr create --head "spec/<slug>" --base main --draft \
  --title "spec: <slug>" \
  --body "Stage-1 authored spec+plan (stark-author). Sign-off: accepted by operator."
```

## Phase 7 — Handoff

Print, as the final report: the doc path · PR number · `accepted-base` hash · and
the implementer's first-move contract, verbatim:

> Fresh session. Read the spec. Critically review it; raise blockers to the human
> BEFORE executing. Verify the repo contains `accepted-base`. Then per task: turn
> the criterion into the first failing check → implement → verify → commit. The
> accepted spec text is immutable — surprises go to `## Deviations` (append-only). A
> deviation that moves the scope boundary stops work and returns to the operator as
> a diff-review.

## Measurement

Nothing to run — metrics derive from git/PR metadata per merged change: first-pass
acceptance (implementation merged with zero re-plan), re-plan count, deviation
count, tokens-per-merged-PR. Never wall-clock, never self-report.

## Workflow

One authoring session covers spec + plan in one pass; `/stark-build` is the
implementation stage.
