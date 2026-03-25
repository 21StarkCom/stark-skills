# stark-review-deployment-plan

Adversarial infrastructure and deployment plan review from a Principal Cloud Architect + SRE perspective. Finds material flaws prioritized by blast radius across 10 failure vectors (partial-failure traps, idempotency, IaC completeness, dependency sequencing, drift, command validation, cutover gates, API prerequisites, identity lifecycle, evidence strictness). Use when the user says "review deployment plan", "review infra plan", "review migration plan", "audit deployment", "review infrastructure", "check my deployment", "review this plan", or any variation involving reviewing/auditing cloud infrastructure, migration, or deployment documents. Also triggers on `/stark-review-deployment-plan`. Proactively use this skill whenever the user shares an infrastructure or migration plan and wants feedback, even casually like "does this plan look right" or "poke holes in this".

## Workflow Overview

```mermaid
graph TD
    User([User Request / Provide Plan]) --> Trigger{Trigger Skill}
    Trigger --> |/stark-review-deployment-plan| Setup[Load Plan & Code Context]
    Trigger --> |"review this deployment"| Setup
    
    Setup --> P1[Pass 1: Full Read]
    P1 --> P2[Pass 2: Contradiction Scan]
    P2 --> P3[Pass 3: Cross-Check vs Runtime]
    P3 --> P4[Pass 4: Vector Evaluation]
    
    P4 --> V_A[A: Partial-Failure Trap]
    P4 --> V_B[B: Imperative Idempotency]
    P4 --> V_C[C: Blank-Slate IaC]
    P4 --> V_D[D: Dependency Sequencing]
    P4 --> V_E[E: Reality Drift]
    P4 --> V_F[F: Command Validation]
    P4 --> V_G[G: Pre-Cutover Gate]
    P4 --> V_H[H: API Prerequisites]
    P4 --> V_I[I: Identity Lifecycle]
    P4 --> V_J[J: Evidence Strictness]
    
    V_A & V_B & V_C & V_D & V_E & V_F & V_G & V_H & V_I & V_J --> Out1[1. Findings List]
    
    Out1 --> Out2[2. Dependency Violations Table]
    Out2 --> Out3[3. Ownership & Drift Table]
    Out3 --> Out4[4. API Matrix]
    Out4 --> Out5[5. Coverage Matrix]
    Out5 --> Final[Remaining Blockers Count]
```

![A visualization of the stark-review-deployment-plan skill showing its invocation methods, the 4-pass adversarial review workflow, the 10 specific failure vectors evaluated, and the strict 5-part tabular output structure generated.](usage.png)

## When to Use

Adversarial infrastructure and deployment plan review from a Principal Cloud Architect + SRE perspective. Finds material flaws prioritized by blast radius across 10 failure vectors (partial-failure traps, idempotency, IaC completeness, dependency sequencing, drift, command validation, cutover gates, API prerequisites, identity lifecycle, evidence strictness). Use when the user says "review deployment plan", "review infra plan", "review migration plan", "audit deployment", "review infrastructure", "check my deployment", "review this plan", or any variation involving reviewing/auditing cloud infrastructure, migration, or deployment documents. Also triggers on `/stark-review-deployment-plan`. Proactively use this skill whenever the user shares an infrastructure or migration plan and wants feedback, even casually like "does this plan look right" or "poke holes in this".

## Prerequisites

*See SKILL.md*

## Arguments

`<path or inline plan>`



## Quick Start

/stark-review-deployment-plan

## Common Patterns



## Troubleshooting



## Related Skills


