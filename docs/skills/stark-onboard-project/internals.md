# stark-onboard-project — Internals

Bootstrap a new project end-to-end — initializes git, creates a GitHub repo in GetEvinced org, connects all 3 GitHub Apps (stark-claude, stark-codex, stark-gemini), then sets up Claude Code (CLAUDE.md, .claude/ directory, memory). Use when the user says "onboard project", "setup claude", "bootstrap claude", "init project", "create repo", "new project", or "stark-onboard-project". Also use when starting work in a directory that has no git repo and no CLAUDE.md.

## Architecture

```mermaid
graph TD
    Start([Start stark-onboard-project]) --> CheckGit{Is Git Initialized?}
    CheckGit -- No --> InitGit[git init & initial commit]
    CheckGit -- Yes --> CheckGH{Remote Exists?}
    InitGit --> CheckGH
    CheckGH -- No --> PromptDetails[Prompt user for Repo details]
    PromptDetails --> CreateRepo[gh repo create]
    CreateRepo --> AddCodeowners[Create CODEOWNERS]
    CheckGH -- Yes --> CheckApps{Are Apps Connected?}
    AddCodeowners --> CheckApps
    CheckApps -- No --> LinkApps[Link stark-claude, codex, gemini apps]
    LinkApps --> CheckClaude{CLAUDE.md exists?}
    CheckApps -- Yes --> CheckClaude
    CheckClaude -- No --> ScanProject[Scan project deps & generate CLAUDE.md]
    ScanProject --> MkdirClaude[Create .claude/ directory]
    CheckClaude -- Yes --> Finish([End Summary])
    MkdirClaude --> Finish
```

![A technical flowchart and architecture visualization for the stark-onboard-project skill, detailing git initialization, GitHub repository creation, GitHub App connections, and Claude Code bootstrapping, with failure modes and observability metrics.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-onboard-project/SKILL.md`, then run `/stark-generate-docs --skill stark-onboard-project` to regenerate documentation.
