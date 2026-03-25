# stark-phase-execute — Internals

Autonomously execute all tasks in a development phase end-to-end — for each task: session start, implement, PR, multi-agent review with fix rounds, merge, session end. Then regression tests, version bump, deploy, dashboard, memory/docs update, and prompt improvement detection. Zero user intervention after trigger. If no GitHub issues exist for the plan slug, automatically runs /stark-plan-to-tasks first to decompose the plan into issues, then executes them. Use when the user says "execute phase", "run phase", "stark-phase-execute", "execute these tasks", "implement this phase", "run the plan", "autopilot", or any variation of wanting to autonomously execute a set of planned GitHub issues. Also triggers on `/stark-phase-execute`. Proactively suggest this skill when the user has just run `/stark-plan-to-tasks` and has open phase issues, OR when a plan file exists but hasn't been decomposed yet.

## Architecture

```mermaid
graph TD
    A[Start: stark-phase-execute] --> B[Phase 0: Check Env & Git State]
    B --> C{Fetch Tasks <br> Project V2 / Labels}
    
    C -->|0 Tasks Found| D[Locate PLAN_FILE in docs/]
    D --> E[Run /stark-plan-to-tasks]
    E --> C
    
    C -->|> 0 Tasks Found| F[Phase 1: Task Loop Starts]
    
    F --> G[Git Checkout & Pull Main]
    G --> H[Create task branch]
    H --> I[Subagent: Implement Issue Body]
    I --> J[Git Push & Create PR]
    
    J --> K[Setup Review Worktree]
    K --> L[multi_review.py --dry-run]
    L --> M{Findings >= Medium?}
    
    M -->|Yes| N[Fix Findings & Test]
    N --> O[Commit & Push]
    O --> P{Rounds < MAX?}
    P -->|Yes| L
    
    M -->|No Findings| Q[Teardown Worktree]
    P -->|No| Q
    
    Q --> R[Post Review Summary to PR]
    R --> S[Squash Merge PR]
    S --> T[Close GitHub Issue]
    
    T --> U{More Tasks?}
    U -->|Yes| F
    
    U -->|No| V[Phase 2: Regression Tests]
    V --> W[Phase 3: Update CHANGELOG & /stark-release]
    W --> X[Deploy App]
    X --> Y[Phase 4 & 5: Dashboard, Memory & Docs]
    Y --> Z[End]

    style A fill:#1e40af,color:#fff
    style Z fill:#047857,color:#fff
    style E fill:#047857,color:#fff
    style L fill:#7c3aed,color:#fff
```

![Architectural flow diagram of the stark-phase-execute skill showing the autonomous pipeline from phase initialization, through a task-by-task implementation and multi-agent review loop, ending with regression testing, deployment, and observability dashboard generation.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-phase-execute/SKILL.md`, then run `/stark-generate-docs --skill stark-phase-execute` to regenerate documentation.
