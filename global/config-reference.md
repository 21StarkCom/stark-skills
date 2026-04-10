# Config Reference — stark-skills

Explanatory context for `global/config.json`. Does not duplicate the values themselves.

---

## Automation Trigger Tiers

Triggers are grouped into four tiers by urgency and cost. When multiple triggers would run at the same time (cron overlap), higher-tier triggers take priority and lower-tier ones are deferred to the next scheduled slot.

| Tier | Purpose | Typical Budget | Examples |
|------|---------|---------------|---------|
| 1 | Strategic / high-value evolution work | $5–$10/run | `stark-evolution`, `stark-self-review` |
| 2 | Active monitoring, dependency & drift detection | $1–$3/run | `stark-sentinel`, `stark-dependency-audit`, `stark-infra-drift`, `stark-api-compat` |
| 3 | Periodic intelligence gathering and sync | $2–$3/run | `stark-intelligence`, `stark-claude-md-sync` |
| 4 | Observability, reporting, housekeeping | $1–$2/run | `stark-digest`, `stark-observability-check`, `stark-automation-monitor`, `stark-hooks-auditor` |

Per-trigger `budget_usd` is a soft cap: the trigger posts a Slack alert to `#stark-automation` if it exceeds the allocation, but does not hard-stop mid-run.

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
| `cost.weekly_budget_usd` ($50) | Rolling 7-day window across all triggers | Matches `automation.cost_alert_threshold_usd_per_week`; posts Slack alert when crossed. Does not stop execution. |
| `cost.daily_alert_usd` ($15) | Single calendar day | Posts Slack alert if daily spend exceeds threshold. |
| `cost.hard_stop_usd` ($100) | Per-session / per-run ceiling | Terminates the current orchestration immediately when hit. Prevents runaway spend on stuck loops. |

Budget evaluation order: per-trigger `budget_usd` check → daily alert → weekly alert → hard stop. A trigger that would breach `hard_stop_usd` is not started.

`cost.track_rolling_7d: true` means spend is accumulated over a sliding 7-day window, not a fixed Mon–Sun week.
