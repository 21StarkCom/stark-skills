# Tournament Scoring

## Semantic evaluation (always)

Read each agent's diff and evaluate on 5 dimensions (1-10 each, max 50 points):

- **Correctness** — does the code do what the step asked for?
- **Quality** — is the code clean, well-structured, following conventions?
- **Completeness** — are edge cases handled, tests written?
- **Integration** — does it work with the existing codebase?
- **Simplicity** — is it the simplest correct solution?

## Total score

Total score: test score (0 or 50) + semantic score (0-50) = 0-100.

## Scorecard format

```
Step 1: [title] — Tournament Results
─────────────────────────────────────
              Tests  Correct  Quality  Complete  Integrate  Simple  Total
  claude      PASS     9        8        9          8         8     92 ★
  codex       PASS     8        9        7          9         9     92
  gemini      FAIL     9        7        8          7         8     39

Winner: claude (92/100) — tie-broken by correctness
```
