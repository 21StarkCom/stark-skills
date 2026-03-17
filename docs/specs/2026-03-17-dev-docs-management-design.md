# Spec: Dev Docs Management System

**Date:** 2026-03-17
**Status:** Draft (rev 1)
**Author:** Aryeh + Claude

## Problem

Code reviews lack context. Reviewers (both human and AI agents) don't know the spec or design intent behind a PR, so reviews are slow, miss the point, or re-litigate decisions already made. There's no org-wide standard for dev docs — every repo has evolved independently. Docs that do exist go stale because nothing detects or flags it.

The stark-review multi-agent system already reviews PRs and design docs, but there's no structured pipeline connecting specs to code reviews. The brainstorming skill already generates specs, but nothing nudges engineers to use it or links the output to the review process.

## Goals

1. Establish an org-wide doc taxonomy and repo structure, adoptable by any Evinced team
2. Connect specs to code reviews — stark-review agents use the spec as review context
3. Detect stale docs before they become dangerously wrong
4. Make `/init-docs` the zero-friction entry point for adopting the system
5. Make the "Start Here" entry point scannable and instant — optimized for short attention spans

## Non-Goals

- Designer/non-engineer workflows (handled separately per project)
- Doc site hosting infrastructure (local `mkdocs serve` is enough for now)
- Enforcing docs via hard CI gates (nudges, not blocks)
- Replacing Confluence for cross-functional/compliance docs

## Solution

Seven components, all living in stark-review and symlinked via `install.sh`:

### 1. Doc Taxonomy & Repo Structure

Every repo that adopts the standard gets:

```
docs/
  specs/           # Design docs / specs (YYYY-MM-DD-slug.md)
  plans/           # Implementation plans (YYYY-MM-DD-slug.md)
  adr/             # Architecture Decision Records (NNNN-slug.md, immutable)
  guides/          # How-to guides, runbooks (descriptive names)
  reference/       # API docs, config reference (descriptive names)
  architecture/    # System overviews, C4 diagrams (descriptive names)
mkdocs.yml         # MkDocs Material, nav mirrors directory layout
.github/
  pull_request_template.md
  CODEOWNERS
.doc-staleness.yml
```

**Naming conventions:**
- Specs and plans: `YYYY-MM-DD-<slug>.md` (date-prefixed, matches existing stark-review pattern)
- ADRs: `NNNN-<slug>.md` (sequential numbering, matches infra-pulse pattern)
- Guides, reference, architecture: descriptive names, no date prefix (living docs)

**MkDocs config:** Material theme, search plugin only. Nav structure mirrors directory layout. No hosting requirement — `mkdocs serve` for local browsing.

### 2. PR Template

Minimal. One functional field:

```markdown
## Spec: <!-- link to docs/specs/ or N/A -->
```

Everything else (what, why, risk, test evidence, change size) is inferred by the AI reviewer from the diff, commit messages, and linked spec. The spec link is the only thing the AI can't derive on its own.

The template exists to:
- Give the stark-review agent a machine-readable pointer to the spec
- Create a moment of reflection: "should I have written a spec for this?"

### 3. Spec-Aware Reviews in stark-review

Closes the loop between specs and code reviews. Two-tier resolution:

**Tier A — Agent-side (default):** Each stark-review agent prompt gets an instruction block: "Check the PR description for a spec link. If found, fetch and read the spec. Validate: does the implementation match the spec's goals? Does it respect the non-goals? Are there gaps between what was specified and what was built? Note deviations — not necessarily as problems, but as 'the spec said X, the implementation does Y, was this intentional?'"

**Tier B — Orchestrator fallback:** If agents can't resolve the spec (relative path, broken URL, access issue), `multi_review.py` resolves it before dispatching. Reads the PR description, extracts the spec path, reads the file content, injects it into each agent's prompt as additional context.

**Failure behavior:**
- Spec linked but unresolvable by both A and B → orchestrator injects a note telling the agent to flag the broken spec reference
- Spec field is "N/A" → normal review; agent auto-detects change size from diff and flags if the change looks non-trivial enough to warrant a spec
- Spec field missing entirely → **red flag**. Review proceeds but opens with a warning that the PR template wasn't followed. This is a process failure, not a judgment call.

### 4. ADR System

Architecture Decision Records per repo, immutable once accepted.

**Template (`docs/adr/0000-template.md`):**

```markdown
# NNNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Superseded by [NNNN]

## Context
<!-- What's the situation that requires a decision? -->

## Decision
<!-- What did you decide? -->

## Alternatives Considered
<!-- What else did you consider and why did you reject it? -->

## Consequences
<!-- What follows from this decision? Both positive and negative. -->
```

**Rules:**
- Sequential numbering, never reuse numbers
- Once accepted, the file is never modified except to update Status to "Superseded by NNNN"
- The superseding ADR links back with "Supersedes NNNN"
- ADRs are referenced from PRs and specs — when a reviewer sees a surprising choice, the ADR link explains why
- stark-review agents can cross-reference ADRs from `docs/adr/` when reviewing; contradicting an accepted ADR without superseding it is a flag

### 5. Staleness Detection

CI check (GitHub Action) that runs on every PR. Warns but does not block.

**Scope:** Only living docs are checked:
- `docs/guides/` — checked
- `docs/reference/` — checked
- `docs/architecture/` — checked
- `docs/adr/` — excluded (immutable by design)
- `docs/specs/` — excluded (point-in-time artifacts)
- `docs/plans/` — excluded (point-in-time artifacts)

**Threshold:** 3 months default, configurable per repo via `.doc-staleness.yml`. Staleness is determined by the git commit timestamp of the last modification to the file (`git log -1 --format=%ct -- <file>`).

```yaml
threshold_days: 90
exclude_paths:
  - docs/adr/
  - docs/specs/
  - docs/plans/
```

**Output:** Single PR comment listing stale files:

```
Stale docs detected (not updated in 3+ months):
- docs/guides/setup-local-dev.md (last updated 2025-12-12)
- docs/reference/api-config.md (last updated 2025-11-03)

These may be outdated. Consider reviewing them if your changes affect related areas.
```

### 6. `/init-docs` Skill

Claude Code skill with four modes, combinable:

- `/init-docs` — shows options, asks which mode
- `/init-docs --template` — scaffolds empty structure + templates (dirs, ADR template, mkdocs.yml, PR template, CODEOWNERS, .doc-staleness.yml). No content, just skeleton. Idempotent.
- `/init-docs --backfill` — scaffolds structure AND generates docs from repo history. Reads `git log`, merged PRs via `gh pr list --state merged`, analyzes codebase. Infers ADRs from technology choices, generates specs from significant merged PRs, creates guides from CI configs/scripts/Makefiles. Wires everything into mkdocs.yml nav. Commits.
- `/init-docs --upgrade` — migrates existing docs into the standard structure. Scans for docs anywhere in the repo, classifies each (spec, ADR, guide, reference, architecture), moves/renames into standard layout, updates internal links, restructures mkdocs.yml nav if one exists. Uses `git mv` to preserve history.
- `/init-docs --clean` — removes the doc structure (skeleton files, templates, config). Does not delete user-generated content (ADRs, specs, guides). Prompts for confirmation before acting.

**Combinable:** `/init-docs --upgrade --backfill` restructures what exists AND fills in gaps from git history.

**Location:** Skill definition in `stark-review/skill/init-docs/SKILL.md`. Templates in `stark-review/standards/templates/`. Symlinked to `~/.claude/` via `install.sh`.

### 7. "Start Here" Docs

Two entry-point documents, both optimized for scanability and short attention spans:

**Per-repo `docs/index.md`** (generated by `/init-docs`):
- One-screen overview of how docs work in this repo
- Mermaid diagram showing the pipeline: brainstorm → spec → code → PR → review
- Copy-paste commands for common operations
- Progressive disclosure — links to deeper docs, never forces you to read them

**Standards pitch page `standards/index.md`** (in stark-review):
- Why this system exists (one paragraph)
- What you get (bullet list with outcomes, not features)
- How to adopt it (`/init-docs --template` or `--backfill`)
- The pipeline diagram
- Links to templates and examples

**Design principles for both:**
- No wall of text. Short paragraphs (2-3 sentences max)
- Mermaid diagrams over prose for any flow or relationship
- Code blocks you can copy-paste for any action
- Progressive depth — if you want more, click through. If you don't, you're done.
- No jargon without a one-line explanation on first use

## Where This Lives

Everything lives in stark-review, following the existing `global/` → `org/` → `repo/` hierarchy:

```
stark-review/
  standards/
    templates/           # PR template, ADR template, mkdocs.yml scaffold,
                         # .doc-staleness.yml, CODEOWNERS template
    index.md             # "Start Here" pitch page for adopting the system
  skill/
    init-docs/
      SKILL.md           # /init-docs skill definition
  docs/
    specs/
      2026-03-17-dev-docs-management-design.md   # this file
```

`install.sh` symlinks `standards/` to `~/.claude/code-review/standards/`.

## Integration Points

| System | Integration |
|--------|-------------|
| Brainstorming skill | Already generates specs in `docs/specs/`. No change needed. |
| stark-review (PR) | Agent prompts updated to read spec from PR description. Orchestrator fallback for resolution. |
| stark-review-plan | Already reviews spec docs. No change needed. |
| `/init-docs` | New skill. Scaffolds, backfills, upgrades, cleans. |
| GitHub Actions | New workflow for staleness detection. |
| `install.sh` | Extended to symlink `standards/` directory. |

## Open Questions

1. Should the staleness GitHub Action live in stark-review as a reusable workflow, or be scaffolded directly into each repo by `/init-docs`? Default: reusable workflow in stark-review, referenced from each repo.
2. For `--backfill`, how aggressively should it generate ADRs? Default: conservative — only obvious technology choices visible in the codebase (language, framework, database, major libraries). Inferred design patterns are too speculative.
3. Should `--upgrade` handle Confluence pages (fetch and convert to Markdown) or only in-repo docs? Default: in-repo only. Confluence migration is a separate concern.
