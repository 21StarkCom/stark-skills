# stark-claude-md-improver — Internals

Analyze and improve CLAUDE.md files for completeness, accuracy, and effectiveness. Use when the user says "improve claude.md", "review claude.md", "audit claude.md", "update claude.md", or "stark-claude-md-improver".

## Architecture

```mermaid
graph TD
    Trigger([Skill Invoked<br>stark-claude-md-improver]) --> Discovery[1. Discovery<br>Find CLAUDE.md files & Memory]
    Discovery --> Analysis[2. Analysis<br>Evaluate 5 Dimensions]
    
    subgraph Analysis Engine
        Analysis --> D1[Structure & Clarity]
        Analysis --> D2[Completeness]
        Analysis --> D3[Accuracy & Freshness]
        Analysis --> D4[Effectiveness for AI]
        Analysis --> D5[Hierarchy Optimization]
    end
    
    D1 & D2 & D3 & D4 & D5 --> Report[3. Output Report<br>Present Scores & Findings]
    Report --> Decision{User Approves<br>Changes?}
    
    Decision -- Yes --> Apply[4. Apply Modifications<br>Direct File Mutation]
    Decision -- No --> Telemetry
    
    Apply --> Telemetry[5. Emit Observability Metrics<br>Record Scores & Actions]
    Telemetry --> End([Completion])
```

![Internal architecture diagram for the stark-claude-md-improver skill showing the discovery, multi-dimensional analysis, user approval, and observability flows.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-claude-md-improver/SKILL.md`, then run `/stark-generate-docs --skill stark-claude-md-improver` to regenerate documentation.
