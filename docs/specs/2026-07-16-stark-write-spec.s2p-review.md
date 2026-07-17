# Spec-to-Plan review summary — 2026-07-16-stark-write-spec (v2, post-convergence-fix)

- Lead: claude · Wing: codex · Rounds: 5 · Re-run after PR #687 (convergence discipline)
- Trajectory: **7→7→5→2→2** (was 7→7→6→8→3 pre-fix) — monotonic, no mid-loop spike, no re-litigation (each round's findings were new/deeper, not re-raised).
- Verdict: `max_rounds_unresolved` — find-convergence limited by genuine spec depth, not churn. The convergence fix worked; 4 rounds is short for a spec this large.
- **Resolution:** 4 residual findings (all correct, all different across rounds 4→5) fixed by hand:
  1. contract.md referenced but never composed into agent requests (agents have no file tools) → `composePrompt` prepends contract contents to every generate/verify/revise call + test.
  2. Existing local branch checked out without fetch+ff → stale-branch guard (fetch + `merge --ff-only`, hard error on divergence) + test.
  3. Adopted draft PR never marked ready under `--ready` → `gh pr ready` (ambient identity, idempotent) + test.
  4. Bare `npm test` (no root package.json) → `npm --prefix tools test`.

## Per-round verdicts
- Round ?: revise — 7 blocking
- Round ?: revise — 7 blocking
- Round ?: revise — 5 blocking
- Round ?: revise — 2 blocking
- Round ?: revise — 2 blocking
