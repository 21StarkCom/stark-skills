---
name: stark-author
description: >-
  Stage 1 — human-gated spec+plan authoring in one session: tier check, time-boxed recon, structured interview, one self-contained doc, one zero-context advisory pass, human gate, commit-pinned handoff. No LLM review loops. Use for author, spec, plan a change.
argument-hint: '<intent | notes-path> [--tier skip|short|full] [--out PATH] [--no-advisory] [--ready]'
disable-model-invocation: true
---

## Help

If the current user request includes a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-author — Stage 1: spec+plan, one session, the human is the gate

One interactive session: interview the operator, author ONE self-contained
spec+plan doc, run at most one zero-context advisory pass, gate it on the
human, pin it, hand off. Replaces the write-spec → review-spec →
spec-to-plan → review-plan chain for new work.

Evidence base: [references/stage1-dossier.md](references/stage1-dossier.md)
(61 claims, 3-vote adversarial verification; `[RQn]` tags below cite it).

**Non-negotiables:**
- **No LLM-reviews-LLM loop.** One advisory pass per *body of text*; its
  findings die at the human. Never revise from them autonomously, never re-run
  a pass over text it already saw. [A1][A2] Text the gate ADDS is unreviewed
  text, not a re-review — see Phase 4's expiry rule.
- **One writer.** This session authors everything; subagents only read. [A4]
- **Every task carries a machine-checkable done-when that is also
  NON-VACUOUS** — it must fail if the work were never done. A check that
  passes on an untouched repo is worse than no check: it reads as proof.
  [A3][RQ3]
- **You are drafting for a fresh implementer session** that knows nothing the
  doc doesn't say. Pin decisions; leave the greppable out. [RQ8]

**Invocation input:** Read the intent, notes path, and flags from the current
user request that explicitly invoked this skill. Do not depend on a host-side
argument placeholder.

## Phase 0 — Tier

Decide before any work; announce the tier and the trigger. Re-check once
after recon; refuse inflation (a Short change dressed in Full ceremony is the
documented failure). `--tier` overrides. [RQ7]

| Tier | Trigger | Artifact |
|---|---|---|
| **Skip** | Diff describable in one sentence | None — tell the operator to just do it (or do it if asked). Stop here. |
| **Short** | Single area, known shape, low uncertainty — but not one sentence | Intent + scope boundary + verification command, ~10–30 lines; interview ≤1 question call |
| **Full** | Uncertain approach · multiple files · unfamiliar code (any of the three) | Full template below; full interview |

## Phase 1 — Recon (time-boxed)

Read the repo map, the applicable `AGENTS.md` instruction chain, and the
files/interfaces plausibly touched. **Hard budget: ~10–15 tool calls.** Everything else is looked up on
demand while authoring — recon is orientation, not an audit. Verify that
every file/interface you intend to name actually exists. [RQ6]

## Phase 2 — Interview

Question wording, coverage, and order are fixed here — do not improvise them
(unaided interviewers never improve on exactly these). [RQ1]

**Order:**
1. **Scope boundary** — what's in; what's explicitly OUT.
2. **Files & interfaces** — named, and verified to exist (Phase 1).
3. **Behavior + edge cases**, EARS-shaped — walk the *unwanted-behaviour*
   pattern explicitly: "what must NOT happen?"
4. **Verification** — "what command proves this works, end to end?"
5. **Tradeoffs the operator hasn't considered** — at least ONE adversarial
   probe with a concrete failure scenario. Don't ask obvious questions.

**Budgets:** Ask 2–4 questions per round; ≤3 rounds at Full tier and ≤1 at
Short. Use the current host's structured user-input mechanism when one exists;
otherwise ask the questions directly in conversation and wait for the answers.
Do not assume a tool with a host-specific name. [RQ1]

**Ambiguity rule — voice, never silently resolve.** The one way tacit
knowledge is lost is a silent wrong disambiguation. State your intended
interpretation and ask. A "whatever you think" answer gets ONE concrete A/B
re-ask, then is marked. **Max 3 open ambiguities**, inline:
`[NEEDS CLARIFICATION: <question> | default: <your default>]`. [RQ1]

**Stopping rule — all five, then stop asking:**
(a) files+interfaces named and verified · (b) OUT has ≥1 real entry ·
(c) every task has a machine-checkable done-when · (d) open ambiguities ≤3
and marked · (e) the last question round produced zero new decisions. [RQ1][RQ3]

## Phase 3 — Author the doc

One self-contained markdown doc: `docs/specs/YYYY-MM-DD-<slug>-spec.md`
(today's date; `--out` overrides). [RQ2]

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

**EARS templates** (use these shapes for the behavior contract) [RQ3]:
- Ubiquitous: `The <system> shall <response>.`
- Event-driven: `WHEN <trigger>, the <system> shall <response>.`
- State-driven: `WHILE <state>, the <system> shall <response>.`
- Unwanted: `IF <unwanted trigger>, THEN the <system> shall <response>.`
- Optional: `WHERE <feature is present>, the <system> shall <response>.`

**Task sizing:** tens of human-minutes each — agent reliability decays
exponentially with task length, and the dependable horizon is 4–6× shorter
than the headline one. [RQ4] **Edges are author-declared**, default
independent; add an edge only when a named artifact (file/interface) forces
it. A cycle is a defect — fix the decomposition. [RQ4]

**Wiring-seam checklist — before a task's file set is final.** Ask: *if
this task's diff were applied and nothing else, would the behavior
criterion actually hold at runtime?* A done-when can pass while the
answer is no — that is the highest-value failure mode the skill exists to
prevent (observed: 5 of 8 tasks in the hibob-profiles-cache run required
files outside their declared set, in the same four categories every time).

For every task, scan these classes before locking the file set:

- **Registration/dispatch** — does the task add a step, capability, route,
  or handler? The registry/step-list/route-table that causes it to be
  invoked MUST be in the set. A migration `.sql` is inert data without the
  step list entry that makes the runner call it; a capability struct is
  dead code without a catalog entry.
- **Generated artifacts pinned by tests** — does the task add or change a
  struct field, schema, or generated doc? `TestSchema_GoStructSync`,
  `TestCatalogUpToDate`, and doc-conformance tests compare generated
  artifacts against on-disk snapshots. Adding a field makes the snapshot
  stale by construction; the snapshot file(s) and any catalog JSON must be
  in the set.
- **Call sites** — does the task add a new helper, function, or audit
  point? A helper with zero callers is dead code behind a green gate. The
  file(s) where the call or audit-append lives MUST be in the set; name
  them explicitly. If no call site exists yet, the task is incomplete —
  either add the call site or add a task for it.
- **Doc/description generators** — does the task produce user-visible
  text (descriptions, labels, help strings)? The file where the generator
  reads or writes those descriptions (e.g. `dbdoc.go`, a `descriptions`
  map) must be in the set, not just the struct or table definition.

The question to answer for every task before moving on: **"if this task's
diff were applied and nothing else, would the behavior criterion actually
hold at runtime?"** If the honest answer is "no — something else must also
change", add that something to the file set or add a task for it.

**Vacuous done-whens — the named anti-patterns.** Each of these is
machine-checkable AND proves nothing. Reject them at authoring time:
- a test-filter that may match **zero** tests (`go test ./... -run 'Docs'`
  when no `Docs*` test covers this area — it exits 0 on an untouched repo)
- a multi-file `grep`/`rg` whose exit code doesn't require **every** file to
  match (`rg -c a.md b.md c.md` exits 0 when only one matched)
- a build/lint/format command standing in for a behavior check
- any assertion on a mock the same task defines

The general test: **would this check still pass if the task were never
done?** If yes, it is not a done-when. Prefer a check that names the exact
artifact and fails per-item.

**Fails-on-success gates — the inverse defect.** `cmd | grep -q X` under
`set -o pipefail` can SIGPIPE a still-writing producer when grep exits at
first match — small/buffered output may pass, which is what makes it
nondeterministic: the gate fails on SUCCESS (proven live on the 2026-07-27
db-dwh-replan build run — 3/3 e2e runs false-negative). Done-when and
verification commands must use pipeline-safe forms:
`cmd | grep -e 'X' >/dev/null` (reads to EOF), or capture-then-match
preserving producer failure: `output=$(cmd) && grep -e 'X' <<<"$output"`.

**Verification fallback ladder** (only when no single command can prove it):
scripted probe (Playwright/CLI harness) → screenshot diff vs accepted
baseline → named human checklist item at the gate, last resort. Pick one
explicitly per task that needs it. [RQ3]

**Two files, one truth.** Alongside the spec, write the operator digest as a
sidecar: `docs/specs/YYYY-MM-DD-<slug>-spec.human.md`. NON-normative: on any
conflict the spec wins, and the gate (Phase 5) still runs against the spec.
Regenerate it on every spec revision — it must never carry a decision the
spec lacks.

**Its job is not summary — it is the gate's raw material in plain English.**
A digest that prose-summarizes strips exactly what the checklist bites on
(the interfaces, the verification command, the IF/THEN criteria, the
done-whens), so the human forms their whole picture from it and arrives at
the gate with nothing to catch. Fixed sections, one per gate item:

| Digest section | Feeds gate item | Contents |
|---|---|---|
| What this does | 1 | 2–3 short sentences, plain English |
| What it will NOT do | 2 | every OUT bullet, verbatim |
| Files and interfaces I claim exist | 3 | one line each: path + the exact signature |
| How we prove it works | 4 | the closing verification command **verbatim**, plus one line on what a real pass prints |
| What must NOT happen | 6 | every unwanted-behaviour criterion, one plain line each — none dropped, none merged |
| Tasks and their checks | 5, 7 | table: # · what it does in one line · its done-when **command verbatim** |
| What I decided for you | 8 | each marked ambiguity as a question + the default I took |
| What the advisory pass flagged | — | one line per finding, each marked open/addressed; "none" if none |

**Verbatim wherever it is checkable.** Commands, interface signatures, and
unwanted-behaviour criteria are copied exactly, in code spans. Paraphrasing
`go test ./... -run 'Docs'` into "runs the docs tests" is precisely how a
vacuous check survives the gate — item 7 cannot fire on prose.

**Material, never verdicts.** The digest hands over the evidence and stops.
Banned, because each is a checklist item's *answer* and pre-supplying it is
what makes rubber-stamping easy: what a false PASS would look like · what's
missing from OUT · which done-when is weak · which task is safe to cut · any
reassurance about risk, quality, or simplicity.

**Budget: ≤60 lines at Full tier, ≤20 at Short.** The bound is density, not
brevity of content: every line traces to a gate item. Background, rationale,
architecture narration, and restated repo context are what make digests long
— cut them, they live in the spec. If the mandatory sections alone blow the
budget, the tier was wrong or the scope is two changes.

Before presenting: if any gate item has no material in the digest, the digest
is defective — regenerate it, don't present.

**Length follows tier.** There is no doc-length quota; what's bounded is the
gate read (Phase 5). If the doc outgrows one gate sitting, the tier was
wrong or the scope is two changes. [RQ7]

## Phase 4 — Advisory pass (one-shot; skip with `--no-advisory`)

Dispatch ONE read-only subagent with **zero shared context** — it receives
only the doc path and this contract, never your reasoning or the interview:

> Read <doc path>. Report ONLY gaps that affect correctness or the stated
> requirements — contradictions, criteria that cannot be checked as written,
> named files/interfaces that don't exist, tasks whose done-when is not
> machine-checkable, and tasks whose done-when is machine-checkable but
> VACUOUS (it would pass on an untouched repo — e.g. a test-filter matching
> zero tests, or a multi-file grep that exits 0 on a partial match). Run the
> done-when commands where you can rather than reasoning about them.
> Everything else is optional and unwanted. Zero findings is a valid,
> expected answer for a sound doc.

Append its findings verbatim under `## Advisory findings (gate)` — they are
input for the human, not for you. Do not act on them, reply to them, or
re-run the pass over text it already saw. [RQ5][A1][A2]

**Expiry — the pass covers the doc it read, not the doc you ship.** If the
Phase 5 gate sends you back to Phase 2 and the operator's deltas ADD tasks or
behavior criteria, the shipped doc now contains material nothing has reviewed.
Before re-presenting, run ONE further pass **scoped to the added sections
only** — name them explicitly in the prompt, and tell the subagent to ignore
the rest. This is not a re-review and does not violate the no-loop rule: it is
a first review of new text. Findings still die at the human. A revision that
only edits or deletes existing text triggers no new pass.

## Phase 5 — Human gate

Budget: **one sitting, <60 minutes, <400 lines read.** [RQ5]

Tell the operator to open the doc in their editor, then walk them through
the checklist — every item demands a **stated value**, never yes/no [RQ5]:

1. Restate the change in one sentence of your own words.
2. Name the one thing most plausibly missing from OUT-of-scope.
3. Open two named files; confirm the stated interfaces exist as written.
4. Read the verification command; describe what a false PASS would look like.
5. Name the task you'd cut first, and why that is safe or not.
6. For each unwanted-behaviour criterion: name a trigger it misses, or say "none".
7. Name a done-when that would still pass if the work were never done — or
   say "none". (The one item aimed at vacuous checks; they are invisible to a
   reader who only asks "is this checkable?".)
8. Answer or explicitly accept each marked ambiguity — no silent defaults
   through the gate.
9. Edit the doc directly.

**Tripwires** — each is a rubber-stamp signature, not a pass:
- A Full-tier doc accepted in under a minute, or with zero human edits — say
  so and re-present ONCE. [RQ5]
- An answer that reproduces the digest's own wording (items 1, 2, 6 are the
  parrotable ones). That is an echo, not a value — re-ask that item once with
  the digest closed. The digest carries material so the human has something
  to catch defects WITH; it never supplies the catch.

Gate verdicts: **accept** → Phase 6 · **revise** → back to Phase 2 with the
human's deltas (human-driven; this is not a review loop) · **abandon** → stop.

## Phase 6 — Pin & land

On accept (all git via the shell; never touch the default branch):

1. `base=$(git rev-parse HEAD)` — stamp the doc header: `accepted-base: <base>`.
2. Branch `spec/<slug>` from the default branch; commit **both files** (the
   spec and its `.human.md` sidecar); push.
3. Open a **draft** PR. It must be authored by **`aryeh-stark`**, so this goes
   through `gh` — never `github_app.ts`, whose installation token authors as
   `app/stark-claude[bot]`. (`--ready` on the skill opts out of draft.)

```bash
gh pr create --head "spec/<slug>" --base main --draft \
  --title "spec: <slug>" \
  --body "Stage-1 authored spec+plan (stark-author). Gate: accepted by operator."
```

## Phase 7 — Handoff

Print, as the final report: the doc path · PR number · `accepted-base` hash ·
and the implementer's first-move contract, verbatim [RQ8]:

> Fresh session. Read the spec. Critically review it; raise blockers to the
> human BEFORE executing. Verify the repo contains `accepted-base`. Then per
> task: turn the criterion into the first failing check → implement → verify
> → commit. The accepted spec text is immutable — surprises go to
> `## Deviations` (append-only). A deviation that moves the scope boundary
> stops work and returns to the gate as a diff-review.

## Measurement

Nothing to run — metrics derive from git/PR metadata per merged change:
first-pass acceptance (implementation merged with zero re-plan), re-plan
count, deviation count, tokens-per-merged-PR. Never wall-clock, never
self-report. [RQ9]

## What this replaces

This single session replaced the former `stark-write-spec`, `stark-review-spec`,
`stark-red-team-spec`, `stark-spec-to-plan`, and `stark-review-plan` skills —
all five were deleted in the 2026-07-26 demolition. This is the authoring
stage; `stark-build` is the implementation stage.
