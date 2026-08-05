---
name: stark-story-judge
description: >-
  Zero-context reader verdict on a long-form post. Use before publishing, after
  an edit pass, or whenever the ask is "how good is this / would a stranger
  read this / fresh eyes on this post / grade it / second opinion / would my
  audience or LinkedIn crowd read this". Dispatches cold judges - one per
  vendor, never a re-roll - that grade the reading experience on an anchored
  rubric with quoted evidence, plus optional audience-persona lenses
  (read/share verdicts, no grades), then relays the scorecards verbatim. Judges only - it never edits (stark-story-edit rewrites,
  stark-blog-sharpen cuts) and never checks publish machinery.
disable-model-invocation: true
model: opus
argument-hint: "<post-path-or-draft>"
---

## Help

If the current request asks for help (a standalone `--help`, `-h`, or `help` token),
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
4. **ONE dispatch per revision PER JUDGE.** Findings are dispositioned once -
   fix, reject, or accept. Re-rolling the same judge on the same text is
   noise with a different seed; a re-grade of the same judge is legal only
   after the text changed. A SECOND OPINION is legal only as a different
   vendor's model (see The second judge below) - that is method difference,
   which is how fresh eyes work (`stark-fresh-eyes` law). There is no third
   judge and no tiebreaker.
5. **Relay the scorecard verbatim.** No softening, no re-scoring, no "but it
   read fine to me." You may add dispositions under it, clearly separated.

| Rationalization | Reality |
|---|---|
| "The session already read the post - dispatching is overhead" | The session grades its own intent, not the text. That is the failure the skill exists to prevent. |
| "I'll re-roll the same judge to confirm the grade" | Same-vendor runs disagree in the noise band and you'll keep the one you like. A second opinion means a different vendor, once. |
| "The two judges disagree - a third breaks the tie" | No tiebreakers. Two scorecards plus your written disposition is the process; a third roll is shopping for the answer you prefer. |
| "The first judge said A, skip the second" | On a publish call the second judge exists precisely to catch the first one's blind spots. |
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

## The second judge (cross-vendor)

A second opinion is a DIFFERENT vendor's model reading the same payload -
never a re-roll. Run it when the grade gates a publish decision or when the
author asks for another round; skip it for quick draft checks.

Determine the current host vendor first. The first cold judge normally uses
that host's isolated subagent. Select the second vendor by this rule:

- Codex host -> Claude; Claude host -> Codex; Gemini host -> Codex.
- If that provider is unavailable or disabled, report that the second opinion
  could not run. Never substitute another model from the current host and call
  it cross-vendor.

The model id comes from fleet config. Create a named run directory and keep its
absolute paths accessible until both scorecards have been relayed; do not hide
the files behind `cd "$(mktemp -d)"` and then lose the directory name.

````bash
CURRENT_HOST="<current-host-vendor>" # runner fills: codex | claude | gemini
case "$CURRENT_HOST" in
  codex)  SECOND_VENDOR="claude" ;;
  claude) SECOND_VENDOR="codex" ;;
  gemini) SECOND_VENDOR="codex" ;;
  *) echo "unsupported current host: $CURRENT_HOST" >&2; exit 2 ;;
esac
case "$SECOND_VENDOR" in
  codex|claude) ;;
  *) echo "unsupported second judge: $SECOND_VENDOR" >&2; exit 2 ;;
esac
command -v "$SECOND_VENDOR" >/dev/null 2>&1 || {
  echo "second-judge CLI unavailable: $SECOND_VENDOR" >&2
  exit 2
}

ASSET_ROOT="${STARK_PLUGIN_ROOT:-}"
[ -n "$ASSET_ROOT" ] || \
  ASSET_ROOT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}"
TOOLS="$ASSET_ROOT/tools"
RUN_ROOT="${STARK_STORY_JUDGE_ROOT:-${TMPDIR:-/tmp}/stark-story-judge}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
JUDGE_DIR="$RUN_ROOT/$RUN_ID"
mkdir -p "$JUDGE_DIR"

PROMPT_FILE="$JUDGE_DIR/judge-prompt.txt"
SCORECARD_FILE="$JUDGE_DIR/$SECOND_VENDOR-scorecard.txt"
STDERR_FILE="$JUDGE_DIR/$SECOND_VENDOR-stderr.txt"
# Write the completed template + payload once to $PROMPT_FILE. Every judge
# receives these exact bytes.

MODEL="$(node --experimental-strip-types "$TOOLS/stark_config_lib.ts" \
  --model "$SECOND_VENDOR" 2>/dev/null || true)"

case "$SECOND_VENDOR" in
  codex)
    MODEL_ARGS=()
    [ -z "$MODEL" ] || MODEL_ARGS=(-m "$MODEL")
    (cd "$JUDGE_DIR" && codex exec --skip-git-repo-check -s read-only \
      "${MODEL_ARGS[@]}" -c model_reasoning_effort="xhigh" - \
      < "$PROMPT_FILE" > "$SCORECARD_FILE" 2> "$STDERR_FILE")
    ;;
  claude)
    MODEL_ARGS=()
    [ -z "$MODEL" ] || MODEL_ARGS=(--model "$MODEL")
    (cd "$JUDGE_DIR" && claude -p - --output-format text \
      "${MODEL_ARGS[@]}" --no-session-persistence --tools "" \
      < "$PROMPT_FILE" > "$SCORECARD_FILE" 2> "$STDERR_FILE")
    ;;
  *)
    echo "unsupported second judge: $SECOND_VENDOR" >&2
    exit 2
    ;;
esac

printf 'judge_dir=%s\nscorecard=%s\nstderr=%s\n' \
  "$JUDGE_DIR" "$SCORECARD_FILE" "$STDERR_FILE"
````

- **The judge prompt is byte-identical for every judge.** Same template, same
  payload, same rubric - a grade difference must come from the judge, never
  from a prompt difference.
- **Prompt stdin reaches EOF.** Both commands read the saved prompt file, so an
  orchestrated shell cannot leave the CLI waiting on an open pipe.
- **Empty temp cwd and tool lockdown.** Codex uses
  `--skip-git-repo-check -s read-only`; Claude uses `--tools ""`. A cold reader
  gets nothing except the prompt.
- Read the absolute scorecard path and relay it verbatim. Keep the run directory
  on failure and report both absolute output paths for diagnosis.

## Reading two scorecards

- **Relay both verbatim.** Never average the totals, never merge rows into
  one table with your own arithmetic.
- **Convergence is the signal.** A problem both judges name independently
  (same fix, same first-line-to-cut) outranks either judge's score. Act on
  convergent findings first.
- **A one-point score gap is the noise band.** Report it, don't adjudicate
  it.
- **A 2+ point gap on one dimension gets a written disposition:** re-read
  that dimension with both quotes on the table and say which evidence holds.
  That is a disposition, not a re-dispatch.
- **Verdicts differ: the stricter one stands** for the publish decision
  (NO STORY YET > REWRITE > PUBLISH AFTER FIXES > PUBLISH).

## The audience lens (optional - a different question)

Craft judges answer "is this good". A lens answers **"would THIS reader read,
finish, and share it"**. Different question, so it does not count against the
judge limits - but a lens is NOT a judge: it outputs **no dimension scores and
no letter grade, and it can never move the craft grade**. Its verdict is a
separate row; when lens and judge disagree (a skimmable block the craft judge
dinged may be exactly what the audience wants), that disagreement is signal,
dispositioned by the author.

Run a lens when distribution matters (a post whose channel is LinkedIn, a
targeted audience) or on request. Same discipline as judges: cold dispatch,
byte-identical payload, no tools, the contamination list applies, ONE dispatch
per revision per lens. A lens is a **simulation of a reader type** - useful
directional signal on register and format, never ground truth about real
audience behavior; channel analytics stay the measure.

### Persona: israeli-linkedin-lead

Israeli engineering leader, director/VP band. Native register is dugri:
bluntness is normal, softened corporate phrasing reads as evasive, hedged
praise reads as spin. Reads English tech content on LinkedIn mobile between
meetings; skims first, reads only if captured; time budget about 90 seconds
unless held. Allergic to AI vocabulary and guru formats (humble-brags,
engagement bait) but VALUES skimmable structure - bold anchors and tight
lists are native reading when they are earned. Shares what makes them look
sharp and is defensible in the comments.

Add personas as data blocks like this one; a run names which persona it used.

### The lens prompt (template - fill the slots, send as-is)

````text
You are role-playing ONE specific reader, defined below. You know nothing
about the author except what the text says. You have no tools; everything you
need is below. Report this reader's honest reactions - where they stop, what
they distrust, what they would repost - not a critique of the writing.

READER: [paste the persona block]

RULES:
- No scores, no letter grades, no craft dimensions. That is another tool's job.
- Do not rewrite anything and do not prescribe restructures. Name what breaks
  this reader's attention; the author owns the fix.
- No invented facts and no arithmetic: if the post withholds a number, flag
  the coyness - do not compute the number.
- Every claim about a reaction anchors to a verbatim quote from the post.
- Frame everything as THIS reader's read, never as facts about real audiences.

Return exactly this shape:
1. VERDICT: WOULD SHARE / WOULD READ / WOULD SCROLL PAST - plus one sentence.
2. The funnel - each stage with the quoted line where it holds or breaks:
   STOP (do the first lines hold on a phone) · READ (past the first third) ·
   FINISH · ACT (share, comment, or send to a colleague - and what they'd
   say over it).
3. Fake-detector: lines that read corporate, AI-flavored, or evasive to this
   reader - quoted; or "none".
4. Skim pass: what a 20-second skimmer leaves with (harvest the bold lines
   and structure), and whether that harvest is the post's actual point.
5. Share trigger: the one quotable line this reader would repost over, or
   its absence.
6. Top 2 audience fixes - named, tagged with the funnel stage each moves; no
   prose, no rewrites.

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
- You dispatched the SAME judge twice on the same revision.
- A third judge broke a tie.
- Two totals were averaged into one number.
- The judge returned rewritten prose.
- You adjusted a score while relaying.
- A lens returned scores or a letter grade, or its verdict was used to move
  the craft grade.
- A lens computed a number the post withheld.

Invalid runs are re-dispatched with the leak fixed - they are not "close
enough".
