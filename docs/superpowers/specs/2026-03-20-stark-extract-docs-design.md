# stark-extract-docs Skill Design

**Date:** 2026-03-20
**Status:** Draft (rev 1)
**Author:** Aryeh + Claude

## Overview

Skill that takes a spec/design document and its associated artifacts (plan, review files), extracts durable knowledge into project documentation, and generates review retrospectives. Two-pass architecture: Pass 1 extracts knowledge into a structured intermediate format, Pass 2 routes it to the right doc types and locations.

Serves three consumers: human engineers (onboarding context), AI review agents (stop re-flagging resolved decisions), and future research/learning (process patterns, agent behavior analysis).

## Inputs

**Invocation:**

```
/stark-extract-docs <path-to-spec>                    # single spec
/stark-extract-docs --batch docs/specs/                # retroactive — all specs in a directory
/stark-extract-docs --batch docs/superpowers/specs/    # works on any spec directory
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `<path-to-spec>` | Yes (unless `--batch`) | Path to a spec/design document |
| `--batch <dir>` | No | Process all `*-design.md` files in a directory |
| `--dry-run` | No | Extract and show intermediate format, don't write files |
| `--no-commit` | No | Write files but don't commit |
| `--target-repo <org/repo>` | No | Override target repo detection |

**Input resolution:** Given a spec path, the skill locates associated artifacts by naming convention:

| Input spec | Associated plan | Spec review | Plan review |
|-----------|----------------|-------------|-------------|
| `docs/specs/YYYY-MM-DD-foo-design.md` | `docs/plans/YYYY-MM-DD-foo.md` | `docs/specs/YYYY-MM-DD-foo-design.review.md` | `docs/plans/YYYY-MM-DD-foo.review.md` |
| `docs/superpowers/specs/YYYY-MM-DD-foo-design.md` | `docs/superpowers/plans/YYYY-MM-DD-foo.md` | `docs/superpowers/specs/YYYY-MM-DD-foo-design.review.md` | `docs/superpowers/plans/YYYY-MM-DD-foo.review.md` |

All associations are optional. A spec with no review still has ADR-worthy decisions. A spec with no plan still has architecture knowledge. The skill works with whatever exists.

**Target repo:** Parse the spec for repo references, fall back to `git remote -v`. Extracted docs go into the target project's `docs/`, not stark-review's. The `--target-repo` flag overrides detection.

**Batch mode:** Iterates over all `*-design.md` files in the given directory, runs extraction on each, deduplicates across specs at the end.

## Two-Pass Architecture

| Pass | Purpose | Input | Output |
|------|---------|-------|--------|
| 1. Knowledge Extraction | Find all durable knowledge in the artifacts | Spec + plan + review files | Structured intermediate JSON |
| 2. Routing & Generation | Route knowledge to the right doc types and locations | Intermediate JSON + target project's doc structure | ADRs, retrospectives, reference docs, glossary, learning log |

## Execution Phases

### Phase 1: Setup

- Read the spec file. Fail if it doesn't exist or is empty.
- Locate associated artifacts (plan, spec review, plan review) by convention. Log which were found, which are missing.
- Detect target repo: parse spec for repo references, fall back to `git remote -v`.
- Read target project's `docs/` tree structure (for routing decisions in Pass 2).
- Read existing ADRs (for numbering and deduplication).
- Read existing `docs/retrospectives/learning-log.md` if it exists (for append).

### Phase 2: Pass 1 — Knowledge Extraction

The LLM reads all available artifacts for a spec and extracts knowledge into a structured intermediate format. This pass answers: **"what knowledge is in here?"** without deciding where it goes.

**Extraction categories:**

| Category | Source signal | Example |
|----------|-------------|---------|
| `decision` | Architectural choices in spec; design principles; technology selections | "CLAUDE.md merge pattern for config hierarchy — same mental model developers already use" |
| `decision_defended` | "Intentional Design Choices" tables in reviews; findings classified as intentional/noise/over-engineering across rounds | "No rollback runbook — rare operation, git history is sufficient" |
| `constraint` | Non-goals, performance budgets, security requirements, compliance | "No GitHub Enterprise support — only github.com is used" |
| `integration` | API contracts, data flows, component interfaces, webhook/event contracts | "GitHub App auth via github_app.py --app \<name\> token, PEM in keychain" |
| `data_model` | Entity definitions, schemas, config formats | "RunRecord schema with timing, agents, findings fields" |
| `evolution` | "Fixed Across Rounds" sections — how the design changed through review | "Round 1→2: added input validation, resumable execution, step reordering" |
| `agent_signal` | Prompt improvement assessments, agent failure patterns, domain noise | "Codex consistently times out 3/4 rounds; Gemini:scope returns parse_error 3/4 rounds" |
| `glossary` | Domain terms defined or used with specific meaning | "Domain IDs are slugs derived from filenames: 01-architecture.md → architecture" |

**Output schema:**

```json
{
  "spec_path": "docs/superpowers/specs/2026-03-19-rename-project-design.md",
  "associated_artifacts": [
    "docs/superpowers/plans/2026-03-19-rename-project.md",
    "docs/superpowers/specs/2026-03-19-rename-project-design.review.md",
    "docs/superpowers/plans/2026-03-19-rename-project.review.md"
  ],
  "extractions": [
    {
      "category": "decision_defended",
      "title": "No rollback runbook for rename operations",
      "content": "Rare operation; git history + resume logic is sufficient recovery path",
      "evidence": "Flagged by all 3 agents across 3 rounds, consistently classified as over-engineering",
      "source": "rename-project-design.review.md → Intentional Design Choices table",
      "confidence": "high"
    },
    {
      "category": "agent_signal",
      "title": "Codex operability prompts over-weight enterprise rollback patterns",
      "content": "All agents fixate on rollback/journal mechanisms for simple specs. Codex especially persistent.",
      "evidence": "rename-project spec + plan reviews, 3/4 rounds",
      "source": "rename-project-design.review.md → Prompt Improvement Assessment",
      "confidence": "high"
    }
  ]
}
```

If `--dry-run`: print the intermediate format and exit.

### Phase 3: Pass 2 — Routing & Generation

Takes the intermediate extractions and routes each to the right document type and location. This pass answers: **"where does this knowledge live durably?"**

**Routing rules:**

| Category | Target doc type | Location | Format |
|----------|----------------|----------|--------|
| `decision` | ADR | `docs/adr/NNNN-<slug>.md` | ADR template (Context, Decision, Alternatives, Consequences) |
| `decision_defended` | ADR | `docs/adr/NNNN-<slug>.md` | Same template — Context includes the review challenge, Decision includes the rationale for holding |
| `constraint` | ADR or append | `docs/adr/` or existing constraint doc | ADR if standalone decision; append if qualifier on existing doc |
| `integration` | Reference doc | `docs/reference/<component>.md` | Markdown with endpoints/contracts/auth patterns |
| `data_model` | Reference doc | `docs/reference/<entity>.md` | Markdown with schema, fields, relationships |
| `evolution` | Review retrospective | `docs/retrospectives/YYYY-MM-DD-<slug>.md` | Structured retrospective |
| `agent_signal` | Retrospective + learning log | Retrospective + `docs/retrospectives/learning-log.md` | Detail in retro, one-liner in log |
| `glossary` | Glossary | `docs/glossary.md` | Definition list, created if missing, appended if exists |

**ADR numbering:** Read existing `docs/adr/` to find the highest `NNNN`, continue from there. If no `docs/adr/` exists, start at `0001`. Related decisions from the same spec get sequential numbers.

**ADR deduplication:** Before creating an ADR, scan existing ADRs for title similarity. If a substantially similar decision already exists, skip and log the duplicate. In batch mode this prevents the same pattern from generating duplicate ADRs across specs.

**ADR format:** Uses the project's ADR template if one exists (`docs/adr/0000-template.md`), otherwise uses the standard template:

```markdown
# NNNN: Title

**Date:** YYYY-MM-DD
**Status:** Accepted

## Context
<!-- Situation requiring a decision. For defended decisions: includes the review challenge. -->

## Decision
<!-- What was decided and why. -->

## Alternatives Considered
<!-- What else was considered. For defended decisions: the alternative the reviewers advocated. -->

## Consequences
<!-- What follows. Both positive and negative. -->
```

**Retrospective format:**

```markdown
# Review Retrospective — <spec name>

**Spec:** `<path>`
**Date:** YYYY-MM-DD
**Review rounds:** N fix + M final

## Design Evolution

What changed through the review process and why.

| Round | Change | Trigger |
|-------|--------|---------|
| 1→2 | Added input validation | 3/3 agents flagged missing validation |
| 2→3 | Custom lookarounds for hyphenated names | Claude identified \b limitation |

## Decisions Defended

Design choices that were challenged by reviewers and held.

| Decision | Challenge | Rationale |
|----------|-----------|-----------|
| No rollback runbook | All agents, 3 rounds | Rare operation; git history sufficient |

## Agent Performance

| Agent | Domain | Signal | Notes |
|-------|--------|--------|-------|
| Claude | All | Strong | Consistent, well-scoped findings |
| Codex | Operability | Noise | Fixated on enterprise rollback patterns |
| Gemini | Scope | Failed | parse_error 3/4 rounds |

## Prompt Improvement Candidates

Signals that should feed into `stark-review-improvement`.

| Signal | Level | Target |
|--------|-------|--------|
| Codex operability over-weights rollback | Global | codex/05-operability.md |
| Gemini scope parser failures | Global | gemini/06-scope.md |
```

**Learning log format** (`docs/retrospectives/learning-log.md`):

```markdown
# Learning Log

Qualitative observations distilled from review retrospectives.

| Date | Spec | Observation | Category |
|------|------|-------------|----------|
```

**Learning log categories:** `agent-behavior`, `agent-reliability`, `domain-signal`, `spec-quality`, `process`, `prompt-improvement`.

**Location adaptation:** The skill reads the target project's existing `docs/` tree and follows what's there. If the project uses `docs/decisions/` instead of `docs/adr/`, it writes there. If there's no docs structure, it creates minimal directories as needed.

### Phase 4: Preview & Write

- Print a summary of what will be created/updated:
  ```
  Will create:
    docs/adr/0003-no-rollback-for-rename.md
    docs/adr/0004-no-checkpoint-file-for-interactive-skills.md
    docs/retrospectives/2026-03-19-rename-project.md
    docs/reference/github-app-auth.md
  Will update:
    docs/retrospectives/learning-log.md (append 3 entries)
    docs/glossary.md (append 2 terms)
  ```
- Write all files.
- If `--no-commit`: stop here.
- Otherwise: `git add` specific files by name, commit with message referencing the source spec: `docs: extract knowledge from <spec-slug>`.

### Phase 5: Batch Coordination (batch mode only)

After all specs are individually processed:
- Run a deduplication pass across all generated ADRs. If spec A and spec C both produced an ADR about the same pattern, keep the richer one, drop the duplicate.
- Renumber ADRs sequentially if any were dropped.
- Final commit covers the dedup cleanup.

### Phase 6: Summary

Print to terminal:
- Specs processed
- ADRs created (with numbers and titles)
- Retrospectives written
- Reference docs created/updated
- Learning log entries appended
- Glossary terms added
- Total files created / updated

Batch mode additionally: cross-spec dedup stats, totals across all specs.

### Phase 7: Metrics & History

**End metrics block** (printed to terminal and persisted to `~/.claude/code-review/history/extract-docs/`):

```json
{
  "skill": "stark-extract-docs",
  "duration_seconds": 87,
  "spec_path": "docs/superpowers/specs/2026-03-19-rename-project-design.md",
  "target_repo": "GetEvinced/stark-review",
  "artifacts_found": {
    "spec": true,
    "plan": true,
    "spec_review": true,
    "plan_review": true
  },
  "pass_1_duration_seconds": 34,
  "pass_2_duration_seconds": 41,
  "extractions": {
    "total": 14,
    "by_category": {
      "decision": 3,
      "decision_defended": 7,
      "constraint": 1,
      "integration": 1,
      "agent_signal": 2
    }
  },
  "outputs": {
    "adrs_created": 4,
    "adrs_deduplicated": 1,
    "retrospectives_created": 1,
    "reference_docs_created": 1,
    "reference_docs_updated": 0,
    "learning_log_entries": 3,
    "glossary_terms": 2
  },
  "files_created": 6,
  "files_updated": 2,
  "batch_mode": false,
  "dry_run": false
}
```

**Batch mode adds:**

```json
{
  "specs_processed": 5,
  "specs_skipped": 0,
  "cross_spec_adrs_deduplicated": 2,
  "per_spec_metrics": ["..."]
}
```

**Improvement flags** (per Skill Observability Protocol):

- Pass 1 extraction count is 0 → "Spec has no extractable knowledge — may be too thin or too implementation-focused"
- ADR dedup rate > 50% → "Many overlapping decisions across specs — consider consolidating at a higher level"
- Any category with 0 extractions across batch → flag the missing category
- Pass 1 > 70% of total time → "Extraction is the bottleneck"
- Missing artifacts → "No review found for spec — review-derived knowledge unavailable"

**History file naming:** `~/.claude/code-review/history/extract-docs/{repo}/{spec-slug}.json`

Feeds into `stark-metrics` for aggregation alongside other skill runs.

## SKILL.md Frontmatter

```yaml
---
name: stark-extract-docs
description: >
  Extract durable knowledge from specs, plans, and reviews into project
  documentation — ADRs, retrospectives, reference docs, glossary, and a
  learning log. Use when the user says "extract docs", "generate ADRs",
  "extract knowledge", "create retrospective", "docs from spec",
  or invokes /stark-extract-docs.
argument-hint: "<path-to-spec> [--batch <dir>] [--dry-run]"
---
```

## Constants

```
SCRIPTS=~/.claude/code-review/scripts
PYTHON=$SCRIPTS/.venv/bin/python3
```

## What This Skill Does NOT Do

- Modify the source spec or plan (those are point-in-time artifacts)
- Delete the spec or plan (unlike `stark-plan-to-tasks`, the spec remains — it's a historical record)
- Create GitHub issues (that's `stark-plan-to-tasks`)
- Challenge or re-evaluate architectural decisions
- Generate docs from code (that's `/init-docs --backfill`)
- Push or create PRs (commit is local-only)

## Edge Cases

- **Spec has no associated review** — skip `evolution`, `decision_defended`, and `agent_signal` categories. Still extract `decision`, `constraint`, `integration`, `data_model`, `glossary`.
- **Spec has no associated plan** — skip plan-specific knowledge. Most knowledge comes from spec + review anyway.
- **Target project has no `docs/` directory** — create minimal structure (`docs/adr/`, `docs/retrospectives/`, `docs/reference/`).
- **ADR directory uses different name** — detect `docs/decisions/`, `docs/adrs/`, `docs/adr/` and use whatever exists.
- **Batch mode with mixed spec locations** — process each spec independently, dedup across all at the end.
- **Spec already processed** — check history file; if exists and spec hasn't changed (compare mtime or hash), skip with log message.
- **Learning log doesn't exist** — create it with the header row.
- **Glossary doesn't exist** — create it with a title.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Spec file doesn't exist or is empty | Fail with clear error message |
| Spec is not markdown | Fail with "expected .md file" error |
| Target repo detection fails | Fall back to current directory; if still ambiguous, ask user |
| Pass 1 extracts nothing | Log "no extractable knowledge found," exit cleanly (not an error) |
| Pass 2 can't determine ADR number | Fall back to `0001` with warning |
| File write fails (permissions) | Report which files succeeded, which failed |
| Batch mode partial failure | Process remaining specs, report failures at end |
| Git commit fails | Files are already written; report and suggest manual commit |

## Observability

Follows the Skill Observability Protocol (`~/.claude/code-review/standards/observability.md`).

**Task-based progress:** TaskCreate per phase with `activeForm` spinner text. TaskUpdate to mark `in_progress` → `completed`.

**Timestamped log lines:** `[HH:MM:SS]` format with phase names and elapsed times.

**5-minute checkpoints:** For batch mode with many specs.

**End metrics block:** As defined in Phase 7 above.
