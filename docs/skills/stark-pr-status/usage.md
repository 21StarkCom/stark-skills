# stark-pr-status

PR analytics dashboard — review rounds, findings by severity, signal-vs-noise, time-to-merge, participants, and most impactful comments. Combines GitHub API data with stark-review history. Use when the user says "PR status", "show PR stats", "how is this PR doing", "PR dashboard", "what happened on PR 15", or invokes /stark-pr-status. Also use when the user asks about review cycles, merge times, or finding quality for specific PRs.

## Workflow Overview

```mermaid
graph TD
    User([User Request / stark-pr-status]) --> Input{Has PR Number?}
    Input -- Yes --> S1[Single PR Mode]
    Input -- No --> S2[All PRs Mode]
    
    S1 --> Script[Run scripts/pr_status.py]
    S2 --> Script
    
    API[(GitHub API)] -.-> Script
    Hist[(stark-review History)] -.-> Script
    
    Script --> Output[Format Terminal Output]
    
    Output --> Logic{Check PR States}
    Logic -- >7 days, 0 reviews --> Sug1[Suggest /stark-review]
    Logic -- High noise ratio --> Sug2[Suggest /stark-review-improvement]
    Logic -- Ready (Approved/Green) --> Sug3[Suggest /stark-pr-flow]
    Logic -- Otherwise --> Done([Complete])
```

![A visualization of the stark-pr-status skill workflow, showing inputs, script execution pulling from GitHub API and local history, output rendering modes, and smart suggestions routing based on PR conditions.](usage.png)

## When to Use

PR analytics dashboard — review rounds, findings by severity, signal-vs-noise, time-to-merge, participants, and most impactful comments. Combines GitHub API data with stark-review history. Use when the user says "PR status", "show PR stats", "how is this PR doing", "PR dashboard", "what happened on PR 15", or invokes /stark-pr-status. Also use when the user asks about review cycles, merge times, or finding quality for specific PRs.

## Prerequisites

*See SKILL.md*

## Arguments

`[PR_NUMBER | --all] [--repo REPO] [--state STATE] [--json]`



## Quick Start

/stark-pr-status

## Common Patterns



## Troubleshooting



## Related Skills


