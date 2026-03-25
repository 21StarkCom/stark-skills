# stark-pr-flow — Internals

End-to-end PR workflow for GetEvinced repos — push, create PR, post self-review via stark-claude bot, present summary, and squash-merge with --admin on approval. Use when the user says "open PR", "create PR", "merge this", "ship it", or "stark-pr-flow".

## Architecture

```mermaid
graph TD
    subgraph Initialization ["Pre-flight Checks"]
        A[Check Branch != main] --> B[Check Clean Working Tree]
    end
    
    B --> C[git push -u origin BRANCH]
    C -. diverged .-> D[fetch & rebase origin/main]
    D --> C
    
    C --> E[Analyze Changes via git diff]
    E --> F[Generate Title & PR Body]
    
    subgraph PR_Creation ["PR Creation (User PAT Auth)"]
        F --> G[gh pr create]
        G --> H(Capture PR_NUM)
    end
    
    subgraph Bot_Review ["Code Review (Bot App Token)"]
        I[github_app.py GET Token] --> J[stark_claude.py Diff Review]
        H --> J
        J --> K[Post Comment as stark-claude bot]
    end
    
    subgraph Approval_Gate ["Evaluation & Approval"]
        K --> L[Advisory: Check Docs State via GraphQL]
        L --> M{Present Summary: Await Explicit Approval}
    end
    
    M -- "Approved" --> N[gh pr merge --squash --admin]
    M -- "Rejected" --> O[Leave PR Open / Close]
    M -- "Changes Req" --> P[User Applies Changes -> Loop]
    
    N --> Q[git checkout main & pull]
    Q --> R[Delete branch local & remote]
```

![Internal architecture visualization of the stark-pr-flow skill showing the dual-auth GitHub workflow, transitioning from branch prerequisites and PR generation using the user's PAT, through bot-authenticated automated code reviews, to a final user approval gate for administrative squash merging.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-pr-flow/SKILL.md`, then run `/stark-generate-docs --skill stark-pr-flow` to regenerate documentation.
