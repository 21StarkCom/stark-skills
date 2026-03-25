# stark-session — Internals

Session management — start and end modes. Start: loads context, git state, health checks, briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json hierarchy. Use when the user says "session start", "session end", "start session", "end session", "what was I working on", "catch me up", or invokes /stark-session.

## Architecture

```mermaid
graph TD
  Invoke([User invokes /stark-session]) --> ParseArgs{Argument?}
  
  ParseArgs -->|start / none| StartInit[START MODE: Init]
  ParseArgs -->|end| EndInit[END MODE: Init]

  subgraph Start Mode Flow
    StartInit --> GatherContext[1. Gather Context<br>CLAUDE.md, Memory, Config]
    GatherContext --> GitState[2. Analyze Git State<br>Branch, status, PRs, GH Board]
    GitState --> HealthCheck[3. Health Checks<br>Run config.health_checks]
    HealthCheck --> FindSkills[4. Find Skills<br>Scan .claude/skills/]
    FindSkills --> Briefing[5. Print Briefing<br>Ask 'What are we working on?']
  end

  subgraph End Mode Flow
    EndInit --> RunTests[1. Test & Build<br>Run config commands]
    RunTests --> MergePRs[2. Merge PRs<br>gh pr merge strategy]
    MergePRs --> CommitDocs[3. Commit Docs<br>Stage docs/, write devlog]
    CommitDocs --> UpdateProject[4. Update Project Board<br>Doc State -> Drafted]
    UpdateProject --> GitPush[5. Push<br>git push upstream]
    GitPush --> Summary[6. Print Summary<br>Metrics & outputs]
  end

  Briefing --> Done([Session Active])
  Summary --> Complete([Session Closed])
  
  RunTests -.->|Fail| AskProceed1{Proceed?}
  AskProceed1 -.->|Yes| MergePRs
  
  MergePRs -.->|Fail| AskProceed2{Skip?}
  AskProceed2 -.->|Yes| CommitDocs
```

![An HTML dashboard visualizing the internals of the stark-session engineering skill, including start/end mode execution flowcharts, config hierarchy mapping, parameter tables, and failure recovery protocols.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-session/SKILL.md`, then run `/stark-generate-docs --skill stark-session` to regenerate documentation.
