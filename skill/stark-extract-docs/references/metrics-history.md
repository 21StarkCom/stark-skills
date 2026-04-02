# Phase 7: Metrics & History — stark-extract-docs

## 7.1 Print metrics block

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

## 7.2 Improvement flags

Check and print if applicable:
- Pass 2 extraction count is 0 → "Spec has no extractable knowledge — may be too thin"
- ADR dedup rate > 50% (batch) → "Many overlapping decisions — consider consolidating"
- Missing review artifacts → "No review found — review-derived knowledge unavailable"
- Pass 1 > 70% of total time → "Extraction is the bottleneck"

If none triggered: "No improvement opportunities detected."

## 7.3 Persist history

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
