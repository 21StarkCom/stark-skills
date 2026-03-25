# stark-review-improvement — Internals

Improve stark-skills prompts based on the Prompt Improvement Assessment from a completed /stark-review run. Reads the assessment from conversation context (or history files), edits the relevant prompt files in ~/git/Evinced/stark-skills/, patches multi_review.py if needed, and logs the learning. Use when the user says "improve review prompts", "start review improvement", "fix review prompts", or invokes /stark-review-improvement.

## Architecture

```mermaid
graph TD
    Start((Start)) --> FindAssessment[Phase 1: Extract Assessment]
    FindAssessment -->|Context or History| ParseItems[Parse into Action Items]
    FindAssessment -.->|Not Found| Error[Throw Error]
    
    ParseItems --> Classify[Classify: Prompt, Orchestrator, Config, No-Action]
    Classify --> Confirm{Confirm with User}
    
    Confirm -- User Approves --> ApplyEdits[Phase 2: Apply Changes]
    ApplyEdits --> EditPrompt[/Prompt Edits .md/]
    ApplyEdits --> EditScript[/Orchestrator Edits .py/]
    ApplyEdits --> EditConfig[/Config Edits .json/]
    
    EditPrompt --> Validate[Phase 3: Validate]
    EditScript --> Validate
    EditConfig --> Validate
    
    Validate -->|Syntax, Compile, JSON, Diff| LogLearning[Phase 4: Log Learning]
    
    LogLearning --> AppendChangelog[Append to CHANGELOG.md]
    LogLearning --> CopyHistory[Copy assessment to history]
    
    AppendChangelog --> Commit[Phase 5: Commit Local Changes]
    CopyHistory --> Commit
    
    Commit --> End((End))
```

![A visualization diagram and architectural breakdown for the stark-review-improvement skill, showing a 5-phase execution flow from extracting assessments to parsing actions, applying minimal edits to prompts/scripts/config, validating syntax, logging to a changelog, and generating a local commit.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review-improvement/SKILL.md`, then run `/stark-generate-docs --skill stark-review-improvement` to regenerate documentation.
