---
name: stark-review-design-improvement
description: >-
  Improve design review prompts from assessment feedback. Wraps /stark-review-improvement for design-review prompts.
argument-hint: (reads assessment from context or design-review history)
disable-model-invocation: true
model: opus
revision: ea7268a18edb159e040db78148f2ab9cb324d76a
revision_date: 2026-05-03T06:43:43Z
---

# stark-review-design-improvement

Improve design/spec review prompts based on assessment feedback from `/stark-review-design` runs.

This is a wrapper around `/stark-review-improvement` that:
1. Sets `--prompts-dir design-review` (targets `global/prompts/design-review/{agent}/`)
2. Looks for assessments in `~/.claude/code-review/history/design-reviews/` or in conversation context (the "Prompt Improvement Assessment" section from a `/stark-review-design` run)
3. Uses `tools/stark_review_doc.ts` as the orchestrator (not `multi_review.ts`)

## Usage

```
/stark-review-design-improvement
```

Typically invoked after a `/stark-review-design` run that produced a Prompt Improvement Assessment with actionable recommendations.

## How It Works

### Step 1: Find the assessment

Look in the current conversation context for a "Prompt Improvement Assessment" section from a `/stark-review-design` run. The assessment typically looks like:

```markdown
## Prompt Improvement Assessment

| Signal | Level | File | Recommendation |
|--------|-------|------|----------------|
| Scope creep noise | Global | design-review/*/03-scope.md | Add calibration instruction |
| ...    | ...   | ...  | ...            |
```

If not in context, check the most recent design review history:
```bash
ls -td ~/.claude/code-review/history/design-reviews/*/ | head -1
```

If the assessment also appears in a `*.design-review.md` file alongside the design doc, read the "Prompt Improvement Assessment" section from that file.

### Step 2: Delegate to /stark-review-improvement

Invoke `/stark-review-improvement --prompts-dir design-review` with the extracted assessment. This resolves all prompt paths to `global/prompts/design-review/{agent}/` and uses `tools/stark_review_doc.ts --prompts-dir design-review` as the orchestrator.

### Step 3: Design-review-specific context

When the delegated skill presents action items for confirmation, add context about the design review pipeline:

- **Domain prompts**: shared domains `01-completeness.md` through `06-consistency.md` live at `global/prompts/design-review/domains/`; only `07-accessibility.md` and `08-test-plan.md` are per-agent at `global/prompts/design-review/{claude,codex,gemini}/`
- **Agent preamble** is at `global/prompts/design-review/{agent}/agent.md`
- **Dispatch script** is `tools/stark_review_doc.ts` (invoked `--prompts-dir design-review`, not `multi_review.ts`)
- **8 domains:** completeness, security, scope, api-design, data-modeling, consistency, accessibility, test-plan

### Common design review improvements

These patterns appear frequently in design review assessments:

| Pattern | Prompt to edit | Fix |
|---------|---------------|-----|
| Scope creep (agents flag Phase 2 / future work) | `03-scope.md` (all agents) | Add: "Only flag items within the design's stated v1 scope" |
| Cross-domain duplicates (same finding in 3+ domains) | `agent.md` (all agents) | Add: "Defer findings to the primary domain" |
| One agent noisier than others | Agent-specific `agent.md` | Tighten severity: "high = blocks implementation or production risk" |
| Scale critique on low-volume system | Relevant domain prompt | Add: "Consider stated traffic volume before flagging" |
| Missing features that are explicitly out of scope | `01-completeness.md` | Add: "Only flag omissions within stated scope" |
| Repeated findings about same design pattern | `agent.md` | Add max-findings guidance or severity floor |

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No assessment in context or history | "Run /stark-review-design first, then invoke this skill" |
| Assessment has no actionable items | Report "No actionable improvements found" and exit |
| /stark-review-improvement not available | Error — skill dependency missing |
