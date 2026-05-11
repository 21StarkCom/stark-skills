# stark-review-improvement — Internals

Improve stark-skills prompts based on the Prompt Improvement Assessment from a completed /stark-review run. Reads the assessment from conversation context (or history files), edits the relevant prompt files in ~/Code/Playground/stark-skills/, patches multi_review.py if needed, and logs the learning. Use when the user says "improve review prompts", "start review improvement", "fix review prompts", or invokes /stark-review-improvement.

## Architecture

```mermaid

```

![A clean internal architecture page titled “stark-review-improvement” showing a vertical workflow from assessment extraction through user approval, targeted prompt or orchestrator edits, validation, changelog logging, and local commit. Blue nodes mark workflow phases, purple nodes mark decisions, green nodes mark editable system layers, amber nodes mark outputs, gray nodes show external inputs like conversation context and history files, and a red node shows the failure path when no assessment is found. Below the flow are tables and cards explaining write targets, data-source resolution order, mutation boundaries, extension points, and failure safeguards for the prompt-improvement loop."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review-improvement/SKILL.md`, then run `/stark-generate-docs --skill stark-review-improvement` to regenerate documentation.
