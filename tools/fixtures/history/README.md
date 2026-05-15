# History parity fixtures

This directory holds canonical history-file snapshots used by
`stark_review.history.test.ts` to assert that the TS history writer
(`writeRoundHistory` in `tools/stark_review.ts`) produces output that is
field-for-field identical to what Python's `multi_review.save_round_history()`
emits.

## Why

The TS pipeline (`/stark-review` after Phase 5) and the Python pipeline
(`/stark-review` until the cut-over) both write to the
same `~/.claude/code-review/history/<org>/<repo>/<pr>/round-N.json` location.
Downstream consumers — the review-history dashboard, `/stark-review-improvement`,
analytics queries, and any future tooling — read these files as a single
schema. Drift on either side silently breaks consumers.

## Files

- `python-round-1.json` — sanitized snapshot representing the **shared
  envelope contract** every round file MUST honor. Sensitive fields (PR
  numbers from real reviews, contributor info, real org/repo names) have been
  replaced with synthetic values; the timestamp is zeroed to a known date.

## How this fixture was generated

The fixture began life as a real round file from a `multi_review.py` run on
an internal PR. The capture and sanitize procedure:

1. Run `python scripts/multi_review.py --pr <N> --repo <ORG/REPO>` against a
   small PR (one or two findings is plenty).
2. Locate the resulting file at
   `~/.claude/code-review/history/<ORG>/<REPO>/<N>/round-1.json`.
3. Copy it into this directory.
4. Replace identifying fields:
   - `repo` → `owner/repo`
   - `pr` → `100`
   - Real model strings → keep, but verify they are the canonical names listed
     in `global/config.json`.
   - Real `file` paths → keep if they are obviously synthetic; replace
     otherwise.
   - Findings' `body` text → trim or replace if it leaks PR-specific detail.
   - `timestamp` → set to `2026-04-15T00:00:00.000000+00:00`.
5. Run the parity test (`node --experimental-strip-types --test
   stark_review.history.test.ts`); fix any drift.

## Refresh policy

Refresh this fixture only when:

- The TS or Python writer schema deliberately changes (in lock-step), AND
- The change has been agreed in a design doc / ADR.

If the parity test fails on master, that is the canary for unintended drift
between the two writers — investigate before "just refreshing the fixture".

## What the parity test asserts

- All keys in the envelope are present and equal: `schema_version`, `repo`,
  `pr`, `mode`, `round`, `domain_agents`, `models`, `results[].{agent,model,
  domain,duration_s,error,api_key_fallback,findings[]}`, and
  `classification_summary.{fix,noise,false_positive,ignored,unclassified,
  total}`.
- `timestamp` is excluded from the equality check, but it MUST exist and
  parse as ISO-8601.
