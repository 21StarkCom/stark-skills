# stark-phase-execute

Autonomously execute all tasks in a development phase end-to-end — for each task: session start, implement, PR, multi-agent review with fix rounds, merge, session end. Then regression tests, version bump, deploy, dashboard, memory/docs update, and prompt improvement detection. Zero user intervention after trigger. If no GitHub issues exist for the plan slug, automatically runs /stark-plan-to-tasks first to decompose the plan into issues, then executes them. Use when the user says "execute phase", "run phase", "stark-phase-execute", "execute these tasks", "implement this phase", "run the plan", "autopilot", or any variation of wanting to autonomously execute a set of planned GitHub issues. Also triggers on `/stark-phase-execute`. Proactively suggest this skill when the user has just run `/stark-plan-to-tasks` and has open phase issues, OR when a plan file exists but hasn't been decomposed yet.

## Workflow Overview

```mermaid
graph TD
  Start([Run stark-phase-execute]) --> Fetch[Fetch Plan Tasks via GitHub/Project API]
  Fetch --> Check{Tasks Exist?}
  Check -- No --> Decompose[Auto-Run /stark-plan-to-tasks] --> Fetch
  Check -- Yes --> LoopStart((Start Task Loop))
  
  LoopStart --> Subagent[Spawn Implementation Subagent]
  Subagent --> CreatePR[Push Branch & Create PR]
  
  CreatePR --> Review[Multi-Agent Code Review]
  Review --> Findings{Actionable Findings?}
  Findings -- Yes --> Fix[Auto-Fix Findings] --> Review
  Findings -- No --> Merge[Squash Merge to main]
  
  Merge --> MoreTasks{More Phase Tasks?}
  MoreTasks -- Yes --> LoopStart
  MoreTasks -- No --> Regression[Run Full Regression Suite]
  
  Regression --> Changelog[Update CHANGELOG.md]
  Changelog --> Release[Auto-Run /stark-release]
  Release --> Deploy[Run Deploy Command]
  Deploy --> Housekeeping[Generate Dashboard & Update Memory]
  Housekeeping --> End([Phase Execution Complete])
  
  classDef loop fill:#eff6ff,stroke:#1e40af,stroke-width:2px;
  class Subagent,CreatePR,Review,Findings,Fix,Merge loop;
```

![A user-focused flowchart and UI visualization of the stark-phase-execute workflow, detailing the autonomous lifecycle from initialization and task fetching to the implementation subagent loop, multi-agent review, merging, release, and final dashboard generation.](usage.png)

## When to Use

Autonomously execute all tasks in a development phase end-to-end — for each task: session start, implement, PR, multi-agent review with fix rounds, merge, session end. Then regression tests, version bump, deploy, dashboard, memory/docs update, and prompt improvement detection. Zero user intervention after trigger. If no GitHub issues exist for the plan slug, automatically runs /stark-plan-to-tasks first to decompose the plan into issues, then executes them. Use when the user says "execute phase", "run phase", "stark-phase-execute", "execute these tasks", "implement this phase", "run the plan", "autopilot", or any variation of wanting to autonomously execute a set of planned GitHub issues. Also triggers on `/stark-phase-execute`. Proactively suggest this skill when the user has just run `/stark-plan-to-tasks` and has open phase issues, OR when a plan file exists but hasn't been decomposed yet.

## Prerequisites

*See SKILL.md*

## Arguments

`<plan-slug-or-path> [--dry-run] [--skip-deploy] [--skip-release] [--start-from <issue-number>] [--rounds <N>] [--repo ORG/REPO]`



## Quick Start

/stark-phase-execute

## Common Patterns



## Troubleshooting



## Related Skills


