# stark-skill-analytics

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Workflow Overview

```mermaid
graph TD
    Start([User Invokes /stark-skill-analytics]) --> ParseArgs{Parse Arguments}
    ParseArgs --> |"[--skill name]"| FilterSkill[Target Single Skill]
    ParseArgs --> |"[--format table|full]"| SetFormat[Set Output Format]
    
    FilterSkill --> Phase1
    SetFormat --> Phase1
    
    subgraph Data Collection
        Phase1[Phase 1: Parse history.jsonl] --> ExtractUsages[Extract Invocations & Sessions]
        ExtractUsages --> CalcUsage[Compute Usage Stats & Sequences]
        
        CalcUsage --> Phase2[Phase 2: Scan run history/]
        Phase2 --> ParseRuns[Parse Run JSONs]
        ParseRuns --> CalcQuality[Compute Success, Timeouts & Durations]
    end
    
    subgraph Cross-Reference Analysis
        CalcQuality --> Phase3[Phase 3: Analyze Data]
        Phase3 --> ReadConfig[(Read CLAUDE.md)]
        ReadConfig --> IdentifyGaps[Identify Unregistered / Unused Skills]
        IdentifyGaps --> GenRecs[Generate Recommendations & Trends]
    end
    
    subgraph Report Generation
        GenRecs --> Phase4[Phase 4: Format Report]
        Phase4 --> |Full/Table Format| WriteMD[Write MD to /insights/skills/]
        WriteMD --> TerminalOut>Print Report to Terminal]
    end
    
    TerminalOut --> Finish([End])
```

![A visualization of the stark-skill-analytics skill workflow, illustrating the four phases of data collection from Claude session logs, run history aggregation, cross-reference analysis with CLAUDE.md, and final report generation.](usage.png)

## When to Use

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Prerequisites

*See SKILL.md*

## Arguments

`[--skill <name>] [--format table|full]`



## Quick Start

/stark-skill-analytics

## Common Patterns



## Troubleshooting



## Related Skills


