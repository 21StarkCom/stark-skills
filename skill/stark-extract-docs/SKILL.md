---
name: stark-extract-docs
description: >
  Extract durable knowledge from specs, plans, and reviews into project
  documentation — ADRs, retrospectives, reference docs, glossary, and a
  learning log. Use when the user says "extract docs", "generate ADRs",
  "extract knowledge", "create retrospective", "docs from spec",
  or invokes /stark-extract-docs.
argument-hint: "<path-to-spec> [--batch <dir>] [--dry-run] [--force]"
---

# stark-extract-docs

Extract durable knowledge from specs, plans, and review files into project
documentation. Two-pass architecture: Pass 1 extracts knowledge into a structured
intermediate format, Pass 2 routes it to the right doc types and locations.

Both passes run in the current Claude Code session — no external agent dispatch.

## Arguments

- `<path-to-spec>` — path to a spec/design document (required unless `--batch`)
- `--batch <dir>` — process all `*-design.md` files in a directory sequentially
- `--dry-run` — extract and show intermediate format, don't write files
- `--no-commit` — write files but don't commit
- `--force` — re-extract even if history file exists for this spec
- `--include-low` — include low-confidence extractions (normally skipped)
- `--target-repo <path>` — override target repo detection with a local path

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Setup

### 1.1 Validate input

- If `--batch` was provided, verify the directory exists and contains at least one `*-design.md` file. If empty, error: "No *-design.md files found in {dir}".
- Otherwise, confirm `<path>` argument was provided. If not, error: "Usage: /stark-extract-docs <path-to-spec>"
- Confirm spec file exists, is readable, and has a `.md` extension. If not, error and abort.
- Read spec file content.

### 1.2 Locate associated artifacts

Given the spec path, derive associated artifact paths by convention:

```
spec:        docs/{prefix}/specs/YYYY-MM-DD-foo-design.md
plan:        docs/{prefix}/plans/YYYY-MM-DD-foo.md
spec review: docs/{prefix}/specs/YYYY-MM-DD-foo-design.review.md
plan review: docs/{prefix}/plans/YYYY-MM-DD-foo.review.md
```

Where `{prefix}` is empty (for `docs/specs/`) or `superpowers` (for `docs/superpowers/specs/`).

For each artifact: check if the file exists. Read it if found. Log which were found and which are missing:

```
[HH:MM:SS] Artifacts found:
  ✓ spec: docs/superpowers/specs/2026-03-19-rename-project-design.md
  ✓ plan: docs/superpowers/plans/2026-03-19-rename-project.md
  ✓ spec review: docs/superpowers/specs/2026-03-19-rename-project-design.review.md
  ✗ plan review: not found
```

### 1.3 Check skip logic

If `--force` was NOT passed:
- Derive spec slug from filename: strip directory, strip `-design.md` suffix. E.g., `2026-03-19-rename-project-design.md` → `2026-03-19-rename-project`.
- Check for history file at `~/.claude/code-review/history/extract-docs/{target-repo}/{spec-slug}.json` (where `{target-repo}` is the `org/repo` identifier, e.g., `GetEvinced/stark-review`, creating a nested directory structure like `extract-docs/GetEvinced/stark-review/`).
- If found, compute SHA-256 hashes of all current input files. Compare against `input_hashes` in the history file.
- If ALL hashes match, log: "Spec already processed with identical inputs. Use --force to re-extract." and exit cleanly.

### 1.4 Detect target repo

Resolution order:

1. If `--target-repo <path>` was provided, use that path. Fail if it doesn't exist.
2. Parse spec content for `org/repo` patterns (e.g., `GetEvinced/widget-system`). Use the FIRST match found. If multiple, warn: "Multiple repo references found, using {first}. Override with --target-repo."
3. Fall back to `git remote -v` in the current directory — extract org/repo from the origin URL.

**Filesystem resolution** for steps 2-3 (when result is an `org/repo` string, not a path):

```bash
# Check sibling directory
PARENT_DIR=$(dirname "$(git rev-parse --show-toplevel)")
if [ -d "$PARENT_DIR/{repo-name}" ]; then
    TARGET_DIR="$PARENT_DIR/{repo-name}"
# Check ~/git/{org}/{repo-name}
elif [ -d "$HOME/git/{org}/{repo-name}" ]; then
    TARGET_DIR="$HOME/git/{org}/{repo-name}"
else
    # Error and abort
    echo "Target repo {org}/{repo} not found locally. Clone it or use --target-repo <path>."
    exit 1
fi
```

When no external repo reference is found, TARGET_DIR is the current directory.

### 1.5 Read target project structure

- List the target project's `docs/` tree (for routing decisions in Pass 2).
- Detect ADR directory variant: check for `docs/adr/`, `docs/decisions/`, `docs/adrs/`. Store the found name. If none exists, default to `docs/adr/`.
- If ADR directory exists, read all existing ADR files to find the highest `NNNN` number. Store as `next_adr_number`.
- Read `docs/retrospectives/learning-log.md` if it exists (for append dedup).
- Read `docs/glossary.md` if it exists (for append dedup).

### 1.6 Check plan-to-tasks overlap

Check for a plan-to-tasks history file at:
```
~/.claude/code-review/history/plan-to-tasks/{target-repo}/{spec-slug}.json
```

If it exists and contains `"plan_deleted": true`, set `SKIP_PLAN_TO_TASKS_CATEGORIES=true`. This means we skip extraction of: `decision`, `constraint`, `integration`, `data_model`, `glossary` — and focus on review-derived categories: `evolution`, `decision_defended`, `agent_signal`.

**Note:** This integration is forward-looking — `stark-plan-to-tasks` is not yet implemented. If the history file doesn't exist (which it won't until plan-to-tasks is built and run), `SKIP_PLAN_TO_TASKS_CATEGORIES` is simply `false` and all 8 categories are extracted. No error on missing file.

## Phase 2: Pass 1 — Knowledge Extraction

Read ALL found artifacts (spec, plan, spec review, plan review) and extract knowledge into a structured JSON format.

If `SKIP_PLAN_TO_TASKS_CATEGORIES` is true, extract ONLY from these categories: `evolution`, `decision_defended`, `agent_signal`.

Otherwise, extract from ALL 8 categories:

| Category | Where to look | What to extract |
|----------|--------------|-----------------|
| `decision` | Spec: design principles, architecture section, technology choices | Architectural choices with rationale |
| `decision_defended` | Review `.review.md`: "Intentional Design Choices" tables, "Unresolved" sections marked as intentional | Decisions that were challenged by reviewers and held, with the challenge and rationale |
| `constraint` | Spec: "Non-Goals", "What This Skill Does NOT Do", performance/security constraints | Boundaries and limitations, with `has_alternatives: true` if alternatives were considered |
| `integration` | Spec: API contracts, invocation patterns, auth mechanisms, data flow diagrams | Interface specifications and contracts |
| `data_model` | Spec: schema definitions, config formats, entity relationships | Structural definitions |
| `evolution` | Review `.review.md`: "Fixed Across Rounds" sections, severity trends | What changed during review, round by round |
| `agent_signal` | Review `.review.md`: "Prompt Improvement Assessment" tables, agent failure patterns | Agent behavior patterns worth tracking |
| `glossary` | Spec: domain terms used with specific meaning, especially in tables or definitions | Term definitions |

For each extraction, produce a JSON object with these fields:

**Required fields (all categories):**
- `category` — one of the 8 categories above
- `title` — concise name for the knowledge item
- `content` — the actual knowledge (2-5 sentences)
- `evidence` — what in the source supports this extraction
- `source` — which file and section it came from
- `confidence` — `high`, `medium`, or `low`

**Category-specific fields:**
- `constraint`: `has_alternatives` (boolean) — true if alternatives were explicitly considered
- `evolution`: `round` (string, e.g., "1→2") — which review round
- `agent_signal`: `affected_agents` (string[], e.g., `["codex"]`)

**Output the complete JSON to yourself** (hold in memory for Phase 3):

```json
{
  "schema_version": 1,
  "spec_path": "<spec-path>",
  "associated_artifacts": ["<found-artifact-paths>"],
  "input_hashes": {
    "<artifact-path>": "sha256:<hash>"
  },
  "extractions": [
    {
      "category": "...",
      "title": "...",
      "content": "...",
      "evidence": "...",
      "source": "...",
      "confidence": "high|medium|low"
    }
  ]
}
```

Compute `input_hashes` by running:
```bash
shasum -a 256 <file>
```
for each found artifact.

### 2.1 Validate extraction output

After producing the JSON, validate:

- `schema_version` equals `1`
- Every extraction has required fields: `category`, `title`, `content`, `source`, `confidence`
- `category` is one of the 8 defined categories — skip unknown with a warning
- `confidence` is one of `high`, `medium`, `low`
- `constraint` extractions have `has_alternatives` (boolean)
- At least one extraction exists — if zero, log "No extractable knowledge found in {spec-path}" and exit cleanly

If validation fails, retry the extraction once with the specific validation error included in the prompt. If still invalid, fail with the validation error message.

### 2.2 Filter by confidence

- Remove extractions with `confidence: "low"` UNLESS `--include-low` was passed.
- Mark extractions with `confidence: "medium"` — these will get a `<!-- needs review -->` marker in generated docs.

### 2.3 Dry-run exit

If `--dry-run`: print the JSON extraction output to terminal in a fenced code block and exit. Do not proceed to Phase 3.

```
[HH:MM:SS] === Dry run — extraction results ===
{extractions JSON}
[HH:MM:SS] === End dry run (X extractions across Y categories) ===
```

## Phase 3: Pass 2 — Routing & Generation

Take the validated extractions and route each to the right document type and location.

### 3.1 Route extractions

For each extraction, determine the target based on its category:

| Category | Target | Location |
|----------|--------|----------|
| `decision` | ADR | `{TARGET_DIR}/{adr_dir}/NNNN-<slug>.md` |
| `decision_defended` | ADR + Retrospective | `{TARGET_DIR}/{adr_dir}/NNNN-<slug>.md` AND included in retrospective "Decisions Defended" table |
| `constraint` (has_alternatives=true) | ADR | `{TARGET_DIR}/{adr_dir}/NNNN-<slug>.md` |
| `constraint` (has_alternatives=false) | Reference | `{TARGET_DIR}/docs/reference/constraints.md` (append) |
| `integration` | Reference | `{TARGET_DIR}/docs/reference/<component-slug>.md` |
| `data_model` | Reference | `{TARGET_DIR}/docs/reference/<entity-slug>.md` |
| `evolution` | Retrospective | `{SOURCE_REPO}/docs/retrospectives/YYYY-MM-DD-<spec-slug>.md` |
| `agent_signal` | Retro + Log | `{SOURCE_REPO}/docs/retrospectives/...` + `learning-log.md` |
| `glossary` | Glossary | `{TARGET_DIR}/docs/glossary.md` (append) |

Where:
- `{TARGET_DIR}` = the resolved target repo path (from Phase 1.4)
- `{SOURCE_REPO}` = the repo where the spec lives (the current working directory)
- `{adr_dir}` = the detected ADR directory name (from Phase 1.5, default `docs/adr/`)

### 3.2 Generate ADRs

For each extraction routed to an ADR:

**Deduplication check:** Read titles and first paragraphs of all existing ADRs in `{adr_dir}/`. Compare the new ADR's title and context against them. If substantially similar to an existing ADR, skip and log: "Skipping duplicate ADR: '{title}' (similar to {existing})". If uncertain, proceed but add `<!-- possible duplicate of NNNN -->` to the generated file.

**Generate the ADR file:**

Use the project's template if `{adr_dir}/0000-template.md` exists, otherwise use:

```markdown
# NNNN: {title}

**Date:** {today YYYY-MM-DD}
**Status:** Accepted

## Context

{For `decision`: the architectural situation from the spec.}
{For `decision_defended`: the situation PLUS the review challenge — "During multi-agent review, N agents flagged {concern} across M rounds."}
{For `constraint` with alternatives: the constraint context.}

## Decision

{content from the extraction, expanded into a full paragraph}

## Alternatives Considered

{For `decision`: alternatives from the spec if mentioned, otherwise "Not documented."}
{For `decision_defended`: the alternative the reviewers advocated.}
{For `constraint`: the rejected alternatives.}

## Consequences

{Positive and negative consequences inferred from the spec context.}
```

If `confidence: "medium"`, prepend `<!-- needs review -->` after the title line.

Assign `NNNN` = `next_adr_number`, then increment `next_adr_number`.

Slug: derive from title, lowercase, hyphens for spaces, max 50 chars. E.g., "No rollback runbook for rename operations" → `no-rollback-runbook-for-rename`.

### 3.3 Generate retrospective

Group all `evolution` and `agent_signal` extractions. If none exist, skip this step entirely (do NOT create empty retrospective).

Derive the retrospective filename from the spec filename: extract the date prefix and the name portion (strip `-design.md`). E.g., `2026-03-19-rename-project-design.md` → date `2026-03-19`, name `rename-project`.

Generate one file: `{SOURCE_REPO}/docs/retrospectives/{spec-date}-{name}.md`

```markdown
# Review Retrospective — {spec title from first heading}

**Spec:** `{spec-path}`
**Date:** {spec-date from filename}
**Review rounds:** {from review file if available, otherwise "unknown"}

## Design Evolution

What changed through the review process and why.

| Round | Change | Trigger |
|-------|--------|---------|
{one row per `evolution` extraction, using `round` field}

## Decisions Defended

Design choices that were challenged by reviewers and held.

| Decision | Challenge | Rationale |
|----------|-----------|-----------|
{one row per `decision_defended` extraction}

## Agent Performance

| Agent | Domain | Signal | Notes |
|-------|--------|--------|-------|
{one row per `agent_signal` extraction}

## Prompt Improvement Candidates

Signals that should feed into `stark-review-improvement`.

| Signal | Level | Target |
|--------|-------|--------|
{from agent_signal extractions that reference specific prompt files}
```

Create `docs/retrospectives/` directory in the source repo if it doesn't exist.

### 3.4 Generate learning log entries

For each `agent_signal` extraction, generate a learning log row:

```
| {today} | {spec-slug} | {content, one line} | {category from: agent-behavior, agent-reliability, domain-signal, spec-quality, process, prompt-improvement} |
```

**Dedup:** Read existing `docs/retrospectives/learning-log.md`. If an entry with the same spec and same observation text already exists, skip it.

If the file doesn't exist, create it:
```markdown
# Learning Log

Qualitative observations distilled from review retrospectives.

| Date | Spec | Observation | Category |
|------|------|-------------|----------|
```

Then append the new rows.

### 3.5 Generate reference docs

For `integration` and `data_model` extractions:
- Derive filename from title slug: `docs/reference/{slug}.md`
- If the file already exists in the target repo, append a new section (don't overwrite)
- If it doesn't exist, create it with a `# {title}` heading and the content

### 3.6 Append to glossary

For `glossary` extractions:
- If `{TARGET_DIR}/docs/glossary.md` doesn't exist, create it:
  ```markdown
  # Glossary

  ```
- Before appending, check if a term with the same name already exists. If so, skip.
- Append each term as:
  ```markdown
  **{term}** — {definition}
  ```

### 3.7 Append to constraints

For `constraint` extractions with `has_alternatives: false`:
- If `{TARGET_DIR}/docs/reference/constraints.md` doesn't exist, create it:
  ```markdown
  # Constraints

  Boundary conditions and non-negotiable limitations.

  ```
- Append: `- **{title}** — {content}`

### 3.8 Update staleness config

If `{TARGET_DIR}/.doc-staleness.yml` exists AND `docs/retrospectives/` was created, check if `docs/retrospectives/` is in the `exclude_paths`. If not, add it.
