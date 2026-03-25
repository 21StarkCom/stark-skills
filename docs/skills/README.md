# Skill Routing Guide

Which skill should I use? Follow the decision trees below.

## Code Review

### I want to...

```mermaid
graph TD
    A{What are you reviewing?} -->|PR code| B[stark-review]
    A -->|Design doc / plan| C[stark-review-plan]
    A -->|Infra / deployment plan| D[stark-review-deployment-plan]
    A -->|Improve review prompts| E[stark-review-improvement]
```

- **`/stark-review`** — *(not installed)*
- **`/stark-review-plan`** — *(not installed)*
- **`/stark-review-deployment-plan`** — *(not installed)*
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

- **[`/stark-metrics`](stark-metrics/usage.md)** — Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.
- **`/stark-skill-analytics`** — *(not installed)*
- **`/stark-pr-status`** — *(not installed)*
