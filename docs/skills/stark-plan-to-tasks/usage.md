# stark-plan-to-tasks

Decompose a spec/design document into phased GitHub issues with story points, risk, and confidence labels. Extracts domain knowledge to project docs and deletes the plan. Use when the user says "plan to tasks", "decompose plan", "break down this plan", "create issues from spec", "create tasks from plan", or invokes /stark-plan-to-tasks.

## Workflow Overview

```mermaid
graph TD
    A[Start: User invokes skill with plan.md] --> B{Pass 1: Plan Quality Gate}
    B -- "Gaps found" --> C[Prompt user to clarify plan]
    C --> B
    B -- "Approved" --> D[Pass 2: Decompose into Phases & Tasks]
    D --> E{Pass 3: Validate Breakdown}
    E -- "Dependency / Coverage errors" --> D
    E -- "Valid" --> F{Is --dry-run?}
    F -- Yes --> G[Output preview to /tmp and exit]
    F -- No --> H[Create Phase Tracking Issues in GitHub]
    H --> I[Create Task Issues, link Dependencies]
    I --> J[Sync Issues to GitHub Projects]
    J --> K[Pass 4: Extract ADRs/Schemas to docs/]
    K --> L[Delete plan.md, Local Git Commit]
    L --> M[End: Print Summary]
```

![A visualization of the stark-plan-to-tasks skill, detailing its usage workflow from taking a markdown plan through a quality gate, decomposition, validation, GitHub issue creation, and finally knowledge extraction and git commits.](usage.png)

## When to Use

Decompose a spec/design document into phased GitHub issues with story points, risk, and confidence labels. Extracts domain knowledge to project docs and deletes the plan. Use when the user says "plan to tasks", "decompose plan", "break down this plan", "create issues from spec", "create tasks from plan", or invokes /stark-plan-to-tasks.

## Prerequisites

*See SKILL.md*

## Arguments

`<path-to-spec> [--dry-run] [--cleanup <slug>]`



## Quick Start

/stark-plan-to-tasks

## Common Patterns



## Troubleshooting



## Related Skills


