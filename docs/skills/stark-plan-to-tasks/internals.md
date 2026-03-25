# stark-plan-to-tasks — Internals

Decompose a spec/design document into phased GitHub issues with story points, risk, and confidence labels. Extracts domain knowledge to project docs and deletes the plan. Use when the user says "plan to tasks", "decompose plan", "break down this plan", "create issues from spec", "create tasks from plan", or invokes /stark-plan-to-tasks.

## Architecture

```mermaid
graph TD
  Start[CLI Invocation] --> P1[Phase 1: Setup & Pre-flight]
  P1 --> GHAuth[GitHub App Auth Check]
  GHAuth --> ValidAgents[Check Validation Agents]
  ValidAgents --> P2[Phase 2: Plan Quality Gate]
  
  P2 -->|LLM Evaluates| P2Check{Passes Checks?}
  P2Check -->|No| P2Loop[Prompt User for Plan Fixes]
  P2Loop -->|Max 3 Cycles| P2
  
  P2Check -->|Yes| P3[Phase 3: Decomposition]
  P3 -->|LLM Extracts| P3JSON[Generate breakdown.json]
  
  P3JSON --> P4[Phase 4: Validation Agent]
  P4 -->|plan_to_tasks_validate.py| P4Check{Validation Passed?}
  P4Check -->|No| P4Loop[Fix JSON Breakdown]
  P4Loop -->|Max 2 Iterations| P4
  
  P4Check -->|Yes| P5[Phase 5: Issue Creation]
  P5 -->|User Auth| GHCreate[Create Labels & Issues]
  GHCreate -->|Bot Auth| GHProject[Add to GitHub Project]
  
  GHProject --> P6[Phase 6: Knowledge Extraction]
  P6 -->|LLM Routes Context| WriteDocs[Write docs/decisions.md]
  WriteDocs --> LocalCommit[Git Commit & Delete Plan]
  
  LocalCommit --> P7[Phase 7: Metrics & Summary]
  P7 --> AppendLogs[Append logs/stark-plan-to-tasks.jsonl]
  AppendLogs --> End[End]
```

![A vertical flowchart visualizing the 7-phase architecture of the stark-plan-to-tasks skill, detailing its multi-agent validation passes, GitHub dual-auth strategy, and automated documentation extraction workflow.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-plan-to-tasks/SKILL.md`, then run `/stark-generate-docs --skill stark-plan-to-tasks` to regenerate documentation.
