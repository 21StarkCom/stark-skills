# stark-pr-flow

End-to-end PR workflow for GetEvinced repos — push, create PR, post self-review via stark-claude bot, present summary, and squash-merge with --admin on approval. Use when the user says "open PR", "create PR", "merge this", "ship it", or "stark-pr-flow".

## Workflow Overview

```mermaid
graph TD
    A[Start: 'stark-pr-flow'] --> PreReq{Check Pre-reqs}
    PreReq -- "On main / Dirty tree" --> Fail[Abort]
    PreReq -- "Feature branch & Clean" --> B[Step 1: Push Branch]
    
    B --> C[Step 2: Analyze Git Log & Diff]
    C --> D[Step 3: Create PR]
    
    D -.-> D1(Artifact: PR Created)
    
    D --> E[Step 4: Bot Self-Review]
    E -.-> E1(Artifact: Review Comment on PR)
    
    E --> F[Step 5: Present Summary]
    F --> DocCheck{Advisory Doc Check}
    DocCheck -- "Incomplete docs" --> Warn(Show Warning)
    DocCheck -- "Docs okay" --> Wait
    Warn --> Wait{Wait for User Approval}
    
    Wait -- "Approve ('yes', 'ship it')" --> G[Step 6: Squash Merge]
    Wait -- "Reject" --> H[Abort / Leave Open]
    
    G --> I[Clean Up: Sync main & Delete Branch]
    I --> J[End]
```

![A workflow visualization of the stark-pr-flow skill showing the step-by-step process of pushing a branch, creating a PR, running a bot self-review, pausing for user approval, and finally merging and cleaning up.](usage.png)

## When to Use

End-to-end PR workflow for GetEvinced repos — push, create PR, post self-review via stark-claude bot, present summary, and squash-merge with --admin on approval. Use when the user says "open PR", "create PR", "merge this", "ship it", or "stark-pr-flow".

## Prerequisites

*See SKILL.md*

## Arguments

`<optional: PR title override or "draft" to create as draft>`



## Quick Start

/stark-pr-flow

## Common Patterns



## Troubleshooting



## Related Skills


