# stark-extract-docs

Extract durable knowledge from specs, plans, and reviews into project documentation — ADRs, retrospectives, reference docs, glossary, and a learning log. Use when the user says "extract docs", "generate ADRs", "extract knowledge", "create retrospective", "docs from spec", or invokes /stark-extract-docs.

## Workflow Overview

```mermaid
graph TD
    A[User Invokes /stark-extract-docs] --> B{Arguments Provided?}
    B -->|--batch <dir>| C[Iterate over all *-design.md specs]
    B -->|<path-to-spec>| D[Single spec execution]
    C --> D
    
    subgraph Phase 1: Setup
        D --> E[Locate Spec, Plan, & Review Artifacts]
        E --> F{Check Skip Logic}
        F -->|Matches History Hash| G[Skip unless --force]
        F -->|New or --force| H[Resolve Target Repo & Setup Dirs]
    end
    
    subgraph Pass 1: Extraction
        H --> I[Read Artifact Contents]
        I --> J[Extract 8 Categories to Structured JSON]
        J --> K[Filter low-confidence extractions]
    end
    
    subgraph Pass 2: Routing
        K --> L[Route to Document Types]
        L --> M[Deduplicate against existing ADRs/Logs]
        M --> N[Generate formatted markdown]
    end
    
    subgraph Output
        N --> O[Write Files to Disk]
        O --> P{--no-commit?}
        P -->|Yes| Q[Done]
        P -->|No| R[Stage and Commit Locally]
        R --> Q
    end
    
    %% Outputs Mapping
    J -.->|decision| ADR[docs/adr/]
    J -.->|evolution| Retro[docs/retrospectives/]
    J -.->|agent_signal| Log[learning-log.md]
    J -.->|glossary| Gloss[docs/glossary.md]
    J -.->|data_model| Ref[docs/reference/]
```

![A documentation page visualizing the stark-extract-docs skill, showing the CLI usage, available flags, extraction categories mapped to their documentation outputs, and the two-pass execution workflow.](usage.png)

## When to Use

Extract durable knowledge from specs, plans, and reviews into project documentation — ADRs, retrospectives, reference docs, glossary, and a learning log. Use when the user says "extract docs", "generate ADRs", "extract knowledge", "create retrospective", "docs from spec", or invokes /stark-extract-docs.

## Prerequisites

*See SKILL.md*

## Arguments

`<path-to-spec> [--batch <dir>] [--dry-run] [--force]`



## Quick Start

/stark-extract-docs

## Common Patterns



## Troubleshooting



## Related Skills


