---
name: simple-gate
# Claude-only: built on the AskUserQuestion interactive tool; no Codex runtime
# override is authored (exempts the bifrost codex overlay gate).
runtimes:
  - claude
description: Use when running the stark-author human gate (Phase 5), or any spec/plan sign-off checklist, and the operator wants the checks walked interactively in dead-simple, non-technical, ELI5 language with multiple-choice questions plus free text. Triggers include "walk me through the gate simply", "explain the gate like I'm five", "gate in plain English", "I don't get the checklist", "make the review easy".
---

# simple-gate

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and `## Arguments`, then stop — do not walk the gate.

## Overview

Walk a person through the 8 stark-author gate items in a live terminal session.
Each item is one multiple-choice question with plain, simple words, plus a free-text
"Other" for their own answer. The goal: a smart non-coder can pass the gate without
knowing any jargon.

**Core rule: write every question as if to a bright 10-year-old.** Short words. Short
sentences. Real choices.

## When to use

- Someone reached the stark-author human gate (Phase 5) and wants it made simple.
- They say "explain it like I'm five", "I don't understand the checklist", "just give me choices".
- Any spec/plan sign-off where the reader is not the coder.

**Do NOT use** to skip the gate. This makes the gate *easy*, not *fake*. The checks still bite.

## Arguments

- `[spec-path]` — optional path to the spec+plan doc under gate. When omitted, use the
  spec+plan the current session just authored (and its `.human.md` sidecar).

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
If a word is not in this table and a 10-year-old would not know it, do not use it —
say the effect in plain words instead.

## How to run it

1. **Read the spec and its `.human.md` sidecar** for the change under gate. Build every
   option from what THAT doc actually says. Never invent facts.
2. **Ask with the `AskUserQuestion` tool.** It shows your options AND a free-text "Other".
   That is "choices plus free text" — use it, do not type questions as plain prose.
3. **Ask up to 4 items per call.** 8 items = about 2 calls. Do not dump all 8 at once.
4. **Put a wrong choice (a decoy) in most questions.** Picking must be a real test, not a
   rubber stamp. Mark nothing as "(right)" — the person must choose.
5. **If they pick the decoy, stop.** Say why it is wrong, in kid words. Ask that one again.
6. **At the end, give the verdict in simple words:** all good (accept) · fix some things
   (revise) · stop (abandon). Name what they still must decide.

## The 8 questions (simple stem + how to build options)

Worked example uses the `alfredd-spine` spec. Copy the shape; swap the facts.

**1. What does it do?** — "Pick the line that says what this change does."
Give 2 true lines (different words) + 1 decoy from the "will NOT do" list.
- "It makes the app send tasks to ClickUp on its own."
- "A background helper sends the work with no chat open."
- "It adds a planner for future jobs." ← decoy (that is a later slice)

**2. What is missing from the "will NOT do" list?** — "What might be missing here?"
Give 2 plausible-missing items + "Nothing, it looks full."
- "It should say it won't touch other computers."
- "It should say it won't change the old send paths."
- "Nothing. The list looks full."

**3. Do the files really exist?** — "Open 2 files. Find 2 pieces of code. Did you?"
Name the two files and the two code names, in plain path form.
- "Yes. Both are there."
- "No. One is missing."
- "I could not open the file."

**4. When could a green check lie?** — "It says one command proves it works. When could that lie?"
Give 2 real ways it could lie + 1 decoy that trusts green blindly.
- "If the tests do not really run."
- "If it never talks to the real ClickUp."
- "It cannot lie. Green means done." ← decoy

**5. Which task would you drop first?** — "Which task could you skip? Is that safe?"
List 2-3 tasks by plain label, each with a safe/not-safe hint.
- "The docs task. Fairly safe. Docs can wait."
- "The crash tests. Not safe. They catch bad crashes."
- "None. I would keep them all."

**6. What bad thing could still happen?** — "It lists bad things to stop. Did it miss one?"
Give 2 already-covered cases + "None, it covers them" + let them type a real gap.
- "Two helpers could run at once." (already covered)
- "A stuck helper could freeze the app." (already covered)
- "None. The list covers it."

**7. Which check passes even with no work done?** — "A good check fails if the work is skipped.
Any check here that stays green anyway?"
Give 2 checks that ARE real (decoys) + "None, all real."
- "The docs check." (it is real)
- "The live test." (it is real)
- "None. Every check needs the work."

**8. The one open choice** — state the real open question from the doc, plainly.
Give the default first, then the other way, then "not sure".
- "Keep the old send path on. It is harmless." (the default)
- "Plan to turn it off later."
- "I'm not sure. Tell me more."

## Common mistakes

- **Typing questions as prose.** Wrong. Use `AskUserQuestion` so they get real choices.
- **Marking the right answer.** Wrong. Then it is not a test.
- **No decoy.** A gate with no wrong option is a rubber stamp.
- **Sneaking in jargon** ("the dispatcher reconciles"). Translate it or cut it.
- **Long sentences.** Over 10 words? Split it.
- **Inventing options** the doc does not support. Read the doc first, always.

## Honesty note

Choices make a gate easy to pass — and easy to fake. Two guards keep it honest: a wrong
decoy in most questions, and the free-text "Other" for a real answer. If someone only ever
picks the safe option with no thought, the gate did not work. Slow down and re-ask.
