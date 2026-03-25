# stark-review-deployment-plan — Internals

Adversarial infrastructure and deployment plan review from a Principal Cloud Architect + SRE perspective. Finds material flaws prioritized by blast radius across 10 failure vectors (partial-failure traps, idempotency, IaC completeness, dependency sequencing, drift, command validation, cutover gates, API prerequisites, identity lifecycle, evidence strictness). Use when the user says "review deployment plan", "review infra plan", "review migration plan", "audit deployment", "review infrastructure", "check my deployment", "review this plan", or any variation involving reviewing/auditing cloud infrastructure, migration, or deployment documents. Also triggers on `/stark-review-deployment-plan`. Proactively use this skill whenever the user shares an infrastructure or migration plan and wants feedback, even casually like "does this plan look right" or "poke holes in this".

## Architecture

```mermaid

```

![A clean internal architecture page for the “stark-review-deployment-plan” skill, showing a vertical review pipeline from plan ingestion through four analysis passes, an evidence gate that routes missing proof to FAIL or DEFERRED, structured output artifacts, ten failure-vector cards, contributor extension points, and observability tables for durations, severity counts, and remaining blockers."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review-deployment-plan/SKILL.md`, then run `/stark-generate-docs --skill stark-review-deployment-plan` to regenerate documentation.
