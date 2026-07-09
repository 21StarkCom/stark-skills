---
name: stark-review-spec-improvement
description: >-
  Improve spec review prompts from assessment feedback. Wraps /stark-review-improvement for spec-review prompts.
argument-hint: (reads assessment from context or spec-review history)
disable-model-invocation: true
model: opus
revision: ea7268a18edb159e040db78148f2ab9cb324d76a
revision_date: 2026-05-03T06:43:43Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-review-spec-improvement

Improve spec review prompts based on assessment feedback from `/stark-review-spec` runs.

This is a wrapper around `/stark-review-improvement` that:
1. Sets `--prompts-dir spec-review` (targets `global/prompts/spec-review/{agent}/`)
2. Looks for assessments in `~/.claude/code-review/history/spec-reviews/` or in conversation context (the "Prompt Improvement Assessment" section from a `/stark-review-spec` run)
3. Uses `tools/stark_review_doc.ts` as the orchestrator (not `multi_review.ts`)

## Usage

```
/stark-review-spec-improvement
```

Typically invoked after a `/stark-review-spec` run that produced a Prompt Improvement Assessment with actionable recommendations.

## How It Works

### Step 1: Find the assessment

Look in the current conversation context for a "Prompt Improvement Assessment" section from a `/stark-review-spec` run. The assessment typically looks like:

```markdown
## Prompt Improvement Assessment

| Signal | Level | File | Recommendation |
|--------|-------|------|----------------|
| Scope creep noise | Global | spec-review/*/03-scope.md | Add calibration instruction |
| ...    | ...   | ...  | ...            |
```

If not in context, check the most recent spec review history:
```bash
ls -td ~/.claude/code-review/history/spec-reviews/*/ | head -1
```

If the assessment also appears in a `*.spec-review.md` file alongside the spec doc, read the "Prompt Improvement Assessment" section from that file.

### Step 2: Delegate to /stark-review-improvement

Invoke `/stark-review-improvement --prompts-dir spec-review` with the extracted assessment. This resolves all prompt paths to `global/prompts/spec-review/{agent}/` and uses `tools/stark_review_doc.ts --prompts-dir spec-review` as the orchestrator.

### Step 3: Spec-review-specific context

When the delegated skill presents action items for confirmation, add context about the spec review pipeline:

- **Domain prompts**: shared domains `01-completeness.md` through `06-consistency.md` live at `global/prompts/spec-review/domains/`; only `07-accessibility.md` and `08-test-plan.md` are per-agent at `global/prompts/spec-review/{claude,codex,gemini}/`
- **Agent preamble** is at `global/prompts/spec-review/{agent}/agent.md`
- **Dispatch script** is `tools/stark_review_doc.ts` (invoked `--prompts-dir spec-review`, not `multi_review.ts`)
- **8 domains:** completeness, security, scope, api-design, data-modeling, consistency, accessibility, test-plan

### Common spec review improvements

These patterns appear frequently in spec review assessments:

| Pattern | Prompt to edit | Fix |
|---------|---------------|-----|
| Scope creep (agents flag Phase 2 / future work) | `03-scope.md` (all agents) | Add: "Only flag items within the spec's stated v1 scope" |
| Cross-domain duplicates (same finding in 3+ domains) | `agent.md` (all agents) | Add: "Defer findings to the primary domain" |
| One agent noisier than others | Agent-specific `agent.md` | Tighten severity: "high = blocks implementation or production risk" |
| Scale critique on low-volume system | Relevant domain prompt | Add: "Consider stated traffic volume before flagging" |
| Missing features that are explicitly out of scope | `01-completeness.md` | Add: "Only flag omissions within stated scope" |
| Repeated findings about same design pattern | `agent.md` | Add max-findings guidance or severity floor |

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No assessment in context or history | "Run /stark-review-spec first, then invoke this skill" |
| Assessment has no actionable items | Report "No actionable improvements found" and exit |
| /stark-review-improvement not available | Error — skill dependency missing |
