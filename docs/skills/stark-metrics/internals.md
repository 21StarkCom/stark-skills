# stark-metrics — Internals

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Architecture

```mermaid
graph TD
  A[Start /stark-metrics] --> B{Parse Arguments}
  B -->|--repo, --skill, etc| C[Execute Python Backend]
  
  subgraph Python Engine [metrics.py]
    C --> D[(~/.claude/code-review/history/)]
    D --> E{Valid JSON?}
    E -- No --> F[Warn stderr & Skip]
    E -- Yes --> G[Normalize & Aggregate]
    G --> H[Apply Filters]
    H --> I[Generate Report Strings/JSON]
  end

  C -- Exit 1 --> J[Error: Prompt /stark-review]
  C -- Exit 2 --> K[Error: Show Usage]
  
  I --> L{--json flag?}
  L -- Yes --> M[Print stdout directly]
  L -- No --> N[Print Terminal Report]
  
  N --> O{Actionable Recommendations?}
  O -- Yes --> P[Prompt User]
  P -- User Selects --> Q[Run /stark-review-improvement]
  O -- No --> R[Evaluate Trends]
  
  R --> S{Meta-Observations}
  S -- First Run --> T[Tip: Run periodically]
  S -- Lower FP Rate --> U[Flag: Win]
  S -- High Failures --> V[Flag: Urgent]
  
  M --> W[Emit Observability Logs]
  Q --> W
  T --> W
  U --> W
  V --> W
  W --> X[End]
```

![Architectural flow diagram and internal components of the stark-metrics skill, showing data ingestion from history files, Python script processing, interactive output handling, and observability telemetry.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-metrics/SKILL.md`, then run `/stark-generate-docs --skill stark-metrics` to regenerate documentation.
