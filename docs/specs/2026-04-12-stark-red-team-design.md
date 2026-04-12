# stark-red-team — Design

**Status:** Draft
**Author:** Aryeh Kiovetsky (brainstorm w/ Claude)
**Date:** 2026-04-12
**Related:**
- [stark-forged-review design](./2026-04-12-stark-forged-review-design.md)
- stark-forge design (previous)

## 1. Purpose

A **red-team layer** that plugs into `/stark-forge` and `/stark-forged-review` at the design and plan stages. A single Codex o3 call acts as a committee of 5 senior architects with distinct domain expertise, challenges every decision in the design/plan artifact, and produces cross-persona synthesis + architecture-level findings with explicit counter-proposals. Findings feed back into the design-generator for iterative refinement until clean or halted.

**Design principles, in order:**
1. **Complementary, not duplicative.** The red team attacks architecture-level decisions — the kind of concerns a senior architect voices in a design review meeting. It does not replicate what existing code-level review domains already cover.
2. **Synthesis > laundry lists.** The red team's unique value is spotting tensions *between* architect concerns (security vs. scalability, DX vs. cost). A single LLM call holding all personas can produce that synthesis naturally.
3. **Iterative refinement.** Findings must be actionable — each one carries a counter-proposal and a trade-off — so the design-generator has something to revise toward.
4. **Configurable, minimal-surface-area rollout.** Ship with design-stage enabled and plan-stage scaffolded-but-disabled. Flipping the plan stage on is a config change, not a code change.
5. **Additive, not load-bearing.** If red team is unavailable (CLI missing, model unreachable), the pipeline logs the degradation and continues.

**First release scope:**
- Design stage: enabled
- Plan stage: scaffolded, config flag defaults off
- `/stark-forge`: integration active (runs after design-review convergence)
- `/stark-forged-review`: integration scaffolded (fires only when the forge path activates, which is itself deferred)

## 2. Where it plugs in

```
                   ┌─────────────────────┐
                   │  design generator   │
                   └──────────┬──────────┘
                              ▼
                   ┌─────────────────────┐
                   │   design review     │ (existing iterative loop)
                   └──────────┬──────────┘
                              ▼
                   ┌─────────────────────┐
                   │      RED TEAM       │ (new — single Codex o3 call
                   │ 5 architect         │   with 5 personas, synthesis
                   │ personas,           │   + counter-proposals)
                   │ iterative refine    │
                   └──────────┬──────────┘
             blocking?        │
                  ┌───────────┴───────────┐
                  ▼                       ▼
       design regen + re-review     plan generator (proceed)
            (loop)                         │
                                           ▼
                                    ┌──────────────┐
                                    │ plan review  │
                                    └──────┬───────┘
                                           ▼
                                    RED TEAM (plan)
                                    [scaffolded, disabled in v1]
```

**In `/stark-forge`:** after design-review converges, before plan generation. Self-contained. No changes to the existing review stages. Output is one grouped set of PR comments (one per persona) on the forge PR if one exists; otherwise logged to state + audit.

**In `/stark-forged-review`:** only fires when the forge path escalates (critical finding or count ≥ `forge_threshold`). Since forge-path auto-apply is itself deferred, the red-team call site in `/stark-forged-review` is scaffolded in v1. The code path exists and is testable, but doesn't run until forge-path auto-apply ships.

## 3. Personas (5)

Each persona is scoped to be **orthogonal to existing forge review domains** and to ask questions a code-level reviewer cannot answer. Persona files live at `global/prompts/red-team/personas/<slug>.md`.

### 3.1 Security & Trust Architect (`security-trust`)

Threat model, trust boundaries, attack surface, blast radius of compromise.

Asks: *Who are the attackers? What changes in their capability if this ships? Where does trust flow cross a boundary? What happens when an attacker lands in this design's "most privileged zone"? Does the design expand lateral movement?*

Distinct from forge's `security` domain (which audits code-level vulns) because this persona attacks the design-level threat model, not the implementation.

### 3.2 Reliability & Distributed Systems Architect (`reliability-distsys`)

Failure modes, partial failure, retry semantics, idempotency, data-loss windows, SPOFs, fanout storms, backpressure, ordering guarantees.

Asks: *What's the failure story? What happens when component X is down for 30 seconds? Can this message be processed twice safely? Is there a SPOF hiding in "just a queue"? What's the blast radius of a runaway retry loop?*

Distinct from forge's `resilience` domain (which checks error handling) — this persona attacks the systemic failure story across components.

### 3.3 Data Architect (`data`)

Schema evolution, migration safety, ownership boundaries, consistency model, read/write patterns, query shape sustainability, data lifecycle.

Asks: *How does this schema age across 3 years of feature drift? Who owns this table? What's the migration story for existing data? Are we creating a distributed transaction without admitting it? Are reads and writes actually aligned with the shape we're committing to?*

Distinct from forge's `data-modeling` domain (which checks ERD correctness) — this persona attacks the design's durability over time.

### 3.4 Product & DX Architect (`product-dx`)

Who the users actually are, whether the API/UX is the right abstraction, footguns, cognitive load, naming, ergonomics at the boundary.

Asks: *Who will call this API and at what level of sophistication? Is the "happy path" actually easy? Where are the footguns? Does a junior engineer writing their first integration succeed on the first try? Is the abstraction we're committing to something users will thank us for, or curse us for?*

No existing forge domain covers this. Often the voice that says *"the design is technically fine but nobody will want to use it."*

### 3.5 Cost & Operations Architect (`cost-ops`)

Runtime cost, infra burden, observability gaps, on-call pager load, deployment and rollback footprint, vendor-lock-in, long-tail ops cost.

Asks: *What does this cost to run at 10x our current scale? Who pages at 3 AM when this breaks? What does rollback look like if something's wrong the morning after deploy? Are we observing the right things? Can an SRE onboard to this system in a week?*

Distinct from forge's `operability` domain (which checks runbook completeness) — this persona asks whether the design can ever be operated economically.

## 4. Mechanics

### 4.1 Topology: single Codex o3 call, 5 personas, synthesis-required output

One LLM call per red-team invocation. The prompt assembles: preamble → all 5 persona files → design artifact (and source spec, and PR diff if available) → output schema.

The LLM is instructed to:
1. Take each persona's viewpoint in sequence and produce findings from that viewpoint
2. Then produce a `synthesis` section naming the top 1–2 cross-persona tensions
3. Emit valid JSON per the schema

**Why single-call rather than N persona subagents:** an opus-class reasoning model is genuinely good at holding multiple viewpoints concurrently, and *synthesis across viewpoints* is inherently a cross-persona operation that's strictly harder to reconstruct from N independent calls. Cost is bounded to 1 call per stage per round. If this proves shallow in practice, multi-call is a structural upgrade worth a follow-up design.

### 4.2 Agent + model

- **Agent:** Codex (dispatched via `codex exec`)
- **Model:** `o3` (per-call override — does not affect the default codex model used by forge/forged-review domain reviewers, which stays at `gpt-5.4`)
- **Reasoning effort:** high (matches other heavy Codex dispatches in the codebase)

The model override is implemented in the dispatcher by passing `-m o3` to the Codex CLI specifically for red-team calls. All other Codex invocations in the pipeline continue to use the model configured in the top-level `models.codex.model_id`.

### 4.3 Iterative refinement loop

```python
round = 1
current_design = design_after_design_review
while round <= cfg.max_rounds:
    rt = run_red_team("design", current_design, cfg, cwd)
    state.red_team.design.rounds.append(rt_to_state(rt))
    audit.record_round(rt)
    post_per_persona_pr_comments(rt)  # one comment per persona on the PR
    if rt.blocking_count == 0:
        state.red_team.design.status = "clean"
        break
    current_design = regenerate_design(current_design, rt)  # design-gen with red-team input
    rerun_design_review(current_design)  # existing review loop on revised design
    round += 1
else:
    state.red_team.design.status = "halted"
    if cfg.halt_on_unresolved:
        halt(
            f"red team has {rt.blocking_count} unresolved blocking "
            f"findings after {cfg.max_rounds} rounds"
        )
```

**Key properties:**
- Each loop iteration = 1 red-team call + 1 design regeneration + 1 design-review loop. The design-review loop has its own max-rounds cap.
- "Blocking" is determined by `min_severity_to_block` (default `high`) — only `critical` and `high` findings count toward the halt decision; `medium` is advisory.
- The design-generator receives the red-team findings in its prompt with this framing: *"The previous design was revised because a committee of senior architects (see personas below) raised these objections. For each finding, either (a) address it in the revised design, or (b) explicitly accept the trade-off and document why in the Trade-offs section."*
- The red team sees the same 5 personas every iteration — the criteria don't drift mid-loop.
- If `halt_on_unresolved` is `false`, unresolved findings are logged prominently but the pipeline exits 0. This is the advisory-only downgrade.

### 4.4 What the red team sees

The red-team prompt is assembled from:
1. **The preamble** (`global/prompts/red-team/preamble.md`): the committee framing, the synthesis rule, the output contract.
2. **All 5 persona files** (`global/prompts/red-team/personas/*.md`).
3. **The design artifact being attacked** (the full design doc as of the current round).
4. **The source spec** the design is supposed to implement (question 12.1 — yes). Gives the red team intent to judge against. For `/stark-forge`, this is the requirements doc or user prompt passed to the pipeline. For `/stark-forged-review`, this is the PR description and the original stark-forged-review finding set that triggered the forge path.
5. **The PR diff** (question 12.2 — yes, when `/stark-forged-review` is the caller). Gives the red team concrete context about what the PR is already doing. Not included when `/stark-forge` is the caller from a fresh requirements doc (no PR yet).
6. **The output schema** from §5.

## 5. Output contract: `RedTeamResult`

```python
@dataclass
class RedTeamFinding:
    id: str                 # "rt1", "rt2", ... — stable within a round
    persona: str            # one of the 5 persona slugs
    severity: str           # "critical" | "high" | "medium"
    concern: str            # 1-sentence statement of what's wrong
    consequence: str        # 2-3 sentences on what breaks if this ships as-is
    counter_proposal: str   # concrete alternative the persona would take
    trade_off: str          # what the counter-proposal gives up

@dataclass
class RedTeamResult:
    stage: str              # "design" | "plan"
    round_num: int
    synthesis: str          # paragraph naming top 1-2 cross-persona tensions
    findings: list[RedTeamFinding]
    blocking_count: int     # count of findings at ≥ min_severity_to_block
    raw_output: str         # preserved for audit
    duration_s: float
    error: str | None = None
```

**Schema-level invariants:**
- Every finding must have `counter_proposal` and `trade_off`. A finding without a counter-proposal is just a gripe — the dispatcher rejects it (downgrades severity to `medium` and notes the schema violation).
- `synthesis` is required. The dispatcher rejects outputs where `synthesis` is empty or obviously copy-pasted from a single finding — the whole point of the red team is the cross-persona view.
- `persona` must be one of the 5 configured slugs. Unknown personas → logged + dropped.
- No `file:line` fields. If the LLM tries to put code-level references in findings, they're stripped during parsing to keep the red team at the design level.

## 6. Config schema (`global/config.json` → `red_team`)

```json
{
  "red_team": {
    "enabled": true,
    "agent": "codex",
    "model": "o3",
    "max_rounds": 2,
    "halt_on_unresolved": true,
    "stages": {
      "design": { "enabled": true },
      "plan":   { "enabled": false }
    },
    "personas": [
      "security-trust",
      "reliability-distsys",
      "data",
      "product-dx",
      "cost-ops"
    ],
    "min_severity_to_block": "high",
    "timeout_s": 900
  }
}
```

| Field | Meaning |
|---|---|
| `enabled` | Master kill-switch for the whole red-team layer |
| `agent` | Which agent to invoke (default `codex`; alternatives can be added later) |
| `model` | Per-call model override passed via `-m` to the agent CLI |
| `max_rounds` | Cap on iterative refinement loop |
| `halt_on_unresolved` | If false, downgrade to advisory-only |
| `stages.design.enabled` | Run red team after design-review |
| `stages.plan.enabled` | Run red team after plan-review (v1: false) |
| `personas` | Ordered list — order controls prompt assembly order and determines persona sections in the output |
| `min_severity_to_block` | Floor for findings that count toward the halt decision |
| `timeout_s` | Per-call timeout (matches other heavy dispatches) |

Standard config hierarchy applies: repo → org → global. A repo can set `red_team.enabled: false` to opt out entirely. A repo with atypical stakes can raise `max_rounds` to 3 or lower `min_severity_to_block` to `medium` to be stricter.

## 7. Prompts layout

```
global/prompts/red-team/
├── preamble.md                     # Shared committee framing + synthesis rule
├── personas/
│   ├── security-trust.md           # ~30 lines: who, what they care about, example findings
│   ├── reliability-distsys.md
│   ├── data.md
│   ├── product-dx.md
│   └── cost-ops.md
├── design.md                       # ~60 lines: assembles preamble + personas + design context + output schema
└── plan.md                         # Same shape as design.md, scaffolded for v1 (dispatch gated by config)
```

- **Preamble (~40 lines):** frames the committee, forbids code-line findings, requires counter-proposal + trade-off on every finding, requires cross-persona synthesis, defines severity semantics.
- **Each persona file (~30 lines):** who they are, what they care about, what they deliberately don't cover (explicit orthogonality), 2–3 examples of the kind of finding they'd raise in this codebase's style.
- **`design.md` (~60 lines):** top-level system prompt — assembles the preamble, loads the persona files, injects the design artifact + source spec + (if available) PR diff, emits the output schema.
- **`plan.md`:** same shape, scaffolded. Enabled later.

Thin prompts keep the heavy lifting in persona files so adding/removing/re-scoping a persona is a single-file edit.

## 8. PR commenting

When the red team runs inside a caller that has a PR context (`/stark-forged-review`, or `/stark-forge` invoked against an existing PR), red-team findings are posted as **separate GitHub comments — one per persona — all on the same PR** (question 12.3).

**Why separate comments per persona:**
- Reviewers can engage with each architect individually. A thread on the security-trust comment stays focused; a thread on a grouped comment becomes a mess.
- Persona-level filtering/search works in the GitHub UI.
- Resolved vs. unresolved per persona is easy to track — once the design-generator addresses a persona's concerns, the next round's comment can be marked as resolved or collapsed.

**Comment body template (one per persona):**

```markdown
## 🔴 Red Team — {Persona Name}

**Round {N} of {max_rounds}**  ·  Findings: {critical} critical, {high} high, {medium} medium

### Synthesis (cross-persona)
{synthesis — same text on every persona comment in this round; gives context}

### Findings from this persona

#### 🔴 [{severity}] {concern}
**Consequence:** {consequence}
**Counter-proposal:** {counter_proposal}
**Trade-off:** {trade_off}

(... more findings ...)

---
*Generated by stark-red-team (Codex o3, round {N}). Config: `red_team.personas.{slug}`.*
```

The per-persona comment includes the top-level synthesis so each comment is independently useful. Bot identity is `stark-codex[bot]` (matches the agent dispatching the call).

## 9. State file additions

For `/stark-forge`'s state file and `/stark-forged-review`'s `.forged-review-state.json`, a new top-level `red_team` section:

```json
{
  "red_team": {
    "design": {
      "status": "pending | running | clean | halted | error",
      "rounds": [
        {
          "round_num": 1,
          "timestamp": "2026-04-12T10:15:00Z",
          "synthesis": "...",
          "findings_by_severity": { "critical": 1, "high": 2, "medium": 3 },
          "blocking_count": 3,
          "findings": [ /* RedTeamFinding array */ ],
          "duration_s": 42.1
        }
      ],
      "iterations_used": 2,
      "max_rounds": 2,
      "model": "o3",
      "started_at": "2026-04-12T10:14:00Z",
      "ended_at": "2026-04-12T10:18:00Z"
    },
    "plan": { "status": "disabled" }
  }
}
```

`status: "pending"` until the first round starts. `"running"` during a round. `"clean"` when blocking_count reaches 0. `"halted"` when max_rounds was exceeded and halt_on_unresolved is true. `"error"` on dispatch/parse failure.

## 10. Audit schema

New tables in `forged_review_metrics.db` (reused since it already exists; adding tables is backward-compatible with existing audits):

```sql
CREATE TABLE red_team_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,              -- "design" | "plan"
    rounds_used INTEGER NOT NULL,
    final_status TEXT NOT NULL,       -- "clean" | "halted" | "error" | "disabled"
    total_findings INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    high_count INTEGER NOT NULL,
    medium_count INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE red_team_persona_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    findings_raised INTEGER NOT NULL,
    findings_at_critical INTEGER NOT NULL,
    findings_at_high INTEGER NOT NULL,
    findings_at_medium INTEGER NOT NULL
);
```

**Why per-persona stats matter:** after a few weeks of live use, we can query:
- Which personas fire most? *(tuning: is one persona too broad or noisy?)*
- Which get resolved most in round 2? *(tuning: is a persona's concerns easy to address, or trivial?)*
- Which are most likely to cause halts? *(tuning: which persona is the hardest blocker?)*

A persona whose findings are always dismissed is probably badly scoped. A persona that never fires is probably redundant with the existing review domains. Both are signals for revising the persona list.

## 11. Scripts

### 11.1 New files

| File | Purpose | Est. lines |
|---|---|---|
| `scripts/stark_red_team.py` | Dispatcher. `run_red_team(stage, artifact, cfg, cwd, source_spec=None, pr_diff=None) → RedTeamResult`. Prompt assembly, Codex dispatch with `-m o3` override, output parsing, schema validation, severity gating. | ~250 |
| `scripts/red_team_audit.py` | Minimal extension using `audit_base`. `init_red_team_tables()`, `record_red_team_run()`, `record_persona_stats()`. | ~100 |
| `scripts/test_stark_red_team.py` | Unit tests: prompt assembly, output parsing, schema validation rejection, severity gating, halt logic, persona file loading, model override. Mocks Codex dispatch. | ~300 |
| `scripts/test_red_team_audit.py` | Schema + insert tests. | ~80 |

### 11.2 Modified files

| File | Change |
|---|---|
| `scripts/config_loader.py` | Add `DEFAULT_RED_TEAM` constant + `get_red_team_config()` accessor |
| `global/config.json` | Add `red_team` section |
| `scripts/forged_review_dispatch.py` | Add `dispatch_red_team_for_stage()` wrapper that the forged-review orchestrator can call when the forge path activates |
| `scripts/forged_review.py` | Scaffolded red-team call site (fires when forge-path auto-apply is built; v1 is a no-op placeholder) |
| `scripts/forged_review_audit.py` | Import the red_team tables from `red_team_audit.py` so they're created alongside the forged-review tables |
| `scripts/forge_orchestrator.py` | Insert red-team call between design-review convergence and plan generation; wire state + audit; honor `stages.design.enabled` config gate |
| `scripts/forge_plan.py` | Scaffolded red-team call site after plan-review, gated on `stages.plan.enabled` (default false) |
| `skill/stark-forge/SKILL.md` | Document the red-team stage briefly (one paragraph pointing at this spec) |
| `skill/stark-forged-review/README.md` | Document that red team runs in the forge path when it activates |

### 11.3 Unchanged (reused as-is)

- `codex_utils.py` — `-m` flag support already exists via `get_codex_model()` + the `codex exec -m <model>` pattern
- `audit_base.py` — shared primitives
- `emit_queue.py` — event emission
- `runtime_env.py` — subprocess env setup

## 12. Observability

**Events** (via `emit_queue.py`):

- `red_team.round.start` `{run_id, stage, round_num, model}`
- `red_team.round.end` `{run_id, stage, round_num, blocking_count, duration_s}`
- `red_team.halt` `{run_id, stage, rounds_used, blocking_count_remaining}`
- `red_team.clean` `{run_id, stage, rounds_used, total_findings}`
- `red_team.parse_error` `{run_id, stage, raw_output_excerpt}`
- `red_team.skipped` `{run_id, stage, reason}` — emitted when the red team is disabled, CLI unavailable, or persona files missing

**Metrics** (in `forged_review_metrics.db`):
- Per-run: stage, rounds used, final status, finding counts by severity, duration, model
- Per-persona per round: findings raised, severity breakdown

## 13. Failure modes

| Failure | Recovery |
|---|---|
| `red_team.enabled: false` | Skip entirely. Emit `red_team.skipped` event with reason `disabled`. Pipeline continues. |
| Codex CLI not available | Skip. Emit `red_team.skipped` with reason `cli_missing`. Pipeline continues. Red team is additive. |
| `o3` model not available on the Codex CLI | Log warning. Fall back to the agent's default model (from `models.codex.model_id`). Audit the fallback. |
| Red team output is not valid JSON | Retry once. On second failure, emit `red_team.parse_error`, treat as zero findings for that round (clean), continue. |
| Red team returns findings missing `counter_proposal` or `trade_off` | Downgrade those findings to `medium` (advisory), log the schema violation. Do not halt on these. |
| Persona file missing | Log which persona's file is missing. Drop that persona from the call. Continue with the remaining personas. |
| `blocking_count == 0` on first round | Skip the loop entirely. Mark status `clean`. Audit as "round 1 only". |
| Design regeneration fails between rounds | Halt with exit 2. Preserve state so `--resume` can pick up. |
| Design-review loop fails between rounds | Halt with exit 2. Preserve state. |
| Red team still blocking after `max_rounds` AND `halt_on_unresolved: true` | Halt with exit 1. Post the final red-team comments. Preserve state. |
| Red team still blocking after `max_rounds` AND `halt_on_unresolved: false` | Log findings prominently. Post comments. Pipeline continues. Exit 0. |
| Timeout during a red-team call | Retry once with same inputs. On second timeout, treat as `error` for that round, halt with exit 2 if `halt_on_unresolved`. |

## 14. Rollout

- **Week 0 (this spec):** design-stage red team enabled in `/stark-forge`. Plan-stage scaffolded. `/stark-forged-review` integration is a no-op placeholder (fires once forge-path auto-apply ships).
- **Weeks 1–2:** run on real `/stark-forge` invocations. Measure: rounds-to-clean distribution, per-persona firing rate, halt rate, total red-team cost per run.
- **Week 2:** first persona-list tuning based on observed signal. Drop or re-scope personas that consistently fire with `medium`-only findings or never fire at all.
- **Week 3:** flip `stages.plan.enabled: true` in the default config. Plan-stage red team goes live.
- **Week 4+:** enable `/stark-forged-review` forge-path red team when that path itself ships auto-apply.
- **Ongoing:** refine persona files based on halt patterns. If single-call synthesis proves shallow, consider upgrading to multi-call (option B from Q2) — structural change, revisited only if the data says so.

## 15. Acceptance criteria

- [ ] `stark_red_team.py` dispatcher compiles, imports cleanly, runs standalone on a fixture design doc with mocked Codex output.
- [ ] All 5 persona prompt files exist under `global/prompts/red-team/personas/`.
- [ ] `global/prompts/red-team/design.md` exists; `plan.md` exists as a scaffolded placeholder.
- [ ] `red_team` section added to `global/config.json` with the exact shape in §6.
- [ ] `get_red_team_config()` typed accessor in `config_loader.py` returns the merged default + override dict.
- [ ] `red_team_audit.py` creates the two tables in §10; inserting a round + persona stats survives a round-trip read.
- [ ] Unit tests cover: prompt assembly (all 5 personas loaded, order preserved), output JSON parsing (valid + malformed + missing-field cases), severity gating (`min_severity_to_block` respected), halt logic (max_rounds exceeded triggers halt when `halt_on_unresolved: true`), persona-file-missing graceful degradation, model-override path (`-m o3` in the command), PR comment generation (one body per persona, synthesis included in each).
- [ ] `/stark-forge` design-stage integration: red team runs after design-review convergence, feeds findings back into design regeneration, loops up to `max_rounds`, halts cleanly on unresolved.
- [ ] `/stark-forged-review` forge-path call site is scaffolded (function exists, wired to config, no-op when forge-path auto-apply is not active).
- [ ] Plan-stage call sites exist but short-circuit on `stages.plan.enabled: false`.
- [ ] `forged_review_metrics.db` opens with the new tables; existing `forged-review` audits still work.
- [ ] PR commenting: when a PR context exists, red-team findings post as separate comments under `stark-codex[bot]`, one per persona, each including the shared `synthesis`.
- [ ] `red_team.skipped` event fires correctly when enabled=false, CLI missing, or `stages.design.enabled: false`.
- [ ] Design spec references red-team personas in `skill/stark-forge/SKILL.md` and `skill/stark-forged-review/README.md`.
- [ ] `skill-creator:skill-creator` structural eval passes on the updated skills.
