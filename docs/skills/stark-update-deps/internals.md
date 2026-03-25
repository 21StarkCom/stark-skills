# stark-update-deps — Internals

Audit and update all dependency versions across a project to their latest stable releases. Scans pyproject.toml, package.json, requirements.txt, Dockerfile, docker-compose.yml, go.mod, Cargo.toml, and any other dependency manifest. Looks up each dependency on official sources (PyPI, npm, Docker Hub, GitHub releases) via WebSearch, checks for compatibility blockers and breaking changes, updates versions in-place, then re-verifies every updated version to ensure accuracy. Use when the user says "update dependencies", "check for outdated packages", "upgrade versions", "are my deps current", "stark-update-deps", or any variation of wanting to bring project dependencies up to date. Also use proactively when you notice stale or outdated versions during other work.

## Architecture

```mermaid
graph TD
  Start([Trigger: update deps]) --> Disc[Phase 1: Discovery]
  
  Disc -->|Extract manifests| Inv[(Inventory Table)]
  Inv --> Res[Phase 2: Research]
  
  subgraph Parallel Lookups
    Res --> S1[PyPI Search]
    Res --> S2[npm Search]
    Res --> S3[Docker Hub Check]
    Res --> S4[Go/Rust Registries]
  end
  
  S1 --> Comp[Phase 3: Compatibility Analysis]
  S2 --> Comp
  S3 --> Comp
  S4 --> Comp
  
  Comp -->|Evaluate Cross-Compat & Codemods| Dec{Decision Matrix}
  
  Dec -->|Major Bump/Risk| Rev[Category: Review]
  Dec -->|Safe Minor/Patch| Safe[Category: Safe]
  Dec -->|Conflict/Missing| Blk[Category: Blocked]
  
  Rev --> Update[Phase 4: Update In-Place]
  Safe --> Update
  Blk -->|Skip| Rep
  
  Update -->|Modify Files| Ver[Phase 5: CRITICAL Verification]
  
  subgraph Anti-Hallucination Loop
    Ver -->|Re-Read Files| Extr[Extract New Tags]
    Extr -->|Explicit Search| Val{Exists on Registry?}
    Val -->|Yes| Conf[Mark Confirmed]
    Val -->|No| Fix[Revert/Search Alt]
    Fix --> Ver
  end
  
  Conf --> Rep[Phase 6: Report Generation]
  
  Rep -->|Export Metrics & CLI Output| End([End Process])

  classDef phase fill:#1e40af,stroke:#1e3a8a,color:#fff,stroke-width:2px;
  classDef decision fill:#7c3aed,stroke:#5b21b6,color:#fff;
  classDef critical fill:#0f172a,stroke:#ef4444,stroke-width:3px,color:#fff;
  
  class Disc,Res,Comp,Update,Rep phase;
  class Dec,Val decision;
  class Ver critical;
```

![`Architecture flow diagram and feature breakdown for the stark-update-deps skill, highlighting its six-phase process: Discovery, Research, Compatibility Analysis, Update, Verification (anti-hallucination), and Reporting.`](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-update-deps/SKILL.md`, then run `/stark-generate-docs --skill stark-update-deps` to regenerate documentation.
