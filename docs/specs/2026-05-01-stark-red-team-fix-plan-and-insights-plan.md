# Implementation Plan: stark-red-team v1.2 — Fix Plan + Insights Audit

**Status:** Synthesized (codex base 8.2/10 + claude merges 7.8/10 — within 0.5-pt tie)
**Date:** 2026-05-01
**Design:** [`2026-05-01-stark-red-team-fix-plan-and-insights-design.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-design.md)
**Cross-review summary:** [`2026-05-01-stark-red-team-fix-plan-and-insights-design.d2p-review.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-design.d2p-review.md)

## 1. Overview

Two incremental tracks:

- **Track A (stark-skills, this repo):** Phases 1–7 + 9–11 add the gated `gpt-5.5-pro` xhigh fix-plan call, the local SQLite migration, the insights event emission helpers, the backfill CLI, sidecar/PR-comment rendering, and the calibration → enable rollout. Ships with `fix_plan.enabled: false`.
- **Track B (stark-insights, separate repo):** Phase 8 registers the three new event types in `PAYLOAD_SCHEMAS` AND adds lifter rules. Track B can DEVELOP in parallel with Track A, but **Track B MUST DEPLOY before any forward emission of `red_team_*` events drains to cloud** — `EventEnvelope.model_validate` rejects unknown event types with `ValueError`, so producer-first is unsafe. The deployment order is enforced by Phase 11 Task 1 (Phase 8 deployed + smoke-tested) being a hard prerequisite of Task 6 (post-flip PR) AND of any calibration override that targets a non-localhost stark-insights endpoint.

Invariants the implementation MUST preserve:
- The skill's exit code, terminal status, sidecar banner, and `red_team_runs.final_status` derive ONLY from the challenge call's `RedTeamResult`. Fix-plan success/failure changes only `fix_plan_status` and the `## Proposed Fix Plan` section. (Resolves design rt3.)
- `fix_plan.enabled`, `model`, `reasoning_effort`, `min_moves`, `max_moves` are LOCKED — no repo-level override.
- No schema migration on `events` table in stark-insights. Lifters only.
- Local SQLite migration is additive and idempotent across fresh / v1.0 / v1.1 / v1.2 / partially-migrated DBs.

## 2. Prerequisites

### 2.1 Phase 0 — Blank-slate bootstrap (resolves round-1 critical: install never installed runtime)

`./install.sh --status` only REPORTS state — it does not create symlinks, the scripts venv, the prompt install paths, or the audit/queue DBs. From a clean machine, every later phase that loads a prompt via `~/.claude/code-review/prompts/...` or queries `~/.stark-insights/queue.db` will fail. Run actual install + DB initialization first:

```bash
cd /Users/aryeh/Code/Playground/stark-skills

# Repo state
git status --short
git rev-parse --abbrev-ref HEAD     # work on feat/red-team-fix-plan-and-insights

# Local tools
python3 --version    # 3.12+
gh auth status
sqlite3 --version
test -n "$OPENAI_API_KEY" || (echo "OPENAI_API_KEY not set; required for Responses API" && exit 1)

# Actual install: install.sh symlinks files but does NOT create scripts/.venv —
# the venv is the dispatcher's runtime interpreter and must be provisioned
# explicitly. There is no requirements.txt; install.sh's `_check_venv` warns
# with the canonical pip command (see scripts/.venv check at install.sh:70).
./install.sh
if [ ! -x scripts/.venv/bin/python3 ]; then
  python3 -m venv scripts/.venv
  scripts/.venv/bin/pip install --quiet --upgrade pip
  scripts/.venv/bin/pip install --quiet PyJWT requests anthropic google-auth
fi
./install.sh --status     # NOW it should report green (or specific drift identified)

# Verify the runtime paths the rest of the plan depends on
test -x ~/.claude/code-review/scripts/.venv/bin/python3 || (echo "venv missing"; exit 1)
test -d ~/.claude/code-review/prompts/red-team || (echo "prompts not symlinked"; exit 1)
test -d ~/.claude/skills/stark-red-team-design || (echo "skills not symlinked"; exit 1)

# Initialize the audit DB so Phase 3 has a place to migrate
~/.claude/code-review/scripts/.venv/bin/python3 -c "
import sys; sys.path.insert(0, '/Users/aryeh/Code/Playground/stark-skills/scripts')
import red_team_audit as a
a.init_red_team_tables(a.DEFAULT_DB_PATH)
print('audit db ready')
"

# Initialize the insights queue DB (lazy-init on first enqueue but easier to verify upfront)
~/.claude/code-review/scripts/.venv/bin/python3 -c "
import sys; sys.path.insert(0, '/Users/aryeh/Code/Playground/stark-skills/scripts')
import emit_queue as q
q._get_db().close()
print('queue db ready')
"
ls ~/.stark-insights/queue.db
ls ~/.claude/code-review/history/forged-review/forged_review_metrics.db

# stark-insights repo (Track B)
test -d /Users/aryeh/Code/Playground/stark-insights \
  || git clone https://github.com/Evinced/stark-insights.git /Users/aryeh/Code/Playground/stark-insights
export STARK_INSIGHTS_REPO=/Users/aryeh/Code/Playground/stark-insights

# Baseline: existing tests pass before edits
python3 -m pytest scripts/test_stark_red_team.py scripts/test_red_team_audit.py
```

### 2.2 Phase 8 prerequisite gate — auth + service registry

**This MUST be answered before Phase 4 producer code merges.** Phase 8 cannot run in parallel without resolving these (round-1 critical: lifters alone won't ingest unknown event types):

- **stark-insights authenticated event POST path:** locate the existing API client (`$STARK_INSIGHTS_REPO/src/stark_insights/api/events.py` confirms the endpoint is `POST /events`; auth lives in `~/.stark-insights/api-token` per the existing service token convention). Document one successful authenticated POST against a non-prod / staging stark-insights instance.
- **`PAYLOAD_SCHEMAS` registry update:** stark-insights `EventEnvelope.model_validate` REJECTS unknown event types with `ValueError("Unknown event type: ...")` — verified at `src/stark_insights/models.py`. The new types (`red_team_run`, `red_team_finding`, `red_team_fix_plan`) MUST be added to `PAYLOAD_SCHEMAS` (Phase 8 Task 1) BEFORE producer events drain. There is NO producer-first deployment safety net; events without registered types fail at the API and dead-letter after 5 retries.
- **`EVENT_PRIORITY` map** (`src/stark_insights/db/buffer.py`): add the three new types with explicit priorities (e.g., `red_team_run: 4`, `red_team_finding: 4`, `red_team_fix_plan: 4`) so they're not silently bucketed at `DEFAULT_EVENT_PRIORITY=2` for buffer eviction.
- **launchd service label:** the actual installed service label (not `com.evinced.stark-insights`-by-assumption — verify via `launchctl list | grep stark`). Document the discovered label for Phase 11 Task 5.

## 3. Phases

### Phase 1: Config, Prompt, And Event-Type Foundations

**Goal:** Add the disabled-by-default configuration surface, locked-field hardening, fix-plan prompt, and event type registration. No runtime behavior change yet.

**Dependencies:** none

**Estimated effort:** M

#### Tasks

1. **Add fix-plan config defaults** — `global/config.json` AND `scripts/config_loader.py:DEFAULT_RED_TEAM`:
   - Bump `red_team.per_run_budget_usd` from `15.00` to `30.00`.
   - Add the COMPLETE `red_team.fix_plan` section. **All seven keys are required** — `model` is consumed in Phase 2 Task 5 and Phase 5 Task 2; omitting it raises `KeyError` on the first enabled run:
     ```json
     "fix_plan": {
       "enabled": false,
       "model": "gpt-5.5-pro",
       "reasoning_effort": "xhigh",
       "timeout_s": 1200,
       "min_moves": 2,
       "max_moves": 6,
       "max_input_chars": 200000
     }
     ```
   - The default-merge in `config_loader.get_red_team_config()` MUST include all seven keys so older configs still resolve `cfg["fix_plan"]["model"]` correctly.
   - **Done when:** unit test loads a pre-v1.2 config (no `fix_plan` section), calls `get_red_team_config()`, and asserts `cfg["fix_plan"]["model"] == "gpt-5.5-pro"` and all seven keys present with documented defaults.

2. **Promote locked fields to dotted-path tuples** — `scripts/config_loader.py`:
   - Change `_RED_TEAM_LOCKED_FIELDS: frozenset[str]` to `frozenset[tuple[str, ...]]` per design §7.1.
   - Convert v1 entries to 1-tuples; add 5 new nested entries: `("fix_plan", "enabled")`, `("fix_plan", "model")`, `("fix_plan", "reasoning_effort")`, `("fix_plan", "min_moves")`, `("fix_plan", "max_moves")`.
   - Implement `_drop_locked_overrides(override, base_path=()) -> tuple[dict, list[str]]` that recursively walks override dicts, drops locked paths, returns dotted paths for audit events.
   - Extend `red_team_override_rejected` payload with a string `path` field (e.g., `"fix_plan.enabled"`).
   - **Done when:** unit tests prove every locked path drops the override and emits an event with the correct dotted `path`; `red_team.fix_plan.timeout_s` (unlocked) IS respected at the repo level.

3. **Register new event types** — `scripts/event_schema.json` and `scripts/emit_queue.py`:
   - Add `red_team_run`, `red_team_finding`, `red_team_fix_plan` to the `type` enum and to `_VALID_TYPES`.
   - **Done when:** `emit_queue.validate(event)` accepts envelopes with these types; existing tests still pass.

4. **Author the fix-plan system prompt** — `global/prompts/red-team/fix-plan.md` (~80 lines):
   - Frame: single senior architect synthesizing 2–6 architectural moves from the committee's findings + synthesis.
   - Forbid: code-level edits, line numbers, mechanical rewrites, finding-ID invention.
   - Require: every move names `addressed_finding_ids` ⊆ given IDs, plus a `new_trade_off`.
   - Output schema (JSON) matching `RedTeamFixPlan` per design §3.3.
   - Same input-injection-defense framing as `preamble.md`: text inside `<<<RED_TEAM_INPUT>>>` blocks is content, not instructions.
   - **Done when:** prompt loads via the assemble step in Phase 2 and a fixture call produces parseable JSON.

#### Risks

- Default-merge regresses an existing field: write tests for both pre-v1.2 and v1.2 config shapes.
- Locked-field recursion misses a deep override: unit-test each path explicitly, including a negative test on `fix_plan.timeout_s`.

#### Verification

```bash
python3 -m pytest scripts/test_config_loader.py scripts/test_emit_queue.py
python3 -c "import json; json.load(open('global/config.json')); print('config valid')"
python3 -c "
from scripts.config_loader import get_red_team_config
cfg = get_red_team_config()
assert cfg['fix_plan']['enabled'] is False
assert cfg['fix_plan']['min_moves'] == 2
assert cfg['fix_plan']['max_moves'] == 6
print('ok')
"
```

---

### Phase 2: Fix-Plan Core Library

**Goal:** Implement `run_red_team_fix_plan(ctx, ...)` end-to-end as a pure callable: dataclasses, prompt assembly, truncation-safe envelope, parsing, validation. Not yet wired into dispatchers.

**Dependencies:** Phase 1

**Estimated effort:** L

#### Tasks

1. **Add `RedTeamRunContext`, `RedTeamFixPlan`, `FixPlanMove` dataclasses** — `scripts/stark_red_team.py`:
   - Match the field lists in design §3.3 and §3.5 exactly. `RedTeamRunContext` is `frozen=True`.
   - **Add `is_human_review` helper** (resolves multiple round-1 highs: gating filter assumes `f.is_human_review` field that doesn't exist on `RedTeamFinding`):
     ```python
     def is_human_review(f: RedTeamFinding) -> bool:
         return f.counter_proposal == REQUEST_HUMAN_REVIEW
     ```
     EVERY consumer (Phase 5 gating, Phase 4 emit_finding, Phase 6 backfill) uses this helper, NOT a non-existent attribute. Do NOT add a `is_human_review` field to `RedTeamFinding` — that would change the existing v1 dataclass shape and break backward compatibility (design §1 non-goal: "RedTeamResult schema unchanged").
   - **Done when:** dataclasses import and round-trip via `asdict`; `is_human_review` helper has unit-test coverage for both branches.

2. **Implement `serialize_findings_envelope(findings, max_chars) -> (envelope_json, omitted_ids, fits_safely)`** — design §3.2.1:
   - Sort findings: severity desc, then `is_human_review(f)` asc (using the helper), then `id`.
   - Greedy-add; when over budget, omit and record ID.
   - Output the documented `{ "truncated": bool, "omitted_finding_ids": [...], "findings": [...] }` shape.
   - `fits_safely = no blocking finding omitted`.
   - **Done when:** unit test with 50 findings totaling 300 KB produces parseable JSON, populated `omitted_finding_ids`, and `fits_safely=False` only when a blocking finding was dropped.

3. **Implement `assemble_fix_plan_prompt(stage, artifact, source_spec, findings, synthesis, max_input_chars)`**:
   - Loads `global/prompts/red-team/fix-plan.md`, then 4 wrapped inputs in the order from design §3.2: artifact, source_spec, findings_envelope (from task 2), synthesis.
   - Same `_escape_delimiters` and SHA-256 tagging as v1's `assemble_prompt`.
   - **Done when:** the assembled prompt round-trips through delimiter parsing without injection bypass; fixture asserts artifact and findings appear inside their respective `<<<RED_TEAM_INPUT>>>` blocks.

4. **Implement `parse_fix_plan_output(raw)` and `validate_fix_plan(raw_dict, blocking_finding_ids, cfg)`**:
   - `parse_fix_plan_output`: best-effort JSON extraction (parallel to v1's `parse_output` — direct, fenced, first-curly fallback).
   - `validate_fix_plan` per design §3.4:
     - Move count: `len < min_moves` → hard `error`. `min_moves ≤ len ≤ max_moves` → success. `max_moves < len ≤ max_moves * 2` → prune to top `max_moves` ranked by `len(addressed_finding_ids)` desc, append `move_cap_hit` warning, recompute coverage. `len > max_moves * 2` → hard `error`.
     - Per-move validation: required string fields non-empty; `sections_touched` and `addressed_finding_ids` are lists (may be empty).
     - Invented IDs (in `addressed_finding_ids` ∉ `blocking_finding_ids`): drop from move, append `ids_invented` warning. If a move has zero remaining IDs and zero `sections_touched`, drop the move.
     - **Post-drop re-check (design §3.4 invariant):** after invented-ID drop AND post-prune coverage recomputation, if `len(moves) < min_moves`, demote to hard `error`. Min violations are NEVER auto-padded.
     - Coverage rules per design §3.4 step 1–5: `addressed = ∪{move.addressed_finding_ids}`, then derive `unaddressed_finding_ids` and `orphan_finding_ids` separately.
     - Per-field length caps: `title ≤ 200`, `rationale ≤ 1000`, `new_trade_off ≤ 500`, `summary ≤ 1000`, `notes ≤ 3000`, `sections_touched ≤ 20 entries × 100 chars`. Over-cap → truncate with `...[CAP]` marker, append `field_capped` warning.
     - **Move ID uniqueness:** collisions get suffixed (`m2`, `m2_dup` → `m2`, `m3`).
   - Validation NEVER raises — invalid plans land on `error`, dispatcher handles rendering.
   - **Done when:** unit tests cover move counts `0, 1, 2, 6, 7, 12, 13`; invented-ID drop pushing below min → hard error; field-cap truncation; orphan detection; duplicate move IDs.

5. **Implement `run_red_team_fix_plan(ctx, *, artifact, source_spec, challenge_findings, synthesis, challenge_cost_usd) -> RedTeamFixPlan`**:
   - Filter human-review findings out of `challenge_findings` (per design §3.1) using `[f for f in challenge_findings if not is_human_review(f)]`.
   - Call `serialize_findings_envelope(filtered, max_input_chars)` — if `fits_safely is False`, return early with `error="findings JSON cannot be safely truncated"` so the dispatcher maps this to `skipped_input_too_large`. (Document that this is the decision point: dispatcher gate calls a thin preflight helper that just runs `serialize_findings_envelope`; if `fits_safely`, dispatcher then calls `run_red_team_fix_plan` which re-uses the envelope. Avoids double-serialization but keeps the gate decision in the dispatcher.)
   - Validate `model in RESPONSES_API_MODELS` (xhigh requires it); if not, return `error`.
   - Dispatch via `dispatch_responses_api(prompt, model=ctx.cfg_red_team["fix_plan"]["model"], timeout_s=ctx.cfg_red_team["fix_plan"]["timeout_s"], reasoning_effort=ctx.cfg_red_team["fix_plan"]["reasoning_effort"], env=ctx.env, max_output_tokens=_RESPONSES_API_DEFAULT_MAX_OUTPUT_TOKENS)`.
   - **Explicit verification:** unit test asserts `max_output_tokens=32768` is actually passed through to the Responses API call (resolves claude→codex review's risk-coverage gap on the worst-case ceiling).
   - On success: `parse_fix_plan_output` → `validate_fix_plan` → populate `cost_usd` via `_resolve_rates` + `_cost_for`.
   - **Done when:** integration test with a mocked Responses API client returns the documented dataclass for success, error, and validation-failure paths; the `max_output_tokens` argument is asserted in the mock call.

6. **Centralize the safe-serialization helper** (resolves codex→claude review's "fits_safely ambiguous between dispatcher and run_red_team_fix_plan"):
   - Expose `preflight_findings_envelope(findings, max_chars) -> (envelope_str, fits_safely, omitted_ids)` so dispatcher and core share one decision.
   - Dispatcher uses the result to decide skip-vs-dispatch; on dispatch, the core re-uses the same envelope.
   - **Done when:** no double serialization happens; unit test confirms identical envelope between dispatcher's preflight and core's prompt assembly.

#### Risks

- Move-count validation order matters: prune-then-recheck must be deterministic. Mitigation: sort raw moves by output order before pruning so two equivalent inputs produce identical output.
- xhigh on a non-Responses-API model would silently downgrade — guarded by §3.5's RESPONSES_API_MODELS check.

#### Verification

```bash
python3 -m pytest scripts/test_red_team_fix_plan.py -v
```

---

### Phase 3: SQLite Audit Migration And Persistence

**Goal:** Make local audit storage v1.2-compatible with additive idempotent migration and persistent fix-plan data.

**Dependencies:** Phase 2 (for `RedTeamFixPlan` JSON shape)

**Estimated effort:** M

#### Tasks

1. **Extend `red_team_runs` columns** — `scripts/red_team_audit.py:init_red_team_tables`:
   - Use `PRAGMA table_info(red_team_runs)` to introspect, then `ALTER TABLE` for any missing columns:
     - `repo TEXT`
     - `artifact_relative_path TEXT`
     - `pr_number INTEGER`  ← **resolves codex→claude review concern about pr_number consistency**: persist locally so backfill can include it; forward emission also reads from ctx
     - `fix_plan_status TEXT`
     - `fix_plan_md TEXT`
     - `fix_plan_json TEXT`
     - `fix_plan_cost_usd REAL`
   - Fresh-DB `CREATE TABLE` matches the migrated shape exactly.
   - **Done when:** migration is idempotent on fresh / v1.0 / v1.1 / v1.2 / partially-migrated (kill-mid-ALTER simulated) DBs. Each test asserts final schema bytes match.

2. **Update `record_red_team_run`** — accept new optional kwargs (`repo`, `artifact_relative_path`, `pr_number`, `fix_plan_status="pending"` default for v1.2 callers); use explicit column names in `INSERT`; older callers (v1) still work because all new params default `None` (or `"pending"` for status).
   - The v1.2 dispatcher always calls `record_red_team_run` with `fix_plan_status="pending"` at step 5.1 of the Phase 5 ordering, then calls `record_fix_plan` at step 5.5 to update `fix_plan_status` to the resolved value. This two-step write means a crash leaves the row visible to backfill recovery.
   - **Done when:** existing v1 caller test still passes; new test inserts a row with all v1.2 fields and round-trips; a test asserts the "pending" sentinel survives a crash-and-recover cycle via `--scope=forward` backfill.

3. **Add `record_finding` helper** — INSERT into the existing `red_team_findings` table (already created by v1's `init_red_team_tables`). Used by Phase 5 Task 7 step 2 to durably record a finding before its event is emitted:
   ```python
   def record_finding(
       *,
       run_id: str,
       stage: str,
       round_num: int,
       finding_id: str,
       persona: str,
       severity: str,
       concern: str,
       consequence: str,
       counter_proposal: str,
       trade_off: str | None,
       reason_for_uncertainty: str | None,
       db_path: str | None = None,
   ) -> None:
       """INSERT INTO red_team_findings (...) — explicit columns; commits."""
   ```
   - **No new table** — the v1 `red_team_findings` table already exists and has the right columns.
   - **Done when:** integration test inserts then SELECTs a finding row; an `emit_finding` test that runs after `record_finding` proves the durable row exists with the same `(run_id, finding_id)` keys used in the event payload.

4. **Add `record_fix_plan` helper** — UPDATE keyed by `run_id`. Always called for every dispatcher invocation (success, error, skipped — see Phase 5 Task 7 ordering):
   ```python
   def record_fix_plan(
       run_id: str,
       *,
       fix_plan_md: str | None,
       fix_plan_json: str | None,
       fix_plan_cost_usd: float | None,
       fix_plan_status: str,                   # "success" | "error" | "skipped_*"
       db_path: str | None = None,
   ) -> None:
       """UPDATE red_team_runs SET fix_plan_md=?, fix_plan_json=?, fix_plan_cost_usd=?, fix_plan_status=?
          WHERE run_id=? — assert rowcount == 1."""
   ```
   - Persist `fix_plan_json` as the validated `RedTeamFixPlan` dict serialized via `json.dumps(asdict(plan))` MINUS `raw_output` (which can echo attacker content). For skipped/error paths, `fix_plan_json` is `NULL`.
   - **Done when:** JSON round-trips via `json.loads`; `dataclass(**parsed)` reconstructs the validated plan with all fields; UPDATE asserts `rowcount == 1` and raises a clear error if the parent `red_team_runs` row is missing; the helper accepts and persists every documented `fix_plan_status` value.

#### Risks

- Mid-migration process kill: per-column gating handles it. Explicit test simulates the partial state.
- `fix_plan_json` size growth on pathological plans: per-field caps from Phase 2 keep this bounded.

#### Verification

```bash
python3 -m pytest scripts/test_red_team_audit.py -v
```

---

### Phase 4: Insights Event Emission

**Goal:** Add red-team event envelope builders that enqueue durable stark-insights events without ever affecting skill success or failure.

**Dependencies:** Phases 1 and 3.

**Note:** Phase 8 (stark-insights `PAYLOAD_SCHEMAS` + lifters) can DEVELOP in parallel with this phase as soon as the §5.2 canonical payload schemas are locked. **It must DEPLOY before any forward-emission events from Track A drain to cloud** — `EventEnvelope.model_validate` rejects unknown event types. Track B deployment is enforced by Phase 11 Task 1 as a hard prerequisite of any post-Phase-8-required Track A operation. (See §4 Integration Points and Phase 8 header for the canonical statement.)

**Estimated effort:** M

#### Tasks

1. **Create `scripts/red_team_insights.py`** with envelope builders + emitters. Split into pure builders (accept primitives) plus thin wrappers over `emit_queue.enqueue` so the same builders serve both forward emission AND backfill (resolves codex→claude review concern):
   ```python
   # Pure builders — accept primitives, return envelopes:
   def build_run_envelope(*, run_id, stage, repo, artifact_relative_path, pr_number,
                          model, caller, final_status, worst_severity, passed,
                          rounds_used, total_findings, blocking_count, human_review_count,
                          critical_count, high_count, medium_count, duration_s, cost_usd,
                          fix_plan_status, warnings, started_at_iso) -> dict: ...
   def build_finding_envelope(*, run_id, stage, repo, pr_number, round_num, finding_id,
                              persona, severity, concern, consequence, counter_proposal,
                              trade_off, reason_for_uncertainty, is_human_review,
                              timestamp_iso) -> dict: ...
   def build_fix_plan_envelope(*, run_id, stage, repo, pr_number, model, reasoning_effort,
                               summary, notes, moves, move_count, addressed_finding_ids,
                               unaddressed_finding_ids, orphan_finding_ids,
                               input_truncated, input_omitted_finding_ids, warnings,
                               cost_usd, duration_s, input_tokens, output_tokens,
                               fix_plan_md, timestamp_iso) -> dict: ...

   # Wrapper emitters — derive primitives from ctx + result objects, then enqueue:
   def emit_run(ctx, *, result, fix_plan_status, run_warnings) -> None: ...
   def emit_finding(ctx, *, finding, round_num) -> None: ...
   def emit_fix_plan(ctx, *, fix_plan, fix_plan_md) -> None: ...
   ```
   - **Wrapper emitters wrap `enqueue` in `try/except: log+continue`** matching `_emit_plan_dispatch_events` in `plan_review_dispatch.py`.
   - **Done when:** forced `enqueue` exception in test does not change dispatcher status or sidecar; pure builders are tested independently of `enqueue`.

2. **Implement payload contracts per design §5.2** — exact field-by-field match. Specific contract details:
   - `worst_severity`: maps to `"critical" | "high" | "medium" | None`. **Never the string `"clean"`** — clean runs use `null` severity + `passed: true`.
   - `repo`: `"unknown"` (string) when not detected — never NULL. `pr_number`: NULL when no open PR.
   - `red_team_run.warnings`: ALWAYS present (empty list `[]` for runs with no warnings) — forward-compat for clients that expect the field.
   - `red_team_fix_plan` event ONLY emitted on `fix_plan_status == "success"`; failure paths land on `red_team_run.fix_plan_status` instead.
   - `red_team_fix_plan` event includes the full `moves` array AND the rendered `fix_plan_md`. (Both — moves for structured queries, md for human-rendered downstream tools.)
   - **Done when:** `scripts/test_red_team_insights.py` asserts each envelope matches the §5.2 example field-by-field.

3. **Centralize dedupe-key construction** — single helper:
   ```python
   _DEDUPE_PREFIXES = {"run", "finding", "fix_plan"}
   def make_dedupe_key(kind: str, *, stage: str, run_id: str, round_num: int | None = None,
                       finding_id: str | None = None) -> str: ...
   ```
   - Forward emission and backfill (Phase 6) MUST use this single helper. Diverging dedupe keys would break idempotency.
   - **Done when:** Phase 6 backfill tests prove forward and backfill keys are byte-identical for the same logical row.

4. **Tests** — `scripts/test_red_team_insights.py`:
   - Envelope shape per §5.2 (asserted field-by-field for each event type).
   - Dedupe-key stability across re-builds.
   - `repo` fallback to `"unknown"`.
   - No `red_team_fix_plan` envelope emitted when `fix_plan_status != "success"`.
   - Exception isolation: forced `enqueue` raise does not propagate.
   - Envelope passes `event_schema.json` validation (when the JSON-schema validator is present; otherwise lightweight in-script validation).

#### Risks

- Producer/lifter contract drift: keep the canonical `_LIFT_RULES` mapping and the §5.2 examples in lock-step via shared test fixtures.
- Empty-warnings forward-compat: include `warnings: []` even when empty so downstream consumers can filter unconditionally.

#### Verification

```bash
python3 -m pytest scripts/test_red_team_insights.py scripts/test_emit_queue.py -v
```

---

### Phase 5: Dispatcher Integration And Rendering

**Goal:** Thread `RedTeamRunContext` through both dispatchers, gate the fix-plan call, render the sidecar section, persist audit fields, and emit insights events.

**Dependencies:** Phases 2–4.

**Estimated effort:** L

#### Tasks

1. **Construct shared `RedTeamRunContext` once** at dispatcher start — both `red_team_design_dispatch.py` and `red_team_plan_dispatch.py`:
   - Populate `run_id` (existing `manual-{uuid4.hex[:12]}` pattern), `stage`, `caller="manual"`, `repo` (via `git rev-parse --show-toplevel` + `gh repo view --json nameWithOwner`, fallback `"unknown"`), `artifact_relative_path` (relativized when repo detected, else `None`), `cwd`, `env` (see below), `model_rates` (from config), `cfg_red_team`, `per_run_budget_usd`, `pr_number` (from `gh pr view`), `started_at_iso`.
   - **`env` construction is allowlist-based but MUST preserve the OpenAI key** (resolves round-2 high: `ctx.env` could strip the OpenAI key needed by Responses API). Use `runtime_env.build_agent_env(...)` per the v1 pattern, then explicitly merge in `OPENAI_API_KEY` and the `OPENAI_API_KEY_FILE` / `OPENAI_API_KEY_LABEL` pair from `os.environ` if any are set. Add a sanity assertion at construction time: `_resolve_openai_api_key(ctx.env)` must return non-None for any code path that will reach `dispatch_responses_api`. If it doesn't, fail fast with a clear error before the run starts.
   - Pass the same `ctx` to: challenge call, fix-plan call, audit row writes, all three insights emit functions.
   - **Done when:** integration test asserts byte-identical `(run_id, stage, repo, artifact_relative_path, pr_number, model_rates)` across the challenge transport call, fix-plan transport call, `red_team_runs` row write, and the three emitted envelopes; AND a separate test asserts `_resolve_openai_api_key(ctx.env)` returns the same key as `_resolve_openai_api_key(os.environ)` (resolves design §3.5 + rt2).

2. **Add fix-plan gating** — implement the design §3.1 sequence (with the round-1 fixes for `is_human_review` helper, `fix_plan.model` already-present default, and the runtime kill switch):
   ```python
   import os
   from stark_red_team import is_human_review

   if os.environ.get("STARK_RED_TEAM_FIX_PLAN_KILL", "").lower() in ("1", "true", "yes"):
       fix_plan_status = "skipped_kill_switch"   # emergency override (see §6 Rollback)
   elif not ctx.cfg_red_team["fix_plan"]["enabled"] and not args.enable_fix_plan_for_calibration:
       fix_plan_status = "skipped_disabled"
   elif challenge.error is not None:
       fix_plan_status = "skipped_challenge_error"
   elif challenge.blocking_count == 0 and challenge.human_review_count > 0:
       fix_plan_status = "skipped_human_review_only"
   elif challenge.blocking_count == 0:
       fix_plan_status = "skipped_clean"
   elif challenge.cost_usd >= ctx.per_run_budget_usd:
       fix_plan_status = "skipped_budget_exhausted"
   else:
       envelope_str, fits_safely, _omitted = preflight_findings_envelope(
           [f for f in challenge.findings if not is_human_review(f)],
           ctx.cfg_red_team["fix_plan"]["max_input_chars"],
       )
       if not fits_safely:
           fix_plan_status = "skipped_input_too_large"
       else:
           fix_plan = run_red_team_fix_plan(ctx, ...)
           fix_plan_status = "success" if fix_plan.error is None else "error"
   ```
   - Add CLI-only flag `--enable-fix-plan-for-calibration` that bypasses ONLY the `enabled: false` check. Emit `red_team.fix_plan.calibration_override` to stderr once when active. NOT exposed through the skill argument parsing — dispatcher CLI only.
   - **Kill-switch env var `STARK_RED_TEAM_FIX_PLAN_KILL`** (resolves round-1 high: locked `enabled` has no fast incident-response path; round-2 critical: clarify why this is not a lock-bypass).
     - **Threat-model distinction.** `_RED_TEAM_LOCKED_FIELDS` prevents *committed config* (`org.json` / repo `.code-review/config.json`) from silently weakening the substance review — it defends against accidental or malicious commits that would persist across operators. The env var is *per-process, per-machine, operator-controlled* — it does not modify any config file, leaves no committed artifact, and has no fleet-wide effect. These are distinct concerns: locks prevent persistent silent weakening; the kill switch enables in-band incident response. Both are required for a paid, externally-visible feature.
     - **Audit trail.** When the kill switch fires:
       - Emit a `red_team.fix_plan.kill_switch_active` warning to stderr once per process.
       - Append the warning to `red_team_run.payload.warnings`, so an operator-initiated bypass shows up in the cloud `events` table alongside the still-emitted `red_team_run` event (the challenge call still runs and still emits).
       - The `red_team_runs.fix_plan_status='skipped_kill_switch'` value is the durable local audit record.
     - Document in Phase 7 SKILL.md and §6 Rollback as the in-band emergency disable. Document the audit trail explicitly so security review has a clear answer to "how do we know who turned it off?"
   - **Done when:** default config always lands on `skipped_disabled`; calibration flag enables real exercise; each skip status (including the new `skipped_kill_switch`) reaches the documented branch and is asserted by tests; tests prove the env-var override fires regardless of `enabled: true` in config.

3. **Compute and append `over_budget_after_fix` warning** (resolves gemini→codex review's missing post-call check):
   - After `run_red_team_fix_plan` returns and before emit_run, compute:
     ```python
     run_warnings = []
     if fix_plan and fix_plan.error is None:
         total = challenge.cost_usd + fix_plan.cost_usd
         if total > ctx.per_run_budget_usd:
             run_warnings.append("over_budget_after_fix")
             fix_plan.warnings.append("over_budget_after_fix")
             print(f"warn: total cost ${total:.2f} exceeds budget ${ctx.per_run_budget_usd:.2f}", file=sys.stderr)
     ```
   - The warning lands BOTH on `red_team_run.payload.warnings` AND on `red_team_fix_plan.payload.warnings` so dashboards filtering on either event type surface the signal.
   - **Done when:** test asserts the warning appears on both event payloads when total cost exceeds budget, and is absent otherwise.

4. **Update `render_sidecar_markdown`** — append `## Proposed Fix Plan` section (success / error / each skip status) per design §4.1. Implement untrusted-content escape rules:
   - Hard length caps already enforced in Phase 2's `validate_fix_plan` — renderer trusts the validated plan.
   - Wrap `rationale`, `notes`, `new_trade_off` in fenced ```text blocks when content contains ```` ``` ````, raw HTML opening tags (`<\w+`), or 4+ consecutive backticks.
   - `title` rendered inline; inline backticks escaped as `\\\``.
   - `addressed_finding_ids` and `orphan_finding_ids` rendered as backticked lists; only `rt\d+`-pattern IDs pass through (defense-in-depth — validator already drops malformed IDs).
   - Total fix-plan section capped at 12 KB; over-cap → truncate with `[TRUNCATED — see local SQLite fix_plan_json]`.
   - **Error template includes the retry hint** (resolves gemini→codex review):
     ```markdown
     ## Proposed Fix Plan

     **Status:** error — {error}
     **Cost / duration:** ${cost} / {duration}s

     The fix-plan call failed. Findings above are still valid. Re-run with
     `--no-pr-comment` to retry locally without re-posting the PR comment.
     ```
   - **Done when:** rendering tests pass for code-fence injection, raw HTML, 4+ backticks, very-long titles, very-long notes, malformed IDs, AND the cap truncation.

5. **PR-comment truncation algorithm (explicit)** — `red_team_design_dispatch.py` and `red_team_plan_dispatch.py`:
   ```python
   GH_COMMENT_LIMIT = 65_536  # GitHub PR comment size limit (chars)

   def truncate_pr_comment(body: str, fix_plan: dict | None) -> str:
       if len(body) <= GH_COMMENT_LIMIT:
           return body
       # Step 1: truncate `notes` to empty.
       body = re.sub(r"### Notes\n.*?(?=\n##|\Z)", "### Notes\n[TRUNCATED — see sidecar]\n", body, flags=re.S)
       if len(body) <= GH_COMMENT_LIMIT:
           return body
       # Step 2: truncate each move's rationale to 200 chars.
       body = re.sub(r"(\*\*Rationale\.\*\* )(.{200})[^\n]*", r"\1\2 [TRUNCATED]", body)
       if len(body) <= GH_COMMENT_LIMIT:
           return body
       # Step 3: hard-truncate body and append marker.
       return body[: GH_COMMENT_LIMIT - 80] + "\n[TRUNCATED — see sidecar for full content]"
   ```
   - **Done when:** test fixture with a 70 KB body lands at exactly ≤ 65 536 after the cascade; each step's marker is present.

6. **Update sidecar commit message** per design §4.3:
   ```
   docs(red-team): findings + fix plan for $(basename design.md)

   3 findings (3 blocking, 0 human-review)
   Fix plan: 2 moves addressing rt1, rt2, rt3   # OR: "skipped (clean)" / "error (timeout)"
   Model: gpt-5.5-pro (challenge: high; fix-plan: xhigh) · Run: <run_id>
   ```
   - **Done when:** test for clean / skipped / error / success commit message bodies all match the documented format.

7. **Wire emit_* timing precisely — emit AFTER local audit writes commit** (resolves round-1 high + round-2 highs: insights emission must be sequenced after durable audit writes for ALL paths, including skipped/error):
   - **Order of operations** (top-to-bottom, no skipping; applies to success, skip, and error paths):
     1. `record_red_team_run(...)` inserts the parent `red_team_runs` row with `final_status` from challenge (NEVER mutated again) AND a provisional `fix_plan_status="pending"` (mutated in step 5). Commits before any emission. **Always runs**, even when the fix-plan call will be skipped. **Invariant clarification:** `final_status` is challenge-derived and immutable after this insert; `fix_plan_status` is a SEPARATE column whose state machine (`pending → resolved`) is orthogonal to the design §10 invariant about `final_status`. The two columns must not be conflated in code or in queries.
     2. `record_finding(...)` for each challenge finding into a (Phase 3 task: also add) `red_team_findings` insert. Commits.
     3. `emit_finding(ctx, finding=f, round_num=1)` fires for each finding (durable local row already exists, so backfill recovery has a source-of-truth).
     4. Run the fix-plan gate (Task 2). Resolve `fix_plan_status` to one of: `success` / `error` / `skipped_*`.
     5. `record_fix_plan(run_id, fix_plan_md=..., fix_plan_json=..., fix_plan_status=<resolved>, fix_plan_cost_usd=...)`. **Always called**, even for skip paths (in which case `fix_plan_md = None`, `fix_plan_json = None`, `fix_plan_cost_usd = None`, but `fix_plan_status` is the resolved skip value). Assert `cursor.rowcount == 1` to catch missing parent row. (Resolves round-2 high: skipped fix-plan statuses never persisted locally.)
     6. If `fix_plan_status == "success"`: `emit_fix_plan(ctx, fix_plan=..., fix_plan_md=...)`.
     7. `emit_run(ctx, result=challenge, fix_plan_status=<resolved>, run_warnings=<...>)` LAST — only by then are `fix_plan_status` and `over_budget_after_fix` accurate.
   - **Crash-safety:** if the dispatcher crashes between step 1 and step 7, the local `red_team_runs` row exists with `fix_plan_status="pending"` (or the resolved value if step 5 ran). Phase 6 backfill `--scope=forward` matches `fix_plan_status NOT IN ('absent_pre_v1_2')` and re-emits from the surviving local rows; cloud-side dedupe protects against duplicates. The "pending" sentinel signals an incomplete run; an extra `--scope=incomplete` flag (or just including pending under `forward`) lets the operator resume.
   - **Forward-emission timestamps** (resolves round-2 high: forward and backfill timestamps not byte-identical): every Phase 4 envelope builder uses `ctx.started_at_iso` as the `timestamp` field, NOT `datetime.now()` at enqueue time. Backfill (Phase 6) uses `red_team_runs.created_at` as the timestamp. Both forward and backfill produce the same timestamp for the same logical row.
   - **Done when:** integration test asserts the emission order in mock; a test simulates a crash between fix-plan call and emit_run, then recovers via `--scope=forward` backfill; tests prove forward + backfill produce byte-identical envelopes for the same `run_id`.

8. **Preserve challenge-derived final status** (resolves design §10 invariant + rt3):
   - Skill exit code, terminal-printed status, sidecar banner status, and `red_team_runs.final_status` ALL derive from `RedTeamResult` only.
   - Fix-plan errors do NOT change `final_status` from `halted` to `clean`, etc.
   - **Done when:** explicit regression test: blocking challenge findings + fix-plan parse failure → exit code is from challenge (halted), not clean.

#### Risks

- Fix-plan error accidentally masks blocking challenge: explicit test asserts the invariant.
- Two dispatchers diverge in subtle ways: extract `_render_fix_plan_section` and `_truncate_pr_comment` as shared module helpers if local patterns support; otherwise duplicate carefully and add a parity test.

#### Verification

```bash
python3 -m pytest scripts/test_red_team_fix_plan.py \
                  scripts/test_red_team_insights.py \
                  scripts/test_red_team_audit.py \
                  scripts/test_red_team_design_dispatch.py \
                  scripts/test_red_team_plan_dispatch.py -v
```

---

### Phase 6: Backfill Tooling

**Goal:** Idempotent CLI that emits historical local SQLite rows into the stark-insights queue.

**Dependencies:** Phases 3 and 4.

**Estimated effort:** M

#### Tasks

1. **Create `scripts/red_team_backfill.py`**:
   ```bash
   python3 scripts/red_team_backfill.py [--dry-run] [--limit N] [--db PATH] [--scope all|legacy|forward]
   ```
   - **Run migration first** — call `red_team_audit.init_red_team_tables(db_path)` BEFORE any SELECT. Resolves the "no such column: repo" failure mode for users who run backfill against a pristine pre-v1.2 DB.
   - Default `--scope=legacy`. Scope semantics — explicit per-type emission rules (resolves round-1 high: forward-scope ambiguity on which event types are emitted per row):
     - `legacy`: `WHERE fix_plan_status IS NULL` (pre-v1.2 rows). Emits 1 `red_team_run` (with `fix_plan_status="absent_pre_v1_2"`) + N `red_team_finding`. NEVER emits `red_team_fix_plan` (no historical data).
     - `forward`: `WHERE fix_plan_status IS NOT NULL` (v1.2 dispatcher wrote it; used to recover from forward-emission failure during a service outage). Per row:
       - Always emits 1 `red_team_run` + N `red_team_finding` (re-emission is idempotent via cloud `UNIQUE(dedupe_key)`).
       - Emits 1 `red_team_fix_plan` ONLY when `fix_plan_status = 'success' AND fix_plan_json IS NOT NULL`. Rows with `fix_plan_status IN ('error', 'skipped_*', 'absent_pre_v1_2')` produce zero `red_team_fix_plan` events.
     - `all`: no filter; emits per the same per-status rules above. Safe due to dedupe.
   - For legacy rows: emit `red_team_run.payload.fix_plan_status = "absent_pre_v1_2"` (a sentinel distinct from `"skipped_*"` so dashboards can tell the difference).
   - `repo`: read from row; NULL → `"unknown"` in payload. `artifact_relative_path`: read row; NULL → `null` in payload.
   - Envelope `timestamp` = `red_team_runs.created_at` (so historical events land in their original time bucket).
   - Dedupe keys: from the same `make_dedupe_key` helper as Phase 4 — byte-identical to forward emission for the same `run_id`.
   - **Done when:** dry-run + live run produce identical event counts; backfill of fixture DB lands deterministic dedupe keys.

2. **Use the same builder primitives as Phase 4** — Phase 4's `build_run_envelope` / `build_finding_envelope` / `build_fix_plan_envelope` accept primitives, so backfill (which has SQLite rows, not `RedTeamRunContext` / `RedTeamResult` objects) reuses them directly. No code duplication.

3. **Add tests** — `scripts/test_red_team_backfill.py`:
   - **Dry-run output** matches expected counts for fixture DB.
   - **Scope filtering**: `legacy` only emits `fix_plan_status IS NULL` rows; `forward` reads `fix_plan_json`; `all` emits everything.
   - **Malformed-row tolerance**: a row with bad `fix_plan_json` (corrupt JSON) is skipped with stderr warning; the script still completes.
   - **Forward fix-plan reconstruction**: a row with valid `fix_plan_json` produces a `red_team_fix_plan` envelope identical to what forward emission would have produced (compare field-by-field).
   - **Migration-before-select**: against a pre-v1.2 DB without `repo`/`fix_plan_status` columns, the script runs the migration first; the legacy-scope SELECT then sees the new columns as NULL.
   - **Idempotency** (offline): use a fake events table with `UNIQUE(dedupe_key)`; first run inserts N rows, second run inserts 0 (rejected by UNIQUE).
   - **Kill-mid-drain resume** (offline simulation, resolves both reviewers' concerns): start backfill, kill after first `enqueue` succeeds but before second; restart; assert the local pending queue still has the unsent rows AND a re-enqueue of already-drained rows is rejected by the cloud-side UNIQUE simulation. End state matches a single full run.

4. **Idempotency manifest for rollback support** (resolves codex→codex review on rollback specificity):
   - Backfill emits a `--manifest <path>` flag that writes the list of generated dedupe keys to a JSON file. Rollback (if ever needed) uses this manifest as the exact set of cloud rows to query/delete, rather than guessing by prefix.
   - **Done when:** manifest file exists after a `--scope=legacy` run and contains every emitted dedupe key.

#### Risks

- Backfill accidentally emits all rows by default: `--scope=legacy` default + the script's startup banner prints the resolved scope prominently before doing any work.
- Counting local enqueue success as cloud insert success: the script reports enqueue counts and explicitly notes "verify via dedupe-key prefix query against `events`" rather than implying success means cloud-side completion.

#### Verification

```bash
python3 -m pytest scripts/test_red_team_backfill.py -v
python3 scripts/red_team_backfill.py --dry-run --limit 5 --scope legacy
```

---

### Phase 7: Skill Documentation

**Goal:** Update user-facing skill docs so installed commands describe v1.2 behavior accurately while preserving the disabled default.

**Dependencies:** Phase 5.

**Estimated effort:** S

#### Tasks

1. **`skill/stark-red-team-design/SKILL.md`** — document the new `## Proposed Fix Plan` section in §Phase 3 rendering. Note insights audit emission (events of types `red_team_run`, `red_team_finding`, `red_team_fix_plan`). State the `enabled: false` default explicitly. **Document the kill-switch env var `STARK_RED_TEAM_FIX_PLAN_KILL`** in a new "Operational controls" subsection so operators can find it during an incident without source-diving. Bump `revision` and `revision_date` fields.

2. **`skill/stark-red-team-plan/SKILL.md`** — same.

3. **Run skill structural eval** if `skill-creator:skill-creator` is wired in this repo:
   ```bash
   ./install.sh --status
   # Plus skill structural validation if invocable from CLI
   ```

#### Risks

- Docs imply fix-plan is enabled in v1.2: explicit "disabled by default; flipped post-calibration" sentence required.

#### Verification

```bash
./install.sh --status
git diff --stat skill/stark-red-team-{design,plan}/SKILL.md
```

---

### Phase 8: stark-insights Type Registration + Lifter Support  ⟂ parallel with Phases 1–7

**Goal:** Register the three new event types in stark-insights' validation registry AND add lifter rules. **MUST deploy BEFORE Phase 4 producer events drain to cloud** — `EventEnvelope.model_validate` (verified at `src/stark_insights/models.py`) raises `ValueError("Unknown event type: ...")` for any type not in `PAYLOAD_SCHEMAS`. The "producer-first is safe" claim from the original synthesis was wrong — the API rejects unknown types.

**Dependencies:** Phase 4 payload contracts locked. Phase 8 can DEVELOP in parallel with Phases 1–7, but its PR MUST merge and deploy BEFORE any forward-emission events from a calibration-override or post-flip dispatcher attempt to drain. (Phase 11 Task 6 hard-gates on Phase 8 deployment.)

**Estimated effort:** M

#### Tasks

0. **Bootstrap stark-insights local dev** (resolves round-1 critical: blank-slate Track B has no install steps):
   - Clone if missing: `git clone https://github.com/Evinced/stark-insights.git $STARK_INSIGHTS_REPO`.
   - `cd "$STARK_INSIGHTS_REPO"; uv sync --extra dev` (or `python3 -m venv .venv && pip install -e ".[dev]"`).
   - `uv run pytest tests/test_lifting.py -q` — establish baseline; should pass.
   - Verify Cloud SQL access path: `bash scripts/tunnel.sh status` OR the bastion SSH path from `$STARK_INSIGHTS_REPO/CLAUDE.md` §"Cloud SQL access via bastion".
   - **Authenticated ingestion identified:** the running service exposes `POST /events` with Bearer auth. Per `~/.stark-insights/api-token` and `src/stark_insights/api/events.py:53`, the request shape is:
     ```bash
     TOKEN=$(cat ~/.stark-insights/api-token)
     curl -sS -X POST http://127.0.0.1:7420/events \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/json" \
          --data @/tmp/fixture-event.json
     ```
   - **launchd service label discovered:** run `launchctl list | grep -i stark-insights` to capture the actual label; typical value is `com.evinced.stark-insights` per `$STARK_INSIGHTS_REPO/CLAUDE.md`. Record the discovered label here in the plan before Phase 11 Task 5 runs.
   - **Service / token bootstrap from blank slate:** if `~/.stark-insights/api-token` does not exist OR `launchctl list | grep stark-insights` returns nothing, run the per-stark-insights install procedure FIRST: `bash $STARK_INSIGHTS_REPO/scripts/install.sh` per its CLAUDE.md (creates the launchd service, generates the API token via `scripts/manage-keys.py`, configures the IAP tunnel). Phase 0 in this plan does not duplicate that procedure — it links to it.
   - **Author the three smoke-test fixture files** before Task 5 runs them:
     ```
     $STARK_INSIGHTS_REPO/tests/fixtures/red_team_run.json
     $STARK_INSIGHTS_REPO/tests/fixtures/red_team_finding.json
     $STARK_INSIGHTS_REPO/tests/fixtures/red_team_fix_plan.json
     ```
     Each is a minimal valid envelope per the §5.2 schemas. Commit them as part of the Track B PR alongside the `PAYLOAD_SCHEMAS` entries — fixtures + schemas land together so the smoke test in Task 5 has its inputs.
   - **Done when:** one hand-crafted `tool_usage` event lands successfully via the curl above; service label and api-token path are documented; the three fixture files exist; tests pass on a clean clone.

1. **Add the three event types to `PAYLOAD_SCHEMAS`** — `$STARK_INSIGHTS_REPO/src/stark_insights/models.py` (resolves round-1 critical: lifters alone won't ingest):
   - Define payload schemas per design §5.2 — every required key with its expected type tuple. Optional keys include `type(None)` in the tuple.
   - Example shape (mirror existing entries for style; full list in design §5.2):
     ```python
     PAYLOAD_SCHEMAS["red_team_run"] = {
         "run_id": (str,),
         "stage": (str,),
         "model": (str,),
         "caller": (str,),
         "final_status": (str,),
         "worst_severity": (str, type(None)),
         "passed": (bool,),
         "rounds_used": (int,),
         "total_findings": (int,),
         "blocking_count": (int,),
         "human_review_count": (int,),
         "critical_count": (int,),
         "high_count": (int,),
         "medium_count": (int,),
         "duration_s": ((int, float),),
         "cost_usd": ((int, float),),
         "repo": (str,),
         "artifact_relative_path": (str, type(None)),
         "pr_number": (int, type(None)),
         "fix_plan_status": (str,),
         "warnings": (list,),
     }
     PAYLOAD_SCHEMAS["red_team_finding"] = {...per §5.2...}
     PAYLOAD_SCHEMAS["red_team_fix_plan"] = {...per §5.2...}
     ```
   - **Done when:** `EventEnvelope.model_validate({"type": "red_team_run", "payload": <example-from-§5.2>, ...})` succeeds; missing required keys raises a clear `ValueError`.

2. **Add `EVENT_PRIORITY` entries** — `$STARK_INSIGHTS_REPO/src/stark_insights/db/buffer.py`:
   - Set explicit priority for each new type so they're not silently bucketed at `DEFAULT_EVENT_PRIORITY=2` for buffer eviction:
     ```python
     EVENT_PRIORITY: dict[str, int] = {
         "tool_usage": 0, "prompt": 1, "code_change": 2, "bug_fix": 3,
         "review_finding": 4, "correction": 5,
         "red_team_run": 4,        # parallel to review_finding — high-value analytics signal
         "red_team_finding": 4,
         "red_team_fix_plan": 5,   # most expensive call; preserve over generic findings
     }
     ```
   - **Done when:** unit test asserts `red_team_*` types are evicted last under buffer pressure (or at least not before `tool_usage` / `prompt`).

3. **Add lifter rules** — `$STARK_INSIGHTS_REPO/src/stark_insights/lifting.py` per design §5.3 (verbatim):
   ```python
   "red_team_run": [
       ("model", "agent_name", None, True),
       ("stage", "domain", None, True),
       ("worst_severity", "severity", None, True),
       ("cost_usd", "score_value", None, False),
       ("passed", "passed", None, True),
       ("repo", "repo", None, True),
       ("pr_number", "pr_number", None, True),
   ],
   "red_team_finding": [
       ("persona", "agent_name", None, True),
       ("stage", "domain", None, True),
       ("severity", "severity", None, True),
       ("repo", "repo", None, True),
       ("pr_number", "pr_number", None, True),
   ],
   "red_team_fix_plan": [
       ("model", "agent_name", None, True),
       ("stage", "domain", None, True),
       ("cost_usd", "score_value", None, False),
       ("repo", "repo", None, True),
       ("pr_number", "pr_number", None, True),
   ],
   ```

4. **Add tests** — `$STARK_INSIGHTS_REPO/tests/test_lifting.py` AND `tests/test_models.py` (or equivalent):
   - **Type-registration tests:** `EventEnvelope.model_validate` accepts a valid envelope of each new type; rejects missing required keys with `ValueError`; tolerates optional NULLs.
   - **Lifter tests** per type:
     - Lifted column extraction.
     - `payload_extra` preservation: every non-lifted field still appears in `payload_extra`.
     - Missing-key tolerance: payloads missing optional keys don't raise.
     - **NULL-payload-value handling:** `worst_severity: null` → `severity` lifted column is SQL NULL, NOT the string `"None"`.
   - **End-to-end ingestion test:** POST a fixture event for each type via the API path from Task 0; assert the cloud `events` row has `type`, lifted columns, and `payload_extra` populated correctly.

5. **Smoke-test authenticated ingestion** (uses Task 0's documented path):
   - POST one fixture event of each type:
     ```bash
     for t in red_team_run red_team_finding red_team_fix_plan; do
         curl -sS -X POST http://127.0.0.1:7420/events \
              -H "Authorization: Bearer $(cat ~/.stark-insights/api-token)" \
              -H "Content-Type: application/json" \
              --data @"$REPO/tests/fixtures/${t}.json"
     done
     # Verify lifted columns populated; query via the bastion or local sync inspection.
     ```
   - **Done when:** all three fixture events land with lifted columns populated AND `payload_extra` retains unlifted fields.

#### Risks

- **Producer-first deployment is NOT safe** in this design — fixed by the hard prerequisite gate. If Track B's PR is delayed, Track A's calibration override and post-flip flips MUST be held until Track B deploys, otherwise events dead-letter.
- Service label drift: documented via Task 0 `launchctl list` capture; do not hard-code.

#### Verification

```bash
cd "$STARK_INSIGHTS_REPO"
uv run pytest tests/test_lifting.py tests/test_models.py -v
TOKEN=$(cat ~/.stark-insights/api-token)
curl -sS -X POST http://127.0.0.1:7420/events \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     --data '{"type":"red_team_run","timestamp":"2026-05-01T00:00:00Z","cli":"claude","source":"skill","schema_version":1,"payload":<minimal-valid>}'
# Expect 201 Created.
```

---

### Phase 9: Disabled-Default End-To-End Verification

**Goal:** Prove v1.2 ships safely with `fix_plan.enabled: false` and no second LLM call by default.

**Dependencies:** Phases 1–7 implemented on the v1.2 branch AND Phase 8 (Track B `PAYLOAD_SCHEMAS`) deployed to whatever stark-insights instance the launchd drainer is pointed at. Without Phase 8 deployed, the disabled-default invocations queue events that drain to a stark-insights endpoint that will reject them with `Unknown event type` and dead-letter — even when fix-plan is `skipped_disabled` and the only events are `red_team_run` + `red_team_finding` (resolves round-3 critical: Phase 9 drains red_team_* events to cloud before Phase 8 deploys). **Runs PRE-merge** of the v1.2 producer PR; the v1.2 PR description references both Phase 9 (disabled-default) and Phase 10 (calibration) results.

**Track B deployment hard-precedes Phase 9 in production.** Locally, `~/.stark-insights/queue.db` is durable; if Phase 8 is not yet deployed, the operator can either (a) stop the launchd drainer for the duration of Phase 9 testing (events accumulate locally; drain after Phase 8 deploy), or (b) point the local launchd service at a Phase-8-loaded staging stark-insights instance.

**Estimated effort:** M

#### Tasks

1. **Run the full unit suite**:
   ```bash
   cd /Users/aryeh/Code/Playground/stark-skills
   python3 -m pytest scripts/test_red_team_fix_plan.py \
                     scripts/test_red_team_insights.py \
                     scripts/test_red_team_backfill.py \
                     scripts/test_red_team_audit.py \
                     scripts/test_config_loader.py \
                     scripts/test_red_team_design_dispatch.py \
                     scripts/test_red_team_plan_dispatch.py
   ```

2. **Disabled-default integration**: invoke each dispatcher on a fixture spec that produces blocking findings; assert:
   - Challenge runs normally.
   - Fix call NOT dispatched (no Responses API call for fix-plan).
   - Sidecar contains `## Proposed Fix Plan` with `Status: skipped — skipped_disabled`.
   - Local SQLite row has `fix_plan_status = 'skipped_disabled'`, all other fix_plan_* columns NULL.
   - `~/.stark-insights/queue.db` has 1 `red_team_run` event (with `fix_plan_status: "skipped_disabled"`) and N `red_team_finding` events; NO `red_team_fix_plan` event.

3. **Verify queued events** (resolves round-1 high: `pending` table has no `type` column — type lives inside `event_json`):
   ```bash
   sqlite3 ~/.stark-insights/queue.db <<'SQL'
     SELECT
       json_extract(event_json, '$.type')                     AS event_type,
       json_extract(event_json, '$.payload.fix_plan_status')  AS fix_plan_status,
       json_extract(event_json, '$.payload.run_id')           AS run_id
     FROM pending
     WHERE json_extract(event_json, '$.type') LIKE 'red_team_%'
     ORDER BY id DESC
     LIMIT 10;
   SQL
   ```

#### Risks

- Fixture doesn't produce blocking findings (would mask the gating logic): use a known-deterministic fixture from `docs/specs/red-team-fixture-source-spec.md`.

#### Verification

```bash
python3 -m pytest -v
git status
```

---

### Phase 10: Calibration And Enabled-Fixture Validation

**Goal:** Measure real fix-plan cost and behavior with the sanctioned `--enable-fix-plan-for-calibration` override BEFORE merging the v1.2 PR. (Resolves design rt15 + §13 rollout step 1.)

**Dependencies:** Phases 1–9 implemented (calibration runs against the v1.2 branch BEFORE merge).

**Estimated effort:** L

#### Tasks

1. **Prepare the fixture set** — three fixtures of varying size:
   - Small: ~200-line spec
   - Medium: ~600-line spec (e.g., the v1 red-team design)
   - Large: ~1500-line spec
   - Each must produce ≥ 1 blocking finding deterministically. Verify by running the challenge call alone first.

2. **Add a calibration harness script** with cost ceilings (resolves round-1 high: calibration spends real money with no abort condition):
   - `scripts/red_team_calibration.py [--fixtures DIR] [--runs N] [--out DOC] [--max-total-cost-usd N] [--abort-on-per-run-cost-usd N]`
   - Defaults: `--max-total-cost-usd 200.00` (hard cap on cumulative OpenAI spend across the run), `--abort-on-per-run-cost-usd 45.00` (1.5× the configured `per_run_budget_usd` of $30 — tripping it suggests the budget itself is wrong).
   - Behavior: dispatches `red_team_design_dispatch.py --enable-fix-plan-for-calibration` N times per fixture, reads results from `red_team_runs.fix_plan_json`. After EACH run, accumulate total cost; if total ≥ `--max-total-cost-usd` OR any single run's `fix_plan.cost_usd` ≥ `--abort-on-per-run-cost-usd`, ABORT the harness with a clear message and partial-aggregate output.
   - Print intermediate p50 / p95 of cost / duration / move_count after every 5 runs so the operator can `Ctrl-C` with informed judgment.
   - Aggregate p50/p95/max for cost/duration/move_count/coverage_rate at the end; write the calibration doc.
   - **Done when:** running the harness on the fixture set produces a complete calibration doc without manual aggregation; abort path is exercised by a unit test that mocks a $50 single-run cost.

3. **Run calibration** — 10 runs per fixture × 3 fixtures = 30 runs minimum:
   ```bash
   python3 scripts/red_team_calibration.py \
       --fixtures docs/calibration/fixtures/ \
       --runs 10 \
       --out docs/calibration/2026-05-XX-red-team-v1.2-fix-plan-calibration.md
   ```

4. **Assert budget headroom**:
   ```text
   per_run_budget_usd >= 1.5 * observed_p95_total_cost
   ```
   - On the current $30 budget, this triggers a budget bump if p95 total cost exceeds **$20**.
   - If the calibration shows p95 > $20: bump `per_run_budget_usd` in the same PR before merging.
   - If `move_cap_hit` warning appears in > 20% of runs: raise `max_moves` from 6.

5. **Verify enabled-path behavior** — one calibration run produces:
   - Sidecar with rendered moves + summary + notes.
   - SQLite row with `fix_plan_status='success'`, non-null `fix_plan_md`, non-null `fix_plan_json`, `fix_plan_cost_usd > 0`.
   - Queue has 1 `red_team_fix_plan` event with `move_count` matching the sidecar.
   - Stderr has `red_team.fix_plan.calibration_override` (emitted exactly once).

#### Risks

- Calibration override leaks into production via skill args: keep the flag dispatcher-CLI-only; no skill-level argument forwarding.
- Cost exceeds priors significantly: bump budget BEFORE merging v1.2 — the calibration doc lives on the same branch as the code.

#### Verification

```bash
test -f docs/calibration/2026-05-XX-red-team-v1.2-fix-plan-calibration.md
sqlite3 ~/.claude/code-review/history/forged-review/forged_review_metrics.db \
  "SELECT json_extract(fix_plan_json, '$.move_count'), fix_plan_cost_usd FROM red_team_runs WHERE fix_plan_status='success' ORDER BY created_at DESC LIMIT 30;"
```

---

### Phase 11: Backfill And Operational Rollout

**Goal:** Roll out cloud analytics safely, backfill historical data idempotently, then enable fix-plan in a separate PR.

**Dependencies:** Phase 8 deployed AND smoke-tested in production. Phase 10 calibration doc approved.

**Estimated effort:** M

#### Tasks

1. **Deploy the Phase 8 stark-insights PR** — HARD gate before any other Phase 11 task:
   - Merge `PAYLOAD_SCHEMAS` + `EVENT_PRIORITY` + `_LIFT_RULES` updates.
   - Deploy: restart the launchd service (`launchctl unload && load <plist>` per the actual label discovered in Phase 8 Task 0).
   - Smoke-test ONE event of each new type via the documented auth path:
     ```bash
     TOKEN=$(cat ~/.stark-insights/api-token)
     for t in red_team_run red_team_finding red_team_fix_plan; do
         curl -sS -w "%{http_code}\n" -X POST http://127.0.0.1:7420/events \
              -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
              --data @"$STARK_INSIGHTS_REPO/tests/fixtures/${t}.json"
     done
     # Each must return 201. Capture the timestamp; PR description in Task 6 references it.
     ```
   - Verify cloud rows have lifted columns populated (query via bastion).
   - **Done when:** all 3 fixture POSTs return 201 AND lifted columns visible in cloud `events`. Capture the smoke-test timestamp — Task 6 PR description must reference a smoke-test < 24h old.

2. **Run dry-run backfill**:
   ```bash
   python3 scripts/red_team_backfill.py --dry-run --scope legacy --manifest /tmp/backfill-manifest.json
   ```
   Review counts and sample envelopes. Confirm scope and DB path printed prominently.

3. **Run live legacy backfill**:
   ```bash
   python3 scripts/red_team_backfill.py --scope legacy --manifest /tmp/backfill-manifest.json
   ```

4. **Server-side source-to-target reconciliation** (round-3 critical: manifest verification only checks expected keys, not source fidelity):
   - Compute the EXPECTED set of dedupe keys deterministically from the local SQLite source rows (independent of what the script emitted):
     ```bash
     python3 -c "
     import sqlite3
     db = sqlite3.connect('~/.claude/code-review/history/forged-review/forged_review_metrics.db')
     run_keys = [f'red-team:run:{r[0]}:{r[1]}' for r in db.execute('SELECT stage, run_id FROM red_team_runs WHERE fix_plan_status IS NULL')]
     find_keys = [f'red-team:finding:{r[0]}:{r[1]}:{r[2]}:{r[3]}' for r in db.execute('SELECT stage, run_id, round_num, finding_id FROM red_team_findings WHERE run_id IN (SELECT run_id FROM red_team_runs WHERE fix_plan_status IS NULL)')]
     print(f'expected runs={len(run_keys)} findings={len(find_keys)}')
     " > /tmp/expected-counts.txt
     ```
   - Compare expected counts to actual counts in cloud `events` filtered by the same dedupe-key set. Any drift (expected > actual) signals events stuck in pending/dead_letter; expected < actual signals duplicate emission (should be impossible if cloud `UNIQUE(dedupe_key)` is in place — assert).
   - The manifest from Task 3 is one input; the local-DB-derived expected set is an INDEPENDENT input. Both must agree.
   ```sql
   -- Compute the expected set from the manifest, then verify each appears EXACTLY once.
   WITH expected_keys(k) AS (VALUES <list-from-manifest>)
   SELECT k, COUNT(e.dedupe_key) AS observed
     FROM expected_keys
     LEFT JOIN events e ON e.dedupe_key = expected_keys.k
   GROUP BY k
   HAVING observed != 1;
   ```
   - **Done when:** zero rows returned (every expected key appears exactly once).

5. **Verify queue drain resilience** — uses the Phase 8 Task-0 discovered service label, NOT the assumed one (resolves round-1 high: launchctl service name unverified):
   ```bash
   SERVICE_LABEL=$(launchctl list | awk '/stark-insights/ {print $3}' | head -1)
   test -n "$SERVICE_LABEL" || { echo "no stark-insights launchd service found"; exit 1; }
   echo "Discovered service label: $SERVICE_LABEL"

   launchctl stop "$SERVICE_LABEL"
   # Run one calibration-override dispatcher invocation; verify events queue locally
   python3 scripts/red_team_design_dispatch.py docs/calibration/fixtures/medium.md \
       --enable-fix-plan-for-calibration
   sqlite3 ~/.stark-insights/queue.db \
       "SELECT COUNT(*) FROM pending WHERE json_extract(event_json,'$.type') LIKE 'red_team_%';"
   # Expect > 0

   launchctl start "$SERVICE_LABEL"
   # Wait one drain cycle (60s); pending should clear (or move to dead_letter on failure)
   sleep 75
   sqlite3 ~/.stark-insights/queue.db \
       "SELECT (SELECT COUNT(*) FROM pending) AS pending,
               (SELECT COUNT(*) FROM dead_letter) AS dead;"
   ```

6. **Open the post-flip PR** with explicit gate criteria:
   - Single-line change: `"enabled": false` → `"enabled": true` in `global/config.json`.
   - **Hard gate (PR description requirements):**
     - Reference Task 1's smoke-test timestamps — must be < 24h old at PR open.
     - Reference Phase 10's committed calibration doc with p95 totals.
     - Reference the documented kill-switch path (`STARK_RED_TEAM_FIX_PLAN_KILL=1`) so on-call has a fast disable in their runbook.
   - CI runs the enabled-fixture test suite from design §12.2 (the spec's "enabled-fixture" acceptance section — there is no separate "Phase 12" in this plan; design §12.2 is the canonical reference).
   - **Approval authority:** the same reviewer set who approved the v1.2 base PR (single-author plus one peer). No silent merge — the post-flip PR is short but operationally significant.
   - **Done when:** PR merges, dispatcher logs show fix-plan calls firing on real invocations, and the kill-switch is documented in `skill/stark-red-team-design/SKILL.md` Phase 7 update.

7. **Add insights queue health check** (resolves round-1 high: queue depth / dead-letter has no alert):
   - Wire a periodic check (cron, launchd `StartInterval`, or stark-session start banner) that queries:
     ```sql
     -- Pending depth + oldest age
     SELECT COUNT(*) AS pending,
            COALESCE(MAX(julianday('now') - julianday(created_at)) * 24, 0) AS oldest_pending_hours
       FROM pending;
     -- Dead-letter accumulation
     SELECT COUNT(*) FROM dead_letter;
     ```
   - Surface a stderr warning (or session-start banner via `stark-session`) when:
     - `pending > 100` OR
     - `oldest_pending_hours > 1` OR
     - `dead_letter` row count grows since last check.
   - **Forward emission timestamp invariant** (related): every envelope built in Phase 4 sets `timestamp = ctx.started_at_iso` (event creation time) so post-outage drains land in the correct historical bucket.
   - **Done when:** test exercises the alert thresholds; documentation in `skill/stark-session/SKILL.md` references the new banner section.

8. **Backfill `--scope=forward` for in-flight failures** (only if dispatcher emit_* calls failed during a service outage):
   ```bash
   python3 scripts/red_team_backfill.py --scope forward --limit 100
   ```
   - Re-emits any forward-scope rows whose events didn't successfully drain.
   - Idempotent — safe to run repeatedly.

#### Risks

- Backfill duplicate cloud rows: the cloud-side `UNIQUE(dedupe_key)` index from `idx_events_dedupe` (verified in stark-insights `schema.py`) is the durable defense. Task 4 confirms via the manifest-based query.
- Production enable PR merges without calibration: the Phase 10 calibration doc is a hard gate — the PR description must reference it.

#### Verification

After Phase 11 completes, the v1.2 system is fully live in production:
- Both red-team skills run the fix-plan call automatically when blocking findings are present.
- Every run lands in stark-insights as `red_team_run` + N×`red_team_finding` + (when applicable) `red_team_fix_plan`.
- Historical data is backfilled.
- Dashboards filter by `repo`, `stage`, `severity`, `pr_number`, `fix_plan_status`.

---

## 4. Integration Points

The implementation must keep the following contracts byte-stable across Track A and Track B PRs:

- **`RedTeamRunContext` is the identity contract.** If it's incomplete or differs between dispatchers, run correlation breaks across SQLite ↔ insights. Phase 5 Task 1 acceptance test enforces byte-identity.

- **`RedTeamResult` is the source of truth for skill exit status.** Fix-plan dispatchers MUST NOT alter `final_status` from challenge. Phase 5 Task 8 enforces.

- **`serialize_findings_envelope` is the contract between challenge output and fix-plan input.** Single source via `preflight_findings_envelope` (Phase 2 Task 6) avoids double-decision drift between dispatcher gating and core dispatch.

- **`fix_plan_json` is the lossless persistence contract for forward backfill.** It MUST contain everything needed to reconstruct a `red_team_fix_plan` event later — including `warnings`, orphan IDs, input-truncation flags, tokens, model, reasoning_effort. Phase 3 Task 3 + Phase 6 Task 2 enforce.

- **`make_dedupe_key` is the single source for forward emission AND backfill.** Diverging formulas would create duplicate cloud events. Phase 4 Task 3 + Phase 6 Task 1 reuse the same helper.

- **`event_schema.json` (Track A) ↔ `PAYLOAD_SCHEMAS` + `_LIFT_RULES` (Track B) contract.** **Track B MUST deploy first** in production. The earlier "producer-first is safe" claim was wrong — `EventEnvelope.model_validate` rejects unknown event types at `POST /events`. Phase 11 Task 1 is the deployment gate; Task 6 (post-flip PR) is hard-blocked on it. For local dev only, calibration runs against a localhost stark-insights instance that has Track B's changes loaded — same gate, smaller blast radius.

- **Locked-field enforcement.** `_RED_TEAM_LOCKED_FIELDS` MUST cover all 5 nested fix-plan paths AND emit `red_team_override_rejected` events with the exact dotted `path` string. Phase 1 Task 2 acceptance covers all 5.

## 5. Testing Strategy

**Unit (per-phase, gated on phase merge):**
- Phase 1: config defaults merged (all 7 `fix_plan` keys including `model`), locked-field recursion (5 nested paths drop with audit event), event-type registration.
- Phase 2: envelope serializer (50-finding fixture), validator (move counts 0/1/2/6/7/12/13), invented-ID drop demoting to `min_moves` violation, prompt assembly, RESPONSES_API_MODELS check, `max_output_tokens=32768` parameter wiring, **`is_human_review` helper for both branches**.
- Phase 3: SQLite migration on fresh / v1.0 / v1.1 / v1.2 / partial DBs; record_red_team_run / record_fix_plan round-trip; `record_fix_plan` asserts `cursor.rowcount == 1` to catch missing parent row.
- Phase 4: envelope shape per §5.2, dedupe-key stability, exception isolation, `worst_severity: null` → NULL severity column, `red_team_fix_plan` not emitted on non-success.
- Phase 5: gate-state machine (each skip status, **including `skipped_kill_switch` with env var set and `enabled: true`**), context byte-identity, `over_budget_after_fix` warning propagation to BOTH event payloads, sidecar untrusted-content escapes, PR-comment 65 KB cascade, commit message variants, exit code from challenge only, **emit-after-write ordering invariant**.
- Phase 6: dry-run, scope filtering (legacy / forward / all per-type emission rules), malformed-row tolerance, forward fix-plan reconstruction (only when `fix_plan_status='success' AND fix_plan_json IS NOT NULL`), migration-before-select, idempotency, kill-mid-drain resume, manifest writeback.
- Phase 8: **type registration in `PAYLOAD_SCHEMAS` (resolves round-1 critical)**, `EVENT_PRIORITY` entries, lifter rules per type, NULL-payload handling, end-to-end POST through `EventEnvelope.model_validate`.

**New tests added in round-1 review pass:**
- `test_is_human_review_helper` — derivation correctness.
- `test_payload_schemas_red_team_run` — invalid envelope raises clear `ValueError`; valid envelope passes.
- `test_kill_switch_overrides_enabled` — `STARK_RED_TEAM_FIX_PLAN_KILL=1` lands on `skipped_kill_switch` even when `enabled: true` and `--enable-fix-plan-for-calibration` set.
- `test_emit_after_write_ordering` — mock asserts insert/update/enqueue order.
- `test_calibration_harness_aborts_on_per_run_cap` — fixture with $50 cost triggers harness abort.
- `test_pending_query_uses_json_extract` — Phase 9 verification SQL works against the actual `pending` schema.

**Integration (post-Phase 7):**
- Disabled-default dispatcher invocations land with `skipped_disabled`.
- Calibration-override dispatcher invocations produce success path end-to-end.
- Context identity across the four sinks.
- Enqueue failure isolation: forced exception in `enqueue` does not change skill exit code.

**End-to-end (Phase 9 + Phase 10):**
- Disabled-default fixture run.
- Calibration fixture runs (×30) with the harness.
- Local sidecar + queue + SQLite all coherent for one calibration run.
- Phase 11 cross-repo: lifter deployment, manifest-based dedupe-key verification, kill-mid-drain backfill resume.

**Test ordering:**
1. Phase 1 unit tests gate Phase 2 work.
2. Phase 2 unit tests gate Phase 3+ wiring.
3. Sidecar/PR-comment snapshot tests are flaky on whitespace — establish once, regenerate via deliberate fixture refresh, not per-run.
4. Calibration runs only AFTER disabled-default CI is green.

**What can wait:**
- Cross-fixture cost-variance analysis (Phase 10) is calibration documentation, not the test suite proper.
- Phase 11 server-side verification can be staged before production rollout.

## 6. Rollback Plan

| Phase | Rollback path |
|---|---|
| 1 | Revert config + event-type registration + prompt file. No runtime path depends on them yet. |
| 2 | Revert `scripts/stark_red_team.py` additions. Existing `run_red_team` and `RedTeamResult` are untouched, so challenge behavior returns to v1. |
| 3 | Stop writing new columns. Do NOT destructively roll back schema — additive columns are harmless idle. |
| 4 | Disable calls to `red_team_insights.emit_*`. Queued events drain or sit; cloud dedupe protects replays. |
| 5 | Revert dispatcher integration. Sidecars previously written with fix-plan sections are documentation artifacts and don't affect future runs. |
| 6 | Stop using `scripts/red_team_backfill.py`. Already-emitted events are idempotent on re-run; no deletion required. Manifest from Task 4 enables targeted rollback if explicitly needed. |
| 8 | Revert lifter rules only. Existing events still ingest with fields in `payload_extra`. |
| 10 | Calibration doc has no runtime effect; supersede if results invalidated by upstream changes. |
| 11 | **Two-layer rollback.** (a) Fast incident response (seconds): set `STARK_RED_TEAM_FIX_PLAN_KILL=1` in the operator's environment — dispatcher hits this BEFORE the locked `enabled` check, lands on `skipped_kill_switch`, no LLM call. Document in operator runbooks so on-call doesn't need to ship code. (b) Permanent rollback (PR cycle): revert the post-flip PR. In-flight runs that already paid for fix-plan are kept (audit data). Backfill manifest scoped rollback available but rarely needed because cloud `UNIQUE(dedupe_key)` makes re-runs no-ops. |

**Ambiguities resolved (rationale):**

- *Phase 8 auth path* — resolved in Phase 8 Task 0: existing `~/.stark-insights/api-token` Bearer auth via `POST /events`. Documented inline.
- *Kill-switch mechanism* — env var `STARK_RED_TEAM_FIX_PLAN_KILL`. NOT in `_RED_TEAM_LOCKED_FIELDS` (locks apply to config keys; env vars are operator-controlled per machine). The lock on `enabled` prevents repo-level downgrade of the substance review; the env var preserves operator-level emergency disable. Distinct concerns, both addressed.

## 7. Synthesis Decisions Log

This plan synthesizes from codex (winner, 8.2/10) and claude (runner-up, 7.8/10) per the `/stark-design-to-plan` 0.5-pt tie rule:

- **Phase structure (11 phases):** codex base.
- **Cross-repo parallelization (Phase 8 ⟂ Phases 1–7):** merged from gemini→codex review; addresses codex's linear sequencing miss.
- **Move-count post-prune re-check (Phase 2 Task 4):** merged from claude→codex review; addresses codex's incomplete validation contract.
- **`max_output_tokens=32768` wiring test (Phase 2 Task 5):** merged from claude→codex review's risk-coverage gap.
- **Centralized `preflight_findings_envelope` (Phase 2 Task 6):** merged from codex→claude review's "fits_safely ambiguous" critique.
- **Pure builders + thin emit wrappers (Phase 4 Task 1):** merged from codex→claude review's signature-mismatch concern.
- **emit_run timing AFTER fix-plan (Phase 5 Task 7):** claude→codex review.
- **`over_budget_after_fix` propagation to both event payloads (Phase 5 Task 3):** gemini→codex review.
- **Error template retry hint (Phase 5 Task 4):** gemini→codex review.
- **Explicit PR-comment truncation algorithm (Phase 5 Task 5):** claude→codex review's PR-truncation ambiguity.
- **Phase 8 Task 0 (auth lookup):** claude→codex review's hand-wavy auth gap.
- **Backfill manifest + kill-mid-drain test (Phase 6 Tasks 3–4):** both reviewers.
- **Calibration harness script (Phase 10 Task 2):** claude→codex review.
- **Calibration BEFORE merge, post-flip PR separate (Phase 10 ⊥ Phase 11):** codex base; claude's plan got this wrong.
- **Local pr_number column (Phase 3 Task 1):** codex→claude review's pr_number consistency concern.
- **Rollback table + ambiguities-flagged section:** claude's risk_coverage strength (8.0 vs codex's 7.5).
