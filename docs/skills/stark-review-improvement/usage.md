# stark-review-improvement

Improve stark-skills prompts based on the Prompt Improvement Assessment from a completed /stark-review run. Reads the assessment from conversation context (or history files), edits the relevant prompt files in ~/git/Evinced/stark-skills/, patches multi_review.py if needed, and logs the learning. Use when the user says "improve review prompts", "start review improvement", "fix review prompts", or invokes /stark-review-improvement.

## Workflow Overview

```mermaid
graph TD
    A[Start: Invocation] --> B{Context holds Assessment?};
    B -- Yes --> C[Extract Action Items];
    B -- No --> B2[Search ~/.claude/code-review/history];
    B2 --> C;
    C --> D[Classify Actions: Prompt, Script, Config];
    D --> E((User Confirmation));
    E -- Approves Actions --> F[Apply Targeted Changes];
    F --> G[Run Automated Validation];
    G --> H[Show Git Diff to User];
    H --> I[Append to prompt-changelog.md];
    I --> J[Git Commit];
    J --> K[End];
```

![Visualization of the stark-review-improvement skill showing the workflow from extracting an assessment, confirming changes with the user, applying targeted edits to prompts and configurations, to validating and committing the improvements.](usage.png)

## When to Use

Improve stark-skills prompts based on the Prompt Improvement Assessment from a completed /stark-review run. Reads the assessment from conversation context (or history files), edits the relevant prompt files in ~/git/Evinced/stark-skills/, patches multi_review.py if needed, and logs the learning. Use when the user says "improve review prompts", "start review improvement", "fix review prompts", or invokes /stark-review-improvement.

## Prerequisites

*See SKILL.md*

## Arguments

`(reads assessment from context or latest history)`



## Quick Start

/stark-review-improvement

## Common Patterns



## Troubleshooting



## Related Skills


