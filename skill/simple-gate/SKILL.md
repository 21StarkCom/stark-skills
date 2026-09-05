---
name: simple-gate
runtimes:
  - claude
  - codex
description: Use when running the stark-author human gate (Phase 5), or any spec/plan sign-off checklist, and the operator wants the checks walked interactively in dead-simple, non-technical, ELI5 language with multiple-choice questions plus free text. Triggers include "walk me through the gate simply", "explain the gate like I'm five", "gate in plain English", "I don't get the checklist", "make the review easy".
---

# simple-gate

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and `## Arguments`, then stop — do not walk the gate.

## Overview

Walk a non-coder through the stark-author human gate in plain words. First you
**hand them an honest brief** — what the change does, what you checked yourself,
and where you are unsure. Then you ask them the few things **only they can
answer**, as multiple-choice questions with a free-text "Other".

**This is not a test you give them.** It is help. You did the technical QA
already; the gate asks the person for the things a machine cannot supply — what
they actually want, which way to decide the open choices, and anything you had no
way to see from the code (what it must not touch, and what must never happen).
There are no trick answers.

**Core rule: write every question as if to a bright 10-year-old.** Short words.
Short sentences. Real choices, honestly labelled.

## When to use

- Someone reached the stark-author human gate (Phase 5) and wants it made simple.
- They say "explain it like I'm five", "I don't understand the checklist", "just give me choices".
- Any spec/plan sign-off where the reader is not the coder.

**Do NOT use** to skip the gate. This makes the gate *easy*, not *fake*. The
questions still need a real answer — but the answer is theirs to give, not a
gotcha to survive.

## Arguments

- `[spec-path]` — optional path to the spec+plan doc under gate. When omitted, use
  the spec+plan the current session just authored (and its `.human.md` sidecar).

## The hard language rules (the whole point)

Break any of these and you failed the task:

1. **Max 10 words per sentence.** Count them.
2. **Max 10 sentences per question** (the question and all its options together).
3. **No jargon. Ever.** Translate every code word to a kid word (table below).
4. **One idea per sentence.**
5. **No big words when a small word works.** "use" not "utilize". "start" not "initialize".

Say the thing plainly. If a 10-year-old would stop and frown, rewrite it.

## Jargon → kid words

| Jargon in the spec | Say this instead |
|---|---|
| provider / ClickUp API | ClickUp (the task app) |
| dispatcher / drain / flush | send the work |
| daemon / LaunchAgent | a helper that runs in the background |
| interface / function / method | a piece of code |
| done-when / criterion | a check |
| vacuous check | a check that stays green even if no one did the work |
| unwanted-behaviour / invariant | a bad thing it must stop |
| OUT-of-scope | the "will NOT do" list |
| verification command | the command that proves it works |
| session | a coding chat |
| idempotent / reconcile | it is safe to run twice |
| lock / flock | only one at a time |
| provenance | proof the helper did it, not someone else |
| backoff / retry policy | how it waits before trying again |
| coalesce / debounce | many pings become one |
| supersede | replaces the old decision |
| race / TOCTOU | two things clash at the same moment |
| DAG / depends-on | which task must come first |

Add rows as needed. When in doubt, name the everyday effect, not the mechanism.
If a word is not in this table and a 10-year-old would not know it, say the effect
in plain words instead.

## How to run it

1. **Read the spec and its `.human.md` sidecar** for the change under gate. Build
   everything you say from what THAT doc says. Never invent facts.
2. **Give the brief first, in plain words** (3 short parts):
   - what this change does — 2-3 short lines;
   - what you checked yourself — the files are real, the checks are honest, the
     proof-it-works command does what it claims;
   - **where you are unsure** — the risks the spec's "Where I'm unsure" section
     lists, one plain line each. Say them straight. Do not hide them.
3. **Then ask with the `AskUserQuestion` tool.** It shows your options AND a
   free-text "Other". That is "choices plus free text" — use it, do not type
   questions as plain prose.
4. **Ask up to 4 items per call.** The three questions below fit one call.
5. **Every option is honest.** No planted wrong answer. Where you offer more than
   one real reading, all of them are things the doc could truly mean — you are
   asking which one THEY meant, not baiting them.
6. **If they pick the first option every time without reading, slow down.** Say so
   kindly, and read the brief out loud with them before asking again.
7. **At the end, give the verdict in simple words:** all good (accept) · fix some
   things (revise) · stop (abandon). Name what they still must decide.

## The questions (simple stem + how to build options)

These mirror the three things the stark-author Phase 5 gate asks — the things only
the person can answer. Copy the shape; swap the facts from the doc.

**1. Did I get what you want?** — first play it back in three plain layers, built
from what they told you, not from the doc's words. Then ask.
- **What you want right now:** "You want the app to send tasks to ClickUp on its own."
- **The deeper thing:** "So you stop copying tasks over by hand."
- **The point:** "Less busywork. Fewer missed tasks."
- Then ask "Did I get that right?" with a real other reading and a free-text fix:
  - "Yes, that's it."
  - "Close, but it should only get ready, and send later." (a real other meaning)
  - "Not quite — let me tell you." (free text)

**2. The calls I made for you** — for each choice you had to make yourself, ask it
plainly. Give the call you made first, then the other way, then "not sure".
- "Keep the old send path on. It is harmless." (what I chose)
- "Turn it off later instead."
- "I'm not sure. Tell me more." (free text)

**3. Anything I could not see from the code?** — "Is there something this must not
touch, or something bad that must never happen, that I would not know?" Name what
the doc already covers first (so they don't repeat it), then ask.
- "It already says it won't touch other computers."
- "It already stops two helpers running at once."
- "Yes — here is what I'd add." (free text) · or "No, that covers it."

## Common mistakes

- **Typing questions as prose.** Wrong. Use `AskUserQuestion` so they get real choices.
- **Planting a trick answer.** Wrong. This is help, not a trap. Every option is honest.
- **Hiding your doubts.** Wrong. The "Where I'm unsure" brief is the most useful thing you give.
- **Sneaking in jargon** ("the dispatcher reconciles"). Translate it or cut it.
- **Long sentences.** Over 10 words? Split it.
- **Inventing options** the doc does not support. Read the doc first, always.

## Honesty note

Choices make a gate easy to pass — so the honesty lives in *what* you ask, not in
tricking the reader. Every question here is something only the person can answer:
what they want, how to decide the open choices, and what you had no way to see from
the code. There is no safe option to rubber-stamp, because there is no answer you
could have supplied for them. If they breeze through without reading, that is
theirs to own — but slow down, read the brief together, and make sure they saw
your flagged risks.
