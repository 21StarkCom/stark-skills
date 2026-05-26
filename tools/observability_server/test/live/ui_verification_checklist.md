# Phase 8 Task 5 — UI verification checklist

Run alongside Tasks 3 + 4 (dispatcher SIGKILL and dispatcher+daemon SIGKILL).
Attach screenshots to `.observability-runs/live-test-YYYY-MM-DD.md`.

## Pre-kill state

- [ ] All 27 sub-agents listed in the run-detail view.
- [ ] Each sub-agent shows `running` status.
- [ ] Live tail panel streaming chunks with timestamps advancing.
- [ ] Planted secrets in agent output rendered as `<REDACTED:GH_TOKEN>` /
      `<REDACTED:ANTHROPIC_API_KEY>` / `<REDACTED:JWT>` (never raw value).

## Post-kill (Task 3 — daemon-written crashed path)

- [ ] Run status transitions to `crashed` within 60 s of SIGKILL.
- [ ] All non-terminal sub-agents transition `running` → `crashed`.
- [ ] `crashed_reason: "parent_exit"` shown on the run-detail header.
- [ ] `ended_at` rendered as a parseable timestamp (no `Invalid Date`).
- [ ] Inline gap markers visible wherever truncation occurred.

## Post-kill (Task 4 — sweeper-written crashed path)

- [ ] Same as above, but transition latency ≤ 90 s.
- [ ] `runs.last_heartbeat_at` stale (> 60 s ago) at the moment of transition.

## Keyboard-only operation

- [ ] Tab through runs list → focus visible on each row.
- [ ] Enter opens run-detail page.
- [ ] Arrow keys navigate sub-agent list.
- [ ] `?` opens the keyboard shortcuts help dialog.
- [ ] `Esc` closes any modal back to the previous view.

## Helper

- [ ] `node --experimental-strip-types tools/observability_open.ts` opens the
      UI without manual log inspection. No browser prompt about the token
      remains on screen after the page settles.

---

Operator: ___________________________   Date: ____________________

Notes:
