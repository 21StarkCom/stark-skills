---
name: stark-fresh-eyes
description: >-
  One-shot zero-context review of a prompt, research brief, spec, or doc before it ships: a single read-only subagent re-verifies every checkable claim by a DIFFERENT method and reports defects only. Findings return to the author once — no second round, no loops. Use for fresh eyes, review prompt, check brief.
argument-hint: '<doc-path> [--focus "aspect"] [--model opus|fable]'
disable-model-invocation: true
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-fresh-eyes — one pass, different method, findings die at the author

A document's author cannot check it — they re-read their own intent, not the
text. This skill dispatches ONE subagent with **zero shared context** (it gets
the file path and the contract below, never your reasoning or history) to
verify every checkable claim by a **different method** than the doc's own,
then returns defects to you exactly once.

**Why one pass, why different method** (2026-07-25 evidence):
- Two independent checks both "confirmed" a file count of 34/35 by re-reading;
  a zero-context reviewer counting **recursively** — a different method — found
  39. Fresh eyes work through method difference, not extra effort.
- Applied at draft time, the authoring rubric + one pass found 2 defects; the
  pre-rubric flow needed 2 rounds for 8-then-3. Rounds past one are rubric
  extraction, not review.
- The fleet autopsy: LLM-review loops are structurally non-convergent —
  findings must decline or the loop is churn. One pass per revision, hard.

**Non-negotiables:**
- **ONE dispatch per document revision.** Apply findings once, ship. If the
  doc is later revised substantially, that NEW revision may get its own single
  pass — never re-run on the same text, never a round 3.
- **Zero shared context.** The subagent receives the path + contract only.
  Sharing your intent turns verification into confirmation.
- **Read-only reviewer.** It never edits the doc; you (the author) apply
  what's real, with a stated disposition per finding.
- **Zero findings is a valid output.** Do not fish; do not re-ask.

**Raw input:** `$ARGUMENTS`

## Phase 1 — Preconditions

1. Resolve the doc path; hard-stop if missing.
2. Note the revision identity (git hash if tracked, else mtime). If this
   session already ran a pass on this exact revision — refuse: apply-or-ship,
   don't re-review.
3. From a quick scan, list the doc's **checkable claim classes** (you list the
   classes, not the answers): file/path references, counts, computed numbers
   and percentages, quoted commands/flags, cross-section dependencies. These
   seed the contract's verification list. `--focus` adds an aspect to
   emphasize; it never removes the default checks.

## Phase 2 — Dispatch (one subagent)

Model: `fable` by default (judgment task); `--model opus` for mechanical-heavy
docs. Dispatch a read-only subagent whose prompt is: the doc path, the claim
classes from Phase 1 with the concrete different-method instruction per class,
and this contract **verbatim**:

> Read <path>. You have NO other context — that is deliberate. Verify every
> CHECKABLE claim by a DIFFERENT method than the doc's own: recount counts
> with your own commands (recursively where relevant), recompute numbers and
> percentages from the raw sources the doc names, test that referenced
> paths/files exist, run `--help` on cited commands, re-derive cross-section
> dependencies. Then report DEFECTS ONLY, numbered:
> (a) factually wrong claims — show your measurement;
> (b) internal contradictions between sections;
> (c) instructions permitting two incompatible readings by the executor;
> (d) references that don't resolve;
> (e) claims stated as fact that you cannot verify — mark "cannot verify",
>     distinct from wrong;
> (f) missing definitions the executor will need.
> NOT defects: style, "could say more", alternative approaches, scope
> opinions. Severity per finding: **blocker** (executor produces a wrong or
> unusable result) / **defect** (wrong fact, bounded blast radius) /
> **note** (genuine minor ambiguity). Cite the exact quote or line for each.
> **Zero findings is a valid, expected output for a sound document.** Your
> final message is the numbered list (or "zero defects") — raw data, no prose.

## Phase 3 — Disposition (you, once)

1. Render the reviewer's findings to the operator **verbatim** (table: #,
   severity, claim, reviewer's evidence).
2. For each: **fix** (apply the edit) / **reject** (say why the reviewer is
   wrong — its zero-context read can misjudge intent) / **accept-as-known**
   (true but deliberate; note it in the doc if an executor could trip on it).
   State the disposition per finding; never silently drop one.
3. Apply all fixes in ONE edit round. Do not re-dispatch to "confirm the
   fixes" — the pass is spent. Ship.

## What this replaces

Ad-hoc self-rereading ("are you sure?" → re-reading the same text the same
way) and multi-round prompt-review loops. One authored draft against a rubric
+ one zero-context different-method pass is the whole quality system.
