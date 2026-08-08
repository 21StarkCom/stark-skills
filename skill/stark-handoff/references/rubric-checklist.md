# The 9-check prompt rubric

Applied at **draft time** (Write Mode Phase 4), before the file is written.
Checks applied at draft time are what produce one-go prompts. Extracted
2026-07-25 from the fleet-burn autopsy work.

1. **Substrate** — name the tools/primitives the output lands on.
2. **Axioms vs testables** — invented defaults are marked "guess to falsify",
   never smuggled in as fixed.
3. **Contradiction logging** — evidence against an axiom goes to Open
   Questions **verbatim**.
4. **Calibration cases** — 2 real-shaped examples the deliverable must
   survive; revise the deliverable, not the case.
5. **Source tiers** — vendor docs Tier A for format facts, Tier C for
   efficacy.
6. **Conflict rule** — MEASURED > OBSERVED > OPINION regardless of tier;
   recency breaks ties.
7. **Traceability** — every recommendation backrefs its finding; no backref =
   labeled speculative.
8. **Bounded deliverable** — exact structure + word budget + effort weighting.
9. **Anti-goals** — name the failure modes the executor must refuse.

## The review rule

**Max ONE zero-context review pass, never a round 3** (fleet-burn autopsy):
LLM-reviews-LLM loops do not converge — they churn. `--fresh-eyes` dispatches
exactly one `/stark-fresh-eyes` pass; disposition every finding once (fix /
reject with a reason / accept as known) and ship.

## Per-type application

- All types: checks 1, 2, 3, 9 always.
- `research`: checks **4–8 must be explicit in the payload text**, not merely
  satisfied implicitly — see
  [skeleton-inquiry.md](skeleton-inquiry.md).
