# stark-metrics

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Workflow Overview

```mermaid
graph TD
    A([User Input: /stark-metrics or 'show metrics']) --> B{Parse Flags}
    B -->|--repo, --skill, --since| C[Execute metrics.py script]
    
    C --> D{Exit Code}
    D -->|1: No Data| E[Error: Run /stark-review to generate data]
    D -->|2: Arg Error| F[Error: Show Argument Usage]
    
    D -->|0: Success| G[Present Formatted Terminal Report]
    
    G --> H{Used --json?}
    H -->|Yes| Z([End])
    
    H -->|No| I{Has Recommendations?}
    I -->|Yes| J[Interactive Prompt: 'Want to act on any?']
    J -->|User selects action| K[Invoke Skill / Edit Config]
    K --> L[Show Meta-Observations]
    
    I -->|No| L
    L --> Z([End])
    
    style A fill:#047857,stroke:#fff,stroke-width:2px,color:#fff
    style C fill:#1e40af,stroke:#fff,stroke-width:2px,color:#fff
    style G fill:#f59e0b,stroke:#fff,stroke-width:2px,color:#000
    style J fill:#7c3aed,stroke:#fff,stroke-width:2px,color:#fff
    style E fill:#dc2626,stroke:#fff,stroke-width:2px,color:#fff
    style F fill:#dc2626,stroke:#fff,stroke-width:2px,color:#fff
```

![Usage visualization for the stark-metrics skill showing the invocation arguments, execution flow, interactive recommendation handling, and common failure modes.](usage.png)

## When to Use

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Prerequisites

*See SKILL.md*

## Arguments

`[--repo REPO] [--skill SKILL] [--since DATE] [--json]`



## Quick Start

/stark-metrics

## Common Patterns



## Troubleshooting



## Related Skills


