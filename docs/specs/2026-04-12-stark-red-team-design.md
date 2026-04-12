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
spent_usd = 0.0

while round <= cfg.max_rounds:
    # Cost circuit breaker — rt5
    if spent_usd >= cfg.per_run_budget_usd:
        state.red_team.design.status = "halted"
        halt("budget_exceeded", f"red team spent ${spent_usd:.2f} of ${cfg.per_run_budget_usd:.2f}")

    rt = run_red_team("design", current_design, cfg, cwd)
    spent_usd += rt.cost_usd
    state.red_team.design.rounds.append(rt_to_state(rt))
    audit.record_round(rt)
    audit.record_findings(rt.findings)  # rt3 — persist raw finding text
    post_per_persona_pr_comments(rt)

    # Human-review halt — rt4
    if rt.human_review_count > 0:
        state.red_team.design.status = "halted_human_review"
        halt("human_review_requested",
             f"{rt.human_review_count} finding(s) request human review; not auto-addressable")

    if rt.blocking_count == 0:
        state.red_team.design.status = "clean"
        break

    # Stability check on the halting round — rt2 (folded in)
    # If this is the last permitted round and blocking_count > 0, run a second
    # call on the same input before halting. Only halt if BOTH calls produce
    # blocking findings AND at least one finding overlaps by (persona, concern).
    if round == cfg.max_rounds:
        rt_verify = run_red_team("design", current_design, cfg, cwd)
        spent_usd += rt_verify.cost_usd
        audit.record_round(rt_verify, tag="stability_verify")
        if rt_verify.blocking_count == 0 or not _overlap(rt, rt_verify):
            # Flicker — downgrade to advisory, do not halt
            state.red_team.design.status = "clean_after_flicker"
            post_flicker_notice_comment(rt, rt_verify)
            break

    current_design = regenerate_design(current_design, rt)
    rerun_design_review(current_design)  # existing review loop on revised design
    round += 1
else:
    state.red_team.design.status = "halted"
    if cfg.halt_on_unresolved:
        halt("findings_unresolved",
             f"red team has {rt.blocking_count} unresolved blocking "
             f"findings after {cfg.max_rounds} rounds")
```

```python
def _overlap(rt_a: RedTeamResult, rt_b: RedTeamResult) -> bool:
    """Two red-team outputs overlap if at least one blocking finding in each
    shares the same persona and has a concern that's textually similar
    (case-insensitive bag-of-words Jaccard ≥ 0.4)."""
    ...
```

**Key properties:**
- Each loop iteration = 1 red-team call + optional design regeneration + 1 design-review loop. The design-review loop has its own max-rounds cap. The stability-verify call fires only on the final round when halt is imminent, so cost is bounded to `max_rounds + 1` red-team calls per stage in the worst case.
- **Three ways to halt:** budget exceeded (rt5), human-review requested (rt4), or findings unresolved after `max_rounds` with stability confirmation (rt2).
- **"Blocking"** is determined by `min_severity_to_block` (default `high`). `medium` is advisory. Human-review findings halt regardless of severity.
- The design-generator receives the red-team findings in its prompt with this framing: *"The previous design was revised because a committee of senior architects (see personas below) raised these objections. For each finding that is NOT a human-review request, either (a) address it in the revised design, or (b) explicitly accept the trade-off and document why in the Trade-offs section. Do not attempt to auto-address findings marked REQUEST_HUMAN_REVIEW — those halt the loop for human attention."*
- The red team sees the same 5 personas every iteration — the criteria don't drift mid-loop.
- **Stability check** (rt2): on the halting round only, run the red team a second time. If the blocking set doesn't overlap with the first call (flicker), downgrade to clean-with-advisory. If both calls produce overlapping blocking findings, halt. This costs one extra call only when halting is imminent.
- If `halt_on_unresolved` is `false`, findings-unresolved becomes advisory; budget and human-review halts are unaffected (they have no advisory mode).

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
    id: str                           # "rt1", "rt2", ... — stable within a round
    persona: str                      # one of the 5 persona slugs
    severity: str                     # "critical" | "high" | "medium"
    concern: str                      # 1-sentence statement of what's wrong
    consequence: str                  # 2-3 sentences on what breaks if this ships as-is
    counter_proposal: str             # concrete alternative OR the sentinel "REQUEST_HUMAN_REVIEW"
    trade_off: str | None             # what the counter-proposal gives up (unused when human-review is requested)
    reason_for_uncertainty: str | None # required iff counter_proposal == "REQUEST_HUMAN_REVIEW"

@dataclass
class RedTeamResult:
    stage: str                        # "design" | "plan"
    round_num: int
    synthesis: str                    # paragraph naming top 1-2 cross-persona tensions
    findings: list[RedTeamFinding]
    blocking_count: int               # count of findings at ≥ min_severity_to_block (excluding human-review requests)
    human_review_count: int           # count of findings with counter_proposal == "REQUEST_HUMAN_REVIEW"
    raw_output: str                   # preserved for audit
    duration_s: float
    error: str | None = None
```

**Schema-level invariants:**
- Every finding must have either (a) a concrete `counter_proposal` + `trade_off`, or (b) `counter_proposal == "REQUEST_HUMAN_REVIEW"` + a populated `reason_for_uncertainty` (rt4). The second form is the red team's honest-uncertainty voice: the persona is worried but cannot articulate a fix. Findings that satisfy neither form are rejected (downgraded to `medium` and flagged as schema violations).
- **Human-review findings halt the loop unconditionally** regardless of severity. The design-generator must not attempt to auto-address them — they are reserved for human eyes. The loop resumes only when a human explicitly overrides (`--accept-red-team-human-review` flag on the caller, not yet implemented in v1).
- `synthesis` is required. The dispatcher rejects outputs where `synthesis` is empty or obviously copy-pasted from a single finding — the whole point of the red team is the cross-persona view.
- `persona` must be one of the 5 configured slugs. Unknown personas → logged + dropped.
- No `file:line` fields. If the LLM tries to put code-level references in findings, they're stripped during parsing to keep the red team at the design level.
- The red team prompt explicitly invites `REQUEST_HUMAN_REVIEW` as a first-class option — it is *not* a fallback or error path. Persona prompts include the framing: "*If you cannot articulate a concrete counter-proposal but the concern is real, request human review. This is a sign of integrity, not failure.*"

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
    "timeout_s": 900,
    "per_run_budget_usd": 3.00,
    "stability_overlap_jaccard_min": 0.4
  }
}
```

| Field | Meaning |
|---|---|
| `enabled` | Master kill-switch for the whole red-team layer |
| `agent` | Which agent to invoke (default `codex`) |
| `model` | Per-call model override passed via `-m` to the agent CLI |
| `max_rounds` | Cap on iterative refinement loop |
| `halt_on_unresolved` | If false, findings-unresolved becomes advisory (budget + human-review halts are unaffected) |
| `stages.design.enabled` | Run red team after design-review |
| `stages.plan.enabled` | Run red team after plan-review (v1: false) |
| `personas` | Ordered list — controls prompt assembly order and persona sections in output |
| `min_severity_to_block` | Floor for findings that count toward the findings-unresolved halt |
| `timeout_s` | Per-call timeout (matches other heavy dispatches) |
| `per_run_budget_usd` | Cost circuit breaker (rt5). Cumulative red-team spend above this halts with `budget_exceeded` |
| `stability_overlap_jaccard_min` | Threshold for concern-text overlap in stability check (rt2) |

### Config override rules (rt1 — prompt-injection defense)

Standard config hierarchy applies: repo → org → global, but **two fields are LOCKED to global config** and cannot be overridden at the org or repo level:

| Locked field | Why |
|---|---|
| `personas` | Persona slugs resolve to prompt files in `global/prompts/red-team/personas/`. Allowing a repo to specify arbitrary persona slugs opens a prompt-injection surface where a malicious config points at an attacker-controlled markdown file with injected system instructions. |
| `model` | Allowing a repo to silently downgrade `o3` to a cheaper/weaker model preserves the "red team ran" appearance while destroying the substance. Downgrading the model must be a global, reviewable, centrally-audited decision. |

All other fields (`enabled`, `max_rounds`, `halt_on_unresolved`, `stages.*.enabled`, `min_severity_to_block`, `per_run_budget_usd`, `timeout_s`, `stability_overlap_jaccard_min`) respect the full hierarchy.

**Enforcement:** `get_red_team_config()` in `config_loader.py` checks if the resolved config from org/repo level contains a key in `_RED_TEAM_LOCKED_FIELDS = {"personas", "model"}`. If yes, the value is dropped from the override, a warning is logged to stderr with the locked field name and the source file that tried to set it, and a `red_team.config.override_rejected` event is emitted for audit.

A repo that genuinely needs a custom persona (e.g., an ML-heavy repo wanting an "ML Systems Architect") must open a PR against `stark-skills` to add the persona file to the global repo. This is by design: customization has the same friction as abuse, so legitimate additions are reviewable.

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

Three new tables in `forged_review_metrics.db` (reused since it already exists; adding tables is backward-compatible with existing audits):

```sql
CREATE TABLE red_team_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,                -- "design" | "plan"
    rounds_used INTEGER NOT NULL,
    final_status TEXT NOT NULL,         -- "clean" | "clean_after_flicker" | "halted"
                                        --  | "halted_human_review" | "halted_budget"
                                        --  | "error" | "disabled"
    total_findings INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    high_count INTEGER NOT NULL,
    medium_count INTEGER NOT NULL,
    human_review_count INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    cost_usd REAL NOT NULL,             -- rt5 — cumulative cost of all red-team calls this run
    model TEXT NOT NULL,
    caller TEXT NOT NULL,               -- "forge" | "forged-review"
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
    findings_at_medium INTEGER NOT NULL,
    human_review_requests INTEGER NOT NULL  -- rt4 — per-persona honest-uncertainty signal
);

-- rt3 — persist raw finding text so persona-tuning in §14 has data to tune from.
-- Sized for ~20 findings/run × ~1KB/finding × 1000 runs/year ≈ 20MB/year.
CREATE TABLE red_team_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    finding_id TEXT NOT NULL,           -- "rt1", "rt2", ... stable within a round
    persona TEXT NOT NULL,
    severity TEXT NOT NULL,             -- "critical" | "high" | "medium"
    concern TEXT NOT NULL,
    consequence TEXT NOT NULL,
    counter_proposal TEXT NOT NULL,     -- concrete text OR "REQUEST_HUMAN_REVIEW"
    trade_off TEXT,                     -- nullable when counter_proposal is REQUEST_HUMAN_REVIEW
    reason_for_uncertainty TEXT,        -- populated iff counter_proposal is REQUEST_HUMAN_REVIEW
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_red_team_findings_run ON red_team_findings(run_id, round_num);
CREATE INDEX idx_red_team_findings_persona ON red_team_findings(persona, severity);
```

**Why the three tables:**
- `red_team_runs` — run-level rollup for cost/halt/duration dashboards. Includes `caller` to distinguish `/stark-forge` vs. `/stark-forged-review` runs, and `cost_usd` so historical data can inform future budget tuning.
- `red_team_persona_stats` — per-persona aggregates for the tuning ritual in §14. Tracks human-review requests as a separate signal.
- `red_team_findings` — **raw finding text**, added in response to rt3. Without this, §14's "tune personas based on observed signal" has no substrate.

**Why per-persona stats matter:** after a few weeks of live use, we can query:
- *Which personas fire most?* (tuning: is one persona too broad or noisy?)
- *Which get resolved most in round 2?* (is a persona's concerns easy to address, or trivial?)
- *Which are most likely to cause halts?* (which persona is the hardest blocker?)
- *Which raise the most `REQUEST_HUMAN_REVIEW` findings?* (a sign of a mature persona that knows its own limits)
- *What did the data architect actually say on PR #42, round 2?* — answerable by joining `red_team_findings` on `run_id + round_num + persona`.

A persona whose findings are always dismissed is probably badly scoped. A persona that never fires is probably redundant with existing review domains. A persona that only ever requests human review is probably missing a concrete capability. All three are signals for revising the persona list — and all three are now empirically observable.

## 11. Scripts

### 11.1 New files

| File | Purpose | Est. lines |
|---|---|---|
| `scripts/stark_red_team.py` | Dispatcher. `run_red_team(stage, artifact, cfg, cwd, source_spec=None, pr_diff=None) → RedTeamResult`. Prompt assembly, Codex dispatch with `-m o3` override, output parsing, schema validation (including `REQUEST_HUMAN_REVIEW` handling per rt4), severity gating, cost tracking per call (rt5), stability overlap computation per rt2. | ~350 |
| `scripts/red_team_audit.py` | Extension using `audit_base`. `init_red_team_tables()`, `record_red_team_run()`, `record_persona_stats()`, **`record_findings()`** (rt3 — writes raw finding text to `red_team_findings`). | ~140 |
| `scripts/test_stark_red_team.py` | Unit tests: prompt assembly, output parsing, schema validation (including REQUEST_HUMAN_REVIEW accepted form and missing-reason-for-uncertainty rejection), severity gating, halt logic (findings/human-review/budget), stability overlap (same persona + Jaccard ≥ threshold), config override locking (rt1), persona file loading, model override. Mocks Codex dispatch. | ~450 |
| `scripts/test_red_team_audit.py` | Schema + insert + round-trip tests for all three tables. | ~140 |

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
| Red team still blocking after `max_rounds` AND `halt_on_unresolved: true` | Stability check fires (rt2): run one more red-team call on the same input. If second call has 0 blocking OR no finding overlap with the first, mark `clean_after_flicker` and exit 0 with advisory comment. Otherwise halt with exit 1. Preserve state. |
| Red team still blocking after `max_rounds` AND `halt_on_unresolved: false` | Same stability check. On confirmed blocking, log prominently, post comments, exit 0. On flicker, mark `clean_after_flicker`, exit 0. |
| Red team produces `human_review_count > 0` at any round (rt4) | Halt with status `halted_human_review` regardless of severity or `halt_on_unresolved`. Human-review findings are never auto-addressable — the design-generator must not revise based on them. Exit 1. Preserve state. Future `--accept-red-team-human-review` flag (not in v1) will allow explicit human override to resume. |
| Cumulative red-team `cost_usd` exceeds `per_run_budget_usd` (rt5) | Halt immediately with status `halted_budget` before the next round starts. Exit 1. Preserve state. Budget overrun is a structural signal that the design is churning and needs human intervention, not more loops. |
| Repo-level config attempts to override `red_team.personas` or `red_team.model` (rt1) | Drop the override. Log warning to stderr with source file. Emit `red_team.config.override_rejected` event. Continue with global-locked values. |
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
- [ ] Persona prompts explicitly invite `REQUEST_HUMAN_REVIEW` as a first-class option (rt4).
- [ ] `red_team` section added to `global/config.json` with the exact shape in §6, including `per_run_budget_usd` and `stability_overlap_jaccard_min`.
- [ ] `get_red_team_config()` typed accessor in `config_loader.py` returns the merged default + override dict AND rejects overrides of `personas` / `model` from org/repo levels, emitting a warning + `red_team.config.override_rejected` event (rt1).
- [ ] `red_team_audit.py` creates all **three** tables in §10 (`red_team_runs`, `red_team_persona_stats`, `red_team_findings` — rt3); inserting a round + persona stats + raw findings survives a round-trip read.
- [ ] `record_findings()` persists `concern`, `consequence`, `counter_proposal`, `trade_off`, and `reason_for_uncertainty` for every finding (rt3).
- [ ] Unit tests cover:
  - Prompt assembly (all 5 personas loaded, order preserved, persona prompts include `REQUEST_HUMAN_REVIEW` invitation)
  - Output JSON parsing (valid + malformed + missing-field cases + REQUEST_HUMAN_REVIEW form)
  - Schema rejection of findings missing `counter_proposal`/`trade_off` AND missing `reason_for_uncertainty` when human-review is requested
  - Severity gating (`min_severity_to_block` respected)
  - Halt logic: findings-unresolved, human-review-requested (rt4), budget-exceeded (rt5)
  - Stability check (rt2): flicker → `clean_after_flicker`; confirmed blocking → halt
  - Config override locking: repo-level `personas` / `model` overrides dropped with warning (rt1)
  - Persona-file-missing graceful degradation
  - Model-override path (`-m o3` appears in the assembled command)
  - Cost tracking: cumulative `cost_usd` updated per call, halts on budget breach
  - PR comment generation (one body per persona, synthesis in each)
- [ ] `/stark-forge` design-stage integration: red team runs after design-review convergence, feeds findings back into design regeneration, loops up to `max_rounds`, halts cleanly on unresolved/human-review/budget.
- [ ] `/stark-forged-review` forge-path call site is scaffolded (function exists, wired to config, no-op when forge-path auto-apply is not active).
- [ ] Plan-stage call sites exist but short-circuit on `stages.plan.enabled: false`.
- [ ] `forged_review_metrics.db` opens with the new tables; existing `forged-review` audits still work.
- [ ] PR commenting: when a PR context exists, red-team findings post as separate comments under `stark-codex[bot]`, one per persona, each including the shared `synthesis`. Comments are idempotent across rounds via deterministic markers.
- [ ] `red_team.skipped` event fires correctly when enabled=false, CLI missing, or `stages.design.enabled: false`.
- [ ] `red_team.config.override_rejected` event fires when a repo/org config tries to override `personas` or `model`.
- [ ] Design spec references red-team personas in `skill/stark-forge/SKILL.md` and `skill/stark-forged-review/README.md`.
- [ ] `skill-creator:skill-creator` structural eval passes on the updated skills.
