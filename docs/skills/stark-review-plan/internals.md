# stark-review-plan — Internals

Multi-agent design document review using 3 LLMs × 7 domains with autonomous fix loop. Use when the user says "review this plan", "review this spec", "review design doc", or invokes /stark-review-plan. Also triggers on `/stark-review-plan <path>`.

## Architecture

```mermaid

```

![A clean internal architecture diagram for the `stark-review-plan` skill showing a top-to-bottom workflow from input validation and PR detection into a 21-sub-agent dispatch matrix, classification and plan-fixing loop, failure-aware branching, final review, summary generation, and artifact persistence, with supporting tables for data flow, extension points, and operational outputs."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review-plan/SKILL.md`, then run `/stark-generate-docs --skill stark-review-plan` to regenerate documentation.
