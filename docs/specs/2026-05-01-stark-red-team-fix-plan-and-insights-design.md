# stark-red-team — v1.2: Fix Plan + Insights Audit

**Status:** Draft
**Author:** Aryeh Kiovetsky (brainstorm w/ Claude)
**Date:** 2026-05-01
**Related:**
- [stark-red-team v1 design (2026-04-12)](./2026-04-12-stark-red-team-design.md) — original spec this builds on
- [stark-red-team v1.1 followups (2026-04-27)](./2026-04-27-red-team-followups.md) — `gpt-5.5-pro` swap, parse-error tightening, etc.

## 1. Purpose

Two enhancements to `/stark-red-team-design` and `/stark-red-team-plan`:

1. **Fix-plan generation.** After the existing challenge call produces blocking findings, run a SECOND LLM call (`gpt-5.5-pro` at reasoning effort `xhigh`) that proposes a synthesis-level patch plan: 2–6 architectural moves resolving the cross-persona tensions named by the committee, each move mapped to the specific finding IDs it addresses. The plan is appended to the existing `<artifact>.red-team.md` sidecar so the orchestrating Claude can read it alongside the findings and decide what to apply.

2. **Stark-insights audit.** Every red-team run (run-level rollup, per-finding events, and the fix plan when present) is emitted as new event types into stark-insights, extending — not replacing — the existing local-SQLite audit. The local DB stays as the dispatcher's authoritative on-disk record (and as the source for backfill); stark-insights becomes the cross-machine, cloud-synced layer for dashboards. A one-shot backfill script ingests the historical local-SQLite rows.

This is **still a challenge-only skill** — the fix plan is advisory output, not a fix loop. Claude (or the user) decides what to apply. The `<artifact>.red-team.md` sidecar grows a "Proposed Fix Plan" section; everything else stays as-is.

**Non-goals:**
- No automatic application of the fix plan to the design/plan doc — the pipeline is read-only on the artifact.
- No multi-round refinement — fix plan is a single call, like the challenge.
- No new persona files — the fix plan is a single-architect synthesis, not a committee.
- No stark-insights schema change to the `events` table — existing lifted columns + `payload_extra` JSONB suffice. Only `lifting.py` rules are added.

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  /stark-red-team-design       /stark-red-team-plan                   │
└──────────────────────┬───────────────────────────────────────────────┘
                       ▼
              red_team_<stage>_dispatch.py
                       │
                       ├─► stark_red_team.run_red_team(...)            │ EXISTING
                       │       gpt-5.5-pro · effort=high · 1 call      │ challenge
                       │       → RedTeamResult                         │
                       │
                       ├─► stark_red_team.run_red_team_fix_plan(...)   │ NEW
                       │       gpt-5.5-pro · effort=xhigh · 1 call     │ fix call
                       │       fires only when blocking_count > 0      │
                       │       → RedTeamFixPlan                        │
                       │       skipped if budget already exhausted     │
                       │
                       ├─► render sidecar markdown                     │
                       │       findings table + detail (existing)      │
                       │       + "## Proposed Fix Plan" section (NEW)  │
                       │
                       ├─► local SQLite audit (red_team_audit.py)      │
                       │       red_team_runs (six new NULL columns):   │
                       │           + repo, artifact_relative_path      │
                       │           + fix_plan_status, fix_plan_md,     │
                       │             fix_plan_json, fix_plan_cost_usd  │
                       │       red_team_findings                       │
                       │       red_team_persona_stats                  │
                       │
                       └─► red_team_insights.py  (NEW helper module)   │
                               emit `red_team_run`     event           │
                               emit `red_team_finding` events          │
                               emit `red_team_fix_plan` event (if any) │
                               via emit_queue → ~/.stark-insights queue│
                               → drains async to /events HTTP endpoint │

                          ───── separate one-shot ─────
                          red_team_backfill.py (NEW)
                              reads local forged_review_metrics.db
                              re-emits historical rows as the same
                              three event types with stable
                              backfill-* run_ids (idempotent dedupe)
```

### What changes vs. v1

| Layer | v1 | v1.2 |
|---|---|---|
| Calls per invocation | 1 (challenge) | 2 (challenge + fix-plan, latter gated) |
| Output | sidecar findings + PR comment | sidecar findings + **fix plan** + PR comment |
| Audit | local SQLite only | local SQLite **+ stark-insights events** |
| Historical data | local SQLite only | also in stark-insights via backfill |
| Per-run budget | $15.00 | **$30.00** (covers xhigh fix call) |

### What does NOT change

- Per-persona prompt files, preamble, challenge stage prompts (`design.md` / `plan.md`).
- The challenge call's model, reasoning effort, transport (Responses API / codex CLI).
- The `RedTeamResult` schema — fix plan is a separate dataclass, returned in a separate field.
- PR commenting bot identity (`stark-claude[bot]`), commit message scope, sidecar path.
- The locked-fields enforcement (`personas`, `model`, `enabled`, etc.).
- Failure-mode contracts already in v1 (`halted_human_review`, `halted_budget`, etc.).

## 3. Fix-plan call

### 3.1 Gating

The fix call fires iff (in order):

```python
cfg["fix_plan"]["enabled"]                          # 1. kill switch on
and challenge.error is None                         # 2. no upstream error
and challenge.blocking_count > 0                    # 3. work to do
and challenge.cost_usd < per_run_budget_usd         # 4. budget remaining
and findings_serialization_fits(...)                # 5. input not over-truncated (§3.2)
```

**Budget policy (single, authoritative).** Pre-call gating is **only** a check that the challenge has not already consumed the budget — `challenge.cost_usd < per_run_budget_usd`. We do **not** estimate the fix call's cost pre-flight; the `max_output_tokens` cap (32 768) and `timeout_s` bound the runaway case, and the §11.1 worst-case computation plus the $30 budget already accounts for the typical case. **Post-call**, after `fix_plan.cost_usd` is known, the dispatcher computes `total_cost_usd = challenge.cost_usd + fix_plan.cost_usd` and, if it exceeds `per_run_budget_usd`, emits a structured `over_budget_after_fix` warning (recorded in the `warnings` field of the `red_team_run` event payload — see §10) and prints to stderr. This does NOT halt the skill — by the time we know, the cost has been incurred — but the warning is a calibration signal: persistent `over_budget_after_fix` events should drive a budget bump in a follow-up PR, not a runtime halt. §11.2 acceptance covers tests at challenge cost just below, at, and above the budget.

Skipped (with a sidecar note explaining why) when:

| Skip reason | Sidecar `fix_plan_status` |
|---|---|
| Challenge call errored | `skipped_challenge_error` |
| Status is `clean` (no blocking findings) | `skipped_clean` |
| Status is `halted_human_review` AND blocking_count == 0 | `skipped_human_review_only` |
| Already over budget after challenge | `skipped_budget_exhausted` |
| `red_team.fix_plan.enabled` is `false` (kill switch) | `skipped_disabled` |
| Findings JSON cannot be safely serialized within `max_input_chars` (§3.2) | `skipped_input_too_large` |

When ONLY blocking-but-also-some-human-review findings exist, the fix call still fires for the blocking ones; human-review findings are excluded from the fix-call input (preserving the "this needs human judgment" signal).

### 3.2 Prompt assembly

Mirrors `assemble_prompt` for the challenge call but uses a separate prompt file:

```
1. global/prompts/red-team/fix-plan.md           (NEW — system prompt + schema)
2. <<<RED_TEAM_INPUT name="artifact">>>           original design or plan
3. <<<RED_TEAM_INPUT name="source_spec">>>        same as challenge call
4. <<<RED_TEAM_INPUT name="findings_envelope">>>  JSON envelope (§3.2.1)
5. <<<RED_TEAM_INPUT name="synthesis">>>          challenge synthesis paragraph
```

The fix call does NOT see persona files. Per-persona viewpoints are already encoded in the findings + synthesis. The fix call is a single architect.

Same input-injection defenses as the challenge call (delimiter wrapping, SHA-256 tagging, `_escape_delimiters`, `max_input_chars` truncation) apply to artifact and source_spec. Findings JSON is wrapped in `<<<RED_TEAM_INPUT>>>` because the model produced its content from attacker-controlled inputs — but its truncation is structured (see §3.2.1).

#### 3.2.1 Truncation-safe findings envelope

A naive `_truncate(json.dumps(findings), max_input_chars)` would corrupt the JSON mid-object and the model would either fail to parse or silently see a half-finding with an incoherent ID. Instead, findings are serialized via `serialize_findings_envelope(findings, max_chars) → (envelope_json, omitted_ids, fits_safely)`:

```json
{
  "truncated": false,
  "omitted_finding_ids": [],
  "findings": [
    { "id": "rt1", "persona": "security-trust", "severity": "critical", ... },
    ...
  ]
}
```

Algorithm:

1. Sort findings by severity descending (`critical > high > medium`), then by `is_human_review` ascending (blocking first), then by `id` for stable ordering.
2. Greedy-add findings to the envelope, recomputing the serialized length after each add.
3. If a finding would push the envelope over `max_chars`, omit it and add its `id` to `omitted_finding_ids`. Do **not** include its partial JSON.
4. If `omitted_finding_ids` is non-empty, set `truncated: true`.
5. Return `fits_safely = (no blocking finding was omitted)`.

If `fits_safely is False`, the dispatcher SKIPS the fix call with `fix_plan_status=skipped_input_too_large` rather than calling with a fix-plan that can't address the omitted blocking findings (per §3.1). When `truncated is True` but only medium/human-review findings were omitted, the fix call still fires; the sidecar's "Notes" section flags the omission.

The fix-plan output schema (§3.3) gains a corresponding `input_truncated: bool` and `input_omitted_finding_ids: list[str]` field so audit trails record the input-side truncation independently of any output-side coverage gaps.

### 3.3 Output schema

```python
@dataclass
class FixPlanMove:
    id: str                             # "m1", "m2", ... — stable within a plan
    title: str                          # 1 line ≤ 100 chars; the architectural move
    rationale: str                      # 2-4 sentences; what tension this resolves
    sections_touched: list[str]         # ["§4.2", "§5"] — design sections affected
    addressed_finding_ids: list[str]    # ["rt1", "rt3"] — challenge findings resolved
    new_trade_off: str                  # what this move gives up (mandatory)


@dataclass
class RedTeamFixPlan:
    summary: str                        # ≤ 100 words; "if you do these N things, the committee is addressed"
    moves: list[FixPlanMove]            # cfg.fix_plan.min_moves ≤ len ≤ cfg.fix_plan.max_moves
    unaddressed_finding_ids: list[str]  # blocking findings the plan deliberately doesn't address
    orphan_finding_ids: list[str]       # blocking IDs the model emitted neither addressed nor unaddressed
    notes: str                          # 0-300 words; rationale for unaddressed; cross-tension calls
    input_truncated: bool               # set when serialize_findings_envelope truncated (§3.2.1)
    input_omitted_finding_ids: list[str] # IDs the prompt didn't show the model
    warnings: list[str]                 # post-validation warnings (e.g., "move_cap_hit", "ids_invented")
    raw_output: str                     # preserved for in-memory audit only; not persisted
    duration_s: float
    cost_usd: float
    input_tokens: int
    output_tokens: int
    model: str                          # the resolved model name (e.g., "gpt-5.5-pro")
    reasoning_effort: str               # "xhigh"
    error: str | None = None
```

**Move-count contract** (single source of truth; resolves rt11):

- `cfg.fix_plan.min_moves` defaults to `2`.
- `cfg.fix_plan.max_moves` defaults to `6`.
- A model output with `len(moves) < min_moves` or `len(moves) > max_moves * 2` is treated as a hard error (`error="fix-plan returned N moves; expected min..max"`), no rendering of the partial plan. The `* 2` slack accommodates over-eager models without rejecting plans that can be safely pruned.
- A model output with `max_moves < len(moves) <= max_moves * 2` is **pruned** post-parse: the `max_moves` highest-leverage moves are kept (ranked by `len(addressed_finding_ids)` desc, then by order in raw output). Pruned moves' addressed IDs are recomputed against the kept moves; any blocking IDs no longer covered move into `unaddressed_finding_ids`. A `move_cap_hit` warning is appended.
- Min violations are never auto-padded — the dispatcher does not synthesize moves to meet `min_moves`.

### 3.4 Schema validation

Post-parse validation in `validate_fix_plan(raw, blocking_finding_ids, cfg) → RedTeamFixPlan`:

- **Move count** per the §3.3 contract: `min_moves <= len <= max_moves` is the success path; `max_moves < len <= max_moves * 2` is pruned with a `move_cap_hit` warning; outside that range is a hard `error`.
- Every move has non-empty `id`, `title`, `rationale`, `new_trade_off`. `sections_touched` and `addressed_finding_ids` may be empty (lists) but must be present.
- `move.addressed_finding_ids ⊆ blocking_finding_ids`. Invented IDs are dropped from the move; `ids_invented` warning recorded. If after dropping a move has zero addressed IDs AND zero `sections_touched`, the move itself is dropped (it's a no-op); the post-drop count is re-checked against `min_moves`.
- Move IDs are unique within a plan; collisions get suffixed (`m2`, `m2_dup` → `m2`, `m3`).
- **Coverage rules** (single, ordered):
  1. `addressed = ∪{move.addressed_finding_ids}` (after invented-ID drop and pruning).
  2. `model_unaddressed = unaddressed_finding_ids` from raw output, intersected with `blocking_finding_ids` (model-invented IDs dropped here too).
  3. `model_unaddressed = model_unaddressed - addressed` (move wins on conflict).
  4. `orphan_finding_ids = blocking_finding_ids - addressed - model_unaddressed`.
  5. Final `unaddressed_finding_ids = model_unaddressed` (does NOT include orphans). `orphan_finding_ids` is its own field on `RedTeamFixPlan` so dashboards can distinguish "deliberately deferred" from "model forgot".
- The sidecar renderer surfaces orphans explicitly (§4.1) so the operator sees that the model never assigned a verdict to those findings.
- `summary`, `notes` are strings (may be empty). `summary` truncated at 1000 chars, `notes` at 3000.
- Per-field length caps (rt13 hardening): `title ≤ 200 chars`, `rationale ≤ 1000 chars`, `new_trade_off ≤ 500 chars`, `sections_touched` capped at 20 entries each ≤ 100 chars. Over-cap fields are truncated with `...[CAP]` marker; corresponding `field_capped` warning recorded.

Validation never raises — invalid plans set `error` and the dispatcher renders an error section in the sidecar.

### 3.5 Dispatch — shared run context

To avoid duplicate state propagation between the design and plan dispatchers (rt2), v1.2 introduces a shared `RedTeamRunContext` carried through the whole invocation:

```python
@dataclass(frozen=True)
class RedTeamRunContext:
    run_id: str                       # generated once at dispatcher start; uuid4-suffixed
    stage: str                        # "design" | "plan"
    caller: str                       # "manual" | "forge" | "forged-review"
    repo: str                         # canonical "owner/name" or "unknown"
    artifact_relative_path: str | None # path relative to repo root, None when no repo
    cwd: str | None                   # working dir for codex-CLI dispatches (kept for parity)
    env: dict[str, str]               # the resolved subprocess env (with OPENAI_API_KEY etc.)
    model_rates: dict[str, Any]
    cfg_red_team: dict[str, Any]      # the merged red_team config (with locks already applied)
    per_run_budget_usd: float
    pr_number: int | None             # for insights event correlation
    started_at_iso: str               # canonical timestamp for downstream events
```

The dispatcher constructs this context once at start. `run_red_team(...)`, `run_red_team_fix_plan(...)`, the local audit, and `red_team_insights.emit_*` ALL accept this context (or specific fields from it) as their primary identity input. The `run_id` is reused across all three persistence sinks so a single skill invocation produces a single, joinable trail.

```python
def run_red_team_fix_plan(
    ctx: RedTeamRunContext,
    *,
    artifact: str,
    source_spec: str,
    challenge_findings: list[RedTeamFinding],
    synthesis: str,
    challenge_cost_usd: float,
) -> RedTeamFixPlan:
    """Single attempt. Internally:
      - reads model/reasoning_effort/timeout_s/max_moves/max_input_chars from
        ctx.cfg_red_team["fix_plan"]
      - serializes findings via serialize_findings_envelope (§3.2.1)
      - dispatches via dispatch_responses_api with ctx.env
      - validates via validate_fix_plan(..., cfg=ctx.cfg_red_team["fix_plan"])
      - returns RedTeamFixPlan; never raises (errors land on .error)
    """
    ...
```

Implementation parallels `run_red_team` — assemble prompt, dispatch via `dispatch_responses_api` (Responses API; codex CLI is not used because xhigh is only supported on Responses-API models per `_RESPONSES_API_REASONING_EFFORT`), parse JSON output, validate, return. `dispatch_responses_api` already accepts `reasoning_effort`; only the call site needs to pass `xhigh`.

If `model not in RESPONSES_API_MODELS`, the dispatch function returns `error="fix-plan requires a Responses-API model; got <model>"` — fail-fast, the sidecar surfaces the error verbatim, no fallback to `effort=high`. (xhigh is meaningless on codex-CLI models.)

The function does not retry. Single attempt. The dispatcher routes to a degraded sidecar on failure.

**Acceptance test (rt2):** integration test asserts that for one design and one plan invocation, `run_id`, `repo`, `artifact_relative_path`, `model_rates`, and the OPENAI_API_KEY-resolution env are byte-identical between the challenge call's transport invocation, the fix-plan call's transport invocation, the row written to `red_team_runs`, and all three insights events.

### 3.6 Cost tracking

`fix_plan.cost_usd` is computed via the same `_resolve_rates` / `_cost_for` helpers used by the challenge call.

```python
total_cost_usd = challenge.cost_usd + (fix_plan.cost_usd if fix_plan else 0.0)
```

The pre-call gate (§3.1) checks `challenge.cost_usd < per_run_budget_usd` only. After the fix call returns, the dispatcher computes `total_cost_usd` and, if it exceeds `per_run_budget_usd`, appends `"over_budget_after_fix"` to the `RedTeamFixPlan.warnings` list (which is persisted in the local `fix_plan_json` column and emitted in the `red_team_fix_plan` event payload). The skill does NOT halt — by then the cost is already incurred — but the warning is the calibration signal that drives a follow-up budget bump.

This replaces the v1 spec's earlier "budget circuit breaker" semantics for the fix call; the v1 challenge-side budget breaker (`halted_budget` exit status when challenge calls cumulatively exceed budget) is unchanged.

## 4. Sidecar + PR comment changes

### 4.1 Sidecar rendering

A new `## Proposed Fix Plan` section is appended to `<artifact>.red-team.md` AFTER the existing `## Detail` section (or AFTER `## Findings` when there's no detail). The renderer is in `red_team_design_dispatch.py:render_sidecar_markdown` and the parallel function in `red_team_plan_dispatch.py`.

**Untrusted-content escape rules (rt13).** All model-produced fields (`title`, `rationale`, `new_trade_off`, `summary`, `notes`, `sections_touched` items) are treated as untrusted markdown:

1. The validation step (§3.4) enforces hard length caps before rendering ever sees the field.
2. The renderer wraps long-form fields (`rationale`, `notes`, `new_trade_off`) in fenced markdown blocks (\`\`\`text ... \`\`\`) when their content contains any of `\`\`\``, raw HTML opening tags, or 4+ consecutive backticks. This neutralizes nested code fences and HTML rendering inside GitHub PR comments.
3. `title` is rendered inline as plain text but with a fixed-width truncation at 200 chars (the §3.4 cap). Inline fences inside `title` are escaped (`\`...\`` becomes `\\\`...\\\``).
4. `addressed_finding_ids` and `orphan_finding_ids` are rendered as backticked lists; finding IDs are syntactically constrained (`rt\d+`) so escaping is a no-op for valid IDs and dropping for malformed IDs.
5. The total rendered fix-plan section is capped at 12 000 chars; over-cap content is truncated with a `[TRUNCATED — see local SQLite `fix_plan_json` column for full text]` marker. The local `fix_plan_json` column (§5.1) is the lossless source of truth.

**When the fix call ran (success):**

```markdown
## Proposed Fix Plan

**Generated by:** `gpt-5.5-pro` at reasoning effort `xhigh`
**Cost / duration:** $4.21 / 87.3s | **Tokens:** in=12450 out=3120
**Coverage:** 5 of 6 blocking findings addressed (1 deliberately deferred)

### Summary
{summary}

### Moves

#### m1 — {title}
**Rationale.** {rationale}
**Sections touched.** {sections_touched joined by comma, or "—" if empty}
**Addresses.** {addressed_finding_ids as backticked list, or "—" if empty}
**Trade-off.** {new_trade_off}

#### m2 — ...

### Notes
{notes — including unaddressed finding rationale; "—" if empty}
```

**When the fix call ran but errored:**

```markdown
## Proposed Fix Plan

**Status:** error — {error}
**Cost / duration:** ${cost} / {duration}s

The fix-plan call failed. Findings above are still valid. Re-run with
`--no-pr-comment` to retry locally without re-posting the PR comment.
```

**When the fix call was skipped:**

```markdown
## Proposed Fix Plan

**Status:** skipped — {fix_plan_status}: {human-readable reason}
```

### 4.2 PR comment

The PR-comment body that the skill posts already mirrors the rendered sidecar. With v1.2 the comment grows the same `## Proposed Fix Plan` section. No structural change to the bot identity or comment idempotency.

A typical fix plan adds ~40–80 lines to the comment. If the PR-comment body would exceed `gh`'s 65 KB limit, the renderer truncates the `notes` field first (preserving moves), then truncates each move's `rationale` to 200 chars, with a `[TRUNCATED — see sidecar]` marker.

### 4.3 Sidecar commit message

Updated to mention fix-plan presence:

```
docs(red-team): findings + fix plan for $(basename design.md)

3 findings (3 blocking, 0 human-review)
Fix plan: 2 moves addressing rt1, rt2, rt3
Model: gpt-5.5-pro (challenge: high; fix-plan: xhigh) · Run: <run_id>
```

When the fix call was skipped or errored, the second line collapses:

```
Fix plan: skipped (clean) | Fix plan: error (timeout)
```

The scoped `git add -- "$sidecar_path"` and `git commit ... -- "$sidecar_path"` from v1 are unchanged — only the message body changes.

## 5. Audit schema changes

### 5.1 Local SQLite (additive)

Six additions to `red_team_runs`:

```sql
ALTER TABLE red_team_runs ADD COLUMN repo TEXT;                    -- nullable
ALTER TABLE red_team_runs ADD COLUMN artifact_relative_path TEXT;  -- nullable
ALTER TABLE red_team_runs ADD COLUMN fix_plan_status TEXT;         -- nullable (see values below)
ALTER TABLE red_team_runs ADD COLUMN fix_plan_md TEXT;             -- nullable, rendered markdown
ALTER TABLE red_team_runs ADD COLUMN fix_plan_json TEXT;           -- nullable, validated JSON of RedTeamFixPlan (omits raw_output)
ALTER TABLE red_team_runs ADD COLUMN fix_plan_cost_usd REAL;       -- nullable
-- Values for fix_plan_status:
--   'success'                  — plan generated, see fix_plan_json/_md
--   'error'                    — plan call failed, see fix_plan_json.error
--   'skipped_clean'            — no blocking findings
--   'skipped_human_review_only'— only human-review findings
--   'skipped_budget_exhausted' — challenge call exhausted budget
--   'skipped_challenge_error'  — challenge call errored
--   'skipped_disabled'         — kill switch off
--   'skipped_input_too_large'  — findings JSON couldn't be safely truncated (§3.2.1)
--   NULL                       — pre-v1.2 row (legacy; see §6.1 backfill filter)
```

**Why both `fix_plan_md` AND `fix_plan_json` (resolves rt8).** `fix_plan_md` is for human reading (renderable, paste-into-PR-comment); `fix_plan_json` is the lossless serialization of the validated `RedTeamFixPlan` dataclass with its moves, warnings, orphan IDs, input-truncation flags, tokens, duration, model, reasoning effort, and error — everything needed to reconstruct a `red_team_fix_plan` event later. `raw_output` is NOT persisted (it's a debug aid only and can echo attacker-controlled prompt content).

`repo` and `artifact_relative_path` are added to support per-repo dashboard filtering in stark-insights. v1 didn't capture them, so legacy rows will have them as NULL (see §6.1).

**Migration mechanics.** `init_red_team_tables()` is the canonical migration entry point. It runs `CREATE TABLE IF NOT EXISTS` for the base v1 tables AND queries `PRAGMA table_info(red_team_runs)` to add any missing v1.2 columns via `ALTER TABLE`. Idempotent on:
- A fresh DB (creates from scratch with all columns).
- A pre-v1.2 DB (v1.0 / v1.1 — adds the six new columns).
- A v1.2 DB (no-op).
- A partially migrated DB (e.g., process killed mid-ALTER) — re-runs only the missing ALTERs because each is gated on the column presence check.

`record_red_team_run` and `record_fix_plan` always reference columns by explicit names, so a forward-compatible row write does not break if the migration has been extended.

### 5.2 stark-insights events

Three new event types in `event_schema.json` and `emit_queue._VALID_TYPES`. Canonical payload schemas below — these are the contract for both producers and lifters.

#### `red_team_run` (cardinality: 1 per skill invocation)

```json
{
  "type": "red_team_run",
  "timestamp": "2026-05-01T12:34:56Z",
  "cli": "claude",
  "source": "skill",
  "schema_version": 1,
  "project": "evinced/stark-skills",
  "dedupe_key": "red-team:run:design:manual-abc123def456",
  "payload": {
    "run_id": "manual-abc123def456",
    "stage": "design",
    "model": "gpt-5.5-pro",
    "caller": "manual",
    "final_status": "halted",
    "worst_severity": "high",
    "passed": false,
    "rounds_used": 1,
    "total_findings": 6,
    "blocking_count": 4,
    "human_review_count": 1,
    "critical_count": 0,
    "high_count": 4,
    "medium_count": 2,
    "duration_s": 87.3,
    "cost_usd": 1.92,
    "repo": "evinced/stark-skills",
    "artifact_relative_path": "docs/specs/foo.md",
    "pr_number": 428,
    "fix_plan_status": "success",
    "warnings": []
  }
}
```

Fields:

- `worst_severity`: `"critical" | "high" | "medium" | null` (NULL when no findings or `final_status == "error"`). Note: `"clean"` is **not** a severity value — clean runs set `worst_severity: null` and rely on `passed: true` / `final_status: "clean"` for filtering.
- `passed`: `true` iff `final_status == "clean"`.
- `repo`: canonical `owner/name` when detected, or the literal string `"unknown"` otherwise (never NULL — lifters require a string).
- `artifact_relative_path`: nullable; only set when both repo and a containing repo are detected.
- `pr_number`: nullable; only set when run inside a feature branch with an open PR.
- `warnings`: list of structured warning strings; absent in v1.2 unless `over_budget_after_fix` was emitted (§3.6) — but the array is always present for forward compatibility.

#### `red_team_finding` (cardinality: 0..N)

```json
{
  "type": "red_team_finding",
  "timestamp": "...", "cli": "claude", "source": "skill",
  "schema_version": 1, "project": "evinced/stark-skills",
  "dedupe_key": "red-team:finding:design:manual-abc123def456:1:rt3",
  "payload": {
    "run_id": "manual-abc123def456",
    "stage": "design",
    "round_num": 1,
    "finding_id": "rt3",
    "persona": "reliability-distsys",
    "severity": "high",
    "concern": "...",
    "consequence": "...",
    "counter_proposal": "...",
    "trade_off": "...",
    "reason_for_uncertainty": null,
    "is_human_review": false,
    "repo": "evinced/stark-skills",
    "pr_number": 428
  }
}
```

- `is_human_review`: `true` iff `counter_proposal == "REQUEST_HUMAN_REVIEW"`.
- `severity` is one of `"critical" | "high" | "medium"` (always non-null; findings without a severity are dropped at validation per v1).
- `trade_off` and `reason_for_uncertainty` are mutually exclusive: one is non-null, the other is null.

#### `red_team_fix_plan` (cardinality: 0 or 1, only when `fix_plan_status == "success"`)

```json
{
  "type": "red_team_fix_plan",
  "timestamp": "...", "cli": "claude", "source": "skill",
  "schema_version": 1, "project": "evinced/stark-skills",
  "dedupe_key": "red-team:fix_plan:design:manual-abc123def456",
  "payload": {
    "run_id": "manual-abc123def456",
    "stage": "design",
    "model": "gpt-5.5-pro",
    "reasoning_effort": "xhigh",
    "summary": "...",
    "notes": "...",
    "moves": [
      {
        "id": "m1",
        "title": "...",
        "rationale": "...",
        "sections_touched": ["§4.2"],
        "addressed_finding_ids": ["rt1", "rt3"],
        "new_trade_off": "..."
      }
    ],
    "move_count": 3,
    "addressed_finding_ids": ["rt1", "rt3", "rt4"],
    "unaddressed_finding_ids": ["rt2"],
    "orphan_finding_ids": [],
    "input_truncated": false,
    "input_omitted_finding_ids": [],
    "warnings": [],
    "cost_usd": 2.41,
    "duration_s": 87.3,
    "input_tokens": 12450,
    "output_tokens": 3120,
    "fix_plan_md": "## Proposed Fix Plan\n...",
    "repo": "evinced/stark-skills",
    "pr_number": 428
  }
}
```

- The `moves` array is the structured source-of-truth; `fix_plan_md` is included as a denormalized rendering for downstream tools that want the markdown directly. Storage cost is acceptable (typical fix plan: ~5 KB of markdown).
- Only emitted when the call succeeded (validated and not errored). Failure cases land on `red_team_run.fix_plan_status` instead — see §10.
- `addressed_finding_ids` is the union of all `move.addressed_finding_ids` (post-validation). `orphan_finding_ids` is non-empty only when the model produced an inconsistent plan (rare; see §3.4 step 4).

### 5.3 Lifter rules in stark-insights

Adds three entries to `_LIFT_RULES` in `src/stark_insights/lifting.py`. Lifted columns must align with the canonical payload schemas in §5.2 — every payload_key referenced below is documented as present in the corresponding payload contract.

```python
"red_team_run": [
    ("model", "agent_name", None, True),
    ("stage", "domain", None, True),
    ("worst_severity", "severity", None, True),    # may be None → column nulled
    ("cost_usd", "score_value", None, False),       # keep in payload_extra too
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
    ("cost_usd", "score_value", None, False),       # keep in payload_extra too
    ("repo", "repo", None, True),
    ("pr_number", "pr_number", None, True),
],
```

- `consume=False` on `cost_usd` mirrors the `validation_result.overall` precedent: the lifted column is a lossy projection (Numeric(12,4) vs. raw float), so we keep the precise value in `payload_extra` for analytics queries that need the full precision.
- Lifters use Python-truthy null handling — payload values of `None` produce a NULL lifted column, not a string `"None"`. Verified by lifter unit tests for `worst_severity: null`.
- Pre-deployment of the new lifters: events still ingest with all fields in `payload_extra`. Dashboards lose the lifted-column query speedup but no data is lost. This makes the cross-repo deployment order (stark-skills first vs. stark-insights first) a non-issue.

### 5.4 Dedupe keys (idempotency)

Each emitted event carries a deterministic `dedupe_key` keyed off `run_id` (already a uuid4 segment per v1) and a stable secondary key:

```
red_team_run:        red-team:run:{stage}:{run_id}
red_team_finding:    red-team:finding:{stage}:{run_id}:{round_num}:{finding_id}
red_team_fix_plan:   red-team:fix_plan:{stage}:{run_id}
```

`repo` is intentionally NOT in the dedupe key — `run_id` is globally unique already, and including `repo` would break dedupe if a row was originally written with `repo=NULL` (legacy) and later forward-emitted with a resolved repo string. This makes `run_id` the single identity axis.

**Idempotency layers (resolves rt6).** The local `emit_queue.pending` table has `UNIQUE(dedupe_key)` so the SAME local queue won't enqueue duplicates. After a successful drain, the row is deleted from `pending` — so a SECOND enqueue of the same dedupe_key after drain WOULD re-enqueue without local protection.

The cloud-side `events` table in stark-insights has `Index("idx_events_dedupe", "dedupe_key", unique=True)` (per `src/stark_insights/db/schema.py` — verified during spec drafting). The HTTP `/events` endpoint enforces this on insert: a duplicate `dedupe_key` is treated as a no-op success (200 OK with `inserted: 0`), not a 4xx error. This is the durable defense; the local `emit_queue` UNIQUE is just an optimization.

**Backfill resume.** When `red_team_backfill.py` is interrupted and re-run:
1. Each row's events are re-enqueued (local `pending` has been drained, so no UNIQUE collision there).
2. On drain, the cloud-side dedupe_key UNIQUE rejects the already-ingested events as no-ops.
3. The dispatcher's success/failure counts are computed from local `pending` deletions, so the same row counts as a "no-op success" on resume.

This is verified by an acceptance test (§12.3) that runs the backfill, kills it mid-drain, runs it again, and asserts the cloud row count is the same as a single full run.

### 5.5 Drain semantics

Telemetry uses the established `emit_queue` push path:

1. Dispatcher calls `red_team_insights.emit_run(...)`, `emit_finding(...)`, `emit_fix_plan(...)`.
2. Each helper builds the envelope (timestamp, cli=`claude`, source=`skill`, schema_version=`1`, project=repo, dedupe_key, payload) and calls `emit_queue.enqueue(event)`.
3. `enqueue()` validates against `event_schema.json` and writes to `~/.stark-insights/queue.db`. Durable as soon as enqueue returns.
4. The launchd-managed stark-insights service drains the queue async on its 1-minute cadence; events flow into Cloud SQL via the on-demand bastion tunnel.
5. Events are durable even if the API is unreachable at emit time — they sit in the local queue with retries, eventually landing in dead-letter after 5 attempts.

The dispatcher does NOT call `emit_queue.drain()` synchronously — telemetry must never block or fail the skill. All emission is wrapped in the same `try/except: log+continue` pattern as `_emit_plan_dispatch_events` in `plan_review_dispatch.py`.

## 6. Backfill mechanics

### 6.1 Script: `scripts/red_team_backfill.py`

```bash
python3 red_team_backfill.py [--dry-run] [--limit N] [--db PATH] [--scope all|legacy|forward]
```

Default DB path: `~/.claude/code-review/history/forged-review/forged_review_metrics.db` (matches `red_team_audit.DEFAULT_DB_PATH`).

`--scope` defaults to `legacy`:
- `legacy`: emit ONLY rows where `fix_plan_status IS NULL` (the marker that no v1.2 dispatcher has ever recorded this row). This is the primary backfill mode.
- `forward`: emit rows where `fix_plan_status IS NOT NULL`. Used when the v1.2 dispatcher's forward emission failed for some rows (network outage, etc.) — re-emits without re-running the LLM calls.
- `all`: emit every row regardless of marker. Dedupe keys keep this idempotent; useful for disaster recovery.

Behavior:

1. **Run the migration first.** `red_team_backfill.py` calls `red_team_audit.init_red_team_tables(db_path)` before issuing any SELECT. This guarantees `repo`, `artifact_relative_path`, `fix_plan_*` columns exist; `--scope=legacy` then filters correctly via the now-NULL post-migration values.
2. Open the DB read-only after migration; SELECT rows from `red_team_runs` matching `--scope`, oldest first by `created_at`.
3. For each row, also SELECT matching `red_team_findings` (join on `run_id`). For `--scope=forward`, also pull `fix_plan_json` and reconstruct the `red_team_fix_plan` event from the validated JSON when present.
4. Synthesize event envelopes:
   - `red_team_run` with all v1.2 payload fields. For legacy rows, `fix_plan_status` is set to `"absent_pre_v1_2"` (a separate sentinel from `"skipped_*"` so dashboards distinguish "no v1.2 dispatcher saw this row" from "v1.2 saw it and skipped").
   - `red_team_finding` per finding row.
   - `red_team_fix_plan` ONLY for forward-scope rows with non-null `fix_plan_json`. Reconstructs by `json.loads(fix_plan_json)`; the resulting payload matches the §5.2 schema exactly because the dispatcher persisted the same JSON at write time.
5. `repo`: read from the row's `repo` column. NULL → emit as `"unknown"` (string, not NULL — lifters require a non-null repo). `artifact_relative_path`: read column; NULL → emit as `null` (lifters tolerate null).
6. Envelope `timestamp` = `red_team_runs.created_at` so historical events land in their original time bucket.
7. Dedupe keys:
   ```
   red-team:run:{stage}:{run_id}
   red-team:finding:{stage}:{run_id}:{round_num}:{finding_id}
   red-team:fix_plan:{stage}:{run_id}
   ```
   Identical to forward-emission keys (per §5.4) — `run_id` is globally unique, so backfill and forward emission produce the same dedupe key for the same logical row. The cloud-side UNIQUE on `dedupe_key` is the durable idempotency guarantee.

### 6.2 Dry-run mode

`--dry-run` prints what would be emitted (counts by event type, sample envelopes, total events, scope filter applied) without calling `enqueue`. Useful for verifying the row mapping and the scope filter before committing to writes.

### 6.3 Acceptance criterion for backfill

After one successful run on a known fixture local SQLite, the script reports its own counts:

```
[backfill] scope=legacy
[backfill] read 18 runs, 47 findings from /Users/.../forged_review_metrics.db
[backfill] enqueued 18 red_team_run, 47 red_team_finding, 0 red_team_fix_plan
[backfill] (re-run would enqueue 0 events of each type)
```

**Server-side verification** is scoped by dedupe-key prefix, NOT by global event type counts (resolves rt7 — global counts include forward emissions and other machines):

```sql
-- Verifies all backfilled rows landed; safe across multi-machine deployments.
SELECT COUNT(*) FROM events
 WHERE type = 'red_team_run'
   AND dedupe_key IN (...the dedupe keys this backfill computed...);
```

The acceptance test computes the expected dedupe keys deterministically from the local DB, then asserts each appears exactly once in `events`. Re-running the backfill produces the same keys and the same row count (cloud-side dedupe UNIQUE enforces idempotency). A separate test simulates a kill mid-drain and confirms the second run reaches the same end state.

### 6.4 Out of scope

- No backfill of `red_team_persona_stats` rows — they're derivable from `red_team_finding` events via aggregation, and the dashboard queries that need persona stats can compute on-the-fly. Persisting the rollup as its own event would be redundant.
- No retention/pruning change. The existing `prune_red_team_metrics(retention_days=180)` in `red_team_audit.py` is already what governs local SQLite size; insights cloud storage retention is governed by stark-insights' own retention policy.

## 7. Config schema changes

Additions to `global/config.json`:

```json
{
  "red_team": {
    "per_run_budget_usd": 30.00,        // bumped from 15.00 — covers xhigh fix call
    "fix_plan": {                        // NEW section
      "enabled": false,                  // ships disabled; flipped post-calibration (§13)
      "model": "gpt-5.5-pro",
      "reasoning_effort": "xhigh",
      "timeout_s": 1200,
      "min_moves": 2,                    // hard error if fewer (§3.3)
      "max_moves": 6,                    // pruned at 2× then hard error (§3.3)
      "max_input_chars": 200000          // shared with challenge call default
    }
  }
}
```

The `enabled: false` initial default is deliberate — the v1.2 PR ships the schema and code, the calibration ritual (§11.2) measures real-world cost/coverage, then a separate small PR flips the default to `true`. This keeps the merge atomic and lets us back out the rollout without a code revert.

### 7.1 Locked fields (defense-in-depth)

The v1 `_RED_TEAM_LOCKED_FIELDS` is a `frozenset[str]` of flat top-level keys. v1.2 promotes it to a `frozenset[tuple[str, ...]]` of dotted-path tuples — every existing v1 entry becomes a 1-tuple, plus five new nested entries:

```python
_RED_TEAM_LOCKED_FIELDS: frozenset[tuple[str, ...]] = frozenset({
    # v1 (now expressed as 1-tuples — semantically unchanged):
    ("personas",), ("model",), ("enabled",), ("agent",),
    ("min_severity_to_block",), ("halt_on_unresolved",),
    ("allow_human_review_halt",), ("stages",),
    # v1.2 (NEW):
    ("fix_plan", "enabled"),
    ("fix_plan", "model"),
    ("fix_plan", "reasoning_effort"),
    ("fix_plan", "min_moves"),
    ("fix_plan", "max_moves"),
})
```

`get_red_team_config()` is updated to walk override dicts recursively against the path tuples. For each candidate override `(value, path)`:

```python
def _drop_locked_overrides(override: dict, base_path: tuple = ()) -> tuple[dict, list[str]]:
    """Returns (cleaned_override, dropped_paths). Recursive; dropped_paths
    contains dotted strings for the override_rejected events."""
```

The `red_team_override_rejected` event payload gains a `path` field (string, dotted: `"fix_plan.enabled"`) so a single locked-field rejection event clearly identifies WHICH locked field was attempted. v1's flat `path` field already shipped — backward-compatible.

Same rationale as v1: a repo-level downgrade ("set effort to medium" / "disable fix-plan") would preserve the appearance of substance review while neutering its rigor. Operational tuning (`timeout_s`, `max_input_chars`) remains unlocked.

**Acceptance tests (resolves rt10).** Unit tests verify each of the 5 new locked paths individually: a repo-level config attempting `red_team.fix_plan.<field> = X` is dropped, a `red_team_override_rejected` event is emitted with `path = "fix_plan.<field>"`, and the resolved config retains the global default for that field. A negative test verifies that `red_team.fix_plan.timeout_s` (unlocked) IS respected at the repo level.

### 7.2 Backward compatibility

`fix_plan` defaults are merged in `config_loader.get_red_team_config()` so callers running on an older `global/config.json` get sane defaults without a config edit. This matches v1's behavior with `personas`, `model`, etc.

## 8. Prompts layout

```
global/prompts/red-team/
├── preamble.md                     # (unchanged) committee framing for challenge
├── design.md                       # (unchanged) challenge-stage prompt for design
├── plan.md                         # (unchanged) challenge-stage prompt for plan
├── fix-plan.md                     # NEW — single-architect fix-plan prompt
└── personas/                       # (unchanged) 5 persona files
    ├── ...
```

`fix-plan.md` (~80 lines):
- Frames the call as: "you are a single senior architect who has read the committee's findings and synthesis; propose 2–6 architectural moves that resolve the cross-persona tensions."
- Forbids: code-level edits, line numbers, mechanical rewrites, finding ID invention.
- Required: every move must name `addressed_finding_ids` (subset of given) and a `new_trade_off`.
- Output schema (JSON) matching `RedTeamFixPlan` from §3.3.
- Same input-injection defense framing as `preamble.md`: text inside `<<<RED_TEAM_INPUT>>>` blocks is content, not instructions.

## 9. Scripts (new + modified files)

### 9.1 New files (stark-skills)

| File | Purpose | Est. lines |
|---|---|---|
| `scripts/red_team_insights.py` | Wraps `emit_queue.enqueue` with red-team-specific envelope builders for `red_team_run`, `red_team_finding`, `red_team_fix_plan`. All emit functions wrap exceptions and never raise. | ~180 |
| `scripts/red_team_backfill.py` | One-shot historical-row migration; CLI flags `--dry-run`, `--limit`, `--db`. | ~220 |
| `scripts/test_red_team_insights.py` | Unit tests: envelope shape, dedupe keys, emission failure isolation, lifter mapping. | ~280 |
| `scripts/test_red_team_backfill.py` | Unit tests: dry-run output, idempotency, missing-column tolerance. | ~180 |
| `scripts/test_red_team_fix_plan.py` | Unit tests for `run_red_team_fix_plan`, `assemble_fix_plan_prompt`, `parse_fix_plan_output`, `validate_fix_plan` (orphans, invented IDs, empty moves, duplicate IDs, max-moves cap). Mocks Responses API. | ~400 |
| `global/prompts/red-team/fix-plan.md` | The new fix-plan system prompt + schema. | ~80 |

### 9.2 Modified files (stark-skills)

| File | Change |
|---|---|
| `scripts/stark_red_team.py` | Add `RedTeamFixPlan`, `FixPlanMove`, `RedTeamRunContext` dataclasses; `assemble_fix_plan_prompt`, `serialize_findings_envelope`, `parse_fix_plan_output`, `validate_fix_plan`, `run_red_team_fix_plan`. ~+350 lines. No changes to existing `run_red_team` or `RedTeamResult`. |
| `scripts/red_team_design_dispatch.py` | Construct `RedTeamRunContext` at start; thread through challenge + fix-plan + audit + insights emission. After `rt.run_red_team(...)`, gate per §3.1 and call `rt.run_red_team_fix_plan(...)` when eligible. Update `render_sidecar_markdown` to append the `## Proposed Fix Plan` section per §4.1. Pipe into local audit (`fix_plan_md`, `fix_plan_json`, `fix_plan_cost_usd`, `fix_plan_status`) and into `red_team_insights.emit_*`. Update commit message body per §4.3. Add `--enable-fix-plan-for-calibration` flag (§11.3). ~+200 lines. |
| `scripts/red_team_plan_dispatch.py` | Same shape as design dispatcher. ~+200 lines. |
| `scripts/red_team_audit.py` | Idempotent migration in `init_red_team_tables` for the six new columns (`repo`, `artifact_relative_path`, `fix_plan_status`, `fix_plan_md`, `fix_plan_json`, `fix_plan_cost_usd`). Update `record_red_team_run` to accept `repo`, `artifact_relative_path`, `pr_number`. Add `record_fix_plan(run_id, fix_plan_md, fix_plan_json, fix_plan_cost_usd, fix_plan_status)` helper. ~+90 lines. |
| `scripts/config_loader.py` | Promote `_RED_TEAM_LOCKED_FIELDS` to `frozenset[tuple[str, ...]]` per §7.1. Implement `_drop_locked_overrides` recursive walker. Default-merge `red_team.fix_plan` (with `enabled: false`). Extend `red_team_override_rejected` event to include dotted `path`. ~+60 lines. |
| `scripts/event_schema.json` | Add `red_team_run`, `red_team_finding`, `red_team_fix_plan` to the `type` enum. |
| `scripts/emit_queue.py` | Add same three to `_VALID_TYPES`. |
| `scripts/test_stark_red_team.py` | Tests for fix-plan flow already covered by `test_red_team_fix_plan.py`; no change unless an existing test makes assumptions invalidated by the new code path. |
| `scripts/test_red_team_audit.py` | Migration test (old DB → upgraded), `record_fix_plan` round-trip. ~+80 lines. |
| `global/config.json` | Bump `per_run_budget_usd` from 15.00 to 30.00. Add `red_team.fix_plan` section per §7. |
| `skill/stark-red-team-design/SKILL.md` | Document the new `## Proposed Fix Plan` section in §Phase 3 rendering. Note insights audit. Bump `revision` field. |
| `skill/stark-red-team-plan/SKILL.md` | Same. Bump `revision` field. |

### 9.3 Modified files (stark-insights)

| File | Change |
|---|---|
| `src/stark_insights/lifting.py` | Add three entries to `_LIFT_RULES` per §5.3. |
| `tests/test_lifting.py` | Coverage for the three new event types: lifted column extraction, payload_extra preservation, missing-key tolerance. |

No schema migration in stark-insights. No new tables. No new lifted columns on `events`.

## 10. Failure modes

**Invariant (resolves rt3): the skill's exit code, terminal-printed status, sidecar-banner status, and `red_team_runs.final_status` are derived ENTIRELY from the challenge call's result.** Fix-call success/failure changes only `fix_plan_status` and the `## Proposed Fix Plan` sidecar section. A blocking-findings challenge result with a fix-plan parse failure remains a `halted` exit, not a `clean` one.

**Diagnostic representation (resolves rt5): all fix-plan diagnostic signals are encoded as fields on the `red_team_run` and `red_team_fix_plan` event payloads, not as new event types.** The fields are:

- `red_team_run.payload.fix_plan_status` — the canonical state machine value (one of the documented strings in §5.1).
- `red_team_run.payload.warnings` — list of structured strings (`"over_budget_after_fix"`, etc.). Always present.
- `red_team_fix_plan.payload.warnings` — list of structured strings (`"move_cap_hit"`, `"ids_invented"`, `"field_capped"`). Only emitted when `fix_plan_status == "success"` (parse errors land on `red_team_run.fix_plan_status` only).
- `red_team_fix_plan.payload.error` — string when the call dispatched but parsing/validation failed and the dispatcher chose to still emit a `red_team_fix_plan` for telemetry purposes (rare; controlled by an internal flag).

This avoids registering 4+ ephemeral event types in `_VALID_TYPES` that exist only to encode fix-plan sub-states.

| Failure | Recovery | `fix_plan_status` | Skill exit / final_status |
|---|---|---|---|
| Challenge call errored | Fix call skipped; sidecar shows challenge error verbatim. | `skipped_challenge_error` | from challenge (typically `error`) |
| Fix call timeout | Sidecar shows error message; raw_output preserved in-memory only. | `error` (via fix_plan_json) | from challenge (unchanged) |
| Fix call returns invalid JSON | Same as timeout. `parse_error` warning recorded. | `error` | from challenge |
| Fix call returns < `min_moves` or > `max_moves * 2` moves | Hard error; no rendering. | `error` | from challenge |
| Fix call returns `max_moves < N <= max_moves * 2` moves | Pruned to `max_moves`; `move_cap_hit` warning. Coverage recomputed; orphaned IDs surface. | `success` | from challenge |
| Fix call invents non-existent finding IDs | Invented IDs dropped per move; `ids_invented` warning. Empty moves dropped; remaining count re-checked against `min_moves`. | `success` (or `error` if drop pushes below `min_moves`) | from challenge |
| Findings JSON cannot fit in `max_input_chars` AND the unfittable findings include any blocking | Fix call NOT dispatched; `serialize_findings_envelope` reported `fits_safely=False`. | `skipped_input_too_large` | from challenge |
| Findings JSON truncated but only medium/human-review findings omitted | Fix call dispatched; `RedTeamFixPlan.input_truncated=True` and `input_omitted_finding_ids` populated. | `success` | from challenge |
| Total cost exceeds budget after fix call returned | Warning `over_budget_after_fix` appended; printed to stderr; persisted. No halt — cost is already incurred. | `success` | from challenge |
| Budget already exhausted by challenge | Fix call skipped. v1 `halted_budget` semantics on challenge are unchanged (NOT triggered by fix-call skip alone). | `skipped_budget_exhausted` | from challenge |
| `OPENAI_API_KEY` unavailable for the fix call | `dispatch_responses_api` returns transport error; sidecar shows error in fix-plan section. Challenge would have failed identically — same upstream signal. | `error` | from challenge |
| stark-insights service down at emit time | Events queue locally in `~/.stark-insights/queue.db`; drained on next service tick. After 5 retries, dead-lettered (existing behavior). | unchanged | unchanged |
| stark-insights lifter changes not yet deployed | Events ingest with all fields in `payload_extra`, lifted columns NULL. Dashboards degrade gracefully. | unchanged | unchanged |
| Backfill encounters a malformed historical row | Skip with stderr warning; continue. Reports skipped count at end. Skill flow N/A (offline tool). | N/A | N/A |
| Backfill killed mid-drain | Re-run resumes via dedupe — cloud-side UNIQUE rejects already-ingested events as no-op success. End state matches a single full run. | N/A | N/A |

## 11. Cost analysis

### 11.1 Per-run cost — typical and worst case

Token rates from `global/config.json` (gpt-5.5-pro): input $25/1M, output $100/1M. `xhigh` reasoning bills as additional output tokens (Responses API includes them in `usage.output_tokens` per the v1 `dispatch_responses_api` accounting note).

**Typical-case projection** (median artifact + median spec + 4 findings):

| Call | Input tokens | Output tokens (incl. reasoning) | Cost |
|---|---|---|---|
| Challenge (effort=high) | ~12 000 | ~3 000 | ~$0.60 |
| Fix-plan (effort=xhigh) | ~14 000 | ~6 000 | ~$0.95 |
| **Typical total** | | | **~$1.55** |

Stability verification on the challenge (when blocking found) adds another ~$0.60 → ~$2.15 typical.

**Worst-case ceiling** (resolves rt14):

| Call | `max_input_chars` ceiling | `max_output_tokens` ceiling | Worst-case cost |
|---|---|---|---|
| Challenge | 200 000 chars ≈ 50 000 tokens | 32 768 | $25/1M × 50k + $100/1M × 32 768 = **$4.53** |
| Fix-plan | 200 000 chars ≈ 50 000 tokens | 32 768 | **$4.53** |

xhigh hidden reasoning is bounded by `max_output_tokens` since reasoning tokens are billed under that header. A pathological run that hits both input and output ceilings on both calls costs **$9.06** (no stability verify) or **$13.59** (with one verify). The configured `per_run_budget_usd: 30.00` provides ~2.2× headroom over this ceiling — defensible for p99.

**The pre-call gate (§3.1) cannot enforce this worst case before the fix call returns** — that's the explicit design choice in §3.6. The post-call `over_budget_after_fix` warning surfaces violations for calibration follow-up, not runtime halt.

### 11.2 Calibration

Two independent calibration steps:

1. **Pre-merge bench-mark** (one-shot, before merging the v1.2 PR). Run the v1.2 dispatcher with `fix_plan.enabled=true` (overridden via the test-only mechanism in §11.3) on the fixture spec set, 10 runs each over 3 fixtures of varying size (small ~200 lines, medium ~600 lines, large ~1500 lines). Record p50, p95, and max for: `fix_plan.cost_usd`, `fix_plan.duration_s`, `fix_plan.input_tokens`, `fix_plan.output_tokens`, `fix_plan.move_count`, `addressed_finding_ids` coverage rate. Write to `docs/calibration/2026-05-XX-red-team-v1.2-fix-plan-calibration.md`. Bump `per_run_budget_usd` if `current_budget < 1.5 × observed_p95_total_cost` (matches the §12.2 acceptance threshold). On the current $30 budget, this triggers when p95 total cost exceeds $20.
2. **Post-rollout observation** (continuous, after enabling). Operate `red_team_run.warnings` as a calibration signal — repeated `over_budget_after_fix` (>5% of runs) prompts a budget bump PR; `move_cap_hit` rate >20% prompts raising `max_moves` from 6.

This is a hard pre-merge gate (resolves rt15): the calibration doc must exist before flipping `fix_plan.enabled` to true. Without calibration, the budget and the move count caps are guesses.

### 11.3 Test-only enable mechanism

Because `fix_plan.enabled` is a locked field (§7.1) and the v1.2 PR ships with `enabled: false`, the calibration bench-mark must use a sanctioned override. Two paths, both globally-scoped (NOT repo-overridable):

1. **Edit `global/config.json` to `enabled: true` for the calibration run, then revert before commit.** The lock prevents repo-level override; it does not prevent global-level edits — the calibration is itself a global decision.
2. **CLI flag `--enable-fix-plan-for-calibration`** on the dispatchers. Bypasses the `cfg["fix_plan"]["enabled"]` check at the call site. Emits a one-time `red_team.fix_plan.calibration_override` warning to stderr so the operator knows the bypass is active. Only available via the `red_team_<stage>_dispatch.py` CLI; not exposed through the skill's argument parsing.

Path 2 is preferred for the calibration ritual because it's reversible without a config edit. The flag exists in v1.2 even after the rollout flips `enabled: true` — useful for debugging future fix-plan regressions.

## 12. Acceptance criteria

Acceptance is split between defaults-as-shipped (12.1) and behavior-when-enabled (12.2) to resolve rt15. The disabled-default tests run in CI on every PR; the enabled-fixture tests run during calibration (§11.2) and as part of the post-flip-enable PR.

### 12.1 Disabled-default (ships with v1.2 PR; CI-enforced)

- [ ] `scripts/stark_red_team.py` exposes `run_red_team_fix_plan`, `RedTeamFixPlan`, `FixPlanMove`, `RedTeamRunContext`, `serialize_findings_envelope`, `validate_fix_plan`. Existing `run_red_team` and `RedTeamResult` are unchanged in shape.
- [ ] `global/prompts/red-team/fix-plan.md` exists; loaded by `assemble_fix_plan_prompt`.
- [ ] `red_team_design_dispatch.py` and `red_team_plan_dispatch.py` invoke `run_red_team_fix_plan` only when ALL of `cfg.fix_plan.enabled`, `challenge.error is None`, `challenge.blocking_count > 0`, `challenge.cost_usd < per_run_budget_usd`, `fits_safely`. Skip cases set the documented `fix_plan_status` value.
- [ ] **Default config ships with `fix_plan.enabled: false`.** When loaded with the default config, both dispatchers skip the fix call with `fix_plan_status=skipped_disabled` regardless of challenge findings. Sidecar renders the skipped section. No `red_team_fix_plan` event emitted.
- [ ] Sidecar renders the `## Proposed Fix Plan` section for success, error, and ALL skip statuses per §4.1.
- [ ] PR comment renders identically; truncation honours the §4.1 12 KB internal cap and the §4.2 65 KB GitHub cap.
- [ ] `red_team_audit.py:init_red_team_tables` is idempotent on:
  - a fresh DB
  - a v1.0 (pre-v1.2) DB
  - a v1.1 DB (after the v1.1 followups landed)
  - a v1.2 DB (no-op)
  - a partially migrated DB (some columns added, others not)
  Each test asserts the final schema matches §5.1 exactly.
- [ ] Both dispatchers construct a `RedTeamRunContext`, populate `repo` (via `git rev-parse --show-toplevel` then `gh repo view --json nameWithOwner`), `artifact_relative_path` (relative to repo root), `pr_number` (when in a feature branch), and pass it to all downstream calls. Integration test asserts byte-identical context across challenge dispatch, fix-plan dispatch, local audit row, and all three insights events.
- [ ] `red_team_insights.py` emits `red_team_run`, `red_team_finding` (one per finding), and `red_team_fix_plan` (only when `fix_plan_status == "success"`) events. Emission failures are caught and logged; never break the skill. Test asserts a forced `enqueue` exception leaves `final_status` and exit code untouched.
- [ ] Dedupe keys match §5.4 exactly. Re-running the same run produces the same keys.
- [ ] `red_team_backfill.py` calls `init_red_team_tables` before SELECT. `--scope=legacy` filters on `fix_plan_status IS NULL`. `--scope=forward` reads `fix_plan_json` and reconstructs `red_team_fix_plan` events. `--dry-run` reports the same counts the live run would emit.
- [ ] Backfill idempotency test: kill mid-drain, re-run, assert cloud `events` table has the expected dedupe-key set with each appearing exactly once.
- [ ] `event_schema.json` and `emit_queue._VALID_TYPES` include the three new types. No diagnostic event types added.
- [ ] `global/config.json` has `per_run_budget_usd: 30.00`, the `fix_plan` section with `enabled: false`, `min_moves: 2`, `max_moves: 6`, and `reasoning_effort: "xhigh"`.
- [ ] `_RED_TEAM_LOCKED_FIELDS` is now a `frozenset[tuple[str, ...]]`; covers all v1 keys as 1-tuples plus the 5 v1.2 nested paths from §7.1. Per-locked-field unit tests verify drop-and-emit-event behavior. Negative test verifies `red_team.fix_plan.timeout_s` IS respected at repo level.
- [ ] Truncation safety: `serialize_findings_envelope` test fixture with 50 findings totaling 300 KB outputs a parseable JSON envelope with `truncated: true` and `omitted_finding_ids` populated. No partial JSON. `fits_safely` is False when blocking findings are omitted.
- [ ] Move-count contract: tests for 0, 1, 2, 6, 7, 12, 13 moves emitted by the model. Each lands in the documented branch (hard error / valid / pruned / hard error).
- [ ] Untrusted-content rendering: tests with code fences, raw HTML, 4+ backticks, very-long titles, very-long notes, non-`rt\d+` finding IDs in `addressed_finding_ids` — verify no markdown breakage and per-field caps honoured.
- [ ] Both skill `SKILL.md` files document the fix-plan section, the disabled default, and bump `revision`.
- [ ] `skill-creator:skill-creator` structural eval passes on both updated skills.

### 12.2 Enabled-fixture (calibration + post-flip PR)

These run when `fix_plan.enabled` is set to `true` (via §11.3 mechanism in calibration; via the post-flip PR's config change in production).

- [ ] One end-to-end run of `/stark-red-team-design` against `docs/specs/red-team-fixture-source-spec.md` with fix-plan enabled:
  - Challenge produces ≥ 1 blocking finding (asserted on the fixture).
  - Sidecar contains a fully-rendered `## Proposed Fix Plan` section with `min_moves..max_moves` moves.
  - Local SQLite has a row in `red_team_runs` with `fix_plan_status='success'`, non-null `fix_plan_md`, non-null `fix_plan_json`, and `fix_plan_cost_usd > 0`.
  - `~/.stark-insights/queue.db` has 1 `red_team_run` event with `fix_plan_status='success'`, ≥1 `red_team_finding` event, and 1 `red_team_fix_plan` event with `move_count` matching the sidecar.
  - After service drain, the cloud `events` table has the matching rows; lifted columns (`severity`, `agent_name`, `domain`, `score_value`, `passed`, `repo`, `pr_number`) populated; `payload_extra` contains the unlifted fields.
- [ ] Calibration doc `docs/calibration/2026-05-XX-red-team-v1.2-fix-plan-calibration.md` exists with p50, p95, max for cost, duration, move_count across ≥ 30 runs (10 per fixture × 3 fixtures). Budget is set to ≥ 1.5× observed p95 total cost.
- [ ] One run with the test-only `--enable-fix-plan-for-calibration` flag emits a `red_team.fix_plan.calibration_override` stderr warning and otherwise behaves as if `enabled: true`.

### 12.3 Stark-insights

- [ ] `lifting.py` has lifters for the three new event types per §5.3.
- [ ] Lifter unit tests cover all three types: lifted column extraction, payload_extra preservation, missing-key tolerance, NULL-payload-value handling (`worst_severity: null` → NULL severity column, not `"None"` string).
- [ ] Pre-deployment lifter behavior: events of the new types written before the lifter PR deploys are ingested with `payload_extra` only and lifted columns NULL — verified in test.

### 12.4 Cross-repo verification

- [ ] Backfill end-to-end smoke run with `--scope=legacy` on the current local SQLite — counts match the §6.3 dedupe-key-prefixed query.
- [ ] Forward-emission resilience: kill stark-insights service, run dispatcher (challenge + fix-plan, with calibration override), restart service, observe events drain successfully on the next 1-min tick.

## 13. Rollout

The order below resolves rt15: calibration uses the §11.3 test-only override, NOT a flip-enable-then-flip-back dance, so `fix_plan.enabled` only changes once in production config history.

1. **Pre-merge calibration.** On a calibration branch, run the §11.2 bench-mark using `--enable-fix-plan-for-calibration` (no config flip). Write the calibration doc. Adjust `per_run_budget_usd` and any tuning parameters in the v1.2 PR if the bench-mark says so.
2. **Merge v1.2 to stark-skills** with `fix_plan.enabled: false`, calibration doc included. CI runs the §12.1 disabled-default tests.
3. **Deploy stark-insights lifter changes** as a separate PR. Smoke-test by emitting a hand-crafted event of each new type and querying the cloud `events` table.
4. **Run `red_team_backfill.py --scope=legacy`** once on the producer's machine; verify the §12.3 dedupe-key-prefixed query matches.
5. **Post-flip PR**: set `fix_plan.enabled: true` in `global/config.json`. CI runs §12.2 enabled-fixture tests against the fixture spec set. Merge.
6. **Observe** for one week: monitor `red_team_run.warnings` (`over_budget_after_fix` rate), `red_team_fix_plan.warnings` (`move_cap_hit` rate), per-fixture coverage rate, fix-call error rate. Open follow-up PRs for budget/move-cap tuning if observed signal exceeds the §11.2 thresholds.
