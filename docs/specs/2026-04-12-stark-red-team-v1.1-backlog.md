# stark-red-team — v1.1 Backlog (round-3 findings)

**Parent spec:** [`2026-04-12-stark-red-team-design.md`](./2026-04-12-stark-red-team-design.md)
**Status:** Deferred — not blocking v1 ship
**Source:** Round 3 of the iterative red-team simulation on the spec itself
**Date:** 2026-04-12

## Context

Rounds 1 and 2 of the red-team simulation found structural issues that would have shipped broken software (prompt injection, unbounded cost, permanent halts). Those were fixed inline.

Round 3 ran past the spec's own `max_rounds=2` by explicit human override. It found a consistent number of blockers (5) but at a *deeper layer* — operational concerns rather than shipping-critical logic gaps. The finding **severity** (what v1 ships with) plateaus after round 2; additional rounds find real issues but not ones that break v1 catastrophically.

The right call is to **accept round 3 as known v1 gaps, document them here, and ship v1** so we can generate real calibration data from implementation. Paper iteration has diminishing returns without empirical feedback.

This document captures round 3's findings for the v1.1 milestone.

## Convergence signal

| Round | Blockers | Severity of gap |
|---|---|---|
| 1 | 5 | Shipping-critical (data loss, injection, permanent halts) |
| 2 | 4 | Structural (cost cascade, flicker, UX escape hatches) |
| 3 | 5 | Operational (integrity verification, predictive gating, automation fit) |

Rounds 1–2 fix shipping-blockers. Round 3 finds operational polish. The consistent blocker count is a property of design-review loops without implementation feedback — *only implementation produces the constraint that forces convergence.*

---

## Finding `rt_c1` — Persona-file integrity + override authorization [critical → v1.1]

**Concern.** Round 2 added SHA-256 hashes to input delimiters (rt_b1) and locked `personas`/`model` config fields (rt1), but:
1. The SHA-256 hashes are computed but never verified — they're audit metadata, not a security control.
2. Persona files on disk are not integrity-verified. A supply-chain attack on `stark-skills` could replace `global/prompts/red-team/personas/*.md` with injected content, bypassing the rt1 config lock.
3. `--accept-red-team-human-review` is authorized by whoever has CLI access. Single-person accepts on critical findings have no second-person review gate.

**Why deferred.** The rt1 and rt_b1 defenses already raise the bar significantly for external prompt injection. The remaining gaps require privileged access (filesystem write to `stark-skills`, CLI access to the user's machine) that in turn require a broader compromise the red team can't defend against anyway. v1 is strictly better than the status quo (no red team at all).

**Proposed v1.1 changes:**
1. Ship `global/prompts/red-team/MANIFEST.sha256` — committed alongside persona files, computed at release time.
2. Preflight verifies persona files match the manifest; mismatches → blocked with a loud error.
3. `--accept-red-team-human-review <id>` on `critical`-severity findings requires either (a) a second user's approval in a sidecar file, or (b) an explicit `--single-person-accept` flag that logs a warning.
4. Hash logging: every run records persona-file hashes to `red_team_runs` so operators can diff across runs.

---

## Finding `rt_c2` — Predictive cost gate [critical → v1.1]

**Concern.** The `cycle_cost_usd` budget check fires at the top of each loop iteration. A round that starts at $9.50 / $10 budget can spend $15 before the next check — the cost breaker is post-mortem, not a circuit breaker.

**Why deferred.** v1's budget overruns are bounded and observable: the `halted_budget` state fires *eventually*, runs halt, and the excess cost is recorded in `red_team_runs.cost_usd`. Week 1–2 operational data will tell us how often overruns happen in practice. If they're rare, v1 is fine. If they're frequent, v1.1 ships the predictive gate with data to calibrate it.

**Proposed v1.1 changes:**
1. Before each sub-step (red-team call, regen, inner review loop), estimate max cost using historical averages from `red_team_runs.cost_usd` or Week-0 calibration data.
2. If `cycle_cost_usd + estimated_next_step_cost > per_run_budget_usd`, halt before the next step runs.
3. Split the single budget into two: `red_team_calls_budget_usd` (default $5) for red-team + stability calls alone, and `cycle_budget_usd` (default $20) for the full cascade.

---

## Finding `rt_c3` — PR comment update-in-place contract [high → v1.1]

**Concern.** Round 2's loop posts new comments every round but doesn't specify the update/append semantics. After a 2-round run, a PR has 10+ red-team comments. Resumed runs post more without cleaning up prior rounds. The PR becomes a wall of bot comments.

**Why deferred.** The information is all there; the UX is just noisy. Users can still read the latest comment for each persona and ignore the history. v1 ships with a cluttered-but-functional PR surface.

**Proposed v1.1 changes:** specify the commenting contract in a new §8.1:
1. Each comment includes an HTML marker: `<!-- red-team:run_id={id} round={n} persona={slug} stage={stage} -->`.
2. On new rounds, dispatcher lists existing PR comments via `gh api`, finds matching `(run_id, persona, stage)` with lower round numbers, and edits-in-place to collapse into a `<details>` block, preserving history.
3. Net effect: one visible current comment per persona per stage, expandable history.

Estimated implementation: ~80 lines in `stark_red_team.py` + a new `scripts/gh_comment_manager.py` helper.

---

## Finding `rt_c4` — Interactive vs. automation operating modes [high → v1.1]

**Concern.** `per_run_budget_usd: $10` × daily cron cadence = weekly budget blown in ~5 runs. The red team is priced as "interactive dev tool" but deployed into cron-driven automation. No mode distinction.

**Why deferred.** v1 ships with `stages.design.enabled: true` by default. Operators can **manually opt out** cron triggers by setting `red_team.enabled: false` per-repo or per-trigger until v1.1 delivers the mode split. This is a workaround, but a documentable one.

**Proposed v1.1 changes:** add operating modes to `red_team` config:
```json
{
  "red_team": {
    "modes": {
      "interactive": { "per_run_budget_usd": 20.00, "max_rounds": 2, "stages": { "design": { "enabled": true } } },
      "automation":  { "per_run_budget_usd":  3.00, "max_rounds": 1, "stages": { "design": { "enabled": false } } }
    },
    "default_mode": "interactive"
  }
}
```
The caller detects interactive vs. automation via `stdin.isatty()` + `CI` env var + explicit `--mode` flag. Automation runs default to red-team-off unless an operator explicitly enables it on a per-trigger basis.

**v1 mitigation.** Document the opt-out path in `skill/stark-forge/README.md` and in the `automation/` trigger configs: "to disable red team for a trigger, set `red_team.enabled: false` in `org/evinced/.code-review/config.json` or in the per-repo override."

---

## Finding `rt_c5` — Unbounded text-field caps [high → v1.1]

**Concern.** `red_team_findings` text fields (`concern`, `consequence`, `counter_proposal`, `trade_off`, `reason_for_uncertainty`, `synthesis`) are unbounded TEXT. A hallucinated 100KB counter-proposal inserts fine into SQLite but breaks downstream PR commenting (GitHub's 65536-char limit) and makes persona-tuning queries memory-heavy.

**Why deferred.** In practice, Codex o3 is unlikely to produce multi-KB findings on typical inputs. The failure mode is tail-case. v1 can ship and Week 1–2 data will tell us whether caps are needed urgently.

**Proposed v1.1 changes:**
1. Add length caps in `stark_red_team.py` parse-time validation:
   - `concern`: 400 chars
   - `consequence`: 1200 chars
   - `counter_proposal`: 1200 chars
   - `trade_off`: 600 chars
   - `reason_for_uncertainty`: 600 chars
   - `synthesis`: 2000 chars
2. Overlong fields → truncate with `[...TRUNCATED]` marker + emit `red_team.schema.truncated` event.
3. DB-level `CHECK (length(concern) <= 400)` constraints backstop the parser.

**v1 fallback.** If a finding exceeds GitHub's comment limit during posting, truncate the comment body with a clear marker and post successfully. Don't fail the run on a cosmetic issue.

---

## Finding `rt_c6` — Canonical `run_id` format [medium → v1.1]

**Concern.** `run_id` format is undefined across callers. Cross-skill joins ("total cost of a PR through both `/stark-forge` and `/stark-forged-review`") are unanswerable.

**Proposed v1.1 changes:**
1. Canonical format: `{caller}-{iso8601_utc}-{short_hash}` (e.g., `forge-2026-04-12T10-14-00Z-a1b2c3d`).
2. Add `parent_run_id` nullable column to `red_team_runs` for chaining.
3. Document format in §10 of the design spec.

---

## Finding `rt_c7` — Config complexity onboarding [medium → v1.1]

**Concern.** `red_team` config now has 14+ fields. No minimal "just turn it on" path in the spec.

**Proposed v1.1 changes.** Add two subsections to §6 of the design spec:
- **§6.1 Minimal config for new repos:** a 5-field example that enables the feature with defaults.
- **§6.2 Configuration recipes:** three tagged examples (`interactive-dev-repo`, `cron-automation-repo`, `high-stakes-security-repo`), each a copy-pastable block with a when-to-use paragraph.

No code change — pure docs.

---

## Decision log

- **2026-04-12:** Rounds 1–2 fixed inline; round 3 captured in this backlog and deferred to v1.1.
- **2026-04-12:** Convergence observation recorded — blocker count is stable across rounds but severity drops between round 1 and round 2, then plateaus. The spec's `max_rounds=2` default is now empirically justified by applying the feature to itself.
- **Next review:** reopen this backlog after Week 2 of v1 operation. Re-prioritize based on real calibration data, actual halt rates, and which theoretical gaps materialized in practice.
