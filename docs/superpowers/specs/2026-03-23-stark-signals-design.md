# stark-signals — LLM Consensus Voting, Tournament Execution & Adaptive Training

## Overview

A system that adds voting-based consensus to the multi-agent review pipeline, parallel implementation tournaments, and a feedback loop that makes agent weights learn from outcomes. Deployed as a standalone service (`stark-signals`) on GCP with a shared Cloud SQL database, Cloud Run API + dashboard, and a Python client embedded in stark-skills.

## Problem Statement

The current multi-agent review system (3 LLMs × N domains) collects findings from all agents but resolves disagreements with a naive "highest severity wins" dedup. There's no consensus mechanism, no way to learn which agent is most accurate per domain, and no ability to have agents compete on implementation quality. Data about review accuracy is collected but not used to improve future reviews.

## Goals

1. **Consensus voting** — replace "highest severity wins" with weighted majority voting on finding severity and classification
2. **Implementation tournament** — 3 LLMs implement the same task in parallel git worktrees, cross-review each other's work, winner selected by cross-review score + acceptance criteria
3. **Training data collection** — capture every decision (votes, classifications, human overrides, post-merge regressions) as labeled training signals
4. **Adaptive weights** — use accumulated signals to recalibrate per-agent × per-domain weights, improving review quality over time
5. **Team dashboard** — web UI for agent scorecards, tournament results, weight trends, finding accuracy

## Non-Goals

- Fine-tuning the LLMs themselves (we tune prompts and weights, not model parameters)
- Replacing human judgment (humans can always override; overrides become gold training signals)
- Real-time inference (recalibration runs on schedule or on-demand, not inline)
- Customer-facing data handling (this is internal engineering data only)

## Architecture

### System Boundary

```
┌──────────────────────────────────────────────────────────────────┐
│ stark-skills (existing)                                          │
│                                                                  │
│  multi_review.py ──→ consensus.py ──→ output (PR comments)      │
│       │                    │                                     │
│  tournament.py ────────────┤                                     │
│       │                    │                                     │
│  signal_client.py ─────────┴──→ stark-signals Cloud Run API     │
│       │                              │                           │
│       │ (fallback: local spool)      │                           │
│       └──→ ~/.cache/stark-signals/   │                           │
│                                      ↓                           │
└──────────────────────────────────────────────────────────────────┘
                                       │
┌──────────────────────────────────────│───────────────────────────┐
│ stark-signals (new repo + Cloud Run) │                           │
│                                      │                           │
│  FastAPI API ────────────────────────┘                           │
│       │                                                          │
│       ├──→ Cloud SQL (stark_signals DB)                          │
│       │                                                          │
│  React Dashboard (agent scores, tournaments, weight trends)      │
│                                                                  │
│  Recalibration Engine (Cloud Run Jobs + Cloud Scheduler)         │
│                                                                  │
│  Webhook Receiver (/api/v1/webhooks/github — no IAP)             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Key architecture decisions**:

1. `signal_client.py` does NOT connect directly to Cloud SQL. All writes go through the `stark-signals` Cloud Run API. This keeps the database behind a single service boundary with schema versioning, validation, and access control in one place. If the API is unreachable, the client spools events to `~/.cache/stark-signals/pending.jsonl` and flushes them on the next successful connection.

2. **Consensus is computed server-side.** The client sends raw findings + review coverage metadata. The server runs the voting protocol, computes consensus severity/classification, and stores votes. This avoids shipping consensus logic to every client and ensures all votes go through the API.

3. **Client auth**: local dev uses `gcloud auth print-identity-token --audiences=<service-url>` (user's Google identity, same as IAP). CI/CD uses service-to-service OIDC. Both paths hit the same API endpoints.

### Deployment

| Component | Target | Auth |
|-----------|--------|------|
| Database | Cloud SQL PostgreSQL (existing infra-ai-platform instance, new `stark_signals` database) | IAM auth, only from Cloud Run service |
| API + Dashboard | Cloud Run (`stark-signals` service) | IAP (Google OAuth, @evinced.com) for dashboard; service-to-service OIDC for client |
| Webhook endpoint | Cloud Run (same service, `/api/v1/webhooks/github`) | Bypasses IAP; validated via `X-Hub-Signature-256` |
| Python client (local) | Embedded in stark-skills (`scripts/signal_client.py`) | `gcloud auth print-identity-token` (user's Google identity) |
| Python client (CI) | Same library | Service-to-service OIDC |
| Background jobs | Cloud Run Jobs + Cloud Scheduler | Service account |
| Terraform | New module in infra-ai-platform registry | WIF (GitHub OIDC) |
| Monitoring | infra-sentinel (Prometheus + Loki + Grafana) | Existing stack |

### Infrastructure

- Register `stark-signals` in infra-ai-platform's service registry
- Onboard to infra-sentinel for monitoring (see Observability section)
- Share the existing Cloud SQL instance (new database, not new instance)
- Cloud Run service behind the existing load balancer
- IAP for dashboard access; IAP bypass for webhook + service-to-service paths
- Cloud Run Jobs for recalibration + regression scanning

### Deployment Sequence

1. **Database first** — Alembic migration creates schema (backward-compatible, additive only)
2. **Cloud Run service** — deploy API + dashboard (can start empty, no traffic yet)
3. **Client update** — update `signal_client.py` in stark-skills to write to API (feature-flagged, off by default)
4. **Enable flag** — turn on signal collection per repo via `.code-review/config.json`
5. **Rollback** — disable feature flag → client stops writing, reviews use static weights, no data loss

## Canonical Enums

Single source of truth for all enum values used across database, API, and client.

```python
class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    NONE = "none"  # implicit vote: agent did not flag this issue

SEVERITY_ORDER = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.NONE]

class Classification(str, Enum):
    FIX = "fix"
    NOISE = "noise"
    FALSE_POSITIVE = "false_positive"
    IGNORED = "ignored"
    RECURRING = "recurring"
    NEEDS_HUMAN_REVIEW = "needs_human_review"

class VoteType(str, Enum):
    ISSUE = "issue"       # agent flagged this
    NOT_ISSUE = "not_issue"  # agent explicitly reviewed and disagrees
    ABSTAIN = "abstain"   # agent did not review this area

class SignalType(str, Enum):
    HUMAN_OVERRIDE = "human_override"
    REGRESSION = "regression"
    CONVERGENCE = "convergence"

class SignalTier(str, Enum):
    GOLD = "gold"
    SILVER = "silver"
    BRONZE = "bronze"

class ReviewType(str, Enum):
    CODE = "code"
    PLAN = "plan"

class ProposalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"
```

## Data Model

### Tables

#### `agents`
Registry of LLM agents.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | VARCHAR | unique: claude, codex, gemini |
| cli_command | VARCHAR | e.g., "claude", "codex", "gemini" |
| model_version | VARCHAR | e.g., "claude-opus-4-6" |
| is_active | BOOLEAN | default true |
| created_at | TIMESTAMP | |

#### `agent_domain_weights`
Per-agent × per-domain accuracy weights. Append-only — versioned by `effective_from`.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| agent_id | UUID | FK → agents |
| domain | VARCHAR | architecture, security, correctness, etc. |
| weight | FLOAT | 0.0–1.0, used in consensus voting |
| precision | FLOAT | TP / (TP + FP), from signal analysis |
| recall | FLOAT | TP / (TP + FN), from signal analysis |
| f1_score | FLOAT | harmonic mean of precision/recall |
| sample_count | INT | how many signals inform this weight |
| effective_from | TIMESTAMP | version tracking |
| created_at | TIMESTAMP | |

Unique constraint: (agent_id, domain, effective_from)

#### `review_runs`
One row per review execution. Snapshots model/prompt versions for reproducibility.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| idempotency_key | VARCHAR | unique: `{repo}:{pr_number}:{base_sha}:{round}` (deterministic, no timestamp) |
| repo | VARCHAR | org/repo |
| pr_number | INT | nullable for plan reviews |
| review_type | VARCHAR | code, plan (see ReviewType enum) |
| plan_file | VARCHAR | nullable, for plan reviews |
| base_sha | VARCHAR | merge base commit |
| round_count | INT | number of review rounds |
| total_findings | INT | |
| fix_count | INT | classified as fix |
| noise_count | INT | classified as noise |
| false_positive_count | INT | |
| needs_human_review_count | INT | |
| signal_to_noise | FLOAT | fix / total |
| duration_seconds | FLOAT | |
| agent_versions | JSONB | snapshot: `{"claude": {"model": "...", "prompt_hash": "..."}, ...}` |
| config_snapshot | JSONB | review config at time of run |
| created_at | TIMESTAMP | |

Unique constraint: (idempotency_key)

#### `findings`
Every finding from every agent, every round, with consensus result.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| idempotency_key | VARCHAR | unique: `{review_run_id}:{agent}:{domain}:{round}:{file_or_section}:{title_hash}` |
| review_run_id | UUID | FK → review_runs |
| round | INT | which review round |
| agent | VARCHAR | claude, codex, gemini |
| domain | VARCHAR | architecture, security, etc. |
| severity | VARCHAR | original severity from agent (see Severity enum) |
| consensus_severity | VARCHAR | voted severity (may differ) |
| consensus_score | FLOAT | 0.0–1.0, agreement strength |
| classification | VARCHAR | see Classification enum |
| consensus_classification | VARCHAR | voted classification (may differ from skill-layer) |
| file | VARCHAR | nullable for plan reviews |
| line | INT | nullable |
| section | VARCHAR | nullable, for plan reviews |
| title | VARCHAR | |
| description | TEXT | |
| suggestion | TEXT | |
| confirmers | JSONB | array of {agent, domain} that also flagged this |
| was_fixed | BOOLEAN | did the fix round address this? |
| created_at | TIMESTAMP | |

Unique constraint: (idempotency_key)

#### `votes`
Raw voting record — audit trail, never modified. Includes both severity and classification ballots.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| finding_id | UUID | FK → findings |
| voter_agent | VARCHAR | which agent cast this vote |
| voter_domain | VARCHAR | from which domain perspective |
| vote_type | VARCHAR | issue, not_issue, abstain (see VoteType enum) |
| severity_vote | VARCHAR | this agent's severity assessment (see Severity enum) |
| classification_vote | VARCHAR | this agent's classification (see Classification enum, nullable) |
| confidence | FLOAT | 0.0–1.0 |
| weight_at_vote | FLOAT | agent's weight when vote was cast |
| created_at | TIMESTAMP | |

#### `tournament_runs`
One row per tournament execution. Snapshots versions for reproducibility.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK, also used in worktree paths for idempotency |
| repo | VARCHAR | |
| issue_number | INT | |
| plan_slug | VARCHAR | |
| task_id | VARCHAR | |
| winner_agent | VARCHAR | nullable until selection |
| winner_score | FLOAT | |
| selection_reason | TEXT | why this agent won |
| acceptance_criteria_met | JSONB | per-agent: which criteria passed/failed |
| duration_seconds | FLOAT | |
| agent_versions | JSONB | snapshot of model versions |
| created_at | TIMESTAMP | |

#### `tournament_implementations`
Each agent's implementation attempt in a tournament.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| tournament_run_id | UUID | FK → tournament_runs |
| agent | VARCHAR | |
| branch_name | VARCHAR | includes tournament_run_id for uniqueness |
| commit_sha | VARCHAR | |
| worktree_path | VARCHAR | includes tournament_run_id |
| files_changed | INT | |
| lines_added | INT | |
| lines_deleted | INT | |
| test_pass_count | INT | |
| test_fail_count | INT | |
| test_skip_count | INT | |
| cross_review_score | FLOAT | aggregate findings from other 2 agents |
| cross_review_findings | INT | total findings from other 2 agents |
| cross_review_critical | INT | critical findings |
| cross_review_high | INT | high findings |
| acceptance_passed | BOOLEAN | did it pass acceptance criteria? |
| selected | BOOLEAN | was this the winner? |
| disqualified | BOOLEAN | default false |
| disqualification_reason | VARCHAR | nullable |
| created_at | TIMESTAMP | |

#### `signals`
Ground truth training data — the labels.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| idempotency_key | VARCHAR | unique: prevents duplicate signals |
| signal_type | VARCHAR | see SignalType enum |
| signal_tier | VARCHAR | see SignalTier enum |
| source_type | VARCHAR | finding, tournament, review_run |
| source_id | UUID | FK to the relevant table |
| agent | VARCHAR | which agent this signal is about |
| domain | VARCHAR | nullable |
| original_value | VARCHAR | what the system decided |
| corrected_value | VARCHAR | what the ground truth says |
| weight_delta | FLOAT | computed impact on agent weight |
| context | JSONB | extra context (who overrode, PR that regressed, etc.) |
| applied_to_proposal_id | UUID | FK → weight_update_proposals, nullable |
| dismissed | BOOLEAN | default false; true if linked proposal was rejected |
| created_at | TIMESTAMP | |

Unique constraint: (idempotency_key)

#### `weight_update_proposals`
Proposed weight changes awaiting approval. Signals are NOT consumed until proposal is approved.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| agent_id | UUID | FK → agents |
| domain | VARCHAR | |
| current_weight | FLOAT | weight at time of proposal |
| proposed_weight | FLOAT | new proposed weight |
| delta | FLOAT | proposed - current |
| signal_count | INT | how many signals drive this proposal |
| signal_ids | JSONB | array of signal IDs |
| status | VARCHAR | pending, approved, rejected, superseded (see ProposalStatus enum) |
| confidence | FLOAT | statistical confidence in the change |
| reviewed_by | VARCHAR | nullable, who approved/rejected |
| reviewed_at | TIMESTAMP | nullable |
| created_at | TIMESTAMP | |

When a new proposal is created for the same (agent, domain) while one is pending, the old proposal is set to `superseded`.

### Indexes

- `findings`: (review_run_id, agent, domain), (file, line), (classification), (idempotency_key UNIQUE)
- `votes`: (finding_id), (voter_agent)
- `signals`: (signal_type, applied_to_proposal_id IS NULL), (agent, domain), (source_type, source_id), (idempotency_key UNIQUE)
- `agent_domain_weights`: (agent_id, domain, effective_from DESC)
- `tournament_implementations`: (tournament_run_id, agent)
- `review_runs`: (idempotency_key UNIQUE), (repo, pr_number)
- `weight_update_proposals`: (agent_id, domain, status), (status) WHERE status = 'pending'

### Capacity Planning

**Estimated data volume per review run:**
- ~20 findings × ~200 bytes each = ~4 KB
- ~60 votes (20 findings × 3 agents) × ~100 bytes = ~6 KB
- ~5 signals × ~150 bytes = ~750 bytes
- Total per review: ~11 KB

**Estimated volume per tournament:**
- 3 implementations × ~500 bytes = ~1.5 KB
- 6 cross-reviews × ~4 KB findings = ~24 KB
- Total per tournament: ~26 KB

**Growth projection:**
- ~20 reviews/week + ~5 tournaments/week = ~700 KB/week = ~36 MB/year
- With indexes and overhead: ~100 MB/year

**Archival strategy:** After 12 months, export completed review/tournament records to GCS as Parquet files. Keep signals and weights in Cloud SQL indefinitely (they're small and needed for recalibration). Archival triggered by Cloud Scheduler job, logged, reversible.

## Consensus Engine

### Finding Grouping

Findings are grouped differently based on review type:

- **Code reviews**: group by `(file, line_bucket ±10, normalized_title)` — same as current dedup
- **Plan reviews**: group by `(section, normalized_title)` — no file/line, uses section header instead

`normalized_title` = lowercase, strip punctuation, collapse whitespace. Two titles match if their Levenshtein distance is ≤ 20% of the longer title's length.

### Voting Protocol

When findings are collected from all agents after a review round:

1. **Group findings** by the appropriate grouping key (code or plan)
2. For each group, each agent casts a **severity vote** and a **classification vote**:
   - Agents that produced a finding vote with `vote_type = issue` and their assessed severity/classification
   - Agents that reviewed the same file/section but did NOT flag the issue vote with `vote_type = not_issue` and `severity = none`
   - Agents that did NOT review the relevant file/section at all are recorded as `vote_type = abstain` — **abstentions do not count in the weighted tally**
3. Each vote is weighted by the voter's `agent_domain_weights` for that domain
4. **Consensus severity** = weighted majority across non-abstain votes. Severity is treated as ordinal: `critical > high > medium > low > none`. The consensus severity is the level where cumulative weighted votes exceed 50%.
5. **Consensus classification** = weighted majority across non-abstain classification votes (same 50% threshold)
6. **Consensus score** = 1.0 - (entropy of weighted vote distribution / max_entropy). 0.0 = maximum disagreement, 1.0 = unanimous
7. All votes recorded in the `votes` table
8. If consensus_score < 0.5 → classification is set to `needs_human_review`

### Tie-Breaking

When weighted votes are exactly tied:
- For severity: use the higher (more severe) value — err on caution
- For classification: use `needs_human_review` — defer to human

### Classification Override

The consensus engine can override the skill-layer classification:
- If consensus_score > 0.8 and consensus_severity >= medium → auto-classify as `fix`
- If consensus_score > 0.8 and consensus_severity = none → auto-classify as `noise`
- If consensus_score < 0.5 → classify as `needs_human_review`
- Human overrides always win and generate gold signals

### Initial Weights

Before any training data exists, weights are static from config:

```json
{
  "claude": {
    "architecture": 0.40, "correctness": 0.40, "security": 0.35,
    "type-safety": 0.30, "accessibility": 0.30, "test-coverage": 0.35
  },
  "codex": {
    "architecture": 0.35, "correctness": 0.35, "security": 0.35,
    "type-safety": 0.35, "accessibility": 0.25, "test-coverage": 0.35
  },
  "gemini": {
    "architecture": 0.25, "correctness": 0.25, "security": 0.30,
    "type-safety": 0.35, "accessibility": 0.45, "test-coverage": 0.30
  }
}
```

These are starting points. The client caches weights locally for 24 hours. If the API is unreachable, the client falls back to these static defaults.

### Worked Example

3 agents review a PR. Agent A (weight 0.4) flags a finding as `high`. Agent B (weight 0.35) flags the same region as `medium`. Agent C (weight 0.25) did not review that file (`abstain`).

- Effective votes: A=high(0.4), B=medium(0.35). C abstains — not counted.
- Total weight: 0.75
- Cumulative from top: critical=0, high=0.4/0.75=53% → exceeds 50%
- Consensus severity: `high`
- Consensus score: 1 - entropy({0.53, 0.47}) / max_entropy ≈ 0.55 (moderate agreement)

## Tournament Runner

### Flow

```
/stark-phase-execute-tournament <plan-slug>

For each task in the plan:

  0. Generate tournament_run_id (UUID)

  1. Create 3 worktrees (run ID in path for idempotency):
     git worktree add /tmp/tournament-{run_id}-claude -b tournament/{run_id}/claude
     git worktree add /tmp/tournament-{run_id}-codex  -b tournament/{run_id}/codex
     git worktree add /tmp/tournament-{run_id}-gemini -b tournament/{run_id}/gemini

  2. Dispatch implementations in parallel:
     Agent(claude) → implement in worktree-claude
     Agent(codex)  → implement in worktree-codex
     Agent(gemini) → implement in worktree-gemini

  3. Acceptance criteria check (per agent, sequential to avoid port/state conflicts):
     For each surviving implementation:
       a. Run test suite (pytest / npm test / etc.)
       b. Verify acceptance criteria from issue body (## Acceptance Criteria)
       c. If tests fail OR acceptance criteria not met → disqualify agent
     Gate: at least 1 agent must pass

  4. Cross-review (6 review passes, parallel):
     claude reviews codex's code
     claude reviews gemini's code
     codex reviews claude's code
     codex reviews gemini's code
     gemini reviews claude's code
     gemini reviews codex's code

  5. Score each surviving implementation:
     score = sum(finding.severity_weight * reviewer.domain_weight)
     Lower score = fewer/less-severe findings = better

  6. Select winner:
     a. Filter to agents that passed acceptance criteria
     b. Among those, winner = agent with lowest cross_review_score
     c. Tie-breaker: fewer files changed, then fewer lines added

  7. Promote winner:
     git push winner's branch as tournament/{issue}/winner
     Create PR from winner's branch
     Clean up loser worktrees + branches

  8. Record tournament:
     POST tournament_run + 3 tournament_implementations to stark-signals API

  9. Merge winner to main (squash merge via `gh pr merge --squash --admin`)
     Wait for merge to complete, then pull main.

  10. Continue to next task.
      - If next task depends on the current task (via issue Dependencies section):
        start from latest main (which now includes the winner)
      - If next task is independent and no prior task is pending merge:
        start from latest main
      - This ensures dependent tasks always build on prior winners.
```

### Worktree Management

- Paths include `tournament_run_id` (UUID) — always unique, safe to retry
- Branch names: `tournament/{run_id}/{agent}` — no collision with prior runs
- On startup, check for orphaned worktrees from crashed runs: `git worktree list --porcelain | grep tournament`
- Cleanup runs in a `finally` block + signal handler (SIGTERM, SIGINT)
- Each task starts from latest `main` (not the previous task's winner branch)

### Cross-Review Scoring

Each finding from a cross-review is weighted:
- critical: 8 points
- high: 4 points
- medium: 2 points
- low: 1 point

Multiplied by the reviewing agent's domain weight for that domain. This means a high finding from an agent that's historically accurate in that domain counts more than one from an agent that's noisy.

### Test Isolation

Tests are run **sequentially** across worktrees, not in parallel, to avoid:
- Port collisions (multiple test servers on same port)
- Database state corruption (shared test databases)
- File lock contention

Each test run gets a clean environment. If the project has database tests, the test command should handle its own isolation (e.g., test database per run).

### Disqualification

An agent is disqualified from a tournament round if:
- Tests fail after implementation
- Acceptance criteria from the issue body are not met
- Implementation produces no changes (empty diff)
- Implementation crashes or times out (configurable, default 15 min per agent)

If only 1 agent survives, it wins by default. If 0 survive, the task is marked as failed and logged.

### Code Execution Trust Model

Tournament execution uses the same trust model as the existing `/stark-phase-execute`: the user runs Claude Code with `--dangerouslySkipPermissions` (or equivalent for Codex/Gemini) in a trusted development environment. The LLMs generate code that runs locally. This is identical to the current workflow where Claude implements tasks and runs tests.

No additional sandboxing is added for Phase 1. If the system is later deployed to CI/CD runners, sandboxing (ephemeral containers, network restrictions) should be added at that point.

## Signal Collection

### Signal Types

#### Gold: Human Overrides (weight: 1.0)
Captured when:
- User manually changes a finding's classification (fix → noise, noise → fix)
- User picks a different tournament winner than the system selected
- User rejects a consensus decision

Mechanism: the skills (`/stark-review`, `/stark-phase-execute-tournament`) detect when the human acts differently from the system's recommendation and POST a signal to the API. The signal includes the authenticated user identity.

Idempotency key: `gold:{source_type}:{source_id}:{corrected_value}`

#### Silver: Post-Merge Regressions (weight: 0.7)
Captured when:
- A bug issue is opened referencing a PR that was reviewed or tournament-selected
- A revert commit references a PR
- Tests fail on main after a merge that the review passed

Mechanism: GitHub webhook to `/api/v1/webhooks/github` (bypasses IAP, validated via `X-Hub-Signature-256`). Matches new issues/reverts to review_runs and tournament_runs via PR number.

**Attribution heuristic:** When a regression is detected, attribute to the domain most related to the bug (using keyword matching on the issue body). If ambiguous, attribute to all domains with a reduced weight (0.7 / number_of_candidate_domains). If no domain can be determined, log the signal with `domain = null` and flag for manual review.

Idempotency key: `silver:{source_type}:{source_id}:{issue_or_commit}`

#### Bronze: Convergence Patterns (weight: 0.3)
Captured automatically from every review:
- All 3 agents agree on severity → positive signal for all 3
- 2 agents agree, 1 disagrees → positive for the 2, negative for the 1
- Only 1 agent flags something that gets classified as noise → negative signal for that agent in that domain
- Only 1 agent flags something that gets classified as fix → strong positive signal (it caught what others missed)

Mechanism: computed inline during consensus voting.

**Important constraint:** Bronze signals are used for **diagnostics and reporting only**. They do NOT directly influence weight updates until validated by gold/silver signals. This prevents the feedback loop where majority agreement reinforces itself regardless of correctness. Bronze signals are stored, analyzed in dashboards, and used to generate hypotheses — but the recalibration engine only applies them after an agent×domain pair has ≥10 gold+silver signals confirming the bronze trend.

Idempotency key: `bronze:{finding_id}:{agent}`

### Signal Processing

Signals accumulate in the `signals` table with `applied_to_proposal_id = NULL`. The recalibration engine processes them in batches when creating proposals.

## Recalibration Engine

Runs as a **Cloud Run Job** triggered by **Cloud Scheduler** (daily at 02:00 UTC) or on-demand via the dashboard.

### Algorithm

```python
def recalibrate(agent, domain):
    # Only use gold + silver signals for weight changes
    signals = get_unapplied_signals(agent, domain, tiers=["gold", "silver"])

    if not signals:
        return None  # nothing to propose

    current_weight = get_current_weight(agent, domain)
    cumulative_delta = 0.0

    for signal in signals:
        if signal.tier == "gold":
            if signal.corrected_value == signal.original_value:
                cumulative_delta += 0.02   # reinforce correct decision
            else:
                cumulative_delta -= 0.05   # penalize mistake (asymmetric)

        elif signal.tier == "silver":
            cumulative_delta += signal.weight_delta * 0.7

    # Divergence guard: cannot move more than ±0.15 from default
    # until sample_count >= 50 for this agent×domain
    sample_count = get_total_signal_count(agent, domain)
    default_weight = get_default_weight(agent, domain)

    if sample_count < 50:
        max_delta = 0.15
        proposed = clamp(
            current_weight + cumulative_delta,
            default_weight - max_delta,
            default_weight + max_delta
        )
    else:
        proposed = clamp(current_weight + cumulative_delta, 0.05, 0.95)

    if abs(proposed - current_weight) < 0.005:
        return None  # change too small to propose

    # Create proposal — do NOT mark signals as applied yet
    proposal = create_proposal(
        agent, domain, current_weight, proposed,
        signal_ids=[s.id for s in signals],
        confidence=compute_confidence(signals)
    )

    return proposal
```

### Approval Gate

Weight updates are proposed, not auto-applied:

1. Recalibration job creates `weight_update_proposals` with `status = pending`
2. Dashboard shows pending proposals with current vs proposed weights, driving signals, confidence
3. **Approval** → new `agent_domain_weights` row with `effective_from = now()`, signals linked to proposal via `applied_to_proposal_id`, proposal status → `approved`
4. **Rejection** → proposal status → `rejected`, driving signals marked as `dismissed` (linked to the rejected proposal). Dismissed signals are excluded from future recalibration. A new proposal for the same (agent, domain) requires new signals arriving AFTER the rejection timestamp.
5. New proposal for same (agent, domain) while one is pending → old pending proposal → `superseded`, its signals become available for the new proposal

**Authorization:** Only users with the `admin` role can approve/reject weight proposals. Role determined by membership in the `stark-admins` GitHub team in the GetEvinced org.

After sufficient validation (~50 tournament runs with stable weights), auto-apply can be enabled via config flag `auto_apply_weight_proposals: true`. Even with auto-apply, all proposals are logged and reversible.

## API (Cloud Run)

### Endpoints with Schemas

#### Ingestion (service-to-service auth, OIDC)

```
POST /api/v1/ingest/review
  Request: {
    idempotency_key: str,  // format: {repo}:{pr_number}:{base_sha}:{round}
    repo: str, pr_number: int | null, review_type: "code" | "plan",
    plan_file: str | null, base_sha: str,
    agent_versions: {agent: {model: str, prompt_hash: str}},
    config_snapshot: object,
    rounds: [{
      round: int,
      findings: [{agent, domain, severity, file, line, section, title, description, suggestion}],
      coverage: [{  // what each agent actually reviewed
        agent: str, domain: str,
        reviewed_files: [str] | null,      // for code reviews
        reviewed_sections: [str] | null,   // for plan reviews
        duration_seconds: float
      }],
      duration_seconds: float
    }]
  }
  Response: 201 {
    review_run_id: UUID,
    consensus_results: [{  // server-computed consensus
      finding_id: UUID,
      consensus_severity: str,
      consensus_classification: str,
      consensus_score: float,
      vote_summary: {agent: {vote_type, severity_vote}}
    }]
  }
  Notes:
    - Server computes consensus using coverage data to determine issue/not_issue/abstain per agent
    - Votes are generated and stored server-side
    - Idempotent: upsert on idempotency_key; replay returns cached consensus_results

POST /api/v1/ingest/tournament
  Request: {
    id: UUID,  # tournament_run_id (used in worktree paths, stable across retries)
    repo, issue_number, plan_slug, task_id,
    agent_versions: object,
    implementations: [{
      agent, branch_name, commit_sha,
      files_changed, lines_added, lines_deleted,
      test_pass_count, test_fail_count, test_skip_count,
      cross_review_score, cross_review_findings,
      acceptance_passed, selected, disqualified, disqualification_reason,
      cross_reviews: [{  // full detail for dashboard comparison
        reviewer_agent: str,
        findings: [{domain, severity, file, line, title, description, suggestion}]
      }]
    }],
    winner_agent, winner_score, selection_reason,
    acceptance_criteria_met: object
  }
  Response: 201 {tournament_run_id: UUID}
  Idempotent: yes (upsert on id)

POST /api/v1/ingest/signal
  Request: {
    idempotency_key: str,
    signal_type, signal_tier, source_type, source_id,
    agent, domain, original_value, corrected_value,
    weight_delta: float | null,
    context: object
  }
  Response: 201 {signal_id: UUID}
  Idempotent: yes (upsert on idempotency_key)
```

#### Read APIs (IAP-protected)

```
GET  /api/v1/agents
  Response: [{name, model_version, is_active, weights: {domain: weight}}]

GET  /api/v1/agents/{name}/weights
  Query: ?since=ISO8601
  Response: [{domain, weight, precision, recall, f1_score, effective_from}]

GET  /api/v1/agents/{name}/accuracy
  Response: {domains: [{domain, precision, recall, f1_score, sample_count}]}

GET  /api/v1/reviews
  Query: ?repo=&review_type=&page=&per_page=
  Response: {items: [{id, repo, pr_number, review_type, total_findings, signal_to_noise, created_at}], total, page}

GET  /api/v1/reviews/{id}
  Response: {id, repo, ..., findings: [{id, agent, domain, severity, consensus_severity, classification, ...}], votes: [{...}]}

GET  /api/v1/tournaments
  Query: ?repo=&page=&per_page=
  Response: {items: [{id, repo, issue_number, winner_agent, winner_score, created_at}], total, page}

GET  /api/v1/tournaments/{id}
  Response: {id, ..., implementations: [{agent, selected, cross_review_score, acceptance_passed, ...}]}

GET  /api/v1/tournaments/{id}/compare
  Response: {implementations: [{agent, diff_stats, cross_review_findings: [...], score}]}

GET  /api/v1/signals
  Query: ?signal_type=&signal_tier=&agent=&page=&per_page=
  Response: {items: [{...}], total, page}

GET  /api/v1/weights/proposals
  Query: ?status=pending
  Response: [{id, agent, domain, current_weight, proposed_weight, delta, signal_count, confidence, status}]

GET  /api/v1/dashboard
  Response: {
    agent_leaderboard: [{agent, overall_f1, domain_scores: {}}],
    review_stats: {total, avg_findings, avg_noise_rate},
    tournament_stats: {total, winner_distribution: {}},
    signal_stats: {gold, silver, bronze, pending_proposals}
  }

GET  /api/v1/dashboard/trends
  Query: ?metric=&period=&agent=
  Response: {data_points: [{date, value}]}

GET  /api/v1/dashboard/leaderboard
  Response: {domains: [{domain, rankings: [{agent, f1_score, sample_count}]}]}
```

#### Mutations (IAP + admin role required)

```
POST /api/v1/signals
  (same as ingest/signal but from dashboard — requires admin role)

POST /api/v1/weights/proposals/{id}/approve
  Request: {}
  Response: {proposal_id, new_weight_id, effective_from}
  Authorization: admin role

POST /api/v1/weights/proposals/{id}/reject
  Request: {reason: str | null}
  Response: {proposal_id, status: "rejected"}
  Authorization: admin role
```

#### Webhooks (no IAP, signature-verified)

```
POST /api/v1/webhooks/github
  Headers: X-Hub-Signature-256, X-GitHub-Event
  Events handled:
    - issues.opened (match "Closes #N" to review_runs → silver signal)
    - push (detect revert commits → silver signal)
  Validation: HMAC-SHA256 signature verification
  Response: 200 {processed: true} or 204 (event not relevant)
```

### Dashboard Pages

1. **Overview** — agent leaderboard, total reviews/tournaments, signal count, weight stability
2. **Agent Detail** — per-agent precision/recall over time, domain heatmap, weight history chart
3. **Tournament History** — list of tournaments, winner distribution, score trends, side-by-side diff comparison
4. **Review Analytics** — finding classification breakdown, noise rate trends, cross-agent agreement
5. **Signals** — ground truth events, pending weight proposals, approval queue (admin actions)
6. **Settings** — agent config, domain config, recalibration schedule

## Observability

### SLIs and Alerts

| SLI | Target | Alert |
|-----|--------|-------|
| API latency (p99) | < 500ms | Page if > 2s for 5 min |
| API error rate | < 1% | Warn at 1%, page at 5% |
| Ingest success rate | > 99% | Warn if < 99% over 1h |
| Client spool backlog | 0 files | Warn if > 10 pending files |
| Recalibration job success | 100% | Warn on any failure |
| Webhook processing | < 5s | Warn if > 30s |

### Dashboards (Grafana)

- **stark-signals-api**: request rate, latency, error rate, by endpoint
- **stark-signals-ingest**: events/min by type (review, tournament, signal), spool backlog
- **stark-signals-recalibration**: job duration, proposals created, weight drift

### Logging

Structured JSON logs via infra-sentinel's Alloy → Loki pipeline. Key fields: `service=stark-signals`, `endpoint`, `review_run_id`, `tournament_run_id`, `agent`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL (Cloud SQL, shared instance, new `stark_signals` database) |
| Backend | Python 3.13+ · FastAPI · SQLAlchemy 2.0 · Alembic |
| Frontend | React 19 · TypeScript · Vite · shadcn/ui · Tailwind 4 · Recharts |
| Client | Python library in stark-skills (`scripts/signal_client.py`) |
| Background | Cloud Run Jobs + Cloud Scheduler |
| Infra | Terraform (infra-ai-platform registry) |
| Monitoring | infra-sentinel (Prometheus + Loki + Grafana) |
| Auth | IAP for dashboard · OIDC for service-to-service · X-Hub-Signature for webhooks |
| CI/CD | GitHub Actions |

## Phased Rollout

### Phase 1: Voting Layer + Signal Store (Week 1-2)
- Terraform: register stark-signals in infra-ai-platform registry, Cloud SQL database, Cloud Run service, IAP config, load balancer backend
- Deploy Cloud SQL database + Alembic schema migration
- Deploy Cloud Run service (API only, no dashboard yet)
- `signal_client.py` in stark-skills (writes to API via `gcloud` identity token, spool fallback)
- `consensus.py` replacing `deduplicate_findings()` with voting (consensus computed server-side)
- Client sends raw findings + review coverage → server computes votes + consensus
- Static weights from config (cached locally, refreshed from API)
- Bronze signals collected automatically (diagnostics only, not applied to weights)
- `/stark-review` and `/stark-review-plan` updated to use consensus
- Feature flag: `signal_store.enabled` in `.code-review/config.json`
- Sentinel onboarding (Prometheus metrics, Loki logs)

### Phase 2: Tournament + Dashboard (Week 3-5)
- `tournament.py` module with worktree management
- `/stark-phase-execute-tournament` skill
- React dashboard on Cloud Run (same service, new frontend)
- Tournament data collection via API (including cross-review detail)
- Gold signal capture (human overrides from dashboard)
- RBAC for weight approval (admin role — Google identity → email match)
- GitHub webhook setup for regression detection (separate backend, no IAP)

### Phase 3: Adaptive Weights (Week 6-7)
- Recalibration engine (Cloud Run Job + Cloud Scheduler)
- Silver signal capture (regression detection via webhooks)
- Weight update proposals in dashboard
- `/stark-metrics` integration
- Bronze signal correlation (only applied after gold/silver validation)
- Auto-apply gate (configurable, default off)
- GCS archival job for old data

## Constraints

- Worktrees must be cleaned up even on crash (finally blocks + signal handlers + startup reconciliation)
- Worktree paths and branch names include tournament_run_id for idempotency
- Tournament timeout: 15 min per agent implementation, 5 min per cross-review
- Tests run sequentially across worktrees (no parallel test execution)
- Signal store writes are non-blocking — client spools to local file if API is unreachable
- Client caches weights locally for 24h — falls back to static defaults if API is down
- All API writes are idempotent via idempotency_key (upsert semantics)
- Minimum 50 gold+silver signals per agent×domain before weights can diverge more than ±0.15 from defaults
- Bronze signals are diagnostic only — cannot influence weights without gold/silver confirmation
- Data retained indefinitely in Cloud SQL; records older than 12 months archived to GCS (Parquet)
- Code execution in tournaments uses the same trust model as existing phase-execute (local dev environment, user's permissions)
