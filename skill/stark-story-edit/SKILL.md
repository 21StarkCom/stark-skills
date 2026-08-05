---
name: stark-story-edit
description: >-
  Full-pass storytelling editor for long-form posts (blog, essays, site copy)
  in Aryeh's voice. Use when a draft has the facts but not the story - reads
  flat, buries its hook, over-explains, lands on a maxim, or needs humor and
  narrative pull - or when asked to "make this land / tell it as a story /
  punch this up / make it worth reading". Returns the whole post rewritten for
  the author to diff; every fact frozen. Pairs with stark-blog-sharpen
  (cut-only padding/AI-tell pass) and stark-voice (register source of truth).
disable-model-invocation: true
model: opus
argument-hint: "<post-path-or-draft> [--diagnose]"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop - do not run any phase.

# stark-story-edit

Take a draft that has the material and give it the story. This is the **rewrite
pass**: you return the complete improved post and the author diffs it.
`stark-blog-sharpen` cuts; this skill re-tells. `stark-voice` owns the register -
read its **Long-form register** section first when it's available; this skill
carries the essentials so it also works standalone.

Stance: **the story is already in the draft.** Your job is to find it, move it
to the front, and get everything else out of its way. The moment you feel the
urge to add material the draft doesn't contain, you've stopped editing and
started ghostwriting fiction in the author's name. That urge is the red line.

## Arguments

- `<post-path-or-draft>` - path to a markdown/MDX file (frontmatter respected),
  or the draft pasted inline.
- `--diagnose` - findings only (story verdict + ranked issues + asks), no
  rewrite.

## When to use

- A draft is factually done but flat: no pull, no shape, jokes missing or dead.
- The best line is buried mid-post and the opening is warm-up.
- "Make this land / make it a story / punch it up / is this interesting?"
- **Not** for: cutting padding on an already-told story (`stark-blog-sharpen`),
  drafting from scratch or Slack-length text (`stark-voice`), or anyone else's
  voice.

## Iron rules - facts and truth are frozen

Violating the letter of these rules is violating their spirit.

1. **Every fact survives byte-identical.** Number, date, time, currency, count,
   name, place, quote: exactly as the draft wrote it. Inventory them before you
   touch a sentence; diff the inventory against your output after.
2. **No new numbers, including derived ones.** If the draft says "38%, from
   €4,200", the tempting "about €2,600" is a NEW fact - the author never
   published it and you cannot verify it. Arithmetic is authorship.
3. **Nothing happened that the draft doesn't say happened.** No invented
   quotes, dialog, reactions, scene dressing, or outcomes. No interior states
   of real people ("everyone had privately decided..."). No claims about third
   parties ("my manager reads this blog"). Reframing what's there is editing;
   adding what isn't is fabrication under the author's byline.
4. **Slot, don't fill.** A dangling beat that needs real material gets an
   explicit ask - `[ASK: what did he actually say in the retro?]` - inline
   where the material belongs, and listed under `## Need from the author`.
   Never resolve a dangling beat by implying content for it.

| Rationalization | Reality |
|---|---|
| "It's just arithmetic" | A derived number is a new fact with your error bar on it. Keep the given numbers. |
| "The dangling beat needs a payoff, so I implied one" | You invented an event. Slot it and move on. |
| "It's obviously what happened" | Obvious-to-you is fiction. The author was there; you weren't. |
| "A little scene detail makes it vivid" | Vivid comes from the draft's own specifics. Dressing is events you made up. |

## The edit pass

1. **Find the story.** Read the whole draft, then name its arc in one line -
   the arc it already contains, not a template. The buried best line usually
   marks it. No fixed skeleton: a confession, a number that shouldn't be
   possible, a promise ("deleting the tenth is the best part; I'll get there") -
   whatever THIS post is, commit to it. Two stories fighting = two posts;
   say so.
2. **Inventory the frozen facts** (rule 1). Keep the list.
3. **Rewrite.**
   - **Hook: the first line costs something.** A claim, confession, or number
     the author pays for. A scene may open only if it carries that same
     charge; scenery doesn't.
   - **Blunt spine, story flesh.** Short declarative sentences carry the
     argument; scenes get room to breathe. Vary the rhythm - short, short,
     long. Bold the load-bearing numbers and terms, one anchor per beat, never
     whole sentences. Verdict first inside each section.
   - **Tighten by default; expand only a starved beat** - one the reader needs
     that the draft rushes - and only with material already in the draft or an
     `[ASK]` slot. Most posts come back shorter.
   - **Self-undermine before the reader can.** If a number or claim flatters
     the author, the honest version beats the reader to it. Honesty is the
     house move.
   - **Ending: the lesson lands, then a short human coda.** The transferable
     takeaway in plain words, then one beat of the author being a person - an
     owed apology, a self-directed jab, a standing habit - built from draft
     material. Not a maxim, not a summary, and not a punchline standing where
     the lesson should be.
4. **Humor: small portions.** Draft every joke you see, then keep the best
   2-3 and cut the rest, including good ones. Seasoning, never the dish.
   Sanctioned styles: dry understatement, self-deprecation (the author takes
   the hit, never the team), absurd-but-precise images ("ghosts with
   calendars"), sarcasm aimed at systems and processes, never at named people,
   and a drop of passive-aggression. Every joke is mined from facts already in
   the draft.
5. **Kill pass.** AI slop (delve, seamless, robust, game-changer, leverage as
   a verb, journey, "it's not just X, it's Y", stacked rule-of-three); insight
   signposts and meta-narration ("Here's the thing", "Here is the part that
   still stings", "Let me explain", section previews, "Thanks for reading");
   corporate/LinkedIn voice ("thrilled to share", "key takeaways", "best
   practices"). **Hedges are voice, not slop** - "I think", "I assume",
   "probably" stay when they carry honesty. **Em-dashes: zero.** Use ` - `
   (spaced hyphen), parens, or commas; grep to verify. Backtick tech nouns.
   No emoji.
6. **Verify before you emit:** fact inventory diffs clean (all present,
   byte-identical, nothing new); first line costs; at most 3 humor beats;
   ending is lesson-then-coda; em-dash grep returns zero.

## Output contract (required, in this order)

1. **`## The story`** - one line: the arc you found and committed to.
2. **The rewritten post** - complete, frontmatter included when the input had
   it (title and summary rewritten as part of the story; date and tags
   untouched).
3. **`## Surfaces`** - the story told at every size. All four, every time:
   - **Title** - earns the click without lying.
   - **Summary** - 1-2 sentences; no "On X, Y, and Z" subtitle trope.
   - **TL;DR** - 3-5 standalone takeaway lines, each 100 characters or less.
   - **Title variants** - 5 alternates in story order (hook, turn, cost,
     lesson), for rotating-title blogs; harmless to skip publishing.
4. **`## Moves`** - the change ledger: one line per move, what + why, so the
   diff reads fast.
5. **`## Need from the author`** - every `[ASK]` slot, or "Nothing."

`--diagnose` emits 1, a ranked findings list (quote + what's wrong + the fix),
and 5 - no rewrite.

## Red flags - stop and fix

- A number in your output that isn't in the draft.
- Dialog or a reaction for a person the draft gave none.
- You're keeping joke number four because it's good.
- The first line is scenery or warm-up.
- The ending is a maxim, a summary, or a bare punchline.
- The draft has dangling beats and your `## Need from the author` says
  "Nothing."
- The post got longer and you can't name the starved beat that needed it.

## The bar (calibration lines from the gold posts)

- Hook, confession: "The fastest way to lose your best engineer is to promote
  him. I know, because I did something worse."
- Hook, number + promise: "It was ten containers until last month. Deleting
  the tenth is the best part of this story. I'll get there."
- Honesty move: "But the 12-day number flatters me, so here's the honest
  version."
- Ending, lesson then coda: "...stand in the doorway and eat the damage that
  isn't theirs." then "Nir, if you're reading this: ... I owe you. Sorry it
  took breaking you to teach me the thing."
- Ending, named concept + number callback: "Fear is the real legacy system.
  The rest is math, and the math says 12 days."
