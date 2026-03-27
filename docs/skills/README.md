# Skill Routing Guide

Which skill should I use? Follow the decision trees below.

## Code Review

### I want to...

```mermaid
graph TD
    A{What are you reviewing?} -->|PR code| B[stark-review]
    A -->|Design / architecture doc| C[stark-review-design]
    A -->|Execution / deployment plan| D[stark-review-plan]
    A -->|Improve review prompts| E[stark-review-improvement]
```

- **`/stark-review`** — *(not installed)*
- **`/stark-review-design`** — *(not installed)*
- **`/stark-review-plan`** — *(not installed)*
- **`/stark-review-improvement`** — *(not installed)*

## PR & Shipping

### I want to...

```mermaid
graph TD
    A{What do you need?} -->|Push + create + review + merge| B[stark-pr-flow]
    A -->|Cut a versioned release| C[stark-release]
```

- **`/stark-pr-flow`** — *(not installed)*
- **`/stark-release`** — *(not installed)*

## Planning

### I want to...

```mermaid
graph TD
    A{Starting or continuing?} -->|Break plan into issues| B[stark-plan-to-tasks]
    A -->|Execute a phase end-to-end| C[stark-phase-execute]
```

- **`/stark-plan-to-tasks`** — *(not installed)*
- **`/stark-phase-execute`** — *(not installed)*

## Session

### I want to...

```mermaid
graph TD
    A{Session lifecycle} -->|Start or end a work session| B[stark-session]
    A -->|Analyze past session patterns| C[stark-session-insights]
```

- **`/stark-session`** — *(not installed)*
- **`/stark-session-insights`** — *(not installed)*

## Documentation

### I want to...

```mermaid
graph TD
    A{What kind of docs?} -->|Scaffold docs structure| B[stark-init-docs]
    A -->|Extract knowledge from specs| C[stark-extract-docs]
    A -->|Generate skill HTML/MD docs| D[stark-generate-docs]
    A -->|Improve CLAUDE.md| E[stark-claude-md-improver]
```

- **`/stark-init-docs`** — *(not installed)*
- **`/stark-extract-docs`** — *(not installed)*
- **`/stark-generate-docs`** — *(not installed)*
- **`/stark-claude-md-improver`** — *(not installed)*

## Project Management

### I want to...

```mermaid
graph TD
    A{Project task?} -->|Bootstrap new project| B[stark-onboard-project]
    A -->|Rename project + refs| C[stark-rename-project]
    A -->|Audit & update deps| D[stark-update-deps]
```

- **`/stark-onboard-project`** — *(not installed)*
- **`/stark-rename-project`** — *(not installed)*
- **`/stark-update-deps`** — *(not installed)*

## Analytics

### I want to...

```mermaid
graph TD
    A{What metrics?} -->|Review performance| B[stark-metrics]
    A -->|Skill usage & adoption| C[stark-skill-analytics]
    A -->|PR analytics dashboard| D[stark-pr-status]
```

- **`/stark-metrics`** — *(not installed)*
- **`/stark-skill-analytics`** — *(not installed)*
- **`/stark-pr-status`** — *(not installed)*

## Other Skills

- **[`/stark-design`](stark-design/usage.md)** — Use this skill when the user wants to create a design document, spec, or architecture doc from requirements, a feature description, or a high-level prompt. Triggers whenever someone needs to go from an idea or set of requirements to a formal design. Covers requests like "design this feature", "write a spec for", "create an architecture doc", "I need a design document for", or any variation where input is requirements/prompt and desired output is a design/spec document. Also triggers on `/stark-design <prompt-or-path>`. Works by dispatching 3 independent AI agents to each produce a design, then cross-reviewing all designs to synthesize the best one. This is the natural first step before design review (`/stark-review-design`).
