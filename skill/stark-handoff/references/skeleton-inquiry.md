# Inquiry skeleton — `brainstorm`, `research`

The executor is thinking, not building: Aryeh in an interactive session
(`brainstorm`) or a web deep-research tool (`research`). Neither is ever
launched headless. Start from [spine.md](spine.md), then fill these sections.

## 1. Destination vs first slice

The end state being aimed at, and the **much smaller** first slice actually
under discussion. Keep the two visibly separate.

## 2. Where this sits in the repo's own vision

Point at the repo's docs/ADRs/specs **with line refs**, so the idea is
anchored in what the project already decided rather than invented fresh.

## 3. What exists today + verify-yourself

The current state as measured, each claim with the command that re-derives it.
Say "verify this rather than trusting me" where the check is cheap.

## 4. Canonical ids and tables

Names drift, ids don't. Give the ids, keys, table/field names, enum values —
verbatim — so the receiver's output lands on real primitives.

## 5. Hard constraints

What the answer must live within: platform, budget, existing contracts,
decisions already made and not up for re-litigation.

## 6. Strawman decomposition — "redraw it if it's wrong"

A concrete proposed breakdown, explicitly marked as a strawman to be replaced
rather than a spec to be filled.

## 7. Tensions to resolve *with* Aryeh

The real trade-offs, stated as tensions with both sides argued — to be settled
**with** him, not decided around him.

## 8. Open questions

Numbered, for the receiver to sequence **one at a time** (a brainstorm prompt
says so in its own text). No question dumps.

## 9. `research` only — rubric checks 4–8, explicit in the text

See [rubric-checklist.md](rubric-checklist.md). A research prompt must carry
these in the payload itself, not merely satisfy them implicitly:

- **4 Calibration cases** — 2 real-shaped examples the deliverable must
  survive. Revise the deliverable, not the case.
- **5 Source tiers** — vendor docs are Tier A for format facts, Tier C for
  efficacy claims.
- **6 Conflict rule** — MEASURED > OBSERVED > OPINION regardless of tier;
  recency breaks ties.
- **7 Traceability** — every recommendation backrefs its finding; anything
  with no backref is labeled speculative.
- **8 Bounded deliverable** — exact structure + word budget + effort weighting.
