---
name: stark-story-judge
description: >-
  Zero-context reader verdict on a long-form post. Use before publishing, after
  an edit pass, or whenever the ask is "how good is this / would a stranger
  read this / fresh eyes on this post / grade it". Dispatches ONE cold subagent
  that grades the reading experience on an anchored rubric with quoted
  evidence, then relays the scorecard verbatim. Judges only - it never edits
  (stark-story-edit rewrites, stark-blog-sharpen cuts) and never checks
  publish machinery.
disable-model-invocation: true
model: opus
argument-hint: "<post-path-or-draft>"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop - do not run any phase.

# stark-story-judge

The judge is the reader the author cannot be. Your session knows the author,
the edit history, the intent behind every paragraph - which is exactly why your
session must not do the grading. **That knowledge is the contamination.** You
prepare a clean payload, dispatch ONE cold subagent with no tools and no
context beyond the rubric, and relay its scorecard verbatim.

Grades, never edits. A fix is named, not written.

## Arguments

- `<post-path-or-draft>` - path to a markdown/MDX file, a CMS slug you can
  read, or the draft pasted inline.

## When to use

- Before publishing: "is this ready? would a stranger read it?"
- After `stark-story-edit` or `stark-blog-sharpen`: did the pass move the grade?
- Ranking drafts: which of these two posts runs first?
- **Not** for: fixing anything (that's `stark-story-edit` /
  `stark-blog-sharpen`), reviewing publish readiness (covers, title variants,
  frontmatter - the CMS gate owns those), or code/spec review
  (`stark-fresh-eyes` owns docs).

## The zero-context protocol

1. **Build the payload: exactly what a stranger sees.** Title, summary, body,
   in that order, inline in the prompt. Include image alt text and captions
   (readers see them). Nothing else.
2. **Contamination list - none of this enters the payload or the prompt:**
   author identity or reputation beyond what the text says, edit history,
   prior grades, the desired outcome, repo paths, CMS/publish-gate rules, and
   especially "this is our best post" or any other anchor. If the judge's
   scorecard mentions your infrastructure, you leaked.
3. **The judge gets no tools.** Say so in the dispatch: everything it needs is
   in the prompt. A cold reader does not grep your repo or google you.
4. **ONE dispatch per revision.** Findings are dispositioned once - fix,
   reject, or accept. A second opinion on the same text is noise with a
   different seed; a re-grade is legal only after the text changed.
   (Same law as `stark-fresh-eyes`: fresh eyes work through method
   difference, not repetition.)
5. **Relay the scorecard verbatim.** No softening, no re-scoring, no "but it
   read fine to me." You may add dispositions under it, clearly separated.

| Rationalization | Reality |
|---|---|
| "The session already read the post - dispatching is overhead" | The session grades its own intent, not the text. That is the failure the skill exists to prevent. |
| "A second judge would confirm the grade" | Two cold runs disagree in the noise band and you'll keep the one you like. Disposition once; re-judge after edits only. |
| "I'll just mention the author so it calibrates" | You just anchored the grade. The payload carries no author. |
| "I'll add the house publish rules for completeness" | Machinery is not reading. The gate has its own tool. |

## The rubric (goes in the judge prompt)

Seven dimensions, each scored 0-3. **Every score must carry a quoted span
from the post as evidence - a score without a quote is invalid; redo it.**

Bands: **0** kills the post for a stranger · **1** weak, costs readers ·
**2** solid, professional · **3** sharp, memorable.

1. **Hook** (title + summary + first paragraph). 0 warm-up or generic
   promise · 1 topic-first, mild pull · 2 a real stake or tension up front ·
   3 the first line costs the author something; not continuing is hard.
2. **One idea** (the matter-test). First, name the single non-obvious
   takeaway in one line - this line is mandatory output. 0 can't name one,
   or it's management/engineering trivia · 1 known advice, well restated ·
   2 a real mechanism or inversion · 3 stealable and quotable; it argues
   with the reader later.
3. **Pull.** Read as a stranger; mark where attention dies. 0 died in the
   first third · 1 middle sags, you skimmed · 2 held to the end · 3 tension
   rises; the turns land.
4. **Voice.** 0 interchangeable content-team prose or AI-tell dense ·
   1 competent, flavorless · 2 a person is audible · 3 lines only this
   author could have written (quote two).
5. **Fluency.** 0 you fought the prose · 1 flab and repetition ·
   2 clean · 3 sentences worth rereading.
6. **Honesty.** 0 smells invented or marketed · 1 asserted without
   receipts · 2 claims carried by specifics · 3 beats the reader to its own
   weaknesses.
7. **Landing.** 0 thud: maxim, summary, or outro filler · 1 stops without
   landing · 2 the lesson lands · 3 lesson plus a human beat that stays.

**Grade:** total out of 21. A 19-21 · B 16-18 · C 12-15 · D 8-11 · F 0-7.
**One idea = 0 caps the grade at D** - craft cannot rescue an empty post.

**Verdict** (one of): `PUBLISH` · `PUBLISH AFTER FIXES` · `REWRITE` ·
`NO STORY YET` - plus one sentence of why.

## The judge prompt (template - fill the slots, send as-is)

````text
You are a sharp, well-read stranger grading a blog post. You know nothing
about the author except what the text says. You have no tools; everything you
need is below. You are grading, not encouraging - a kind grade on a post that
loses readers is a failed review.

Score seven dimensions, 0-3 each, using the anchored bands provided.
RULES:
- Every score carries a verbatim quote from the post as evidence. No quote,
  no score.
- Most drafts have at least two dimensions at 0 or 1. If you scored every
  dimension 2+, re-read your weakest dimension trying to refute your own
  score before submitting.
- Never average toward the middle. A 1 with a reason beats a 2 without one.
- Do not rewrite anything. Name problems; do not draft replacement prose.
- Judge only the reading experience. Ignore metadata, SEO, and anything a
  reader does not see.

[RUBRIC - paste the seven dimensions, bands, grade mapping, and verdict enum
from the skill]

Return exactly this shape:
1. VERDICT + grade + total (first line).
2. The one-line takeaway (the matter-test) - or "cannot name one".
3. Seven rows: dimension - score - quote - one line of why.
4. The three lines you'd quote back to the author.
5. The first line you'd cut.
6. Top 3 fixes, ranked by expected lift on the grade. Name each problem and
   the dimension it moves; do not write the fix's prose.

POST:
Title: {{TITLE}}
Summary: {{SUMMARY}}
Body:
{{BODY}}
````

## Red flags - the run is invalid

- A score arrived without a quote.
- Every dimension scored 2 or higher on a first draft.
- The scorecard mentions your repo, gates, frontmatter, or tooling.
- You dispatched twice on the same revision.
- The judge returned rewritten prose.
- You adjusted a score while relaying.

Invalid runs are re-dispatched with the leak fixed - they are not "close
enough".
