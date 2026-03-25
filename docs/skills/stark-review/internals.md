# stark-review — Internals

Multi-agent PR code review using 3 LLMs × N domains with autonomous fix loop. Use when the user says "stark review", "review this PR with all agents", "multi-agent review", or invokes /stark-review. Also triggers on `/stark-review` or `/stark-review <number>`.

## Architecture

```mermaid
graph TD
    A[Start: stark-review] --> B{Determine Mode}
    B -->|Review Only| C[Setup Basic Env]
    B -->|Full Mode| D[Create Isolated Git Worktree]
    D --> E[Capture Baseline Failures]
    
    C --> F[Phase 2: Review Dispatch]
    E --> F
    
    subgraph Phase 2: Autonomous Fix Loop
        F -->|multi_review.py| G1(Claude x 6 Domains)
        F -->|multi_review.py| G2(Codex x 6 Domains)
        F -->|multi_review.py| G3(Gemini x 6 Domains)
        
        G1 --> H[Classify Findings JSON]
        G2 --> H
        G3 --> H
        
        H --> I{Actionable?}
        I -->|Noise/Ignored| J[Track for Analysis]
        I -->|Fix/Recurring| K[Edit Code in Worktree]
        
        K --> L[Build & Test Validation]
        L --> M{Regressions?}
        M -->|Yes| N[Attempt Fix x3]
        N --> L
        M -->|No| O[Commit & Push]
    end
    
    O --> P{Max Rounds OR Clean?}
    P -->|Next Round| F
    P -->|Stop| Q
    
    J --> Q[Phase 3: Final Summary Generation]
    Q --> R[Phase 4: Post Comments & Create Issues]
    R --> S[Phase 5: Cleanup Worktree]
    S --> T[End & Render Observability Metrics]
```

![Architecture and data flow visualization of the stark-review skill showing the multi-agent PR review process, including setup, the autonomous review-fix loop across 3 LLMs in isolated worktrees, noise classification, summary generation, and GitHub issue creation phases.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review/SKILL.md`, then run `/stark-generate-docs --skill stark-review` to regenerate documentation.
