---
name: stark-review-deployment-plan
description: Adversarial infrastructure and deployment plan review from a Principal Cloud Architect + SRE perspective. Finds material flaws prioritized by blast radius across 10 failure vectors (partial-failure traps, idempotency, IaC completeness, dependency sequencing, drift, command validation, cutover gates, API prerequisites, identity lifecycle, evidence strictness). Use when the user says "review deployment plan", "review infra plan", "review migration plan", "audit deployment", "review infrastructure", "check my deployment", "review this plan", or any variation involving reviewing/auditing cloud infrastructure, migration, or deployment documents. Also triggers on `/stark-review-deployment-plan`. Proactively use this skill whenever the user shares an infrastructure or migration plan and wants feedback, even casually like "does this plan look right" or "poke holes in this".
---

# Review Deployment Plan

Adversarial review of infrastructure, migration, and deployment plans. The goal is to find material flaws in a single pass, prioritized by blast radius — not stylistic polish.

## Arguments

- A deployment/infrastructure/migration plan document. The user may:
  - Paste the plan inline
  - Reference a file path (read it)
  - Reference a URL (fetch it)
- If no plan is provided, ask the user for one.

## Hard Constraints

- Do NOT fabricate facts, file contents, command behavior, or documentation URLs.
- If uncertain about command/API semantics, write **UNCERTAIN** and explain the risk.
- If codebase/scripts are not accessible, explicitly mark those checks as **DEFERRED**.
- Do not PASS by omission — every vector requires concrete evidence to pass.

## Review Process

### Pass 1: Full Read
Read the entire plan document end to end.

### Pass 2: Contradiction Scan
Second pass specifically looking for contradictions, hidden assumptions, and missing gates.

### Pass 3: Cross-Check
Cross-check against repo scripts and runtime config IF accessible. If not accessible, list exactly what was not verifiable as DEFERRED.

### Pass 4: Vector Evaluation
Evaluate all 10 required failure vectors below. Continue until every vector is covered.

## Required Failure Vectors

All 10 vectors must be evaluated. If forced to choose due to context limits, complete all High findings and all required tables before Medium/Low findings.

### A) Partial-Failure Trap
Dual-write and migration cutovers.
- Simulate both directions: A succeeds / B fails, and B succeeds / A fails.
- Identify source of truth at each migration step.
- Require explicit anti-split-brain cutover gate (final delta sync or write freeze + reconciliation).

### B) Imperative Idempotency
CI/CD and scripts.
- Identify imperative commands (`create`, `deploy`, `execute`, etc.) that are NOT idempotent or NOT upsert-safe.
- Skip commands that are already safe.

### C) Blank-Slate IaC Completeness
Assume a brand-new empty project/account.
- Verify required APIs/services are explicitly enabled in IaC.
- Flag hidden assumptions about pre-existing service agents, IAM grants, networking defaults, or default service accounts.

### D) Cross-Boundary Dependency Sequencing
- Validate infra dependencies AND deployment/runtime dependencies.
- Call out phase-order breakages (e.g., secret/runtime changes required before deploy steps).

### E) Reality Drift
Split ownership and manual edits.
- For each non-IaC-managed resource, define authoritative owner.
- Explain drift correction mechanism; if no automatic correction exists, explain detection and manual remediation.

### F) Command Contract Validation
- Validate CLI/API usage and flags using your knowledge.
- If uncertain, mark **UNCERTAIN**; do not guess and do not fabricate URLs.

### G) Pre-Cutover Gate
- For dual-write migrations, require explicit final delta sync or write freeze immediately before read cutover.
- Mark FAIL if missing.

### H) API Prerequisite Matrix
- Map each phase capability to required cloud APIs/services and explicit IaC enablement.
- Mark FAIL if any required API is implied but undeclared.

### I) Runtime Identity Lifecycle
- Require explicit lifecycle for each runtime identity: creation, IAM bindings, and deploy-time attachment (`--service-account` or equivalent).
- Mark FAIL if identity is referenced but lifecycle is incomplete.

### J) Evidence Strictness
- If evidence is missing, use FAIL or DEFERRED with explanation.

## Severity Rubric

| Severity | Criteria |
|----------|----------|
| **High** | Execution blocker, data loss/divergence risk, security break, or guaranteed drift |
| **Medium** | Likely operational issue with workaround |
| **Low** | Non-blocking improvement |

## Confidence Rubric

| Confidence | Criteria |
|------------|----------|
| **High** | Verifiable from document text alone |
| **Medium** | Requires assumption about runtime behavior or external system |
| **Low** | Uncertain about underlying API/tool behavior |

## False-Positive Guard

- Do not report stylistic preferences or purely theoretical edge cases as findings.
- Every High finding must include a concrete production failure sequence.

## Output Format

Use this exact structure. Do not skip sections — if a section has no findings, say so explicitly.

### 1) Findings (High → Medium → Low)

Only material flaws. For each finding:

- **Severity:** High / Medium / Low
- **Location:** Line number if available; otherwise section heading + exact quote
- **Failure scenario:** Concrete sequence of events leading to failure
- **Why current plan fails:** What's missing or wrong
- **Fix:** Exact technical fix (specific command, pattern, Terraform change, etc.)
- **Confidence:** High / Medium / Low

### 2) Dependency Violations Table

| Prerequisite | Dependent step | What breaks if missing | Fix |
|---|---|---|---|

### 3) Ownership & Drift Table

Cover every resource explicitly mentioned in the plan (not just problematic ones).

| Resource | Owner | Drift risk | Correction mechanism OR detection + manual remediation |
|---|---|---|---|

### 4) API Prerequisite Matrix

| Capability / Phase | Required API / Service | Explicitly enabled in IaC? | Evidence | Status |
|---|---|---|---|---|

### 5) Coverage Matrix

Vectors A–J, each marked PASS / FAIL / DEFERRED with one-line evidence.

| Vector | Status | Evidence |
|---|---|---|

### Closing Line

End the response with exactly:

```
Remaining blockers before execution: <count>
```

Where `<count>` is the number of High-severity findings.

## Traceability

- Use exact line numbers when available.
- If line numbers are unavailable, quote exact section text or snippet from the plan.

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Per-pass duration (Full Read, Contradiction Scan, Cross-Check, Vector Evaluation)
- Findings: count by severity (High/Medium/Low)
- Vectors: PASS/FAIL/DEFERRED counts
- Remaining blockers count

## Quality Bar

- No generic advice.
- No hand-wavy "consider X".
- PASS requires concrete evidence.
- DEFERRED requires explicit reason.
