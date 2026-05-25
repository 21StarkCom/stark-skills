# Manual keyboard walkthrough

Required by plan Phase 5 Task 5. Run with a real keyboard only — no
pointer, no touch.

## Setup

1. Bring the stack up (loopback mode).
2. Generate a fresh synthetic run via the Phase 2 emit harness (so the
   tree is non-empty and at least one sub-agent is live):
   ```bash
   node --experimental-strip-types tools/observability_emit_harness.ts \
     --duration-s 60 --subagents 3 --truncate-after-s 30
   ```
3. Run the bootstrap helper, accept the printed URL in Safari, Firefox,
   AND Chrome on macOS. The cold-load asset bundle must render the
   shell without a cookie (plan §1.5.1 E1).

## Steps

| # | Key | Expected behavior |
| - | --- | --- |
| 1 | `Tab` once on the loaded UI | Focus lands on the skip link. |
| 2 | `Enter` on the skip link | Focus jumps into the main panel heading. |
| 3 | `Tab` once more | Focus enters the tablist (Live tab active). |
| 4 | `→` | History tab activates; tabindex moves with it. |
| 5 | `←` back to Live | Live tab is active again. |
| 6 | `Tab` | Focus moves into the left rail tree (first treeitem). |
| 7 | `↓` × N | Roving tabindex walks down visible rows. |
| 8 | `→` on a collapsed row with children | Row expands; aria-expanded=true. |
| 9 | `→` again | Focus moves to first child. |
| 10 | `←` on an expanded row | Row collapses. |
| 11 | `Home` / `End` | Focus jumps to first / last visible row. |
| 12 | `Enter` on a run row | Detail pane focuses its heading (`h2`). |
| 13 | `Tab` into the run table | First column header takes focus. |
| 14 | `Enter` on a column header | Sort direction toggles; `aria-sort` updates. |
| 15 | `Tab` to a sub-agent button + `Enter` | Selection moves to that sub-agent; live tail renders. |
| 16 | `Tab` through the log viewer | Focus rings ≥ 3:1 on every focusable element. |
| 17 | Wait for a `chunk_truncated` event | An inline gap marker renders and is in the tab order. |
| 18 | `Tab` to the gap marker | Focus ring is visible; screen reader announces the `aria-label`. |
| 19 | Open a stderr `<details>` via `Enter` | Stderr expands; focus stays on the summary. |
| 20 | `Shift+Tab` repeatedly | Reverse traversal hits every element in reverse order with no traps. |
| 21 | Toggle the "Quiet announcements" checkbox | Subsequent batched updates make no aria-live announcement. |
| 22 | Browser zoom 200% (`Cmd =` four times) | Layout reflows; no horizontal scrollbar; min 44×44 targets remain. |
| 23 | Enable `Reduce motion` in System Settings | Pulse indicator becomes a static dot. |

## Sign-off

- [ ] Safari macOS — pass / fail
- [ ] Firefox macOS — pass / fail
- [ ] Chrome macOS — pass / fail
- [ ] VoiceOver (Safari) — announces sub-agent selection + gap markers
