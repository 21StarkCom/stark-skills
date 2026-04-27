---
name: stark-graph
description: >-
  Code dependency graph: parse, validate, diff, and audit docstring annotations.
  Wires graph context into PR reviews and checks blast radius for changed modules.
argument-hint: "[validate|audit|diff|pr <number>] [--repo PATH] [--dry-run]"
disable-model-invocation: true
model: opus[1m]
revision: 6c5b36c238a467e43b6a29d0cad9e6ec37f641a7
revision_date: 2026-04-07T23:23:58+03:00
---

# stark-graph

Dependency graph pipeline for the current repository. Parses `Depends:`, `Publishes:`, and `Called by:` docstring annotations, validates coverage and staleness, computes blast radius for diffs, and wires graph context into PR reviews.

## Arguments

- *(no argument)* — run full pipeline: parse → validate → audit report
- `validate` — parse graph and check for STALE, MISSING, and NO_DOCSTRING violations
- `audit` — human-readable docstring coverage report (always exits 0)
- `diff` — compute blast radius between HEAD and base branch
- `pr <number>` — run diff against the PR's base branch and show blast radius
- `--repo PATH` — override repo root (default: current directory)
- `--dry-run` — print commands, do not execute

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
STARK_GRAPH = $SCRIPTS/stark_graph.py
```

## Phase 1: Setup

1. Parse `$ARGUMENTS` to determine the sub-command:
   - If first token is `validate`, `audit`, `diff`, or `pr`, use that as the stage.
   - Otherwise default to running parse + validate + audit in sequence.
2. Detect repo root if `--repo` not specified:
   ```bash
   REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
   ```
3. If sub-command is `pr`, detect base branch:
   ```bash
   PR_NUM=$(echo "$ARGUMENTS" | grep -oP '(?<=pr )\d+')
   BASE=$(gh pr view $PR_NUM --json baseRefName --jq .baseRefName)
   ```

## Phase 2: Run

### `/stark-graph` (default — parse + validate + audit)

```bash
$PYTHON $STARK_GRAPH --stage parse --repo $REPO
$PYTHON $STARK_GRAPH --stage validate --repo $REPO
$PYTHON $STARK_GRAPH --stage audit --repo $REPO
```

Parse prints a status JSON. Validate exits 1 if errors found (strict mode). Audit always exits 0.

### `/stark-graph validate`

```bash
$PYTHON $STARK_GRAPH --stage validate --repo $REPO
```

Exit codes:
- `0` — no errors (warnings may still be present)
- `1` — validation errors found (STALE, MISSING, or NO_DOCSTRING)
- `2` — setup error (shallow clone, bad workdir, injection attempt)

### `/stark-graph audit`

```bash
$PYTHON $STARK_GRAPH --stage audit --repo $REPO
```

Human-readable report. Always exits 0.

### `/stark-graph diff`

```bash
BASE=$(git rev-parse HEAD~1 2>/dev/null || echo "main")
$PYTHON $STARK_GRAPH --stage diff --repo $REPO --base $BASE
```

Output is JSON with `added_nodes`, `removed_nodes`, `added_edges`, `removed_edges`, and `blast_radius` (direct, transitive, event_subscribers, depth_cap_reached).

### `/stark-graph pr <number>`

```bash
BASE=$(gh pr view $PR_NUM --json baseRefName --jq .baseRefName)
$PYTHON $STARK_GRAPH --stage diff --repo $REPO --pr $PR_NUM --base $BASE
```

Same JSON output as `diff` but scoped to the PR's changes.

## Phase 3: Present Results

### Validate output

Present a summary table:

```
Graph Validation — <repo>
──────────────────────────
Nodes:    <node_count>
Edges:    <edge_count>
Errors:   <N> (STALE, MISSING, NO_DOCSTRING)
Warnings: <N>

Errors to fix:
  1. [STALE] module.function — Depends: target no longer exists
  2. [MISSING] module.function — no docstring annotation found
```

For each error, show the file path and the quick-fix from `docs/docstring-convention.md`.

### Diff / PR blast radius output

```
Blast Radius — PR #<N> (<base>..HEAD)
──────────────────────────────────────
Added nodes:   <N>
Removed nodes: <N>
Added edges:   <N>
Removed edges: <N>

Direct dependents (<N>):
  - module.function
  - ...

Transitive dependents (<N>)  [depth cap: yes/no]:
  - module.function
  - ...
```

If blast radius is large (>20 transitive nodes), flag as high-risk and suggest running `/stark-team-review`.

## Observability

```
[stark-graph] === stark-graph started ===
[stark-graph] Phase 1: Setup — repo: /path/to/repo, stage: validate
[stark-graph] Phase 2: Running validate
[stark-graph] Phase 3: 3 errors, 2 warnings
[stark-graph] === stark-graph completed ===
```

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Exit 2 (setup error) | Check `--repo` path; ensure repo is not a shallow clone |
| Exit 1 (validate errors) | See Phase 3 for list; fix annotations per `docs/docstring-convention.md` |
| `gh` not found | Install GitHub CLI or pass `--base` explicitly for diff stage |
| No `.py` files found | Repo may not use Python; check `--include` patterns |
| Worktree creation fails | Ensure no pending changes block `git worktree add`; run `git stash` first |
