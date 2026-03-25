# Design Review & Plan Review Split — Design Spec

> Split `/stark-review-plan` into two distinct skills: `/stark-review-design` (architectural soundness) and `/stark-review-plan` (execution validity). Introduce interactive priority questionnaire, content-based domain activation, and challenge mechanism.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.md`

---

## Problem

The current `/stark-review-plan` mixes two fundamentally different concerns:

1. **"Is this design sound?"** — architecture, trade-offs, security model, API contracts
2. **"Will this plan deliver the design?"** — task decomposition, dependency ordering, acceptance criteria, rollback

These are different questions asked at different times by people with different expertise. Mixing them produces muddled feedback — a brilliant architecture with a terrible execution plan gets averaged into "looks OK." A sound plan built on a flawed design passes because the plan-level checks are fine.

Additionally, the current system reviews every domain with equal intensity regardless of what the plan actually touches. A CSS refactor gets the same security scrutiny as an auth system rewrite. This wastes reviewer cycles and trains users to ignore findings.

## Goals

1. Two skills with zero domain overlap — clear separation of concerns
2. Content-based domain activation — only review what the plan touches
3. Priority-weighted review intensity — deep review on what matters, light scan on the rest
4. Interactive questionnaire — force the author to declare priorities, challenge mismatches
5. Priority declarations become a review artifact — traceable, auditable

## Non-Goals

- Changing the multi-agent dispatch engine (`multi_review.py`) — both skills use the same 3-LLM infrastructure
- Changing the fix loop mechanism — both skills use the same review-fix-review cycle
- Building a new questionnaire UI — the interaction happens in the terminal via Claude Code's standard conversation flow

## Data Handling Note

Design specs and plans are sent to external LLM APIs (Claude, Codex, Gemini) for review. This is the same data flow as `/stark-review` and `/stark-review-plan` today. No new data exposure is introduced. Teams handling sensitive content (e.g., security architecture for auth systems) should be aware that spec content is transmitted to these APIs. Standard API data handling policies of each provider apply.

---

## MVP Scope

### v1 (this spec)

- Skill separation (`/stark-review-design` + narrowed `/stark-review-plan`)
- Content-based domain activation via regex signal scanning
- Priority questionnaire: **simplified** — core questions (Q1-Q2) always asked; conditional questions asked based on activated domains. No adaptive question generation beyond the fixed question bank defined here.
- Challenge mechanism: up to 3 challenges based on the fixed rule table
- `--priorities` flag for CI/headless mode
- Priority record as repo sidecar file

### v2 (future)

- Adaptive question generation (questions generated dynamically based on spec content, not just domain activation)
- Cross-review questionnaire learning (pre-fill from user history)
- Priority record analytics (override-to-incident correlation)
- Extension points for custom signal maps and domain plugins

---

## Architecture

### Skill Separation

```
Before:
  /stark-review-plan  →  7 mixed domains  →  reviews everything

After:
  /stark-review-design  →  12 design domains (5 always-on + 7 conditional)
                        →  requires: spec/design doc
                        →  output: approved design artifact

  /stark-review-plan    →  10 plan domains (3 always-on + 7 conditional)
                        →  requires: approved design + implementation plan
                        →  output: approved plan artifact
```

### Flow

```
Author writes spec.md
        │
        ▼
/stark-review-design
  ├── 1. Content scan (detect what the spec touches)
  ├── 2. Priority questionnaire (multiple-choice)
  ├── 3. Challenge mismatches (push back on inconsistencies)
  ├── 4. Confirm priorities + active domains
  ├── 5. Multi-agent review (3 LLMs × active domains)
  ├── 6. Fix loop (classify, fix, re-review)
  └── 7. Output: approved design + priority record
        │
        ▼
Author writes plan.md (implementation plan)
        │
        ▼
/stark-review-plan (narrowed)
  ├── 1. Load approved design + priority record
  ├── 2. Content scan (detect what the plan covers)
  ├── 3. Domain activation (based on plan content + design priorities)
  ├── 4. Multi-agent review (3 LLMs × active domains)
  ├── 5. Fix loop
  └── 6. Output: approved plan
        │
        ▼
/stark-plan-to-tasks (unchanged)
```

---

## `/stark-review-design` — Detailed Design

### Domain Catalog

#### Always-on domains (apply to every design)

| ID | Domain | What it challenges |
|----|--------|--------------------|
| `problem-fit` | Problem-solution fit | Does the design solve the stated problem? Are requirements understood? Are constraints explicit? Missing non-functional requirements? |
| `architecture` | Architecture & decomposition | Component boundaries, communication patterns (sync/async), data flow, consistency model. Are responsibilities clear and single? |
| `tradeoffs` | Trade-offs & alternatives | Are trade-offs stated explicitly? Were alternatives genuinely considered or are they strawmen? ATAM sensitivity/tradeoff point identification. |
| `failure-modes` | Failure modes & resilience | Per-component: what happens when it fails? Blast radius? Timeout/retry strategy? Graceful degradation? Is the happy-path-only anti-pattern present? |
| `maintainability` | Maintainability & evolvability | Coupling analysis, complexity budget, extension points, tech debt trajectory. Can a new engineer understand this in a day? |

#### Conditional domains (activated by content signals)

| ID | Domain | Activation signals | What it challenges |
|----|--------|-------------------|-------------------|
| `api-contracts` | API contracts & compatibility | Mentions: endpoint, REST, GraphQL, gRPC, SDK, client library, webhook, callback | Consumer-first design, versioning strategy, backward/forward compatibility, error contracts, idempotency, pagination, rate limiting |
| `data-arch` | Data architecture & migration | Mentions: database, schema, migration, table, model, storage, index, query, column, entity | Schema fitness for access patterns, migration strategy (expand/contract), consistency guarantees, data lifecycle, growth projections |
| `security` | Security & threat model | Mentions: auth, token, secret, password, PII, permission, role, encrypt, certificate, OAuth, SAML, trust | STRIDE per data flow, trust boundaries, secrets management, attack surface, least privilege. Depth scales with priority. |
| `scalability` | Scalability & performance | Mentions: latency, throughput, cache, load, queue, scale, concurrent, batch, rate limit, SLO, p99 | Load estimates with evidence, bottleneck identification, caching strategy, back-pressure, hot spots, horizontal vs vertical |
| `observability` | Observability design | Mentions: metric, logging, tracing, alert, dashboard, SLO, SLI, monitor, on-call | Four Golden Signals, SLO definitions, distributed tracing design, alert actionability, dashboard needs |
| `operations` | Operational readiness | Mentions: deploy, rollback, canary, blue-green, feature flag, capacity, infra, terraform, kubernetes, CI/CD | Deployment strategy, rollback capability, capacity planning, on-call impact, runbook needs |
| `existing-impact` | Existing system impact | Mentions: backward compatible, breaking change, consumer, migration, deprecat, existing, downstream, upstream, integration | What breaks? Consumer migration path? Expand/contract needed? Notification plan for dependents? |

### Content Scan

Before the questionnaire, the skill scans the spec for activation signals:

```python
SIGNAL_MAP = {
    "api-contracts": [
        r"\b(?:endpoint|REST|GraphQL|gRPC|SDK|client.library|webhook|callback)\b",
        r"\b(?:API|api)\b.*\b(?:design|contract|spec|version)\b",
    ],
    "data-arch": [
        r"\b(?:database|schema|migration|storage|model|entity|table|column|index)\b",
        r"\b(?:SQL|NoSQL|Postgres|Redis|DynamoDB|Mongo)\b",
    ],
    "security": [
        r"\b(?:auth|token|secret|password|PII|permission|role|encrypt|OAuth|SAML|certificate)\b",
        r"\b(?:trust.boundar|attack.surface|threat)\b",
    ],
    "scalability": [
        r"\b(?:latency|throughput|cache|concurrent|batch|rate.limit|SLO|p99|scale|load)\b",
        r"\b(?:performance|capacity|horizontal|vertical)\b",
    ],
    "observability": [
        r"\b(?:metric|logging|tracing|alert|dashboard|SLO|SLI|monitor|on.call|Grafana|Datadog)\b",
    ],
    "operations": [
        r"\b(?:deploy|rollback|canary|blue.green|feature.flag|terraform|kubernetes|CI/CD|infra)\b",
    ],
    "existing-impact": [
        r"\b(?:backward.compat|breaking.change|consumer|deprecat|downstream|upstream|existing)\b",
        r"\b(?:migration.path|expand.contract)\b",
    ],
}
```

Each domain is activated if ≥1 signal pattern matches. The scan result is shown to the user before the questionnaire:

```
Scanning spec... detected signals:

  ✓ api-contracts     — found: "REST endpoints", "webhook callback"
  ✓ data-arch         — found: "PostgreSQL schema", "migration"
  ✓ security          — found: "OAuth tokens", "PII"
  ✗ scalability       — no signals found
  ✓ observability     — found: "metrics", "Grafana dashboard"
  ✓ operations        — found: "canary deployment", "rollback"
  ✗ existing-impact   — no signals found

  Always-on: problem-fit, architecture, tradeoffs, failure-modes, maintainability
```

### Priority Questionnaire

After the content scan, the skill asks 4-6 multiple-choice questions. The questions are adaptive — they're generated based on which domains were activated.

#### CI / Headless Mode

For non-interactive environments (CI pipelines, scripted reviews), the questionnaire can be bypassed with a `--priorities` flag pointing to a YAML file:

```bash
/stark-review-design --spec path/to/spec.md --priorities path/to/priorities.yaml
```

The priorities file uses the same schema as the `answers` section of the priority record:

```yaml
optimization_target: correctness
resilience: mission-critical
security_posture: high
consumers: internal-teams
data_sensitivity: large-scale-sensitive
```

When `--priorities` is provided, the content scan still runs (to activate conditional domains), but the questionnaire and challenge steps are skipped. The priority record logs `source: file` instead of `source: interactive`.

#### Core questions (always asked)

```
1. What's the primary optimization target for this system?

   a) Throughput — maximize volume/rate (batch processing, ETL, data pipelines)
   b) Latency — minimize response time (user-facing APIs, real-time systems)
   c) Correctness — zero data loss/corruption (financial, medical, compliance)
   d) Availability — minimize downtime (customer-facing services, SLA-bound)
   e) Cost — minimize infrastructure spend (internal tools, dev tooling)
   f) Developer velocity — minimize time-to-change (early-stage, rapid iteration)

2. How critical is resilience?

   a) Mission-critical — cascading failure = customer-facing incident, SLA breach
   b) Important — should self-heal, minutes of downtime acceptable
   c) Best-effort — manual recovery OK, hours of downtime tolerable
   d) Not applicable — offline tool, script, one-shot migration
```

#### Conditional questions (asked only when domain is activated)

```
# Asked when security signals detected
3. Security posture?

   a) High — handles PII, auth tokens, payments, or is external-facing
   b) Standard — internal service, no sensitive data, behind VPN
   c) Minimal — dev tooling, CI scripts, no user data
   d) Regulatory — subject to SOC2, HIPAA, FedRAMP, or similar compliance

# Asked when api-contracts signals detected
4. Who consumes this system's APIs?

   a) External customers or third-party integrations
   b) Other internal teams (they depend on our API contract)
   c) Only our team's own services
   d) Nobody yet — greenfield, consumers TBD

# Asked when data-arch signals detected
5. Data sensitivity and scale?

   a) Large-scale + sensitive — millions of records, contains PII/financial data
   b) Large-scale + non-sensitive — high volume but internal/non-PII data
   c) Small-scale + sensitive — low volume but critical data
   d) Small-scale + non-sensitive — configuration, metadata, internal state

# Asked when existing-impact signals detected
6. How many existing systems depend on what you're changing?

   a) Many (5+) — shared platform, core library, widely-used API
   b) Some (2-4) — a few known consumers
   c) One — single direct dependent
   d) None — net-new, no existing consumers
```

#### Question selection rules

- Questions 1-2: always asked
- Question 3: asked if `security` domain activated
- Question 4: asked if `api-contracts` domain activated
- Question 5: asked if `data-arch` domain activated
- Question 6: asked if `existing-impact` domain activated
- Maximum: 6 questions. If more than 6 would trigger, prioritize by domain activation signal strength (more matches = more likely to be relevant).

### Challenge Mechanism

After the user answers, the skill cross-references answers against content scan results. Mismatches trigger challenges.

#### Challenge rules

| User said | But spec contains | Challenge |
|-----------|------------------|-----------|
| Security = minimal | PII, auth tokens, OAuth, encrypt | "You said security is minimal but your spec describes {signal}. That's an untrusted input / sensitive data boundary. Revise?" |
| Security = minimal | External-facing API, webhook | "You said security is minimal but this system accepts external input via {signal}. Revise?" |
| Resilience = not applicable | Multiple service dependencies | "You said resilience isn't applicable but your design depends on {N} external services. What happens when one is down?" |
| Consumers = nobody yet | Mentions backward compatibility, existing API | "You said no consumers yet but your spec mentions {signal}. Are there existing consumers?" |
| Optimization = cost | SLO, p99, latency targets | "You're optimizing for cost but your spec defines latency targets ({signal}). Which takes priority when they conflict?" |
| No scalability signals | But mentions "batch", "millions of records" | "Scalability wasn't detected but your spec mentions {signal}. Should we activate the scalability domain?" |

#### Challenge interaction format

```
⚠️  Mismatch: You said security is "minimal" but your spec describes
   OAuth token handling and webhook payloads from external providers.

   a) You're right — upgrade to Standard
   b) You're right — upgrade to High (this is PII/compliance-sensitive)
   c) No — [explain why this is safe despite the signals]
```

If the user picks (c), they must provide a reason. The skill evaluates the reason:
- **Valid** (e.g., "webhooks are signature-verified at the load balancer before reaching this service") → accept, log the override with justification
- **Weak** (e.g., "it's fine" / "we'll handle it later") → challenge once more: "That's not a mitigation — it's deferral. Security issues deferred to 'later' are the #1 source of post-incident findings. Proceed anyway?"
- If the user insists after two challenges → accept, log as `priority_override: forced` with the reason. The review still runs the domain at reduced intensity, and the override is flagged in the review artifact.

Maximum: 3 challenges per questionnaire. Don't interrogate the user — this should feel like a quick calibration, not a compliance form.

**Determinism note:** Challenge evaluation (deciding whether a user's override reason is "valid" vs. "weak") uses a fixed prompt with `temperature=0` to ensure consistent classification across runs. The evaluation prompt includes 3-4 examples of valid and weak justifications to anchor the LLM's judgment.

### Priority → Review Intensity Mapping

User answers map to review intensity per domain:

| Priority level | Review behavior |
|----------------|----------------|
| **Deep** | All 3 LLMs review this domain. Findings below medium severity are still reported. Reviewers actively probe for edge cases. |
| **Standard** | All 3 LLMs review. Only medium+ severity reported. |
| **Light** | 1 LLM reviews (Claude only). Only high+ severity reported. |
| **Skip** | Domain not activated. No review. Logged as skipped. |

Mapping from answers:

```python
# Priority optimization target → domain intensity boosts
OPTIMIZATION_BOOST = {
    "throughput":  {"scalability": "deep", "data-arch": "deep"},
    "latency":     {"scalability": "deep", "api-contracts": "deep"},
    "correctness": {"data-arch": "deep", "failure-modes": "deep"},
    "availability": {"failure-modes": "deep", "operations": "deep", "observability": "deep"},
    "cost":        {"scalability": "standard", "operations": "standard"},
    "velocity":    {"maintainability": "deep", "api-contracts": "light"},
}

# Resilience answer → failure-modes intensity
RESILIENCE_MAP = {
    "mission-critical": "deep",
    "important":        "standard",
    "best-effort":      "light",
    "not-applicable":   "skip",  # but can be overridden by challenge
}

# Security answer → security domain intensity
SECURITY_MAP = {
    "high":       "deep",
    "regulatory": "deep",
    "standard":   "standard",
    "minimal":    "light",
}

# Consumers answer → api-contracts + existing-impact intensity
CONSUMERS_MAP = {
    "external":       {"api-contracts": "deep", "existing-impact": "deep"},
    "internal-teams": {"api-contracts": "deep", "existing-impact": "standard"},
    "own-team":       {"api-contracts": "standard", "existing-impact": "light"},
    "nobody":         {"api-contracts": "light", "existing-impact": "skip"},
}

# Data sensitivity answer → data-arch + security intensity
DATA_SENSITIVITY_MAP = {
    "large-scale-sensitive":     {"data-arch": "deep", "security": "deep", "scalability": "deep"},
    "large-scale-non-sensitive": {"data-arch": "deep", "scalability": "deep"},
    "small-scale-sensitive":     {"data-arch": "standard", "security": "deep"},
    "small-scale-non-sensitive": {"data-arch": "standard"},
}

# Dependency count answer → existing-impact intensity
DEPENDENCY_COUNT_MAP = {
    "many":  {"existing-impact": "deep"},
    "some":  {"existing-impact": "standard"},
    "one":   {"existing-impact": "light"},
    "none":  {"existing-impact": "skip"},
}
```

#### Conflict Resolution

When multiple mappings set different intensities for the same domain, the **maximum wins** (`deep` > `standard` > `light` > `skip`). The intensity hierarchy is:

```python
INTENSITY_ORDER = {"skip": 0, "light": 1, "standard": 2, "deep": 3}

def resolve_intensity(mappings: list[str]) -> str:
    """Given a list of intensity values from different mappings, return the highest."""
    return max(mappings, key=lambda x: INTENSITY_ORDER[x])
```

If a content scan activates a domain but no answer boosts it, the default intensity is `standard`.

### Priority Record Artifact

After questionnaire + challenges, the skill writes a priority record.

#### Schema

```yaml
# Priority Record Schema v1
schema_version: 1  # REQUIRED — bump on breaking changes

# Required fields
priority_record:
  spec_file: string          # path to the reviewed spec
  spec_hash: string          # SHA-256 of spec file at review time (for staleness detection)
  timestamp: string          # ISO 8601
  source: enum[interactive, file]  # REQUIRED — how priorities were provided
  answers:                   # user responses (keys match question IDs)
    optimization_target: string   # REQUIRED
    resilience: string            # REQUIRED
    security_posture: string      # present if security domain activated
    consumers: string             # present if api-contracts domain activated
    data_sensitivity: string      # present if data-arch domain activated
    dependency_count: string      # present if existing-impact domain activated
  active_domains:            # REQUIRED — map of domain_id → intensity
    string: enum[deep, standard, light, skip]
  content_signals:           # REQUIRED — map of domain_id → matched strings
    string: list[string]

# Optional fields
  challenges: list           # present only if challenges were issued
    - domain: string
      initial: string
      signal: string
      resolution: enum[accepted, upgraded, forced]
      reason: string
  skipped_domains: list[string]  # domains not activated
  overrides: list            # present only if user forced past challenges
    - domain: string
      reason: string
```

#### Example

```yaml
schema_version: 1
priority_record:
  spec_file: docs/specs/my-feature-design.md
  timestamp: 2026-03-25T10:30:00Z
  content_signals:
    api-contracts: ["REST endpoints", "webhook callback"]
    data-arch: ["PostgreSQL schema", "migration"]
    security: ["OAuth tokens", "PII"]
    observability: ["metrics", "Grafana dashboard"]
    operations: ["canary deployment", "rollback"]
  answers:
    optimization_target: correctness
    resilience: mission-critical
    security_posture: high    # upgraded from initial "standard" after challenge
    consumers: internal-teams
    data_sensitivity: large-scale-sensitive
  challenges:
    - domain: security
      initial: standard
      signal: "OAuth tokens, PII references"
      resolution: upgraded_to_high
      reason: "User agreed — handles PII"
  active_domains:
    problem-fit: deep       # always-on
    architecture: deep      # always-on
    tradeoffs: deep         # always-on
    failure-modes: deep     # boosted by resilience=mission-critical + optimization=correctness
    maintainability: standard  # always-on, no boost
    api-contracts: deep     # consumers=internal-teams
    data-arch: deep         # optimization=correctness + data_sensitivity=large-scale-sensitive
    security: deep          # security_posture=high (post-challenge)
    scalability: light      # no signals, no boost — activated only because data-arch implies scale
    observability: standard # signals detected, no specific boost
    operations: standard    # signals detected, no specific boost
    existing-impact: standard  # consumers=internal-teams
  skipped_domains: []
```

This record is:
1. Printed as a summary before the review starts (user confirms)
2. Stored in the `.review.md` artifact
3. Passed to `/stark-review-plan` as input (so the plan review inherits design priorities)

### Definition of "Approved Design"

A design is considered **approved** when it has completed a `/stark-review-design` cycle with all HIGH and CRITICAL findings resolved (fixed or explicitly dismissed with justification in the fix loop). The review artifact (`.review.md`) records this outcome. Concretely, a design is approved when the final review iteration produces zero open HIGH/CRITICAL findings and the priority record exists on disk. There is no separate approval gate — completing the review loop *is* the approval. For designs reviewed outside this system (e.g., via manual team review), the author can create a priority record manually or use option (b)/(c) when `/stark-review-plan` prompts for it.

---

## `/stark-review-plan` (Narrowed) — Detailed Design

### Prerequisites

- An approved design document (has been through `/stark-review-design` or manually approved)
- An implementation plan document
- The priority record from the design review (if available)

If no priority record exists (design was reviewed manually), the skill asks:

```
No priority record found for this design. Either:
  a) Point me to the design review artifact (path?)
  b) I'll infer priorities from the design doc (less accurate)
  c) Skip priority weighting — review all plan domains equally
```

### Domain Catalog

#### Always-on domains

| ID | Domain | What it validates |
|----|--------|--------------------|
| `design-traceability` | Design-plan traceability | Every design element maps to ≥1 task. No orphan tasks. No dropped requirements. Cross-references design components, APIs, data models against plan tasks. |
| `decomposition` | Decomposition quality | Tasks are right-sized (1-3 days). Independently testable where possible. Clear "done" definition. No epics disguised as tasks. No single-line tasks that should be merged. |
| `phasing` | Phasing & incremental value | Each phase delivers testable value. Highest risks addressed early. Natural integration/verification points at phase boundaries. Rollback possible at each boundary. |

#### Conditional domains

| ID | Domain | Activation signals | What it validates |
|----|--------|-------------------|-------------------|
| `dependency-graph` | Dependency ordering | Plan has >5 tasks or explicit dependency declarations | No circular deps. Implicit deps surfaced. Critical path identified. Parallel work is genuinely independent (not serialized by shared resource/person). |
| `acceptance-criteria` | Acceptance criteria quality | Tasks have acceptance criteria sections | INVEST-compliant. Verifiable, specific, includes error/edge cases. Not restating the title. Not prescribing implementation. |
| `risk-mitigation` | Risk & mitigation | Plan mentions risk, or design priority record has any "deep" domains | Risks identified and ordered by impact × probability. Mitigation per risk. Circuit-breaker decision points. Overall risk profile acceptable. |
| `rollback` | Rollback planning | Plan touches database/schema, deployment, or infra | Rollback triggers defined with thresholds. Procedures ordered. Schema rollback feasibility (expand/contract?). Time estimates. Data loss assessment. |
| `integration-points` | Integration & verification | Plan has multiple phases or external dependencies | Smoke tests per phase. Load test timing. Backward compat verification during transition. Manual checkpoints identified. |
| `nfr-coverage` | Non-functional coverage | Design priority record has any domain at "deep" intensity | Performance, security, observability, documentation tasks are explicit in the plan — not assumed to "happen naturally." Cross-references design priorities. |
| `resource-deps` | Resource & external dependencies | Plan mentions other teams, external services, or shared infrastructure | Team skills match plan needs. External commitments confirmed (not assumed). No knowledge single-points-of-failure. Infrastructure provisioning tasks present. |

### Priority Inheritance

The plan review inherits the design review's priority record:

- Domains that were "deep" in design review → corresponding plan domains get extra scrutiny
- If the design had `security: deep`, the plan review checks that security hardening tasks exist, are sequenced correctly, and have acceptance criteria
- If the design had `scalability: deep`, the plan review checks for load testing tasks, capacity planning tasks, and performance benchmarks in acceptance criteria

### Design-Plan Traceability Check

The most important automated check. This is **LLM-powered** (not regex extraction) — each sub-agent receives both the design doc and the plan, and is prompted to identify coverage gaps.

#### Approach

The traceability check runs as part of the `design-traceability` domain prompt. The prompt instructs the LLM to:

1. **Identify design elements**: Read the design doc and list all named components, APIs, data models, NFRs, and architectural decisions.
2. **Identify plan tasks**: Read the plan and list all implementation tasks with their scope descriptions.
3. **Build a traceability matrix**: For each design element, identify which plan task(s) cover it. For each plan task, identify which design element(s) it implements.
4. **Flag gaps**:
   - Design elements with no corresponding task → "This component from the design has no implementation task"
   - Plan tasks with no design element → "This task doesn't trace to anything in the approved design — is it scope creep?"
   - Non-functional requirements from the design with no dedicated task → "The design specifies SLO targets but no performance testing task exists"

#### Limitations

This is best-effort semantic matching, not formal verification. The LLM may miss implicit coverage (e.g., a task named "implement auth service" covers multiple design components) or produce false positives on loosely-named tasks. The traceability output should be treated as a **review aid requiring human verification**, not a gate. Authors can dismiss false positives with a brief justification in the fix loop.

---

## Prompt Architecture

### Per-domain prompt structure

Each domain gets its own prompt file, same pattern as current system:

```
global/prompts/{agent}/{domain-id}.md
```

New directory structure:

```
global/prompts/
├── claude/
│   ├── design/                    # /stark-review-design domains
│   │   ├── agent.md               # design review agent preamble
│   │   ├── 01-problem-fit.md
│   │   ├── 02-architecture.md
│   │   ├── 03-tradeoffs.md
│   │   ├── 04-failure-modes.md
│   │   ├── 05-maintainability.md
│   │   ├── 06-api-contracts.md
│   │   ├── 07-data-arch.md
│   │   ├── 08-security.md
│   │   ├── 09-scalability.md
│   │   ├── 10-observability.md
│   │   ├── 11-operations.md
│   │   └── 12-existing-impact.md
│   ├── plan/                      # /stark-review-plan domains
│   │   ├── agent.md               # plan review agent preamble
│   │   ├── 01-design-traceability.md
│   │   ├── 02-decomposition.md
│   │   ├── 03-phasing.md
│   │   ├── 04-dependency-graph.md
│   │   ├── 05-acceptance-criteria.md
│   │   ├── 06-risk-mitigation.md
│   │   ├── 07-rollback.md
│   │   ├── 08-integration-points.md
│   │   ├── 09-nfr-coverage.md
│   │   └── 10-resource-deps.md
│   └── code/                      # /stark-review domains (unchanged)
│       ├── agent.md
│       └── 01-architecture.md ... 06-test-coverage.md
├── codex/
│   ├── design/
│   ├── plan/
│   └── code/
└── gemini/
    ├── design/
    ├── plan/
    └── code/
```

### Intensity-aware prompt injection

When a domain runs at different intensities, the prompt includes an intensity directive:

```markdown
<!-- Injected at top of domain prompt -->
## Review Intensity: DEEP

You are reviewing this domain at DEEP intensity because the author
declared {reason}. This means:
- Report findings at ALL severity levels (low, medium, high, critical)
- Actively probe for edge cases and unstated assumptions
- Challenge the design's approach, not just its completeness
- Look for ATAM sensitivity points and tradeoff points
```

```markdown
## Review Intensity: LIGHT

You are reviewing this domain at LIGHT intensity because {reason}.
- Report only HIGH and CRITICAL severity findings
- Focus on showstoppers, not style or suggestions
- Skip edge case probing — check for fundamental correctness only
```

### Domain-specific prompt content

Each domain prompt follows the structure:

```markdown
# Domain: {name}

## What you're checking
{dimension description}

## Review checklist
{specific items to verify — adapted from the research}

## Common anti-patterns to flag
{known bad patterns for this dimension}

## What to skip
{things that look like issues but aren't — reduces false positives}

## Finding format
{structured output format — same as current system}
```

### Prompt Authoring Strategy

The full matrix is 3 agents x 12 design domains + 3 agents x 10 plan domains = 66 prompt files. This is managed through a generation + validation pipeline, not manual authoring:

1. **Generate from domain descriptions.** Each domain's table entry (checklist, anti-patterns, what-to-skip) serves as a seed. A generation script produces agent-specific prompt variants, adapting tone and structure to each LLM's strengths (Claude: nuanced reasoning, Codex: code-centric analysis, Gemini: breadth scanning).

2. **Validate with test reviews.** Maintain 3-5 reference specs (covering different system types: API service, data pipeline, CLI tool, infrastructure change) with known issues. Each prompt variant is tested against these references. A prompt passes if it catches the seeded issues without >20% false positive rate.

3. **Incremental rollout.** Start with Claude-only prompts for all domains (12 + 10 = 22 files). Add Codex and Gemini variants one domain at a time, validating each. This reduces the initial effort from 66 files to 22.

4. **Reuse existing code-review prompts** as structural templates. The `design/` and `plan/` prompts follow the same format — only the checklist content and anti-patterns differ.

---

## `multi_review.py` Changes

### Domain filtering

Currently `multi_review.py` dispatches all domains to all agents. New behavior:

```python
# New parameter: active_domains with intensity
active_domains = {
    "problem-fit": "deep",
    "architecture": "deep",
    "security": "standard",
    # ... only activated domains
}

# Dispatch only active domains
for agent in agents:
    for domain_id, intensity in active_domains.items():
        if intensity == "skip":
            continue
        if intensity == "light" and agent != "claude":
            continue  # light = Claude only
        prompt = load_prompt(agent, review_type, domain_id, intensity)
        dispatch(agent, prompt, ...)
```

### New CLI flags

```
multi_review.py --review-type design --spec path/to/spec.md \
  --domains-json '{"problem-fit": "deep", "security": "standard", ...}'

multi_review.py --review-type plan --plan path/to/plan.md \
  --design path/to/spec.md --priority-record path/to/priority.yaml \
  --domains-json '{"design-traceability": "deep", ...}'
```

#### `--domains-json` Schema

The `--domains-json` flag accepts a JSON object mapping domain IDs to intensity levels:

```jsonschema
{
  "type": "object",
  "additionalProperties": false,
  "patternProperties": {
    "^[a-z][a-z0-9-]+$": {
      "type": "string",
      "enum": ["deep", "standard", "light", "skip"]
    }
  }
}
```

Valid domain IDs depend on `--review-type`:
- `design`: `problem-fit`, `architecture`, `tradeoffs`, `failure-modes`, `maintainability`, `api-contracts`, `data-arch`, `security`, `scalability`, `observability`, `operations`, `existing-impact`
- `plan`: `design-traceability`, `decomposition`, `phasing`, `dependency-graph`, `acceptance-criteria`, `risk-mitigation`, `rollback`, `integration-points`, `nfr-coverage`, `resource-deps`
- `code`: (existing domains, unchanged)

Unknown domain IDs are rejected with an error. Omitted domains default to `skip`.

---

## Migration

### MVP Boundary

Phases 1-3 constitute the MVP. After Phase 3, `/stark-review-design` is fully usable as a standalone skill — the skill split is delivered because `/stark-review-design` is net-new and `/stark-review-plan` continues unchanged. The split is "complete" in the sense that design review is separated; Phase 4 then narrows the existing plan review to remove the design-domain overlap. Each phase is independently deployable and rollback-safe.

### Phase 1: Add new prompt directories + domain prompts

Create `global/prompts/{agent}/design/` and `global/prompts/{agent}/plan/` with all domain prompts. The current `global/prompts/{agent}/` (code review) moves to `global/prompts/{agent}/code/` with backward-compat symlinks.

**Rollback:** Delete new directories, remove symlinks. Zero impact on existing behavior.

### Phase 2: Update `multi_review.py`

Add `--review-type`, `--domains-json`, and intensity-aware prompt loading. Backward compatible — omitting `--review-type` defaults to `code` (current behavior).

**Rollback:** Revert the `multi_review.py` changes. New flags are additive; old invocations are unaffected.

### Phase 3: Build `/stark-review-design` skill

New skill with questionnaire, content scan, challenge mechanism, priority record output. This is a net-new skill — no existing behavior is modified.

**Rollback:** Delete the skill file. No other skills are affected.

**--- MVP complete here. Validate with real reviews before proceeding. ---**

### Phase 4: Narrow `/stark-review-plan` skill

Remove design-review domains from the plan review. Add plan-specific domains. Add design-plan traceability check. Add priority record loading.

**Rollback:** Restore previous `/stark-review-plan` SKILL.md from git. Priority record loading is additive (degrades gracefully if no record exists).

### Phase 5: Update lifecycle and docs

Update README lifecycle diagram, skill docs, routing guide.

**Rollback:** Revert doc changes. No functional impact.

### Staged Rollout Criteria

Each phase gates on the previous:
- **Phase 1 → 2:** All prompt files pass lint (valid markdown, correct frontmatter). No regressions in existing `/stark-review` runs.
- **Phase 2 → 3:** `multi_review.py` passes existing test suite. Manual smoke test: `--review-type code` (default) produces identical output to pre-change behavior.
- **Phase 3 → MVP gate:** Run `/stark-review-design` on 3 real specs (one API-heavy, one data-heavy, one simple). Validate: questionnaire completes in <60s, domain activation matches expectations, no crash/hang. Collect qualitative feedback before proceeding.
- **Phase 4:** Only after ≥5 successful `/stark-review-design` runs in production use. The narrowed `/stark-review-plan` is validated by running it on a plan whose design was reviewed in Phase 3.

---

## Observability

### Metrics to track

- Per-domain activation rates — which domains are most/least commonly activated?
- Challenge acceptance rate — how often do users accept challenges vs. override?
- Priority distribution — are users calibrating priorities realistically?
- Per-domain finding rates at each intensity — does "light" intensity actually produce fewer findings?
- False positive rate by intensity — does "deep" produce more noise?
- Override-to-incident correlation — do `priority_override: forced` decisions correlate with later issues?

### Success criteria

- Design review and plan review produce non-overlapping finding types
- Domain activation reduces total findings by 20%+ (fewer irrelevant findings) while maintaining or increasing actionable finding rate
- Challenge mechanism catches ≥1 priority mismatch in 30%+ of reviews
- Users complete the questionnaire in <60 seconds (it should feel quick, not bureaucratic)

---

## Open Questions — Proposed Resolutions

1. **Should the plan review auto-fail if no approved design exists?**
   **Proposed: Degrade gracefully.** The plan review runs without traceability checks but emits a warning: "No approved design found — traceability domain disabled. Run `/stark-review-design` first for full coverage." This avoids blocking teams that review plans independently.

2. **How does `/stark-review-deployment-plan` relate?**
   **Proposed: (a) Keep it separate.** The adversarial SRE review is a distinct persona and audience. Folding it in would dilute both skills. The `operations` and `rollback` domains in `/stark-review-plan` cover execution-level deployment concerns; `/stark-review-deployment-plan` covers adversarial "what could go wrong in production" scenarios. No overlap if domain scopes are respected.

3. **Should priority records be stored in the repo or in review history?**
   **Proposed: Repo sidecar file.** Store as `{spec-name}.priorities.yaml` next to the spec. This makes priorities visible in PRs, reviewable by the team, and diffable when priorities change. History storage is a secondary copy for analytics.

4. **How do we handle design changes after plan approval?**
   **Proposed: Hash-based staleness detection.** The priority record stores a `spec_hash` (SHA-256 of the spec file at review time). When `/stark-review-plan` loads a priority record, it compares the hash. If stale, it warns: "Design spec has changed since the priority record was created. Re-run `/stark-review-design` or proceed with potentially outdated priorities." It does not auto-invalidate — the user decides.

5. **Should the questionnaire adapt across reviews?**
   **Proposed: No pre-filling in v1.** The value of the questionnaire is forcing deliberate thought per spec. Pre-filling undermines that. Revisit in v2 if user feedback indicates the questionnaire feels repetitive — at that point, offer "same as last time" as an explicit option the user must confirm.
