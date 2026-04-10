---
name: stark-extract-docs
description: >-
  Extract ADRs, retrospectives, and reference docs from specs, plans, and reviews. Use for extract docs, generate ADRs.
argument-hint: "<path-to-spec> [--batch <dir>] [--dry-run] [--force]"
disable-model-invocation: true
context: fork
model: opus
---

# stark-extract-docs

Extract durable knowledge from specs, plans, and review files into project documentation. Two-pass architecture: Pass 1 extracts knowledge into a structured intermediate format, Pass 2 routes it to the right doc types and locations.

Both passes run in the current Claude Code session — no external agent dispatch.

## Arguments

- `<path-to-spec>` — path to a spec/design document (required unless `--batch`)
- `--batch <dir>` — process all `*-design.md` files in a directory sequentially
- `--dry-run` — extract and show intermediate format, don't write files
- `--no-commit` — write files but don't commit
- `--force` — re-extract even if history file exists for this spec
- `--include-low` — include low-confidence extractions (normally skipped)
- `--target-repo <path>` — override target repo detection with a local path

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Setup

### 1.1 Validate input

- `--batch`: verify directory exists and contains at least one `*-design.md` file. Error if empty.
- Otherwise: confirm `<path>` provided, file exists, readable, `.md` extension.
- Read spec file content.

### 1.2 Locate associated artifacts

Derive associated artifact paths from spec path by convention:
```
spec:        docs/{prefix}/specs/YYYY-MM-DD-foo-design.md
plan:        docs/{prefix}/plans/YYYY-MM-DD-foo.md
spec review: docs/{prefix}/specs/YYYY-MM-DD-foo-design.review.md
plan review: docs/{prefix}/plans/YYYY-MM-DD-foo.review.md
```
Check existence of each. Log found/missing:
```
[HH:MM:SS] Artifacts found:
  ✓ spec: docs/superpowers/specs/2026-03-19-rename-project-design.md
  ✗ plan review: not found
```

### 1.3 Check skip logic

If `--force` NOT passed: derive spec slug (strip directory and `-design.md` suffix). Check history at `~/.claude/code-review/history/extract-docs/{target-repo}/{spec-slug}.json`. If found, compare SHA-256 hashes of all inputs against stored `input_hashes`. If all match → log "already processed" and exit.

### 1.4 Detect target repo

Resolution order:
1. `--target-repo <path>` if provided.
2. Parse spec content for `org/repo` pattern (first match). Warn if multiple found.
3. Fall back to `git remote -v` in current directory.

Filesystem resolution for org/repo string: check `$PARENT_DIR/{repo-name}`, then `$HOME/git/{org}/{repo-name}`. Error if neither found. When no external reference found, TARGET_DIR is the current directory.

### 1.5 Read target project structure

- List target project's `docs/` tree.
- Detect ADR directory: check for `docs/adr/`, `docs/decisions/`, `docs/adrs/`. Default to `docs/adr/`.
- If ADR directory exists, find highest `NNNN` number. Store as `next_adr_number`.
- Read `docs/retrospectives/learning-log.md` and `docs/glossary.md` if they exist (for dedup).

### 1.6 Check plan-to-tasks overlap

Check for history at `~/.claude/code-review/history/plan-to-tasks/{target-repo}/{spec-slug}.json`. If found with `"plan_deleted": true`, set `SKIP_PLAN_TO_TASKS_CATEGORIES=true` — extract only `evolution`, `decision_defended`, `agent_signal`. Missing history file = `false` (normal first run).

## Phase 2: Pass 1 — Knowledge Extraction

Read ALL found artifacts. If `SKIP_PLAN_TO_TASKS_CATEGORIES=true`, extract from `evolution`, `decision_defended`, `agent_signal` only. Otherwise extract from all 8 categories:

| Category | Where to look | What to extract |
|----------|--------------|-----------------|
| `decision` | Spec: design principles, architecture section, technology choices | Architectural choices with rationale |
| `decision_defended` | Review: "Intentional Design Choices" tables, "Unresolved" marked intentional | Decisions challenged and held, with challenge and rationale |
| `constraint` | Spec: "Non-Goals", performance/security constraints | Boundaries and limitations; `has_alternatives: true` if alternatives considered |
| `integration` | Spec: API contracts, invocation patterns, auth mechanisms | Interface specifications and contracts |
| `data_model` | Spec: schema definitions, config formats, entity relationships | Structural definitions |
| `evolution` | Review: "Fixed Across Rounds", severity trends | What changed during review, by round |
| `agent_signal` | Review: "Prompt Improvement Assessment" tables, agent failure patterns | Agent behavior patterns worth tracking |
| `glossary` | Spec: domain terms with specific meaning | Term definitions |

**Required extraction fields (all categories):** `category`, `title`, `content` (2–5 sentences), `evidence`, `source`, `confidence` (high/medium/low).
**Category-specific:** `constraint` → `has_alternatives` (boolean); `evolution` → `round` (e.g., "1→2"); `agent_signal` → `affected_agents` (string[]).

Output the complete JSON to memory for Phase 3:
```json
{
  "schema_version": 1,
  "spec_path": "<spec-path>",
  "associated_artifacts": ["..."],
  "input_hashes": {"<artifact-path>": "sha256:<hash>"},
  "extractions": [{"category":"...","title":"...","content":"...","evidence":"...","source":"...","confidence":"high|medium|low"}]
}
```

Compute hashes with `shasum -a 256 <file>`.

### 2.1 Validate extraction output

Verify: `schema_version=1`, all extractions have required fields, valid `category` and `confidence` values, `constraint` extractions have `has_alternatives`. At least one extraction must exist. If validation fails, retry once with the error. Still invalid → fail.

### 2.2 Filter by confidence

Remove `confidence: "low"` unless `--include-low`. Mark `confidence: "medium"` with `<!-- needs review -->` in generated docs.

### 2.3 Dry-run exit

If `--dry-run`: print the JSON in a fenced block and exit.

## Phase 3: Pass 2 — Routing & Generation

### 3.1 Route extractions

| Category | Target | Location |
|----------|--------|----------|
| `decision` | ADR | `{TARGET_DIR}/{adr_dir}/NNNN-<slug>.md` |
| `decision_defended` | ADR + Retro | ADR file + retrospective "Decisions Defended" table |
| `constraint` (has_alternatives=true) | ADR | `{TARGET_DIR}/{adr_dir}/NNNN-<slug>.md` |
| `constraint` (has_alternatives=false) | Reference | `{TARGET_DIR}/docs/reference/constraints.md` (append) |
| `integration` | Reference | `{TARGET_DIR}/docs/reference/<component-slug>.md` |
| `data_model` | Reference | `{TARGET_DIR}/docs/reference/<entity-slug>.md` |
| `evolution` | Retrospective | `{SOURCE_REPO}/docs/retrospectives/YYYY-MM-DD-<spec-slug>.md` |
| `agent_signal` | Retro + Log | retrospective + `learning-log.md` |
| `glossary` | Glossary | `{TARGET_DIR}/docs/glossary.md` (append) |

### 3.2 Generate ADRs

**Deduplication:** Compare new ADR title/context against existing ADRs. Skip if substantially similar; add `<!-- possible duplicate of NNNN -->` if uncertain.

Use project template if `{adr_dir}/0000-template.md` exists, otherwise generate:
```markdown
# NNNN: {title}

**Date:** {today YYYY-MM-DD}
**Status:** Accepted

## Context
{architectural situation; for decision_defended: add "During multi-agent review, N agents flagged {concern}"}

## Decision
{content from extraction, expanded}

## Alternatives Considered
{alternatives from spec; for decision_defended: the alternative reviewers advocated}

## Consequences
{positive and negative consequences inferred from spec context}
```

If `confidence: "medium"`, prepend `<!-- needs review -->`. Assign `NNNN = next_adr_number`, then increment. Slug: lowercase, hyphens, max 50 chars.

### 3.3 Generate retrospective

Group all `evolution` and `agent_signal` extractions. If none exist, skip (do NOT create empty file).

Filename: `{SOURCE_REPO}/docs/retrospectives/{spec-date}-{name}.md`

```markdown
# Review Retrospective — {spec title}

**Spec:** `{spec-path}`
**Date:** {spec-date}
**Review rounds:** {from review file or "unknown"}

## Design Evolution

| Round | Change | Trigger |
|-------|--------|---------|
{one row per evolution extraction}

## Decisions Defended

| Decision | Challenge | Rationale |
|----------|-----------|-----------|
{one row per decision_defended extraction}

## Agent Performance

| Agent | Domain | Signal | Notes |
|-------|--------|--------|-------|
{one row per agent_signal extraction}

## Prompt Improvement Candidates

| Signal | Level | Target |
|--------|-------|--------|
{from agent_signal extractions referencing prompt files}
```

### 3.4 Generate learning log entries

For each `agent_signal` extraction, append a row to `docs/retrospectives/learning-log.md`:
```
| {today} | {spec-slug} | {content, one line} | {category} |
```
Dedup: skip if same spec + observation text already exists. Create file with header if missing.

### 3.5 Generate reference docs

For `integration` and `data_model` extractions: derive filename from title slug `docs/reference/{slug}.md`. Append new section to existing file or create with `# {title}` heading.

### 3.6 Append to glossary

For `glossary` extractions: create `# Glossary` header if file missing. Skip if term already exists. Append `**{term}** — {definition}`.

### 3.7 Append to constraints

For `constraint` extractions with `has_alternatives: false`: create `# Constraints` header if missing. Append `- **{title}** — {content}`.

### 3.8 Update staleness config

If `{TARGET_DIR}/.doc-staleness.yml` exists and `docs/retrospectives/` was created, add it to `exclude_paths` if not already there.

## Phase 4: Preview & Write

### 4.1 Preview

```
[HH:MM:SS] === Files to write ===
Will create:
  docs/adr/0003-no-rollback-for-rename.md
  docs/retrospectives/2026-03-19-rename-project.md
Will update:
  docs/retrospectives/learning-log.md (append 3 entries)
  docs/glossary.md (append 2 terms)
```

### 4.2 Create directories

Create missing directories. Only create `docs/retrospectives/` if retrospective content exists.

### 4.3 Write files

Write generated content using Write tool for new files, Edit tool for appending. Track written files for commit.

### 4.4 Commit (unless --no-commit)

If `--no-commit`: log and skip. Otherwise:

1. Check `git -C "{TARGET_DIR}" status --porcelain` for pre-existing changes. If dirty, warn and skip commit.
2. Stage and commit specific files: `git -C "{TARGET_DIR}" add <specific-files> && git -C "{TARGET_DIR}" commit -m "docs: extract knowledge from {spec-slug}"`
3. If source repo ≠ target repo and retrospective/learning-log were written to source: commit those too, or warn if source is dirty.

## Phase 5: Batch Coordination (--batch mode only)

If not `--batch`, skip entirely.

Iterate over all `*-design.md` files in the batch dir sequentially. Run Phases 1–4 for each; preserve `next_adr_number` counter across specs. Log failures and continue.

After all specs: compare all ADRs created in this run for duplicates. Keep the more detailed one, delete the duplicate (no renumbering). Commit any deletions: `git -C "{TARGET_DIR}" add -u && git -C "{TARGET_DIR}" commit -m "docs: deduplicate ADRs from batch extraction"`

## Phase 6: Summary

```
[HH:MM:SS] === stark-extract-docs completed ===
Spec:                 {spec-path}
Target repo:          {target-repo}
Artifacts found:      spec ✓, plan ✓, spec review ✓, plan review ✗
Extractions:          {total} total ({N} per category)
Outputs:
  ADRs created:       {N}
  Retrospective:      {path or "none"}
  Reference docs:     {N} created, {N} updated
  Learning log:       {N} entries appended
  Glossary:           {N} terms added
Files:                {N} created, {N} updated
```

## Phase 7: Metrics & History

See [references/metrics-history.md](references/metrics-history.md) for metrics block format, improvement flags, and history persistence schema.

## Observability

Standard observability: create task, emit timestamped progress logs, record metrics block (spec, target repo, extraction counts by category, files written/updated, duration), emit completion event via `emit_queue.py`. See [references/observability.md](references/observability.md).

## Force Re-Run Behavior (--force)

Read `created_artifacts` from history file. ADRs: overwrite same files. Retrospective: overwrite. Learning log: remove previous run's entries by spec slug + observation text, then append new. Glossary: remove previous terms by name, then append. Reference docs/constraints: overwrite sections added by previous run (tracked in history). If no history file, `--force` bypasses skip check only.

## What This Skill Does NOT Do

- Modify the source spec or plan
- Delete the spec or plan
- Create GitHub issues (that's `stark-plan-to-tasks`)
- Challenge or re-evaluate architectural decisions
- Generate docs from code (that's `/init-docs --backfill`)
- Push or create PRs (commit is local-only)

## Edge Cases

- **Spec has no review file** — skip `evolution`, `decision_defended`, `agent_signal`. Extract from spec only.
- **Spec has no plan** — skip plan-specific knowledge.
- **Target has no `docs/`** — create `docs/adr/`, `docs/reference/`. Only create `docs/retrospectives/` if content exists.
- **ADR dir uses different name** — detected in Phase 1.5.
- **Source repo ≠ target repo** — retrospectives go to source, ADRs to target. Warn about separate commits.

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.
