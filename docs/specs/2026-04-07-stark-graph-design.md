# stark-graph — Code Dependency Graph System

**Date:** 2026-04-07
**Status:** Design
**Approach:** B — Pluggable Pipeline
**Schema Version:** 1
**MVP Target:** stark-showcase backend (full vertical slice)

## Problem

Code review agents lack structural awareness. They review diffs in isolation without understanding how changes propagate through the dependency graph. This leads to missed blast radius, undetected breaking changes to consumers, and no validation that documented dependencies match reality.

## Solution

A pluggable pipeline that:
1. Parses source code (AST) and docstrings to build a hierarchical dependency graph
2. Validates declared dependencies (docstrings) match actual dependencies (AST) — strict, CI-blocking
3. Diffs the graph between main and PR branches to surface dependency changes
4. Enriches review agent prompts with graph context for blast radius awareness
5. Posts dependency change summaries as PR comments

## Alternatives Considered

- **Approach A — Monolithic Script:** Single file handling parse/validate/diff/render. Simple to build, but adding a second language or repo requires rewriting. Rejected for poor extensibility.
- **Approach C — LSP-Backed Graph:** Use Pyright/tsserver for type-aware dependency resolution. Most accurate, but LSP startup overhead (2-5s), hard dependency on language servers in CI, and per-project-only scope (no cross-repo). Rejected for CI complexity.

## Graph Model

Hierarchical graph with two node layers (MVP) and typed edges. One JSON file per repo stored as a CI artifact (not committed to repo), merged at query time for cross-repo views (Phase 2).

### Node

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | `"repo:relative_path"` for modules, `"repo:relative_path:ClassName"` for classes |
| `layer` | enum | yes | `module` or `class` (MVP); `function` added in Phase 2 |
| `parent` | string | no | Parent node ID. Null for modules, module ID for classes |
| `depends` | list[string] | no | Parsed from `Depends:` docstring field. Qualified names (see Parsing Rules). |
| `publishes` | list[string] | no | Parsed from `Publishes:` docstring field. Event names (trust-only). |
| `called_by` | list[string] | no | Parsed from `Called by:` docstring field. Informational only in MVP — not strictly validated. |
| `file_path` | string | yes | Repo-relative path |
| `line` | int | yes | Line number of definition |

### Edge

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | yes | Full node ID |
| `target` | string | yes | Full node ID |
| `type` | string | yes | One of: `imports`, `inherits`, `depends`. Open string — unknown types accepted by consumers with default styling. |
| `origin` | enum | yes | `ast` or `docstring` — how we discovered this edge |

Edge types are an open set. MVP uses `imports`, `inherits`, and `depends`. Phase 2 may add `publishes`, `subscribes`, `calls`. Consumers must ignore unknown types gracefully.

### Graph Envelope

```json
{
  "schema_version": "1",
  "repo": "GetEvinced/stark-showcase",
  "generated": "2026-04-07T13:00:00Z",
  "commit_sha": "abc1234",
  "parser": "python:1.0",
  "nodes": [],
  "edges": []
}
```

`schema_version` is a semver major version. Consumers reject graphs with an unrecognized major version. Additive fields within a version are safe; breaking changes bump the version. Migration: re-run parser on the repo.

### Node ID Format

`repo:relative_path` for modules, `repo:relative_path:qualname` for classes.

- Module: `GetEvinced/stark-showcase:backend/showcase/services/version_service.py`
- Class: `GetEvinced/stark-showcase:backend/showcase/services/version_service.py:VersionService`

Module IDs use exactly two segments (repo:path). Class IDs use three (repo:path:classname). This is unambiguous and consistent.

### Repo Identity

Derived from `git remote get-url origin`, normalized to `org/repo` format (e.g., `GetEvinced/stark-showcase`). Override with `--repo-name` CLI flag for non-standard remotes or monorepo subpaths.

## Docstring Convention

Structured metadata in docstrings that parsers extract and drift detection validates. Required for classes and modules.

### Class-level (required)

```python
class VersionService:
    """Manage version lifecycle for projects.

    Depends: showcase.services.gcs_storage.GCSStorage, showcase.repositories.project.ProjectRepository
    Publishes: version.created, version.activated
    Called by: showcase.services.upload_pipeline.UploadPipeline
    """
```

### Module-level (required)

```python
"""Upload pipeline orchestrator.

Depends: showcase.services.version_service, showcase.services.gcs_storage
Publishes: upload.started, upload.completed
"""
```

### Metadata Fields

| Field | Meaning | Validation | MVP Strictness |
|-------|---------|------------|----------------|
| **Depends** | Services/modules this unit calls or instantiates | Cross-checked against `import` statements | **Strict** — CI-blocking |
| **Publishes** | Events, signals, or side effects | Trust-only — not import-traceable. Flagged if removed. | **Trust-only** |
| **Called by** | Reverse edges — who consumes this | Informational — helps reviewers but not strictly validated in MVP | **Informational** |

### Parsing Rules

- Fields are case-insensitive: `depends:`, `Depends:`, `DEPENDS:` all match
- Values are comma-separated: `Depends: A, B, C`
- **Values use qualified names** (dotted module path or module.ClassName) — not short names. This avoids ambiguity when multiple classes share a name.
- If a qualified name resolves to exactly one node, it matches. If it resolves to zero or multiple nodes, the validator reports an error with candidates.
- Fields can appear anywhere in the docstring after the summary line
- Missing docstring on a class/module = drift violation (NO_DOCSTRING)

### Suppression

Individual nodes can be excluded from strict validation with `# stark-graph: ignore` on the class/module definition line:

```python
class GeneratedProto:  # stark-graph: ignore
    """Auto-generated, no docstring required."""
```

Suppressed nodes are tracked in the validation report under a `suppressed` field.

## Parser Interface

Each language parser implements one protocol:

```python
class Parser(Protocol):
    def parse(self, paths: list[Path], repo: str) -> Graph: ...
    def language(self) -> str: ...
    def file_patterns(self) -> list[str]: ...  # e.g. ["*.py"]
```

### Python Parser (MVP)

Uses the `ast` module. MVP scope is **module and class nodes only** (function-level deferred to Phase 2). Extracts:
- **Module nodes:** one per `.py` file
- **Class nodes:** `ast.ClassDef` — parent is the module
- **Import edges:** `ast.Import`, `ast.ImportFrom` → `imports` edge type, origin `ast`
- **Inheritance edges:** `ast.ClassDef.bases` → `inherits` edge type, origin `ast`
- **Docstring edges:** regex extraction of `Depends:` → `depends` edge type, origin `docstring`

**Error handling:** Files that fail `ast.parse()` (syntax errors, encoding issues) are skipped with a WARNING log entry. Empty files and `__init__.py` with no classes produce module nodes only. Files above 500KB are skipped (likely generated). The parser emits a `skipped_files` list in its output for the validation report.

### TypeScript Parser (Phase 2)

Node.js subprocess using `ts-morph` or the TypeScript compiler API. Same output contract — writes Graph JSON to stdout. Must run sandboxed (no network, read-only fs) to prevent RCE from malicious tsconfig.json plugins.

### Limitations

AST parsing cannot detect: dependency injection (constructor params resolved at runtime), `getattr`-based dispatch, factory patterns, framework callbacks. These dependencies must be declared via the `Depends:` docstring field. Blast radius counts should be labeled as "confirmed minimum" rather than absolute totals.

## Pipeline Stages

Four stages in MVP (parse, validate, diff, comment), each a standalone script. Orchestrated by `stark_graph.py` which chains them in sequence. Phase 2 adds merge and render stages.

### Inter-Stage Data Contract

All stages communicate via JSON files in a working directory (default: `.stark-graph/{slug}/`):

```
.stark-graph/
├── parse-python.json        # Stage 1 output
├── graph.json               # Stage 2 output (= parse output for single-language MVP)
├── validation.json           # Stage 3 output
├── diff.json                 # Stage 4 output
└── render/                   # Stage 5 output (Phase 2)
    └── graph.svg
```

Each stage reads from the previous stage's output file and writes its own. The orchestrator passes `--workdir .stark-graph/{pr_or_branch_slug}/` to all stages (e.g., `.stark-graph/pr-123/` or `.stark-graph/feat-upload/`). This prevents working directory collisions when multiple PRs are processed concurrently on the same runner. Stage scripts accept `--input` and `--output` flags for explicit override.

### Error Contract (all stages)

All stages follow this contract:
- **Exit 0:** success, output written
- **Exit 1:** domain failure (drift detected, validation failed) — CI-blocking
- **Exit 2:** infrastructure error (parse crash, network failure, OOM) — triggers graceful degradation
- **Stderr:** JSON error object: `{"stage": "parse", "error": "syntax_error", "file": "foo.py", "message": "..."}`
- **Partial output:** stages that process multiple files may write partial output with a `partial: true` flag in the envelope

The orchestrator behavior on errors:
- Exit 1 from validation → block, post PR comment explaining drift, stop pipeline
- Exit 2 from any stage → warn, post PR comment that graph context is unavailable, proceed with review agents without graph enrichment (graceful degradation)

### Stage 1: Parse (per language)

- Input: list of source files (from `--repo` path), repo identity
- Output: `.stark-graph/parse-python.json` (Graph JSON)
- Scripts: `python_parser.py`
- Per-file timeout: 5s. Files exceeding timeout are skipped with a warning.

### Stage 2: Validate (strict)

For MVP with a single language, the merge step is inlined into the orchestrator (passthrough). A standalone `graph_merge.py` is extracted in Phase 2 when the TS parser introduces real multi-language merge.

Validation runs directly on the parse output:

- Input: `.stark-graph/parse-python.json` (or merged `graph.json` in Phase 2)
- Output: `.stark-graph/validation.json`, exit code 0 (pass) or 1 (fail)
- Script: `drift_validator.py`

Three validation checks (MVP):

| Check | Meaning | Action |
|-------|---------|--------|
| **STALE** | Docstring declares `Depends: X`, AST finds no import of X | CI fail |
| **MISSING** | AST finds `import X`, docstring doesn't declare `Depends: X` | CI fail |
| **NO_DOCSTRING** | Class/module has no structured docstring and is not suppressed | CI fail |

`Called by` cross-validation (`BROKEN_XREF`) is **informational in MVP** — reported but not CI-blocking. Promoted to strict in Phase 2 once the convention is established.

Validation output:

```json
{
  "schema_version": "1",
  "status": "FAIL",
  "stale": [{"node": "GetEvinced/stark-showcase:backend/showcase/services/version_service.py:VersionService", "declared": "showcase.indexes.TypesenseIndex", "evidence": null}],
  "missing": [{"node": "GetEvinced/stark-showcase:backend/showcase/services/version_service.py:VersionService", "actual": "showcase.jobs.ReaperJob", "declared": null}],
  "broken_xref": [],
  "no_docstring": ["GetEvinced/stark-showcase:backend/showcase/utils/helpers.py"],
  "suppressed": ["GetEvinced/stark-showcase:backend/showcase/proto/generated_pb2.py"],
  "skipped_files": ["backend/showcase/vendor/large_lib.py"],
  "coverage": {"modules": 12, "with_docstring": 10, "pct": 83.3}
}
```

All node references use full node IDs. Display names are for human readability only.

### Stage 3: Diff

- Input: base branch Graph JSON + PR branch Graph JSON
- Output: `.stark-graph/diff.json`
- Script: `graph_differ.py`

**Base graph acquisition:** The orchestrator checks out the base branch in a temporary git worktree, runs the parser, and produces the base graph. The PR branch graph is from Stage 1. Both graphs are identified by commit SHA in their envelope.

```json
{
  "schema_version": "1",
  "base_sha": "abc1234",
  "head_sha": "def5678",
  "added_edges": [{"source": "...:VersionService", "target": "...:ReaperJob", "type": "depends"}],
  "removed_edges": [{"source": "...:VersionService", "target": "...:LegacyIndex", "type": "imports"}],
  "added_nodes": ["GetEvinced/stark-showcase:backend/showcase/jobs/reaper.py:ReaperJob"],
  "removed_nodes": ["GetEvinced/stark-showcase:backend/showcase/indexes/legacy.py:LegacyIndex"],
  "blast_radius": {
    "direct": 3,
    "transitive": 7,
    "transitive_depth_cap": 5,
    "depth_cap_reached": false,
    "event_subscribers": 2
  }
}
```

`changed_edges` is deferred to Phase 2 (requires call-site metadata not in the MVP edge model).

### Blast Radius Algorithm

1. Collect all nodes that are sources or targets of added/removed edges → "changed nodes"
2. **Direct:** BFS depth 1 from changed nodes — all immediate callers/importers
3. **Transitive:** BFS up to `transitive_depth_cap` (default 5, configurable). Uses a visited set for cycle safety. If cap reached, `depth_cap_reached: true`
4. **Event subscribers:** For each changed node that has a `publishes` field, find all nodes whose `depends` entries reference a module containing that node. This is an approximation — exact event matching is Phase 2.

### Stage 4: PR Comment

- Input: `.stark-graph/diff.json`, `.stark-graph/validation.json`
- Output: GitHub PR comment via stark-claude[bot]
- Script: `pr_commenter.py`
- Uses existing `github_app.py` auth (stark-claude[bot] GitHub App, per CLAUDE.md)
- **Idempotent:** Finds existing bot comment by a hidden marker (`<!-- stark-graph-comment -->`) and updates in place. No duplicate comments on retry/rerun.
- **Retry:** 3 attempts with exponential backoff (1s, 2s, 4s). Respects `Retry-After` on 429. Per-request timeout 10s. On exhausted retries, exit code 2 (infrastructure error).

Comment format:

```markdown
<!-- stark-graph-comment -->
## Dependency Changes

+ VersionService → ReaperJob (new dependency)
- VersionService → LegacyIndex (removed)

## Blast Radius (confirmed minimum)
Direct: 3 services | Transitive: 7 (depth ≤5) | Event subscribers: 2

<details><summary>Full edge list</summary>

| Source | Target | Type | Change |
|--------|--------|------|--------|
| ...VersionService | ...ReaperJob | depends | added |
| ...VersionService | ...LegacyIndex | imports | removed |

</details>
```

### Stage 5: Render (Phase 2)

Deferred. The PR comment provides sufficient dependency change visibility for MVP. Renderer added when there's a concrete consumer (UI dashboard, Confluence artifact).

## CI Integration

The graph pipeline runs in GitHub Actions as part of the PR review workflow.

```yaml
# .github/workflows/graph-review.yml (sketch)
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  graph:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # full history for worktree-based base graph
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install pydantic
      - run: |
          python stark_graph.py \
            --repo . \
            --pr ${{ github.event.pull_request.number }} \
            --warn  # remove --warn after bootstrap
        env:
          GH_TOKEN: ${{ secrets.STARK_CLAUDE_TOKEN }}
```

**Dependencies:** Python 3.12+, pydantic. No system packages for MVP (graphviz only needed in Phase 2).

**Skipped files and coverage:** If the parser skips files (syntax errors, size limits, timeouts), the validation report includes `skipped_files` and the coverage percentage reflects only successfully parsed files. If coverage drops below a configurable threshold (default 80%), the pipeline posts a warning comment. This prevents silent coverage erosion.

## Review Integration

Graph feeds into the existing review pipeline at two points.

### Pre-Review Gate

`drift_validator.py` runs before `multi_review.py`. Behavior by exit code:
- **Exit 0:** validation passed → proceed to review
- **Exit 1:** drift detected → post validation report as PR comment, skip review (no tokens wasted)
- **Exit 2:** infrastructure error → post warning comment, proceed with review without graph context

### Domain Enrichment

Graph diff JSON is injected into the system prompts for review domains configured in `graph_enriched_domains` (config.json). Default: `["architecture", "correctness", "regression-prevention"]`.

The diff is appended as a `## Dependency Context` section. **Size budget:** max 2000 tokens per prompt injection. If the diff exceeds the budget, include only added/removed edges (not transitive) and link to the full PR comment.

## Prompt Injection Safety

Repository content (docstrings, symbol names, file paths) flows into review agent prompts and PR comments. Mitigations:
- Docstring metadata values are constrained to a strict grammar: `[a-zA-Z0-9_.]+` for qualified names, `[a-zA-Z0-9_.]+` for event names. Values not matching the grammar are rejected by the parser.
- All values are JSON-encoded before prompt insertion
- HTML/SVG/Markdown-escaped before rendering
- PR comment content is sanitized via GitHub's own markdown renderer (no raw HTML)

## File Structure

```
scripts/
├── graph/                        # all graph pipeline scripts
│   ├── __init__.py
│   ├── model.py                  # Graph, Node, Edge Pydantic models + validation
│   ├── python_parser.py          # Python AST + docstring parser
│   ├── drift_validator.py        # AST vs docstring strict check
│   ├── graph_differ.py           # base vs PR graph diff + blast radius
│   └── pr_commenter.py           # post diff + blast radius to PR (idempotent)
├── stark_graph.py                # pipeline orchestrator (CLI entry point)

skill/
└── stark-graph/
    └── SKILL.md                  # /stark-graph skill wrapper
```

## /stark-graph Skill

The skill wraps `stark_graph.py` for agent invocation:

| Command | Behavior |
|---------|----------|
| `/stark-graph` | Full pipeline on current repo (parse → validate → diff → comment) |
| `/stark-graph validate` | Parse + validate only (drift check, no diff/comment) |
| `/stark-graph audit` | Parse + report missing docstrings (no CI blocking) |
| `/stark-graph diff` | Parse + diff against main (no comment posting) |
| `/stark-graph pr 123` | Full pipeline targeting PR #123 |

## CLI Interface

```bash
# Full pipeline on a repo
stark_graph.py --repo /path/to/stark-showcase/backend

# Parse only (outputs Graph JSON to stdout)
stark_graph.py --repo /path/to/repo --stage parse

# Validate only (exits 1 on drift)
stark_graph.py --repo /path/to/repo --stage validate

# Audit mode — report missing docstrings, no CI blocking (exit 0 always)
stark_graph.py --repo /path/to/repo --stage audit

# Diff against main
stark_graph.py --repo /path/to/repo --stage diff --base main

# Warn mode — validate but exit 0 even on drift (for phased rollout)
stark_graph.py --repo /path/to/repo --stage validate --warn

# Full PR pipeline (validate + diff + comment)
stark_graph.py --repo /path/to/repo --pr 123

# Full PR pipeline in warn mode (post comment but don't block)
stark_graph.py --repo /path/to/repo --pr 123 --warn

# Override repo identity
stark_graph.py --repo /path/to/repo --repo-name GetEvinced/stark-showcase
```

### `--warn` Mode

When `--warn` is passed, the pipeline runs identically but:
- `drift_validator.py` exits 0 instead of 1 on drift findings
- PR comment is prefixed with `⚠️ Warn mode — findings reported but not blocking`
- The validation JSON includes `"mode": "warn"` for metrics tracking
- All other stages (diff, comment) run normally

This allows teams to measure false positive rates during bootstrap without blocking PRs. Promote to strict mode by removing `--warn` once the rate is acceptable.

## Testing Strategy

### Unit Tests

| Component | Tests |
|-----------|-------|
| `model.py` | Pydantic model validation: required fields, optional defaults, schema version rejection |
| `python_parser.py` | Fixture files: valid module, class with docstring, class without docstring, syntax error file, empty file, `__init__.py`, file >500KB, encoding issues |
| `drift_validator.py` | One fixture per check type: STALE, MISSING, NO_DOCSTRING, clean (zero findings), suppressed node. Assert exact JSON output per fixture. |
| `graph_differ.py` | Fixture graph pairs: added edge, removed edge, added node, removed node, cycle (no infinite loop), depth cap reached |
| `pr_commenter.py` | Mock GitHub API: idempotent update, retry on 429, timeout handling |

### Integration Tests

- Full pipeline on a fixture repo (committed to `tests/fixtures/graph/`): parse → validate → diff. Assert intermediate JSON files validate against Pydantic models.
- Blast radius on a fixture graph with known cycle: verify no infinite loop, verify counts match expected.

### Acceptance Criteria

| Component | Criterion |
|-----------|-----------|
| Python parser | Extracts 100% of class and module nodes from stark-showcase backend (verified by manual spot-check of 5 files) |
| Drift validator | False positive rate <5% on bootstrapped stark-showcase codebase (measured during --warn rollout phase) |
| Full pipeline | Completes in <30s on stark-showcase backend (~50 Python files) on a standard CI runner |
| PR comment | Correctly shows added/removed edges for a test PR with known dependency changes |

## Capacity Baseline

Expected for stark-showcase backend MVP:
- **Files:** ~50 Python files
- **Nodes:** ~50 modules + ~80 classes = ~130 nodes
- **Edges:** ~200 import edges + ~50 docstring depends edges = ~250 edges
- **Graph JSON size:** ~50-100KB
- **Parse time:** <5s (sequential, single-threaded sufficient for MVP scale)
- **Full pipeline:** <30s target including worktree checkout for base graph
- **PR frequency:** ~5-10 PRs/day

At this scale, sequential parsing, in-memory graph, and full re-parse per PR are acceptable. Incremental parsing (Phase 2) is needed when file count exceeds ~500.

## MVP Scope — stark-showcase backend

Full vertical slice on one repo. Everything works end-to-end before generalizing.

### In Scope
- Python parser (ast module, module + class level)
- Graph model (Pydantic, schema_version)
- Drift validator (strict for Depends, informational for Called by)
- Graph differ (base vs PR with blast radius)
- PR comment posting (idempotent, with retry)
- Review domain enrichment (configurable domain list)
- `/stark-graph` skill
- Docstring convention docs
- Fixture-based test suite
- `--audit` mode for bootstrap
- `--warn` mode for phased rollout

### Phase 2
- TypeScript parser (sandboxed)
- Function-level nodes and `calls` edges
- Cross-repo graph merge (`graph_merge.py` extracted)
- `changed_edges` in diff output
- `Called by` strict validation (BROKEN_XREF)
- SVG/HTML renderer with accessible markup
- Weekly LLM audit agent
- Incremental parsing (cache by commit SHA)
- Interactive D3 explorer
- Coverage metrics CI artifact

### Out of Scope
- LSP integration
- Runtime tracing
- Go/Java/other language parsers
- Graph database storage
- Historical graph diffing (beyond base vs PR)

## Bootstrap Strategy

Existing code in stark-showcase has no structured docstrings. Bootstrap path:

1. **Audit:** Run `stark_graph.py --repo ... --stage audit` — generates a report of all classes/modules missing docstrings. Output is plain text + JSON (accessible to all reviewers).
2. **Generate drafts:** LLM agent reads each class, infers dependencies from AST, generates draft docstrings. Uses the same LLM already authorized for code review (no new data boundary).
3. **Human review:** Developer reviews draft docstrings in a PR. Docstrings are pure metadata (class/module names, event names) — no proprietary logic exposed.
4. **Warn mode:** Enable `stark_graph.py --warn` in CI for 1-2 sprints. Reports violations without failing CI. Measure false positive rate.
5. **Strict mode:** When false positive rate <5%, enable strict validation. Start with a subset of directories if needed (`--include backend/showcase/services/`).

Recovery: if a bootstrapped docstring is incorrect, any developer can fix it. `# stark-graph: ignore` provides an escape hatch for nodes that are hard to document (generated code, metaprogramming).
