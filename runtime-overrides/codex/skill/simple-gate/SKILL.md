---
name: simple-gate
description: Use when running the stark-author human gate (Phase 5), or any spec/plan sign-off checklist, and the operator wants the checks walked interactively in dead-simple, non-technical language. Uses structured choices plus free text when Codex exposes them, with a one-question conversational fallback.
---

# simple-gate

## Help

If the current user request includes a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and `## Arguments`, then stop — do not walk the gate.

## Overview

Walk a non-coder through the stark-author human gate in plain words. First you
**hand them an honest brief** — what the change does, what you checked yourself,
and where you are unsure. Then you ask them the few things **only they can
answer**. Prefer Codex's structured choice UI, which includes free text. When
that UI is unavailable, ask one short open-ended question per turn; do not
imitate controls in prose.

**This is not a test you give them.** It is help. You did the technical QA
already; the gate asks the person for the things a machine cannot supply — what
they actually want, what's out of scope, which way to decide the open choices,
and whether the risks you flagged are the real ones. There are no trick answers.

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
3. **Then use the current host's structured user-input UI when it is exposed.**
   It must show honest options and accept free text. If it is unavailable, ask
   one short open-ended question, wait for the answer, then continue.
4. **Ask up to 3 items per structured call.** The questions below take about
   two calls. The conversational fallback asks one at a time.
5. **Every option is honest.** No planted wrong answer. Where you offer more than
   one real reading, all of them are things the doc could truly mean — you are
   asking which one THEY meant, not baiting them.
6. **If they pick the first option every time without reading, slow down.** Say so
   kindly, and read the brief out loud with them before asking again.
7. **At the end, give the verdict in simple words:** all good (accept) · fix some
   things (revise) · stop (abandon). Name what they still must decide.

## The questions (simple stem + how to build options)

These mirror the five things the stark-author gate asks — the things only the
person can answer. Copy the shape; swap the facts from the doc.

**1. Is this what you wanted?** — "Here is what I think you want. Is that right?"
Give your best plain read first, then one honest alternative read the doc could
also mean, then let them fix it.
- "You want the app to send tasks to ClickUp on its own." (my read)
- "You want it to only get ready, and send later." (a real other meaning)
- "Not quite — let me tell you." (free text)

**2. What is missing from the "will NOT do" list?** — "What might be missing here?"
Give the items YOU suspect might be missing, then "nothing", plus free text.
- "It should say it won't touch other computers."
- "It should say it won't change the old send paths."
- "Nothing. The list looks full."

**3. The open choices** — for each open choice in the doc, ask it plainly.
Give the choice you made first, then the other way, then "not sure".
- "Keep the old send path on. It is harmless." (what I chose)
- "Turn it off later instead."
- "I'm not sure. Tell me more."

**4. Did I miss a bad thing to stop?** — "It lists bad things it must stop. Did I
miss one?" List what it already covers (so they don't repeat it), then ask.
- "It already stops two helpers running at once."
- "It already stops a stuck helper freezing the app."
- "You missed one — let me tell you." (free text) · or "No, it covers them."

**5. Are these the real risks?** — "These are the things I am unsure about. Are
these the real worries, or am I worried about the wrong thing?" State your flagged
risks plainly, then ask them to judge.
- "Yes. Those are the real worries."
- "No. The real worry is something else." (free text)
- "I don't think any of those matter, because…" (free text)

## Common mistakes

- **Faking structured controls in prose.** Wrong. Use the structured UI when
  available; otherwise ask one open-ended question at a time.
- **Planting a trick answer.** Wrong. This is help, not a trap. Every option is honest.
- **Hiding your doubts.** Wrong. The "Where I'm unsure" brief is the most useful thing you give.
- **Sneaking in jargon** ("the dispatcher reconciles"). Translate it or cut it.
- **Long sentences.** Over 10 words? Split it.
- **Inventing options** the doc does not support. Read the doc first, always.

## Honesty note

Choices make a gate easy to pass — so the honesty lives in *what* you ask, not in
tricking the reader. Every question here is something only the person can answer:
what they want, what's out of scope, how to decide, and whether your worries are
the right ones. There is no safe option to rubber-stamp, because there is no answer
you could have supplied for them. If they breeze through without reading, that is
theirs to own — but slow down, read the brief together, and make sure they saw
your flagged risks.
