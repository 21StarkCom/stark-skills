# stark-extract-docs — Internals

Extract durable knowledge from specs, plans, and reviews into project documentation — ADRs, retrospectives, reference docs, glossary, and a learning log. Use when the user says "extract docs", "generate ADRs", "extract knowledge", "create retrospective", "docs from spec", or invokes /stark-extract-docs.

## Architecture

```mermaid
graph TD
    subgraph "Phase 1: Setup"
        A1[Spec] --> B{Artifact Resolver}
        A2[Plan] --> B
        A3[Reviews] --> B
        B --> C{Skip Logic Check}
        C -- Hashes Match --> Z[Exit Cleanly]
        C -- Missing/Force --> D[Input Files]
    end

    subgraph "Phase 2: Pass 1 (Extraction)"
        D --> E[LLM Knowledge Extraction]
        E --> F{Schema & Confidence Validation}
        F -- Invalid --> E
        F -- Valid --> G[Structured JSON Extraction]
    end

    subgraph "Phase 3 & 4: Routing & Write"
        G --> H[Routing Engine]
        H --> I1(ADRs)
        H --> I2(Retrospectives)
        H --> I3(Reference Docs)
        H --> I4(Glossary/Log)
        
        I1 --> J[File System Write]
        I2 --> J
        I3 --> J
        I4 --> J
    end

    subgraph "Post-Processing"
        J --> K[Git Stage & Commit]
        J --> L[Persist Metrics JSON]
        L --> M((End))
    end
```

![Architecture diagram and data flow visualization for the stark-extract-docs skill, detailing the two-pass process from raw artifacts to structured intermediate JSON, through the routing engine, and into generated Markdown documents with corresponding skip logic and state persistence.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-extract-docs/SKILL.md`, then run `/stark-generate-docs --skill stark-extract-docs` to regenerate documentation.
