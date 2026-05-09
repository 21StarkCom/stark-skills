# Integration test replay fixtures

Replays for the Phase 6 opt-in integration suite (`stark_review.e2e.test.ts`).
Each scenario directory holds canned responses for the fake gh / codex / git
binaries from `tools/fixtures/bin/`:

- `happy-dry-run/` — successful PR fetch + one finding from codex; no POST.
- `fix-loop-denied/` — normal PR fetch but the dispatcher emits the V1
  warning that the fix loop is disabled. (Currently exercised via the
  `--allow-untrusted-fix-loop` warning path; full fix-loop integration is
  V1.1.)
- `dispatch-failure/` — codex exits non-zero across all domains; receipt
  surfaces `ok:false` with `error.code='dispatch_failure'`.

These fixtures are intentionally tiny (one or two findings each). Trim large
diffs before committing.

The suite runs only when `STARK_REVIEW_E2E=1`; the default `npm test` skips
it. Weekly CI cron should set the env var.

To refresh: capture a fresh round through `multi_review.py`, sanitize per
the rules in `tools/fixtures/history/README.md`, and re-derive these
canned responses against the same envelope contract.
