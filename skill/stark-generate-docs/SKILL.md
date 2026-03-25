---
name: stark-generate-docs
description: >
  Generate or update skill documentation with multi-LLM visualizations.
  Detects which SKILL.md files changed, regenerates docs for those skills,
  and commits the results. Use when the user says "generate docs",
  "update skill docs", "regenerate viz", or invokes /stark-generate-docs.
  Proactively use when a SKILL.md has been modified in the current session.
argument-hint: "[--skill <name>] [--all] [--check] [--force]"
---

# stark-generate-docs

Generate or update skill documentation with multi-LLM visualization competition.

## Arguments

- `/stark-generate-docs` — regenerate docs for skills with changed SKILL.md files
- `/stark-generate-docs --skill <name>` — regenerate one specific skill
- `/stark-generate-docs --all` — regenerate all (alias for `--force`)
- `/stark-generate-docs --check` — check if any docs are stale (no changes)

## Constants

```
ROOT = <repo root of stark-skills>
```

## Workflow

### Phase 1: Detect Changes

If `--skill` or `--all` specified, skip detection.

Otherwise:

```bash
python $ROOT/scripts/generate_skill_docs.py --check
```

If exit 0: "All skill docs are up to date." Done.
If exit 1: capture stale skill names.

### Phase 2: Generate

```bash
python $ROOT/scripts/generate_skill_docs.py [--skill <name> | --force]
```

Report progress per skill.

### Phase 3: Commit

```bash
cd $ROOT
git add docs/skills/
git commit -m "docs: update skill documentation — <list of skills>"
```

### Phase 4: Summary

Report: updated skills, winners, scores, file counts.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| LLM calls fail | Report which failed, continue |
| Playwright missing | Skip screenshots, warn |
| No changes | Report "all up to date" |
