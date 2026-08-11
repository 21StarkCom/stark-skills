# Config Reference — stark-skills

Explanatory context for `global/config.json`. Does not duplicate the values themselves.

---

## Feature Flag Interactions

Four subsystems can be enabled or disabled independently. They interact as follows:

| Flag | What it does | Interacts with |
|------|-------------|----------------|
| `self_heal.enabled` | Detects repeated failures and suggests or auto-applies fixes. `mode: suggest` means findings are posted only; `mode: auto` applies `auto_patterns`. | `validation_gate` — if the gate fails, self-heal is invoked before retrying. |
| `validation_gate.enabled` | Runs a post-implementation review pass on `implementation` and `autopilot` workflows. Blocks merge if findings exceed `fix_threshold`. | `self_heal` — gate failure triggers heal attempt up to `circuit_breaker_threshold` times. |
| `skill_activation.enabled` | Watches for signals (review findings, corrections, skill invocations) and suggests relevant skills after `suggest_after_review_rounds` rounds. Respects `cooldown_hours` between suggestions per skill. | Independent of heal/gate; purely advisory. |
| `context_compaction.enabled` | Checkpoints agent context every `checkpoint_interval_minutes` to stay under token limits during long-running workflows (autopilot, phase-execute). | Active only during multi-step orchestration; no interaction with heal or gate. |

Disabling `validation_gate` also silences any self-heal retries triggered by gate failures, even if `self_heal.enabled` is `true`.

---

## Cost Controls

Three thresholds govern spend at different scopes:

| Key | Scope | Behavior |
|-----|-------|---------|
| `cost.weekly_budget_usd` ($50) | Rolling 7-day window across all runs | Posts a Slack alert when crossed. Does not stop execution. |
| `cost.daily_alert_usd` ($15) | Single calendar day | Posts Slack alert if daily spend exceeds threshold. |
| `cost.hard_stop_usd` ($100) | Per-session / per-run ceiling | Terminates the current orchestration immediately when hit. Prevents runaway spend on stuck loops. |

Budget evaluation order: daily alert → weekly alert → hard stop. A run that would breach `hard_stop_usd` is not started.

`cost.track_rolling_7d: true` means spend is accumulated over a sliding 7-day window, not a fixed Mon–Sun week.
