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
spec+plan doc, run at most one zero-context advisory pass, gate it on the
human, pin it, hand off. Replaces the write-spec → review-spec →
spec-to-plan → review-plan chain for new work.

Evidence base: [references/stage1-dossier.md](references/stage1-dossier.md)
(61 claims, 3-vote adversarial verification; `[RQn]` tags below cite it).

**Non-negotiables:**
- **No LLM-reviews-LLM loop.** One advisory pass max; its findings die at the
  human. Never revise from them autonomously, never re-run. [A1][A2]
- **One writer.** This session authors everything; subagents only read. [A4]
- **Every task carries a machine-checkable done-when** — downstream loops
  terminate on pass/fail checks, never on a model verdict. [A3][RQ3]
- **You are drafting for a fresh implementer session** that knows nothing the
  doc doesn't say. Pin decisions; leave the greppable out. [RQ8]

**Raw input:** `$ARGUMENTS`

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

Read the repo map, root CLAUDE.md, and the files/interfaces plausibly
touched. **Hard budget: ~10–15 tool calls.** Everything else is looked up on
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

**Budgets:** 2–4 questions per `AskUserQuestion` call; ≤3 calls at Full tier,
≤1 at Short. [RQ1]

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
## Operator digest              | ≤20 short lines, simple English, no jargon: what this
                                | does · what it will NOT do · how we prove it works ·
                                | what I decided for you (the voiced ambiguities + defaults).
                                | NON-normative — on any conflict, the body wins.
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

**Verification fallback ladder** (only when no single command can prove it):
scripted probe (Playwright/CLI harness) → screenshot diff vs accepted
baseline → named human checklist item at the gate, last resort. Pick one
explicitly per task that needs it. [RQ3]

**Two audiences, one file.** The body is the LLM implementer's source of
truth. The `Operator digest` is the human's read — short sentences, plain
English. Regenerate it on every revision; it must never carry a decision the
body lacks. The gate (Phase 5) still runs against the body — the digest is
orientation, not the gate.

**Length follows tier.** There is no doc-length quota; what's bounded is the
gate read (Phase 5). If the doc outgrows one gate sitting, the tier was
wrong or the scope is two changes. [RQ7]

## Phase 4 — Advisory pass (one-shot; skip with `--no-advisory`)

Dispatch ONE read-only subagent with **zero shared context** — it receives
only the doc path and this contract, never your reasoning or the interview:

> Read <doc path>. Report ONLY gaps that affect correctness or the stated
> requirements — contradictions, criteria that cannot be checked as written,
> named files/interfaces that don't exist, tasks whose done-when is not
> machine-checkable. Everything else is optional and unwanted. Zero findings
> is a valid, expected answer for a sound doc.

Append its findings verbatim under `## Advisory findings (gate)` — they are
input for the human, not for you. Do not act on them, reply to them, or
re-run the pass. [RQ5][A1][A2]

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
7. Answer or explicitly accept each marked ambiguity — no silent defaults
   through the gate.
8. Edit the doc directly.

**Tripwires:** a Full-tier doc accepted in under a minute, or with zero human
edits, is a rubber-stamp signature — say so and re-present ONCE. [RQ5]

Gate verdicts: **accept** → Phase 6 · **revise** → back to Phase 2 with the
human's deltas (human-driven; this is not a review loop) · **abandon** → stop.

## Phase 6 — Pin & land

On accept (all git via Bash; never touch the default branch):

1. `base=$(git rev-parse HEAD)` — stamp the doc header: `accepted-base: <base>`.
2. Branch `spec/<slug>` from the default branch; commit the doc; push.
3. Open a **draft** PR (authored by stark-claude; `--ready` opts out):

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/github_app.ts \
  --app stark-claude pr create --head "spec/<slug>" \
  --title "spec: <slug>" --body "Stage-1 authored spec+plan (stark-author). Gate: accepted by operator."
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

For new work, this single session replaces `/stark-write-spec`,
`/stark-review-spec`, `/stark-red-team-spec`, `/stark-spec-to-plan`, and
`/stark-review-plan`. Those skills remain installed for legacy artifacts
until removed.
