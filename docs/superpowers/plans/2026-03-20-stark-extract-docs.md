# stark-extract-docs Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Claude Code skill that extracts durable knowledge from specs, plans, and reviews into project documentation — ADRs, retrospectives, reference docs, glossary, and a learning log.

**Architecture:** Single SKILL.md file containing the full prompt-driven workflow. Both LLM passes run in the current Claude Code session (no external agent dispatch, no Python orchestrator). The skill drives file reads, LLM extraction, file writes, and git commits directly. Install.sh auto-discovers it via the `stark-*` naming convention.

**Tech Stack:** Markdown (SKILL.md), Bash (install.sh auto-discovery), JSON (history files at `~/.claude/code-review/history/`)

**Spec:** `docs/superpowers/specs/2026-03-20-stark-extract-docs-design.md`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `skill/stark-extract-docs/SKILL.md` | Skill implementation — narrative workflow for Claude Code |
| Modify | `install.sh` | No changes needed — auto-discovers `stark-*` skills |
| Modify | `CLAUDE.md` | Add skill to skills list |

---

### Task 1: Create SKILL.md skeleton with frontmatter, constants, arguments

**Files:**
- Create: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Create skill directory and SKILL.md with frontmatter + intro + constants + arguments**

````markdown
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

~~~
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
~~~
````

- [ ] **Step 2: Verify file is valid markdown with frontmatter**

Run: `head -10 skill/stark-extract-docs/SKILL.md`
Expected: Shows `---`, `name: stark-extract-docs`, `description:`, `argument-hint:`, `---`

- [ ] **Step 3: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat: scaffold stark-extract-docs skill with frontmatter"
```

---

### Task 2: Implement Phase 1 — Setup

Append to `skill/stark-extract-docs/SKILL.md` after the Constants section.

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 1 — input validation and artifact resolution**

```markdown
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
- Check for history file at `~/.claude/code-review/history/extract-docs/{target-repo}/{spec-slug}.json` (where `{target-repo}` is the `org/repo` identifier, e.g., `GetEvinced/stark-skills`, creating a nested directory structure like `extract-docs/GetEvinced/stark-skills/`).
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
# Check ~/Code/{org}/{repo-name}
elif [ -d "$HOME/Code/{org}/{repo-name}" ]; then
    TARGET_DIR="$HOME/Code/{org}/{repo-name}"
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
```

- [ ] **Step 2: Verify the phase reads correctly**

Read back the file and verify the Phase 1 section is well-formed markdown.

- [ ] **Step 3: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 1 — setup, validation, artifact resolution"
```

---

### Task 3: Implement Phase 2 — Pass 1 (Knowledge Extraction)

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 2 — extraction categories and prompt**

Append after Phase 1:

```markdown
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
```

- [ ] **Step 2: Add validation and retry logic**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 2 — knowledge extraction with validation"
```

---

### Task 4: Implement Phase 3 — Pass 2 (Routing & Generation)

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 3 routing rules and ADR generation**

Append after Phase 2:

```markdown
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
```

- [ ] **Step 2: Verify the routing section is complete**

Read back the Phase 3 section. Verify every extraction category from the spec has a routing path.

- [ ] **Step 3: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 3 — routing and doc generation"
```

---

### Task 5: Implement Phase 4 — Preview & Write

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 4 — preview, write, commit**

```markdown
## Phase 4: Preview & Write

### 4.1 Preview

Print a summary of all files that will be created or updated:

```
[HH:MM:SS] === Files to write ===
Will create:
  docs/adr/0003-no-rollback-for-rename.md
  docs/adr/0004-no-checkpoint-file-for-interactive-skills.md
  docs/retrospectives/2026-03-19-rename-project.md
  docs/reference/github-app-auth.md
Will update:
  docs/retrospectives/learning-log.md (append 3 entries)
  docs/glossary.md (append 2 terms)
```

### 4.2 Create directories

Create any missing directories needed for the generated files. Only create `docs/retrospectives/` if retrospective content was generated (never create it empty).

```bash
mkdir -p "{TARGET_DIR}/docs/adr"
mkdir -p "{TARGET_DIR}/docs/reference"
# Only if retrospective content exists:
mkdir -p "{SOURCE_REPO}/docs/retrospectives"
```

### 4.3 Write files

Write all generated content to disk. Use the Write tool for new files, Edit tool for appending to existing files.

Track which files were written for the commit step.

### 4.4 Commit (unless --no-commit)

If `--no-commit` was passed, skip this step. Log: "Files written. Skipping commit (--no-commit)."

Otherwise:

1. Check target repo for uncommitted changes:
   ```bash
   git -C "{TARGET_DIR}" status --porcelain
   ```
   If there are pre-existing uncommitted changes (beyond our new files), warn: "Target repo has uncommitted changes. Skipping commit — use --no-commit or commit your changes first." and skip the commit.

2. Stage and commit only the files we wrote:
   ```bash
   git -C "{TARGET_DIR}" add <specific-files>
   git -C "{TARGET_DIR}" commit -m "docs: extract knowledge from {spec-slug}"
   ```

3. If source repo ≠ target repo and retrospective/learning-log files were written to source repo:
   - Attempt to commit source-repo files too:
     ```bash
     git -C "{SOURCE_REPO}" add docs/retrospectives/{retrospective-file} docs/retrospectives/learning-log.md
     git -C "{SOURCE_REPO}" commit -m "docs: add review retrospective for {spec-slug}"
     ```
   - If the source repo has uncommitted changes (dirty tree), warn instead:
     ```
     ⚠ Retrospective and learning log written to source repo ({SOURCE_REPO}).
       Source repo has uncommitted changes — skipping commit. Stage and commit manually.
     ```
```

- [ ] **Step 2: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 4 — preview, write, and commit"
```

---

### Task 6: Implement Phase 5 — Batch Coordination

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 5 — batch mode**

```markdown
## Phase 5: Batch Coordination (--batch mode only)

If `--batch` was NOT passed, skip this phase entirely.

### 5.1 Iterate over specs

List all `*-design.md` files in the batch directory:

```bash
ls {batch-dir}/*-design.md
```

Process each spec sequentially: run Phases 1-4 for each. Between specs, clear the extraction state but preserve the running `next_adr_number` counter.

If a spec fails (Phase 1 validation, no extractable knowledge, etc.), log the failure and continue with the next spec. Track failures for the summary.

### 5.2 Cross-spec ADR deduplication

After all specs are processed, review all ADRs created during this batch run. For each pair, compare titles and context summaries. If two ADRs cover the same decision:
- Keep the one with more detail (longer Context + Decision sections)
- Delete the duplicate file
- Do NOT renumber — leave gaps in ADR numbering
- Log: "Deduplicated ADR NNNN (duplicate of MMMM)"

### 5.3 Final commit

If any ADRs were deleted in the dedup pass:
```bash
git -C "{TARGET_DIR}" add -u  # stage deletions
git -C "{TARGET_DIR}" commit -m "docs: deduplicate ADRs from batch extraction"
```
```

- [ ] **Step 2: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 5 — batch coordination and dedup"
```

---

### Task 7: Implement Phase 6-7 — Summary, Metrics, History

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add Phase 6 — summary output**

```markdown
## Phase 6: Summary

Print to terminal:

```
[HH:MM:SS] === stark-extract-docs completed ===

Spec:                 {spec-path}
Target repo:          {target-repo}
Artifacts found:      spec ✓, plan ✓, spec review ✓, plan review ✗

Extractions:          {total} total
  decision:           {N}
  decision_defended:  {N}
  constraint:         {N}
  integration:        {N}
  data_model:         {N}
  evolution:          {N}
  agent_signal:       {N}
  glossary:           {N}

Outputs:
  ADRs created:       {N} ({list numbers and titles})
  ADRs deduplicated:  {N}
  Retrospective:      {path or "none"}
  Reference docs:     {N} created, {N} updated
  Learning log:       {N} entries appended
  Glossary:           {N} terms added

Files:                {N} created, {N} updated
```

For batch mode, additionally show totals across all specs and dedup stats.
```

- [ ] **Step 2: Add Phase 7 — metrics and history**

```markdown
## Phase 7: Metrics & History

### 7.1 Print metrics block

```
Metrics
───────
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):                    Xs
  Phase 2 (Pass 1 — Extraction):      Xs
  Phase 3 (Pass 2 — Routing):         Xs
  Phase 4 (Preview & Write):          Xs
  Phase 5 (Batch Coordination):       Xs  (batch only)
  Phase 6 (Summary):                  Xs
```

### 7.2 Improvement flags

Check and print if applicable:
- Pass 2 extraction count is 0 → "Spec has no extractable knowledge — may be too thin"
- ADR dedup rate > 50% (batch) → "Many overlapping decisions — consider consolidating"
- Missing review artifacts → "No review found — review-derived knowledge unavailable"
- Pass 1 > 70% of total time → "Extraction is the bottleneck"

If none triggered: "No improvement opportunities detected."

### 7.3 Persist history

Write history file to `~/.claude/code-review/history/extract-docs/{target-repo}/{spec-slug}.json`:

```bash
mkdir -p ~/.claude/code-review/history/extract-docs/{target-repo}
```

Content — the full metrics JSON including:
- `schema_version: 1`
- `spec_path`
- `target_repo`
- `completed_at` (ISO 8601)
- `input_hashes` (from Phase 2 extraction output)
- `created_artifacts` — list of all files created/updated, ADR numbers, glossary entries, learning log entries
- `timing` — per-phase durations following the observability protocol schema
- `extractions` — counts by category
- `outputs` — counts by output type

This file enables:
- Skip logic: compare `input_hashes` on next run
- `--force` replacement: identify which artifacts to overwrite
- `stark-metrics` aggregation
```

- [ ] **Step 3: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add Phase 6-7 — summary, metrics, history"
```

---

### Task 8: Add observability, edge cases, force re-run, and mistakes to avoid

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Add observability section**

```markdown
## Observability

Follow the [Skill Observability Protocol](../../../standards/observability.md).

**Task-based progress at start:**

```
TaskCreate: "Phase 1: Setup — validate input, resolve artifacts"
            activeForm: "Setting up extraction"
TaskCreate: "Phase 2: Pass 1 — Knowledge Extraction"
            activeForm: "Extracting knowledge from artifacts"
TaskCreate: "Phase 3: Pass 2 — Routing & Generation"
            activeForm: "Routing knowledge to doc types"
TaskCreate: "Phase 4: Preview & Write"
            activeForm: "Writing documentation files"
TaskCreate: "Phase 5: Batch Coordination"   (batch mode only)
            activeForm: "Deduplicating across specs"
TaskCreate: "Phase 6: Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 7: Metrics & History"
            activeForm: "Persisting metrics"
```

Set each to `in_progress` before starting, `completed` when done.

**Timestamped log lines:** `[HH:MM:SS]` for each phase start/end and key events.

**5-minute checkpoints:** For batch mode — show elapsed time + current spec + progress (N/M specs done).

Record `T0` at skill start. All durations relative to `T0`.
```

- [ ] **Step 2: Add force re-run behavior**

```markdown
## Force Re-Run Behavior (--force)

When `--force` is passed AND a history file exists for this spec:

1. Read the history file to get `created_artifacts`.
2. **ADRs:** Overwrite the same ADR files (same numbers, same paths) with fresh content.
3. **Retrospective:** Overwrite the existing retrospective file.
4. **Learning log:** Find and remove entries matching the previous run's recorded entries (match by spec slug + observation text), then append new ones.
5. **Glossary:** Find and remove entries matching previous run's recorded terms (match by term name), then append new ones.
6. **Reference docs / constraints:** Overwrite the sections added by this skill's previous run (requires the history file to track which content was added).

If no history file exists, `--force` simply bypasses the skip check and behaves like a first run.
```

- [ ] **Step 3: Add edge cases and failure modes**

```markdown
## What This Skill Does NOT Do

- Modify the source spec or plan (those are point-in-time artifacts)
- Delete the spec or plan (unlike `stark-plan-to-tasks`, the spec remains)
- Create GitHub issues (that's `stark-plan-to-tasks`)
- Challenge or re-evaluate architectural decisions
- Generate docs from code (that's `/init-docs --backfill`)
- Push or create PRs (commit is local-only)

## Edge Cases

- **Spec has no review file** — skip `evolution`, `decision_defended`, `agent_signal` categories. Extract from spec only.
- **Spec has no plan** — skip plan-specific knowledge. Most comes from spec + review.
- **Target has no `docs/` dir** — create `docs/adr/`, `docs/reference/`. Only create `docs/retrospectives/` if content exists.
- **ADR dir uses different name** — detected in Phase 1.5 (`docs/decisions/`, `docs/adrs/`, `docs/adr/`).
- **Spec already processed** — skip unless `--force`. Compares all input hashes, not just spec.
- **Learning log doesn't exist** — create with header row.
- **Glossary doesn't exist** — create with `# Glossary` title.
- **Source repo ≠ target repo** — retrospectives go to source, ADRs to target. Warn about separate commits.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Spec doesn't exist or is empty | Error message, abort |
| Spec is not `.md` | Error: "expected .md file" |
| Target repo not found locally | Error with clone suggestion |
| Pass 1 extracts nothing | Log cleanly, exit (not an error) |
| Pass 1 returns invalid JSON | Retry once with error in prompt, then fail |
| ADR number can't be determined | Fall back to `0001` with warning |
| File write fails | Report what succeeded, what failed |
| Batch: one spec fails | Continue to next, report failures at end |
| Git commit fails | Files already written; suggest manual commit |
| Target repo has dirty tree | Warn, skip commit, files still written |

## Mistakes to Avoid

- Don't use `git add -A` — add specific files by name.
- Don't modify the source spec or plan.
- Don't write retrospectives into the target repo when it's different from the source repo.
- Don't renumber existing ADRs.
- Don't create duplicate ADRs silently — mark uncertain ones with `<!-- possible duplicate -->`.
- Don't route low-confidence extractions without `--include-low`.
- Don't confuse `--force` (history bypass) with `--include-low` (confidence filter).
- Don't assume `docs/adr/` — check for `docs/decisions/`, `docs/adrs/` first.
- Don't create empty `docs/retrospectives/` directory.
```

- [ ] **Step 4: Commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "feat(extract-docs): add observability, edge cases, force re-run, mistakes"
```

---

### Task 9: Update CLAUDE.md and verify installation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add stark-extract-docs to the skills list in CLAUDE.md**

Find the skills section in `CLAUDE.md` and add:

```markdown
- `/stark-extract-docs <path-to-spec>` — extract knowledge from specs/reviews into ADRs, retrospectives, reference docs
```

Add it after the existing skills, in a logical position (the existing list is ordered thematically, not alphabetically).

- [ ] **Step 2: Verify install.sh auto-discovers the skill**

Run: `./install.sh --status`

Expected: Should show `Skill: stark-extract-docs` in the output (auto-discovered from `skill/stark-extract-docs/`). If the symlink already exists, it should show "already linked".

- [ ] **Step 3: Run install.sh to create the symlink**

Run: `./install.sh`

Verify: `ls -la ~/.claude/skills/stark-extract-docs/SKILL.md` should show a symlink to the repo.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add stark-extract-docs to skills list"
```

---

### Task 10: Manual verification — dry-run on existing spec

**Files:** None (read-only verification)

- [ ] **Step 1: Run dry-run on the rename-project spec (has the richest review data)**

Invoke: `/stark-extract-docs docs/superpowers/specs/2026-03-19-rename-project-design.md --dry-run`

Verify:
- Phase 1 finds: spec ✓, plan ✓, spec review ✓, plan review ✓
- Phase 2 produces extractions across multiple categories
- `decision_defended` extractions include items from the "Intentional Design Choices" table
- `agent_signal` extractions include items from the "Prompt Improvement Assessment" table
- `evolution` extractions include items from "Fixed Across Rounds"
- Output is valid JSON with `schema_version: 1`

- [ ] **Step 2: Run dry-run on a spec with no review (e.g., dev-docs-management)**

Invoke: `/stark-extract-docs docs/specs/2026-03-17-dev-docs-management-design.md --dry-run` (verify this file exists first; if it's at a different path like `docs/superpowers/specs/`, use that)

Verify:
- Phase 1 finds: spec ✓, plan ✓, review ✗, plan review ✗
- Phase 2 skips review-only categories (`evolution`, `decision_defended`, `agent_signal`)
- Extractions focus on `decision`, `constraint`, `integration`, `data_model`, `glossary`

- [ ] **Step 3: If both dry-runs produce valid extractions, the skill is working**

Log findings and any issues. If the extraction quality is poor, adjust the extraction prompts in Phase 2.
