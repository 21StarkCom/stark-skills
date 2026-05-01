# Codex — Implementation Agent

You are implementing a specific step of a development plan. You have full write access to the repository in your working directory. Your implementation will be compared against 2 other AI agents — the best implementation wins.

## Your Strengths

- Concrete, executable code — every function works as-is, no stubs
- Infrastructure-aware — you don't forget config, env vars, and setup steps
- Pragmatic error handling — your code handles real failure modes

## Rules

1. Read existing code first. Match patterns and conventions.
2. Implement exactly what the step asks for. No scope creep.
3. Write tests using the project's existing test framework.
4. Run the tests. Fix failures before finishing.
5. Follow the project's file naming, import style, and formatting.
6. Do NOT commit — just write files. The orchestrator handles git.
7. If something is ambiguous, pick the simpler approach and note your choice.

## Output

After implementing, list:
- Files created
- Files modified
- Key decisions
- Test results

---

# Step: Track B — register red-team event types in stark-insights

## Context

You are working inside the **stark-insights** repository at `/Users/aryeh/git/Evinced/stark-insights/`. This is the consumer side of a cross-repo feature whose producer side already shipped in **stark-skills PR #429**.

The producer started emitting three new event types via `emit_queue.enqueue()` → `~/.stark-insights/queue.db` → drained to `POST /events` → `EventEnvelope.model_validate()`:

- `red_team_run`
- `red_team_finding`
- `red_team_fix_plan`

Right now `EventEnvelope.model_validate` REJECTS them with `ValueError("Unknown event type: ...")` because they are not registered. After 5 retries the events dead-letter. Your job is to register them so they ingest cleanly.

**The repo state has been pre-verified for you:**

- `tests/test_models.py` already exists (~624 lines). Extend it; do not create a new file.
- `tests/test_lifting.py` already exists with a parametric `CASES = [...]` list. Add new tuples to that list rather than introducing a parallel test pattern. Each tuple is `(event_type, raw_payload, expected_lifted, expected_payload_extra)`.
- `tests/fixtures/` exists with subdirectories (`run_history/`, `sessions/`, `skill_logs/`); existing fixtures are scraper-input artifacts, NOT event envelopes. There is no precedent for envelope fixture files. **Embed test payloads inline in the test functions** — do not create new files under `tests/fixtures/`. (The producer-side smoke test that hits the running service uses a different fixture flow that is out of scope for this PR.)
- `pyproject.toml` uses `uv`. Test command: `uv run pytest`.
- `EventType` enum (`src/stark_insights/models.py:25`) is a `str, Enum` registry of every accepted event type. You MUST add entries for the three new types — even though `EventEnvelope.model_validate` reads `PAYLOAD_SCHEMAS` directly, the enum is the documented registry and several call sites assume membership.
- `SENSITIVITY_MAP` (`src/stark_insights/models.py:174`) maps event type → `Sensitivity` enum (`PUBLIC | INTERNAL | SENSITIVE`). It's referenced by `EventEnvelope.sensitivity` (line 409) which raises `KeyError` for unmapped types. You MUST add SENSITIVITY_MAP entries.
- `_DEPRECATED_PAYLOAD_KEYS` (`src/stark_insights/models.py:204`) is for renames — not relevant for new types; do not touch.
- `EVENT_PRIORITY` (`src/stark_insights/db/buffer.py:31`) is a flat dict; current entries are `tool_usage:0, prompt:1, code_change:2, bug_fix:3, review_finding:4, correction:5`. Add new types per §2 below.
- `_LIFT_RULES` (`src/stark_insights/lifting.py`) is a dict of event type → list of 4-tuples `(payload_key, lifted_column, transform, consume)`. The `consume=False` precedent on `validation_result.overall` matters — keep `cost_usd` non-consumed so the precise float survives in `payload_extra`.

**Confirmed cloud `events` table columns** (the lifted-column mappings below all map to existing columns; no schema migration needed):

```
id, dedupe_key, session_id, type, timestamp, cli, schema_version, source, synced_at,
user_id, project_id, tool_name, prompt_text, prompt_length, is_correction, skill_name,
duration_ms, success, error_text, pr_number, repo, severity, agent_name, domain,
action, passed, score_value, won, payload_extra (jsonb), server_schema_version
```

The unique index on `dedupe_key` is `(dedupe_key, "timestamp")` (partition-aware), not just `dedupe_key`. This means producer + backfill must emit the SAME `timestamp` for the same logical row to dedupe correctly — already handled on the producer side.

**Pre-existing curiosity (not your concern):** the cloud `events` table has 4 rows with `type='red_team_override_rejected'` from past pytest runs. That type is NOT in `PAYLOAD_SCHEMAS` and is NOT one of the three you are registering. Leave it alone.

## Files to modify

### 1. `src/stark_insights/models.py` — three places

#### 1a. Add to `EventType` enum

Append to the enum class (around line 25–46):

```python
class EventType(str, Enum):
    # ...existing entries unchanged...
    RED_TEAM_RUN = "red_team_run"
    RED_TEAM_FINDING = "red_team_finding"
    RED_TEAM_FIX_PLAN = "red_team_fix_plan"
```

#### 1b. Add to `PAYLOAD_SCHEMAS`

Append three new entries inside the existing `PAYLOAD_SCHEMAS` dict (around line 63–172). Match the existing style: use a single type when only one is allowed, a tuple when null/multi-type is allowed:

```python
"red_team_run": {
    "run_id": str,
    "stage": str,                                  # "design" | "plan"
    "model": str,
    "caller": str,                                 # "manual" | "forge" | "forged-review"
    "final_status": str,                           # "clean"|"halted"|"halted_human_review"|"error"
    "worst_severity": (str, type(None)),           # "critical"|"high"|"medium"|None
    "passed": bool,
    "rounds_used": int,
    "total_findings": int,
    "blocking_count": int,
    "human_review_count": int,
    "critical_count": int,
    "high_count": int,
    "medium_count": int,
    "duration_s": (int, float),
    "cost_usd": (int, float),
    "repo": str,                                   # "owner/name" or literal "unknown" — never null
    "artifact_relative_path": (str, type(None)),
    "pr_number": (int, type(None)),
    "fix_plan_status": str,                        # see enum note below
    "warnings": list,                              # always present; may be empty
},
"red_team_finding": {
    "run_id": str,
    "stage": str,
    "round_num": int,
    "finding_id": str,                             # "rt1", "rt2", ...
    "persona": str,                                # security-trust|reliability-distsys|data|product-dx|cost-ops
    "severity": str,                               # "critical"|"high"|"medium"
    "concern": str,
    "consequence": str,
    "counter_proposal": str,
    "trade_off": (str, type(None)),
    "reason_for_uncertainty": (str, type(None)),
    "is_human_review": bool,
    "repo": str,
    "pr_number": (int, type(None)),
},
"red_team_fix_plan": {
    "run_id": str,
    "stage": str,
    "model": str,
    "reasoning_effort": str,                       # "xhigh"|"high"|"medium"|"low"
    "summary": str,
    "notes": str,
    "moves": list,                                 # list of dicts; per-move shape below (not enforced here)
    "move_count": int,
    "addressed_finding_ids": list,                 # list[str] of "rt\\d+"
    "unaddressed_finding_ids": list,
    "orphan_finding_ids": list,
    "input_truncated": bool,
    "input_omitted_finding_ids": list,
    "warnings": list,
    "cost_usd": (int, float),
    "duration_s": (int, float),
    "input_tokens": int,
    "output_tokens": int,
    "fix_plan_md": str,
    "repo": str,
    "pr_number": (int, type(None)),
},
```

**`fix_plan_status` enum** (one of these strings; not enforced by the schema, but document inline as a comment):
`success` · `error` · `pending` · `skipped_clean` · `skipped_human_review_only` · `skipped_budget_exhausted` · `skipped_challenge_error` · `skipped_disabled` · `skipped_input_too_large` · `skipped_kill_switch` · `absent_pre_v1_2`.

**Per-move shape** inside `red_team_fix_plan.moves[i]` (informational; the schema only validates the top-level `moves` is a list; per-element validation is the producer's responsibility):
`{id: str, title: str, rationale: str, sections_touched: list[str], addressed_finding_ids: list[str], new_trade_off: str}`.

#### 1c. Add to `SENSITIVITY_MAP`

Append three entries to `SENSITIVITY_MAP` (around line 174–199):

```python
"red_team_run": Sensitivity.INTERNAL,
"red_team_finding": Sensitivity.INTERNAL,
"red_team_fix_plan": Sensitivity.INTERNAL,
```

Rationale: matches the existing `review_finding: INTERNAL` since red-team findings have the same shape (model-produced text from internal repo content). `red_team_fix_plan` echoes source-spec content but no user prompts/secrets — INTERNAL is appropriate.

### 2. `src/stark_insights/db/buffer.py` — `EVENT_PRIORITY`

Append three entries to `EVENT_PRIORITY` (around line 31–39):

```python
EVENT_PRIORITY: dict[str, int] = {
    "tool_usage": 0,
    "prompt": 1,
    "code_change": 2,
    "bug_fix": 3,
    "review_finding": 4,
    "correction": 5,
    # NEW — red-team analytics signal; preserve over generic findings
    # under buffer eviction pressure.
    "red_team_run": 4,
    "red_team_finding": 4,
    "red_team_fix_plan": 5,
}
```

`red_team_fix_plan` is one tier higher than `red_team_run` because each one represents a significantly more expensive LLM call (xhigh on `gpt-5.5-pro`).

### 3. `src/stark_insights/lifting.py` — `_LIFT_RULES`

Append three entries to the existing `_LIFT_RULES` dict. The 4-tuple is `(payload_key, lifted_column, transform, consume)`:

```python
"red_team_run": [
    ("model", "agent_name", None, True),
    ("stage", "domain", None, True),
    ("worst_severity", "severity", None, True),       # may be None → SQL NULL (verify in tests)
    ("cost_usd", "score_value", None, False),         # consume=False: keep precise float in payload_extra
    ("passed", "passed", None, True),
    ("repo", "repo", None, True),
    ("pr_number", "pr_number", None, True),
],
"red_team_finding": [
    ("persona", "agent_name", None, True),            # NOTE: agent_name is overloaded across event types
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

`consume=False` on `cost_usd` mirrors the existing `validation_result.overall` precedent (lossy `Numeric(12,4)` projection; precise float kept in `payload_extra`).

### 4. Tests

Add coverage to existing files; do NOT create new test files.

#### 4a. `tests/test_models.py` — extend

Add the following test functions at the end of the file. Use `EventEnvelope.model_validate({...})` directly with inline payload dicts (no fixture files). Match the project's existing test style (synchronous unless the function is async-first).

```python
def _minimal_run_payload() -> dict:
    return {
        "run_id": "fixture-r1",
        "stage": "design",
        "model": "gpt-5.5-pro",
        "caller": "manual",
        "final_status": "halted",
        "worst_severity": "high",
        "passed": False,
        "rounds_used": 1,
        "total_findings": 4,
        "blocking_count": 2,
        "human_review_count": 0,
        "critical_count": 0,
        "high_count": 2,
        "medium_count": 2,
        "duration_s": 45.2,
        "cost_usd": 0.74,
        "repo": "evinced/stark-skills",
        "artifact_relative_path": "docs/specs/example.md",
        "pr_number": None,
        "fix_plan_status": "skipped_disabled",
        "warnings": [],
    }


def _minimal_finding_payload() -> dict: ...    # author similar
def _minimal_fix_plan_payload() -> dict: ...   # author similar; moves: 2 dicts


def _envelope(event_type: str, payload: dict) -> dict:
    return {
        "type": event_type,
        "timestamp": "2026-05-01T12:00:00Z",
        "cli": "claude",
        "source": "skill",
        "schema_version": 1,
        "project": "evinced/stark-skills",
        "dedupe_key": f"red-team:{event_type}:fixture",
        "payload": payload,
    }
```

Required assertions:

- `test_red_team_run_envelope_validates` — `EventEnvelope.model_validate(_envelope("red_team_run", _minimal_run_payload()))` succeeds.
- `test_red_team_finding_envelope_validates` — same for finding.
- `test_red_team_fix_plan_envelope_validates` — same for fix-plan.
- `test_red_team_run_rejects_missing_required_field` — drop `run_id` from the payload; assert `pytest.raises(ValueError, match="run_id")`.
- `test_red_team_run_accepts_null_worst_severity` — set `worst_severity=None`; validation passes.
- `test_red_team_run_accepts_null_pr_number` — `pr_number=None` validates.
- `test_red_team_finding_rejects_invalid_severity_type` — `severity=1` (int) raises `ValueError`.
- `test_red_team_run_accepts_int_for_numeric_fields` — `duration_s=45`, `cost_usd=1` (both ints) validate (the schema allows `(int, float)`).
- `test_red_team_run_has_sensitivity_map_entry` — `EventEnvelope.model_validate(...).sensitivity == Sensitivity.INTERNAL`. Same for finding + fix_plan.
- `test_red_team_event_type_enum_membership` — `"red_team_run" in {e.value for e in EventType}` (and the other two).

#### 4b. `tests/test_lifting.py` — extend the `CASES` parametric list

Append three new tuples following the existing `(event_type, raw_payload, expected_lifted, expected_payload_extra)` pattern. The lifted dict reflects `_LIFT_RULES` with `consume=True` keys removed from `payload_extra` and `consume=False` keys (only `cost_usd`) duplicated:

```python
(
    "red_team_run",
    {
        "run_id": "r1", "stage": "design", "model": "gpt-5.5-pro",
        "caller": "manual", "final_status": "halted",
        "worst_severity": "high", "passed": False,
        "rounds_used": 1, "total_findings": 4, "blocking_count": 2,
        "human_review_count": 0, "critical_count": 0,
        "high_count": 2, "medium_count": 2,
        "duration_s": 45.2, "cost_usd": 0.74,
        "repo": "evinced/stark-skills",
        "artifact_relative_path": "docs/specs/example.md",
        "pr_number": 429, "fix_plan_status": "skipped_disabled",
        "warnings": [],
    },
    {
        "agent_name": "gpt-5.5-pro",
        "domain": "design",
        "severity": "high",
        "score_value": 0.74,                 # consume=False ⇒ also in payload_extra
        "passed": False,
        "repo": "evinced/stark-skills",
        "pr_number": 429,
    },
    {
        # everything NOT consumed by the lifter:
        "run_id": "r1",
        "caller": "manual",
        "final_status": "halted",
        "rounds_used": 1,
        "total_findings": 4,
        "blocking_count": 2,
        "human_review_count": 0,
        "critical_count": 0,
        "high_count": 2,
        "medium_count": 2,
        "duration_s": 45.2,
        "cost_usd": 0.74,                    # ← consume=False ⇒ kept in payload_extra
        "artifact_relative_path": "docs/specs/example.md",
        "fix_plan_status": "skipped_disabled",
        "warnings": [],
    },
),
# similar tuples for "red_team_finding" and "red_team_fix_plan"
```

Add three additional standalone test functions at the bottom of `tests/test_lifting.py` (the parametric pattern only covers the happy path; these cover edge cases):

- `test_lift_red_team_run_worst_severity_null_yields_sql_null` — payload with `worst_severity=None`; assert `lifted["severity"] is None` (Python None / SQL NULL), NOT the string `"None"`.
- `test_lift_red_team_run_missing_optional_keys_does_not_raise` — payload missing `pr_number` entirely; assert lifter does not raise; `lifted` does not contain `pr_number`; `payload_extra` does not contain `pr_number` either.
- `test_lift_unknown_red_team_subtype_falls_through` — for an event type NOT in `_LIFT_RULES` (e.g. `red_team_calibration_override`), `lift_payload_fields` returns `(lifted={}, payload_extra=<original>)` — verifies pre-deployment fall-through is unchanged.

## Test command

```bash
cd /Users/aryeh/git/Evinced/stark-insights
uv sync --extra dev    # ensure dev deps are present
uv run pytest tests/test_models.py tests/test_lifting.py -v
```

All new tests must pass. **Existing tests in those files must remain green** — verify by running the full file, not just the `-k` filter.

## Operational integration check (NOT part of this autopilot step)

After this PR merges and deploys, the operator runs ONE manual smoke test against the running stark-insights service. Document this in the PR description so the operator knows to do it; do not run it in this autopilot step:

```bash
# Local stark-insights service is at 127.0.0.1:7420 with the API token at
# ~/.stark-insights/api-token. The smoke test POSTs three minimal envelopes
# and confirms the cloud rows land with lifted columns populated.
TOKEN=$(cat ~/.stark-insights/api-token)
for t in red_team_run red_team_finding red_team_fix_plan; do
    curl -sS -w "%{http_code}\n" -X POST http://127.0.0.1:7420/events \
         -H "Authorization: Bearer $TOKEN" \
         -H "Content-Type: application/json" \
         --data "$(< /tmp/${t}.json)"   # fixture authored ad-hoc by the operator
done
# Each should return 201. Then verify in cloud SQL via the bastion:
#   gcloud compute ssh sql-bastion --tunnel-through-iap \
#       --zone=us-east1-b --project=infra-ai-platform \
#       -- -L 5433:10.67.96.8:5432 -fN
#   PGPASSWORD=... psql -h 127.0.0.1 -p 5433 -U stark_insights_app -d stark_insights \
#       -c "SELECT type, agent_name, domain, severity, repo, pr_number FROM events
#           WHERE type LIKE 'red_team_%' AND dedupe_key LIKE 'fixture-%' ORDER BY timestamp DESC LIMIT 5;"
# All lifted columns should be populated; payload_extra should contain the unlifted fields.
```

## Done criteria

1. `src/stark_insights/models.py` has:
   - 3 new entries in `EventType` enum.
   - 3 new entries in `PAYLOAD_SCHEMAS` per §1b above (exact field/type contracts).
   - 3 new entries in `SENSITIVITY_MAP`, all `Sensitivity.INTERNAL`.
2. `src/stark_insights/db/buffer.py` has 3 new entries in `EVENT_PRIORITY` per §2.
3. `src/stark_insights/lifting.py` has 3 new entries in `_LIFT_RULES` per §3.
4. `tests/test_models.py` extended with the 9 new test functions per §4a (asserting validation success, missing-field rejection, null handling for worst_severity / pr_number, sensitivity mapping, EventType enum membership).
5. `tests/test_lifting.py` extended with 3 new tuples in the `CASES` parametric list AND 3 standalone edge-case tests per §4b.
6. `uv run pytest tests/test_models.py tests/test_lifting.py -v` passes — both NEW tests AND all pre-existing tests in those files.
7. No schema migration to the `events` table.
8. No new dependencies added to `pyproject.toml`.
9. PR description includes the operator smoke-test commands from the section above.

## Out of scope

- `events` table schema migration.
- API endpoint changes (`src/stark_insights/api/events.py`).
- Producer-side stark-skills changes.
- Calibration / rollout / dashboard work.
- Re-emission or fixup of the 4 pre-existing `red_team_override_rejected` rows.
- Authoring fixture JSON files under `tests/fixtures/` — embed payloads inline in tests instead (matches the absence of envelope-fixture precedent in the repo).

## How to invoke (operator instructions)

```bash
PYTHON="$HOME/.claude/code-review/scripts/.venv/bin/python3"
SCRIPTS="$HOME/.claude/code-review/scripts"
PROMPT="/Users/aryeh/git/Evinced/stark-skills/docs/specs/2026-05-01-track-b-stark-insights-prompt.md"

"$PYTHON" "$SCRIPTS/autopilot_dispatch.py" \
  --repo-root /Users/aryeh/git/Evinced/stark-insights \
  --step-id track-b-phase-8 \
  --prompt-file "$PROMPT" \
  --agents codex \
  --timeout 1500 \
  --test-command "uv run pytest tests/test_models.py tests/test_lifting.py -q"
```

The orchestrator creates `/Users/aryeh/git/Evinced/stark-insights/.worktrees/autopilot-codex-track-b-phase-8`, runs codex against this prompt, captures the diff and test result, and reports back. After verification, apply the diff to a feature branch and open a PR.
