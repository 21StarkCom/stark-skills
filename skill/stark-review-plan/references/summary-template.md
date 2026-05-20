# Summary Template (Phase 4)

Generate a consolidated markdown summary with these sections.

## Dispatch Failure Template

**If dispatch failure occurred**, use this template instead of the normal summary:

```markdown
## Plan Review -- Dispatch Failure

**File:** {path}
**Status:** Review could not complete -- {succeeded}/{total} sub-agents succeeded.

### Error Details
| Agent | Domain | Error | Stderr (truncated) |
|-------|--------|-------|-------------------|
(one row per failed sub-agent from the dispatch JSON)

### Diagnostics
- CLI availability: claude={yes/no}, codex={yes/no}, gemini={yes/no}
- Single-agent probe: {result of diagnostic dispatch}

### Recommendation
{e.g., "Check API keys/auth", "CLI not installed", "Network issue"}
```

## Normal Summary Sections

### 4a. Headline Counts

**Issues and noise are counted separately.** The headline reflects only real issues.

```markdown
**Issues found:** {fix + recurring count} | **Noise:** {noise + false_positive count} | **Ignored:** {ignored count}
**Signal-to-noise:** {issues / (issues + noise) * 100}%
```

- **Issues** = findings classified as `fix` or `recurring` (real problems in the plan)
- **Noise** = `false_positive` or `noise` (not real problems -- do not count as issues)
- **Ignored** = below fix_threshold

### 4b. All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|

### 4c. Fixed -- findings addressed, grouped by round.

### 4d. Recurring -- findings in 2+ rounds. Which round resolved them.

### 4e. Unresolved -- findings from the final round that remain.

### 4f. Noise & False Positives -- one-line reasoning per finding.

### 4g. Misalignment Analysis

For each noise/false_positive finding, analyze **why** the reviewer flagged it and what context was missing. Group into root causes:

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Missing context in spec/plan** | N | Spec didn't explain rationale for choice X -> add a "## Rationale" or "## Design Decisions" section |
| **Overly aggressive prompt** | N | Domain prompt flags pattern X which is valid for this plan type -> tune prompt |
| **Scope mismatch** | N | Reviewer applied production-system criteria to dev tooling -> add context-awareness to prompt |
| **Already addressed elsewhere** | N | Finding refers to something covered in a different section -> improve cross-references in the plan |

For each root cause, provide a concrete action: what to add to the plan, which prompt to tune, or what config to change.

### 4h. Coverage Matrix

Maps the deployment-plan failure vectors (A-J) to the 4 adversarial domains. Populated from actual findings. See [domain-definitions.md](domain-definitions.md) for the full vector table.

### 4i. Changes Made

Diff of plan changes across all fix rounds. Compare `original_content` with current file content.

### 4j. Prompt Improvement Assessment

Analyze patterns across all rounds:

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Agent X false positives in domain Y across plans | **Global** | `global/prompts/plan-review/{agent}/{domain}.md` |
| Agent X false positives only for this repo | **Repo** | `{repo}/.code-review/plan-prompts/{agent}/{domain}.md` |
| All agents miss same issue found during fixing | **Global** (all agents) | `global/prompts/plan-review/*/{domain}.md` |
| Findings irrelevant to plan type | **Repo config** | `disabled_domains` in config |

Recommend only -- do NOT modify prompts.
