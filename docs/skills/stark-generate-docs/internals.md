# stark-generate-docs — Internals

Generate or update skill documentation with multi-LLM visualizations. Detects which SKILL.md files changed, regenerates docs for those skills, and commits the results. Use when the user says "generate docs", "update skill docs", "regenerate viz", or invokes /stark-generate-docs. Proactively use when a SKILL.md has been modified in the current session.

## Architecture

```mermaid
graph TD
  Start([User Command: /stark-generate-docs]) --> Args{Arguments provided?}
  
  Args -->|--skill or --all| Gen[Phase 2: Generate Docs]
  Args -->|None or --check| Check[Phase 1: Run --check Script]

  Check --> CheckResult{Exit Code?}
  CheckResult -->|0| UpToDate[Done: All docs up to date]
  CheckResult -->|1| Stale[Capture stale skill names]
  
  Stale --> Gen

  Gen --> |scripts/generate_skill_docs.py| Generate[Multi-LLM Generation & Viz]
  Generate --> Commit[Phase 3: git add & git commit]
  Commit --> Summary[Phase 4: Output Summary Report]

  Generate -.-> Fail1[Failure: LLM Calls]
  Fail1 -.->|Recovery| Cont1[Report & Continue]
  
  Generate -.-> Fail2[Failure: Playwright Missing]
  Fail2 -.->|Recovery| Cont2[Skip Screenshots, Warn]
```

![Flowchart illustrating the stark-generate-docs skill internal architecture, showing phases for change detection, multi-LLM documentation generation, git committing, and summary reporting.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-generate-docs/SKILL.md`, then run `/stark-generate-docs --skill stark-generate-docs` to regenerate documentation.
