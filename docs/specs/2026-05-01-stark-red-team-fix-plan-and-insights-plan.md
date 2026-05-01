# Implementation Plan: stark-red-team v1.2 — Fix Plan + Insights Audit

**Status:** Synthesized (codex base 8.2/10 + claude merges 7.8/10 — within 0.5-pt tie)
**Date:** 2026-05-01
**Design:** [`2026-05-01-stark-red-team-fix-plan-and-insights-design.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-design.md)
**Cross-review summary:** [`2026-05-01-stark-red-team-fix-plan-and-insights-design.d2p-review.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-design.d2p-review.md)

## 1. Overview

Two incremental tracks:

- **Track A (stark-skills, this repo):** Phases 1–7 + 9–11 add the gated `gpt-5.5-pro` xhigh fix-plan call, the local SQLite migration, the insights event emission helpers, the backfill CLI, sidecar/PR-comment rendering, and the calibration → enable rollout. Ships with `fix_plan.enabled: false`.
- **Track B (stark-insights, separate repo):** Phase 8 adds lifter rules. **Runs in parallel with Track A** once the §5.2 payload contracts are locked in Phase 4 (see §4 Integration Points). Producer (Track A) and consumer (Track B) tolerate either deployment order: events written before lifters land ingest into `payload_extra`-only.

Invariants the implementation MUST preserve:
- The skill's exit code, terminal status, sidecar banner, and `red_team_runs.final_status` derive ONLY from the challenge call's `RedTeamResult`. Fix-plan success/failure changes only `fix_plan_status` and the `## Proposed Fix Plan` section. (Resolves design rt3.)
- `fix_plan.enabled`, `model`, `reasoning_effort`, `min_moves`, `max_moves` are LOCKED — no repo-level override.
- No schema migration on `events` table in stark-insights. Lifters only.
- Local SQLite migration is additive and idempotent across fresh / v1.0 / v1.1 / v1.2 / partially-migrated DBs.

## 2. Prerequisites

```bash
# Repo state
cd /Users/aryeh/git/Evinced/stark-skills
git status --short

# Local tools
python3 --version    # 3.12+
gh auth status
sqlite3 --version

# Runtime access
test -n "$OPENAI_API_KEY"     # for fix-plan and challenge dispatch via Responses API
ls ~/.stark-insights/queue.db # exists (created on first emit if not)
ls ~/.claude/code-review/history/forged-review/forged_review_metrics.db  # exists or creatable

# stark-insights repo location (Track B)
test -d /Users/aryeh/git/Evinced/stark-insights || \
    echo "clone first: git clone <stark-insights-url> /Users/aryeh/git/Evinced/stark-insights"

# Baseline: existing tests pass before edits
python3 -m pytest scripts/test_stark_red_team.py scripts/test_red_team_audit.py
./install.sh --status
```

**Design gaps to resolve during implementation (flag-only — Phase 8 needs an answer):**
- Exact stark-insights authenticated event POST mechanism (env var, client, or service-relay path) for the lifter smoke test. **Phase 8 Task 0** is to locate `stark_insights/api/` or equivalent client and document the path before any direct ingestion is attempted.

## 3. Phases

### Phase 1: Config, Prompt, And Event-Type Foundations

**Goal:** Add the disabled-by-default configuration surface, locked-field hardening, fix-plan prompt, and event type registration. No runtime behavior change yet.

**Dependencies:** none

**Estimated effort:** M

#### Tasks

1. **Add fix-plan config defaults** — `global/config.json`:
   - Bump `red_team.per_run_budget_usd` from `15.00` to `30.00`.
   - Add the `red_team.fix_plan` section per design §7 (with `enabled: false`, `min_moves: 2`, `max_moves: 6`, `reasoning_effort: "xhigh"`, `timeout_s: 1200`, `max_input_chars: 200000`).
   - **Done when:** loading old and new config both produce a complete `red_team.fix_plan` section after default-merge.

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
   - **Done when:** dataclasses import and round-trip via `asdict`.

2. **Implement `serialize_findings_envelope(findings, max_chars) -> (envelope_json, omitted_ids, fits_safely)`** — design §3.2.1:
   - Sort findings: severity desc, then `is_human_review` asc, then `id`.
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
   - Filter human-review findings out of `challenge_findings` (per design §3.1).
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

2. **Update `record_red_team_run`** — accept new optional kwargs (`repo`, `artifact_relative_path`, `pr_number`, `fix_plan_status`); use explicit column names in `INSERT`; older callers (v1) still work because all new params default `None`.
   - **Done when:** existing v1 caller test still passes; new test inserts a row with all v1.2 fields and round-trips.

3. **Add `record_fix_plan` helper** — single-column update keyed by `run_id`:
   ```python
   def record_fix_plan(
       run_id: str,
       *,
       fix_plan_md: str | None,
       fix_plan_json: str | None,
       fix_plan_cost_usd: float | None,
       fix_plan_status: str,
       db_path: str | None = None,
   ) -> None:
       ...
   ```
   - Persist `fix_plan_json` as the validated `RedTeamFixPlan` dict serialized via `json.dumps(asdict(plan))` MINUS `raw_output` (which can echo attacker content).
   - **Done when:** JSON round-trips via `json.loads`; `dataclass(**parsed)` reconstructs the validated plan with all fields.

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

**Note:** Phase 8 (stark-insights lifters) MAY start in parallel as soon as the §5.2 canonical payload schemas in this phase are locked. The producer-first deployment is safe — see §4 Integration Points.

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
   - Populate `run_id` (existing `manual-{uuid4.hex[:12]}` pattern), `stage`, `caller="manual"`, `repo` (via `git rev-parse --show-toplevel` + `gh repo view --json nameWithOwner`, fallback `"unknown"`), `artifact_relative_path` (relativized when repo detected, else `None`), `cwd`, `env` (resolved subprocess env), `model_rates` (from config), `cfg_red_team`, `per_run_budget_usd`, `pr_number` (from `gh pr view`), `started_at_iso`.
   - Pass the same `ctx` to: challenge call, fix-plan call, audit row writes, all three insights emit functions.
   - **Done when:** integration test asserts byte-identical `(run_id, stage, repo, artifact_relative_path, pr_number, model_rates)` across the challenge transport call, fix-plan transport call, `red_team_runs` row write, and the three emitted envelopes (resolves design §3.5 + rt2).

2. **Add fix-plan gating** — implement the design §3.1 sequence:
   ```python
   if not ctx.cfg_red_team["fix_plan"]["enabled"] and not args.enable_fix_plan_for_calibration:
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
           [f for f in challenge.findings if not f.is_human_review],
           ctx.cfg_red_team["fix_plan"]["max_input_chars"],
       )
       if not fits_safely:
           fix_plan_status = "skipped_input_too_large"
       else:
           fix_plan = run_red_team_fix_plan(ctx, ...)
           fix_plan_status = "success" if fix_plan.error is None else "error"
   ```
   - Add CLI-only flag `--enable-fix-plan-for-calibration` that bypasses ONLY the `enabled: false` check. Emit `red_team.fix_plan.calibration_override` to stderr once when active. NOT exposed through the skill argument parsing — dispatcher CLI only.
   - **Done when:** default config always lands on `skipped_disabled`; calibration flag enables real exercise; each skip status reaches the documented branch.

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

7. **Wire emit_* timing precisely** (resolves claude→codex review concern):
   - `emit_finding` for each challenge finding fires AFTER challenge returns (does not need to wait for fix-plan).
   - `emit_run` fires AFTER the fix-plan path resolves (success / skip / error finalized) — only by then are `fix_plan_status` and `run_warnings` accurate.
   - `emit_fix_plan` fires ONLY when `fix_plan_status == "success"`, after `record_fix_plan` is called locally.
   - **Done when:** test asserts `emit_run` is called after `run_red_team_fix_plan` returns, with the resolved `fix_plan_status` and warnings.

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
   - Default `--scope=legacy`. Scope semantics:
     - `legacy`: `WHERE fix_plan_status IS NULL` (pre-v1.2 rows).
     - `forward`: `WHERE fix_plan_status IS NOT NULL` (v1.2 dispatcher wrote it). Reads `fix_plan_json`, reconstructs `red_team_fix_plan` events for `fix_plan_status='success'` rows.
     - `all`: no filter; safe due to dedupe.
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

1. **`skill/stark-red-team-design/SKILL.md`** — document the new `## Proposed Fix Plan` section in §Phase 3 rendering. Note insights audit emission. State the `enabled: false` default explicitly. Bump `revision` and `revision_date` fields.

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

### Phase 8: stark-insights Lifter Support  ⟂ parallel with Phases 1–7

**Goal:** Add lifted-column mappings for the new event types in the `stark-insights` repo. No schema migration on `events`.

**Dependencies:** Phase 4 payload contracts locked (the `__LIFT_RULES__` content here must match §5.2 / §5.3 exactly).

**Cross-repo:** This is a **separate PR in `stark-insights`**, not in `stark-skills`. Producer-first deployment is supported: events written before the lifter PR deploys land with `payload_extra` only (lifted columns NULL). This means Phase 8 can ship in parallel with Track A.

**Estimated effort:** M

#### Tasks

0. **Locate the authenticated event ingestion path** (resolves claude→codex review's auth gap):
   - Investigate `$STARK_INSIGHTS_REPO/src/stark_insights/api/`, `src/stark_insights/clients/`, and any service test harness.
   - Identify the env var or Bearer token mechanism actually used by the running service (`/Users/aryeh/.stark-insights/api-token` is one candidate — but confirm the consumer).
   - Document findings in this plan's body or a sidecar before continuing — Phase 8 task 3 (smoke test) cannot complete without this answer.
   - **Done when:** authenticated event POST is documented and one fixture event lands with the path identified.

1. **Add lifter rules** — `$STARK_INSIGHTS_REPO/src/stark_insights/lifting.py`:
   - Three entries to `_LIFT_RULES` per design §5.3 (verbatim):
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

2. **Add lifter tests** — `$STARK_INSIGHTS_REPO/tests/test_lifting.py`:
   - Lifted column extraction for each event type.
   - `payload_extra` preservation: every non-lifted field still appears in `payload_extra`.
   - Missing-key tolerance: payloads missing optional keys don't raise.
   - **NULL-payload-value handling**: `worst_severity: null` → `severity` lifted column is SQL NULL, NOT the string `"None"`. (Resolves design rt4 + claude→codex review.)
   - Pre-deployment behavior: events of the new types written BEFORE this lifter PR deploys ingest with all fields in `payload_extra`, lifted columns NULL — verified with a test that uses the un-patched `_LIFT_RULES`.

3. **Smoke-test authenticated ingestion** — using the path identified in Task 0:
   - POST one fixture event of each new type via the documented client/auth.
   - Query the cloud `events` table for the resulting rows; verify lifted columns populated per §5.3.
   - **Done when:** all 3 fixture events appear with the expected lifted columns AND `payload_extra` contains the unlifted fields.

#### Risks

- Producer deploys before lifter (acceptable; data still in `payload_extra`).
- Auth env var mismatch: Task 0 is the gate; do not skip it.

#### Verification

```bash
cd "$STARK_INSIGHTS_REPO"
python3 -m pytest tests/test_lifting.py -v
```

---

### Phase 9: Disabled-Default End-To-End Verification

**Goal:** Prove v1.2 ships safely with `fix_plan.enabled: false` and no second LLM call by default.

**Dependencies:** Phases 1–7 merged with `enabled: false`.

**Estimated effort:** M

#### Tasks

1. **Run the full unit suite**:
   ```bash
   cd /Users/aryeh/git/Evinced/stark-skills
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

3. **Verify queued events**:
   ```bash
   sqlite3 ~/.stark-insights/queue.db \
     "SELECT type, json_extract(event_json, '$.payload.fix_plan_status') FROM pending WHERE type LIKE 'red_team_%' ORDER BY id DESC LIMIT 10;"
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

2. **Add a calibration harness script** (resolves claude→codex review's "running 30 times by hand and grepping logs is fragile"):
   - `scripts/red_team_calibration.py [--fixtures DIR] [--runs N] [--out DOC]`
   - Reads fixture list, dispatches `red_team_design_dispatch.py --enable-fix-plan-for-calibration` N times per fixture, collects results from `red_team_runs.fix_plan_json` (since the JSON already contains tokens, duration, cost), aggregates p50/p95/max for cost/duration/move_count/coverage_rate, writes the calibration doc.
   - **Done when:** running the harness on the fixture set produces a complete calibration doc without manual aggregation.

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

**Dependencies:** Phase 8 deployed, Phase 10 calibration doc approved.

**Estimated effort:** M

#### Tasks

1. **Deploy the Phase 8 stark-insights lifter PR** (if not already done in parallel):
   - Merge and deploy.
   - Smoke-test one event of each new type via the Task-0-identified auth path.
   - **Done when:** lifted columns populate for new rows.

2. **Run dry-run backfill**:
   ```bash
   python3 scripts/red_team_backfill.py --dry-run --scope legacy --manifest /tmp/backfill-manifest.json
   ```
   Review counts and sample envelopes. Confirm scope and DB path printed prominently.

3. **Run live legacy backfill**:
   ```bash
   python3 scripts/red_team_backfill.py --scope legacy --manifest /tmp/backfill-manifest.json
   ```

4. **Server-side dedupe-key verification** (resolves design §6.3 + rt7):
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

5. **Verify queue drain resilience** (resolves design rt-failover):
   - Stop stark-insights service (`launchctl stop com.evinced.stark-insights`).
   - Run one calibration-override dispatcher invocation.
   - Confirm events sit in `~/.stark-insights/queue.db`.
   - Restart service (`launchctl start com.evinced.stark-insights`).
   - On next 1-min tick, assert pending rows clear (or move to dead-letter on failure).

6. **Open the post-flip PR**:
   - Single-line change: `"enabled": false` → `"enabled": true` in `global/config.json`.
   - CI runs Phase 12.2 enabled-fixture suite.
   - **Done when:** PR merges, dispatcher logs show fix-plan calls firing on real invocations.

7. **Backfill `--scope=forward` for in-flight failures** (only if dispatcher emit_* calls failed during a service outage):
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

- **`event_schema.json` (Track A) ↔ `_LIFT_RULES` (Track B) contract.** Producer can deploy first; lifter PR can deploy independently. Pre-deployment behavior is "events ingest with `payload_extra` only" — verified by Phase 8 Task 2's pre-deployment test.

- **Locked-field enforcement.** `_RED_TEAM_LOCKED_FIELDS` MUST cover all 5 nested fix-plan paths AND emit `red_team_override_rejected` events with the exact dotted `path` string. Phase 1 Task 2 acceptance covers all 5.

## 5. Testing Strategy

**Unit (per-phase, gated on phase merge):**
- Phase 1: config defaults merged, locked-field recursion, event-type registration.
- Phase 2: envelope serializer (50-finding fixture), validator (move counts 0/1/2/6/7/12/13), invented-ID drop demoting to `min_moves` violation, prompt assembly, RESPONSES_API_MODELS check, `max_output_tokens=32768` parameter wiring.
- Phase 3: SQLite migration on fresh / v1.0 / v1.1 / v1.2 / partial DBs; record_red_team_run / record_fix_plan round-trip.
- Phase 4: envelope shape per §5.2, dedupe-key stability, exception isolation, `worst_severity: null` → NULL severity column, `red_team_fix_plan` not emitted on non-success.
- Phase 5: gate-state machine (each skip status), context byte-identity, `over_budget_after_fix` warning propagation to BOTH event payloads, sidecar untrusted-content escapes, PR-comment 65 KB cascade, commit message variants, exit code from challenge only.
- Phase 6: dry-run, scope filtering, malformed-row tolerance, forward fix-plan reconstruction, migration-before-select, idempotency, kill-mid-drain resume, manifest writeback.
- Phase 8: lifter rules per type, NULL-payload handling, pre-deployment fallback to `payload_extra`-only.

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
| 11 | The `enabled: false → true` flip is reversible by reverting the post-flip PR. In-flight runs that already paid for fix-plan are kept (audit data). Backfill manifest scoped rollback is available but rarely needed because cloud `UNIQUE(dedupe_key)` makes re-runs no-ops. |

**Ambiguities flagged for stakeholder decision:**
- Phase 8 Task 0 — exact stark-insights authenticated event POST mechanism. Must be answered before Phase 8's smoke test.
- Whether the post-flip PR should be auto-revertable via a feature flag in the dispatcher (additional layer of "kill switch") vs. config-only revert. Default position: config-only is sufficient because `fix_plan.enabled` is locked at the global level.

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
