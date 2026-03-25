# stark-review-plan

Multi-agent design document review using 3 LLMs × 7 domains with autonomous fix loop. Use when the user says "review this plan", "review this spec", "review design doc", or invokes /stark-review-plan. Also triggers on `/stark-review-plan <path>`.

## Workflow Overview

```mermaid

```

![A clean single-page diagram for the stark-review-plan skill showing a usage-focused flow from command invocation, setup, validation, and PR detection into a 21-agent review-fix loop, a dispatch-failure branch, a final review round, consolidated summary generation, and output artifacts like a .review.md file, PR comments, and saved history, with cards explaining arguments, common workflows, outputs, observability, and troubleshooting."}}](usage.png)

## When to Use

Multi-agent design document review using 3 LLMs × 7 domains with autonomous fix loop. Use when the user says "review this plan", "review this spec", "review design doc", or invokes /stark-review-plan. Also triggers on `/stark-review-plan <path>`.

## Prerequisites

*See SKILL.md*

## Arguments

`<path> [--rounds N] [--dry-run] [--force]`



## Quick Start

/stark-review-plan

## Common Patterns



## Troubleshooting



## Related Skills


