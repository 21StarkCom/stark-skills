# stark-skill-analytics — Internals

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Architecture

```mermaid
graph TD
    A[history.jsonl] -->|Line-by-line parse| P1(Phase 1: Usage Parsing)
    B[code-review/history/*.json] -->|JSON parsing| P2(Phase 2: Quality Parsing)
    C[CLAUDE.md] -->|Extract manifest| P3(Phase 3: Cross-Reference)
    P1 -->|Invocation counts, sequences| P3
    P2 -->|Duration, success rates| P3
    P3 -->|Analysis & Recommendations| P4(Phase 4: Generate Report)
    P4 -->|Format: Table or Full| O1[Terminal Output]
    P4 -->|Write| O2[skill-analytics.md]
    P4 -->|Single skill mode| O3[skill-analytics-name.md]
    
    classDef file fill:#e5e7eb,stroke:#9ca3af,stroke-dasharray: 5 5,color:#444;
    classDef phase fill:#1e40af,stroke:none,color:#fff;
    classDef output fill:#f59e0b,stroke:none,color:#1a1a1a;
    
    class A,B,C file;
    class P1,P2,P3,P4 phase;
    class O1,O2,O3 output;
```

![A documentation page titled stark-skill-analytics - Internal Architecture showing a vertical flow diagram connecting Phase 1 Collect Usage Data, Phase 2 Collect Quality Data, Phase 3 Cross-Reference, and Phase 4 Generate Report, alongside data source inputs and feature details.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-skill-analytics/SKILL.md`, then run `/stark-generate-docs --skill stark-skill-analytics` to regenerate documentation.
