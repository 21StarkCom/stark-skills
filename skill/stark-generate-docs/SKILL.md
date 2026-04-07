---
name: stark-generate-docs
description: >-
  Generate/update skill documentation with multi-LLM visualizations. Use for generate docs, update skill docs.
argument-hint: "[--skill <name>] [--all] [--check] [--force]"
disable-model-invocation: true
model: opus
---

# stark-generate-docs

Generate or update skill documentation with enabled-agent visualization competition.

## Arguments

- `/stark-generate-docs` — regenerate docs for skills with changed SKILL.md files
- `/stark-generate-docs --skill <name>` — regenerate one specific skill
- `/stark-generate-docs --all` — regenerate all (alias for `--force`)
- `/stark-generate-docs --check` — check if any docs are stale (no changes)

**Raw input:** `$ARGUMENTS`

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

### Phase 4: Push to stark-data-core

For each skill that was generated, push the updated doc to the database so `/docs` updates immediately without waiting for the 6-hour sync.

```bash
PUSH_SCRIPT="$HOME/git/Evinced/stark-data-core/scripts/push_skill_doc.py"
PUSH_URL="${STARK_DATA_CORE_URL:-https://data-internal.evinced.rocks}"

for skill in <generated skills>; do
  python "$PUSH_SCRIPT" \
    --url "$PUSH_URL" \
    --json-file "$ROOT/docs/skills/$skill/_manifest_entry.json" \
    --source-revision "$(git -C $ROOT rev-parse HEAD)" \
    --source-timestamp "$(git -C $ROOT log -1 --format=%aI)"
done
```

If the push script is not found or the URL is not reachable, log a warning and continue — the scheduled sync will catch up within 6 hours.

### Phase 5: Summary

Report: updated skills, winners, scores, file counts, push results.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| LLM calls fail | Report which failed, continue |
| Playwright missing | Skip screenshots, warn |
| No changes | Report "all up to date" |
| Push to DB fails | Warn, scheduled sync will catch up |
