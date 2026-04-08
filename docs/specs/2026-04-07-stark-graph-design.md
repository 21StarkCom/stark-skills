# stark-graph — Code Dependency Graph & Docstring Pipeline

**Date:** 2026-04-07 (revised 2026-04-08)
**Status:** Design
**Approach:** B — Pluggable Pipeline
**Schema Version:** 1
**MVP Target:** stark-showcase backend (full vertical slice)

## Problem

Code review agents lack structural awareness. They review diffs in isolation without understanding how changes propagate through the dependency graph. This leads to missed blast radius, undetected breaking changes to consumers, and no validation that documented dependencies match reality.

Additionally, docstrings across the codebase are inconsistent, incomplete, or absent. Manual docstring maintenance doesn't scale — developers forget to update them when dependencies change, and there's no enforcement mechanism. The result is documentation that drifts from reality, which is worse than no documentation at all.

## Solution

A pluggable pipeline with two complementary subsystems:

### Dependency Graph (validation + blast radius)

1. Parses source code (AST) and docstrings to build a hierarchical dependency graph
2. Validates declared dependencies (docstrings) match actual dependencies (AST) — strict, CI-blocking
3. Diffs the graph between main and PR branches to surface dependency changes
4. Enriches review agent prompts with graph context for blast radius awareness
5. Posts dependency change summaries as PR comments

### Docstring Generation (deterministic + LLM-assisted)

1. Extracts structural metadata from code deterministically (AST, types, signatures)
2. Classifies symbols by importance to decide generation strategy
3. Generates docstrings using templates for simple cases, LLM only for semantic synthesis
4. Validates generated output against deterministic correctness checks
5. Enforces freshness and completeness in CI

The generation subsystem feeds the validation subsystem: generated docstrings include `Depends:` annotations that the drift validator then enforces.

## Alternatives Considered

- **Approach A — Monolithic Script:** Single file handling parse/validate/diff/render. Simple to build, but adding a second language or repo requires rewriting. Rejected for poor extensibility.
- **Approach C — LSP-Backed Graph:** Use Pyright/tsserver for type-aware dependency resolution. Most accurate, but LSP startup overhead (2-5s), hard dependency on language servers in CI, and per-project-only scope (no cross-repo). Rejected for CI complexity.
- **Approach D — LLM-Driven Docstrings:** Let the model read source and generate complete docstrings from scratch. High hallucination risk, expensive, hard to validate, non-deterministic output. Rejected — the model should fill slots, not write free-form prose.

## Architecture Principles

Ten rules that govern the pipeline design:

1. **Do not ask the LLM to do extraction.** Never let the model infer things that code can extract exactly. Parameters, types, exceptions, decorators, visibility — all come from AST.
2. **Generate docstrings only for code that matters.** Skip trivial private helpers, one-line wrappers, obvious getters/setters, generated code, migrations, test helpers.
3. **Use a template-first system.** The LLM fills slots in a canonical skeleton, not free-form text. Many functions need zero LLM.
4. **Make "no guess" a hard rule.** When confidence is low, emit a minimal docstring or skip. Never invent.
5. **Separate correctness from readability.** Correctness is deterministic (params covered, return documented). Semantic confidence is separate (summary consistent with tests/callers).
6. **Run generation at change boundaries.** Pre-commit locally, PR CI for changed files, nightly for full-repo reconciliation.
7. **Put most logic in repo-owned code.** Parser, extractor, normalizer, scorer, detector, annotator — all in code. The model is a replaceable subroutine.
8. **Use GitHub Actions as the policy gate.** Regenerate, validate, diff, comment, fail — all in CI.
9. **Use GCP only where centralization is worth it.** Start in Actions; move generation to GCP only when scale demands it.
10. **Version prompts and outputs like build artifacts.** Prompt version, model version, schema version, confidence score — all tracked.

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
| **Depends** | Intra-repo services/modules this unit calls or instantiates | Cross-checked against intra-repo `import` statements (stdlib and third-party imports are excluded from validation) | **Strict** — CI-blocking |
| **Publishes** | Events, signals, or side effects | Trust-only — not import-traceable. Removal visible in diff output but not CI-blocking. | **Trust-only** |
| **Called by** | Reverse edges — who consumes this | Informational — helps reviewers but not strictly validated in MVP | **Informational** |

### Parsing Rules

- Fields are case-insensitive: `depends:`, `Depends:`, `DEPENDS:` all match
- Values are comma-separated: `Depends: A, B, C`
- **Values use qualified names** (dotted module path or module.ClassName) — not short names. This avoids ambiguity when multiple classes share a name.
- If a qualified name resolves to exactly one node, it matches. If it resolves to zero or multiple nodes, the validator reports an error with candidates.
- Fields can appear anywhere in the docstring after the summary line
- Missing docstring on a class/module = drift violation (NO_DOCSTRING)

### Suppression

Individual nodes can be excluded from strict validation:

**Class-level:** `# stark-graph: ignore` on the class definition line:

```python
class GeneratedProto:  # stark-graph: ignore
    """Auto-generated, no docstring required."""
```

**Module-level:** `# stark-graph: ignore` as the first comment in the file (before the module docstring):

```python
# stark-graph: ignore
"""Auto-generated protobuf bindings — no structured docstring required."""
```

Suppressed nodes are tracked in the validation report under a `suppressed` field.

## Extraction Layer

The extraction layer builds a structured payload for each symbol using deterministic code analysis. This payload is the primary input for both template generation and LLM enrichment — the model never sees raw source directly. For Protected-tier symbols, additional structured context (test names, caller patterns) is appended alongside the payload (see Stage 3).

### What Code Extracts

| Data | Source | Notes |
|------|--------|-------|
| Parameter names | `ast.arguments` | Positional, keyword, *args, **kwargs |
| Type hints | `ast.arg.annotation`, `ast.FunctionDef.returns` | Evaluated as strings, not types |
| Default values | `ast.arguments.defaults` | Repr'd for display |
| Raised exceptions | `ast.Raise` nodes | Only explicit `raise X` — not runtime |
| Async/generator status | `ast.AsyncFunctionDef`, `ast.Yield` | Binary flags |
| Decorators | `ast.FunctionDef.decorator_list` | Full decorator expression |
| Overloads | `@typing.overload` detection | Grouped by function name |
| Return annotation | `ast.FunctionDef.returns` | String repr |
| Visibility | Name prefix (`_` private, `__` dunder) | Plus `__all__` membership |
| Base classes | `ast.ClassDef.bases` | For inheritance edges |
| Import graph | `ast.Import`, `ast.ImportFrom` | Resolved to qualified names |
| Existing docstring | `ast.get_docstring()` | Preserved if present |
| Complexity signals | Statement count, branch count, call count | For classification |

### Structured Payload

Each symbol produces a JSON payload:

```json
{
  "name": "fetch_user",
  "qualified_name": "showcase.services.user_service.UserService.fetch_user",
  "visibility": "public",
  "kind": "method",
  "is_async": false,
  "is_generator": false,
  "signature": "(self, user_id: str, include_deleted: bool = False) -> User | None",
  "params": [
    {"name": "user_id", "type": "str", "default": null},
    {"name": "include_deleted", "type": "bool", "default": "False"}
  ],
  "return_type": "User | None",
  "raises": ["UserNotFoundError", "DatabaseError"],
  "decorators": [],
  "calls": ["self._repo.get_by_id", "self._cache.invalidate"],
  "base_classes": [],
  "imports": ["showcase.repositories.user.UserRepository"],
  "existing_docstring": null,
  "complexity": {"statements": 12, "branches": 3, "calls": 4},
  "file_path": "backend/showcase/services/user_service.py",
  "line": 45
}
```

This reduces hallucination and token use. The LLM receives facts, not source code to interpret.

## Symbol Classification

Deterministic heuristics decide what each symbol deserves. Classification happens before any generation.

### Tiers

| Tier | Criteria | Generation Strategy |
|------|----------|-------------------|
| **Skip** | Private + trivial (≤3 statements), one-line wrappers, obvious property getters/setters, generated code (`# stark-graph: ignore`), migrations, test helpers, `__init__` passthrough | No docstring generated |
| **Template-only** | Public + simple (≤5 statements, ≤1 branch), clear naming, single return path | Deterministic template — zero LLM |
| **LLM-assisted** | Public + non-trivial (>5 statements or >1 branch), unclear intent from name alone | Template skeleton + LLM fills summary/behavior |
| **Protected** | Core/shared APIs, `__all__` exports, cross-module public interfaces | LLM-assisted + stricter confidence threshold + tests in context |

### Classification Rules

```python
def classify(symbol: ExtractedSymbol) -> Tier:
    if symbol.suppressed:
        return Tier.SKIP
    if symbol.visibility == "private" and symbol.complexity.statements <= 3:
        return Tier.SKIP
    if symbol.is_property and symbol.complexity.statements <= 2:
        return Tier.SKIP
    if symbol.kind == "test":
        return Tier.SKIP
    if symbol.visibility == "public" and symbol.complexity.statements <= 5 \
       and symbol.complexity.branches <= 1:
        return Tier.TEMPLATE
    if symbol.in_all:
        return Tier.PROTECTED
    return Tier.LLM_ASSISTED
```

**Consumer count upgrade (optional second pass):** The classifier initially runs without graph data (Stage 2 precedes Stage 5). After the graph is built, an optional promotion pass upgrades symbols with >3 consumers from LLM to Protected tier. This is a refinement — the initial classification is correct without it, just conservative (some Protected symbols may first generate at LLM tier).

The classifier is pure code — no model calls. Override per-symbol with `# stark-graph: tier=skip|template|llm|protected`.

## Template System

Templates produce canonical docstring skeletons. For Tier.TEMPLATE symbols, the skeleton is the final output. For Tier.LLM_ASSISTED and Tier.PROTECTED, the LLM fills slots in the skeleton.

### Skeleton Construction

1. **Summary line** — For templates: derived from function name + verb pattern (`get_X` → "Get X.", `is_X` → "Check whether X.", `create_X` → "Create X."). For LLM tiers: `{{SUMMARY}}` slot.
2. **Args section** — Always deterministic. Built from `params` payload.
3. **Returns section** — Always deterministic. Built from `return_type`.
4. **Raises section** — Always deterministic. Built from `raises` list.
5. **Yields section** — If generator. Deterministic.
6. **Long description** — LLM-only slot `{{DESCRIPTION}}`. Omitted for Template tier.
7. **Examples** — LLM-only slot `{{EXAMPLES}}`. Only for Protected tier.
8. **Notes** — LLM-only slot `{{NOTES}}`. Only for edge cases the LLM flags.

### Example: Zero-LLM Output (Tier.TEMPLATE)

```python
def get_user(self, user_id: str) -> User:
    """Get user.

    Args:
        user_id: The user ID.

    Returns:
        The user.

    Raises:
        UserNotFoundError: If the user is not found.
    """
```

### Example: LLM-Assisted Output (Tier.LLM_ASSISTED)

The LLM receives the structured payload + skeleton and fills only `{{SUMMARY}}` and `{{DESCRIPTION}}`:

```python
def reconcile_versions(self, project_id: str, strategy: MergeStrategy = MergeStrategy.LATEST) -> ReconcileResult:
    """Reconcile divergent version histories for a project.

    Compares all active version branches against the canonical timeline
    and resolves conflicts using the specified merge strategy. Versions
    that cannot be auto-reconciled are marked for manual review.

    Args:
        project_id: The project ID.
        strategy: The merge strategy to use.

    Returns:
        The reconciliation result.

    Raises:
        ProjectNotFoundError: If the project is not found.
        ReconcileConflictError: If auto-reconciliation fails.
    """
```

The Args/Returns/Raises sections are deterministic. The summary and description are LLM-generated.

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

### Python Extractor (Generation)

Extends the parser to produce the full structured payload (see Extraction Layer). Uses the same `ast` module but extracts function-level detail:

```python
class Extractor(Protocol):
    def extract(self, paths: list[Path], repo: str) -> list[ExtractedSymbol]: ...
    def language(self) -> str: ...
```

The extractor and parser are separate scripts with independent AST traversals. This means two passes over the file set, which is acceptable at MVP scale (<5s each). Merging them into a single pass is a Phase 2 optimization if parse time becomes a concern at >500 files.

### TypeScript Parser (Phase 2)

Node.js subprocess using `ts-morph` or the TypeScript compiler API. Same output contract — writes Graph JSON to stdout. Must run sandboxed (no network, read-only fs) to prevent RCE from malicious tsconfig.json plugins.

### Limitations

AST parsing cannot detect: dependency injection (constructor params resolved at runtime), `getattr`-based dispatch, factory patterns, framework callbacks. These dependencies must be declared via the `Depends:` docstring field. Blast radius counts should be labeled as "confirmed minimum" rather than absolute totals.

## Pipeline Stages

Eight stages in the full pipeline (extract, classify, generate, write-back, parse, validate, diff, comment), plus audit as a reporting mode. The orchestrator chains them based on the requested command and auto-resolves prerequisites (e.g., `--stage validate` implicitly runs parse first if parse output is missing). Phase 2 adds merge and render stages.

### Inter-Stage Data Contract

All stages communicate via JSON files in a working directory (default: `.stark-graph/{slug}/`):

```
.stark-graph/
├── extract.json              # Stage 1 output (symbol payloads)
├── classify.json             # Stage 2 output (tiered symbol list)
├── generate-report.json      # Stage 3 output (generation results + confidence)
├── parse-python.json         # Stage 5 output (graph from HEAD)
├── base-parse-python.json    # Stage 5 output (graph from base branch, for diff)
├── graph.json                # Stage 5 output (= parse output for single-language MVP)
├── validation.json           # Stage 6 output
├── diff.json                 # Stage 7 output
└── render/                   # Phase 2
    └── graph.svg

All inter-stage JSON files include a `schema_version` field in their envelope for contract compatibility.
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

### Stage 1: Extract

- Input: list of source files (from `--repo` path), repo identity
- Output: `.stark-graph/extract.json` (list of `ExtractedSymbol` payloads)
- Script: `symbol_extractor.py`
- Per-file timeout: 5s. Files exceeding timeout are skipped with a warning.

Produces the structured payload described in the Extraction Layer section. One pass over the AST, extracting everything code can determine.

### Stage 2: Classify

- Input: `.stark-graph/extract.json`
- Output: `.stark-graph/classify.json` (symbols grouped by tier: skip, template, llm, protected)
- Script: `symbol_classifier.py`

Pure deterministic logic. Applies the classification rules to sort symbols into tiers. Output includes the tier and the reason (for auditability):

```json
{
  "schema_version": "1",
  "symbols": [
    {"qualified_name": "...", "tier": "template", "reason": "public, 3 statements, 0 branches"},
    {"qualified_name": "...", "tier": "llm", "reason": "public, 12 statements, 3 branches"},
    {"qualified_name": "...", "tier": "skip", "reason": "private, 2 statements"}
  ],
  "counts": {"skip": 45, "template": 30, "llm": 18, "protected": 7}
}
```

### Stage 3: Generate

- Input: `.stark-graph/classify.json`, `.stark-graph/extract.json`
- Output: `.stark-graph/generate-report.json` (generated docstrings + metadata)
- Script: `docstring_generator.py`

Three sub-paths:

1. **Template tier:** Build docstring from skeleton + deterministic slot fills. No model call.
2. **LLM tier:** Build skeleton, send structured payload to model, model fills `{{SUMMARY}}` and `{{DESCRIPTION}}` slots. Formatter normalizes output.
3. **Protected tier:** Same as LLM tier but with tests included in context and stricter confidence threshold.

**Low confidence fallback:** If the model returns low-confidence output (vague phrases, invented guarantees, contradictions with the payload), the generator falls back to a minimal deterministic docstring and flags the symbol as `needs-human-intent`.

**LLM call contract:**
- Per-call timeout: 30s (configurable via `docgen_timeout` in config)
- Retry: 2 attempts with exponential backoff (2s, 4s)
- Circuit breaker: after 3 consecutive failures, skip remaining LLM-tier symbols and fall back to templates for the rest of the run. Log the circuit break event.
- Rate limit: respect `Retry-After` headers. If rate-limited, queue remaining symbols and retry after the specified delay.
- On total LLM failure (provider down), the pipeline continues with template-only output for all tiers and exits 0 with a warning in the report. Generation is best-effort — it should never block the graph validation pipeline.

**LLM input redaction:** Before sending the structured payload to the model, strip fields that could leak sensitive information:
- `file_path` is shortened to the last two path segments (e.g., `services/user_service.py`)
- `calls` entries are included only if they reference symbols within the same repo (no external library internals)
- Actual source code is never sent — only the structured payload
- Credentials, environment variable names, and hardcoded strings detected in defaults are replaced with `<REDACTED>`

Output includes per-symbol metadata:

```json
{
  "schema_version": "1",
  "generated": [
    {
      "qualified_name": "...",
      "tier": "template",
      "docstring": "...",
      "correctness_score": 1.0,
      "semantic_confidence": null,
      "generator_version": "1.0",
      "prompt_version": null,
      "model": null,
      "fallback_reason": null
    },
    {
      "qualified_name": "...",
      "tier": "llm",
      "docstring": "...",
      "correctness_score": 1.0,
      "semantic_confidence": 0.85,
      "generator_version": "1.0",
      "prompt_version": "v3",
      "model": "claude-sonnet-4-6",
      "fallback_reason": null
    }
  ],
  "skipped": ["..."],
  "needs_human_intent": ["..."]
}
```

### Stage 4: Write-back

- Input: `.stark-graph/generate-report.json`, source files
- Output: modified source files (in-place), `.stark-graph/writeback-report.json`
- Script: `docstring_writer.py`
- Flag: `--write` (required — write-back is opt-in to prevent accidental source modification)

Writes generated docstrings back into source files using AST-aware insertion (preserves formatting, indentation, and surrounding code). Only writes symbols where the generated docstring differs from the existing one.

**Safety rules:**
- Never overwrites a high-confidence existing docstring with a lower-confidence one (Hard Rule 1)
- Skips symbols flagged as `needs-human-intent`
- Creates a backup of each modified file in `.stark-graph/backup/` before writing

The write-back report records which files were modified and which symbols were updated, skipped, or protected:

```json
{
  "schema_version": "1",
  "modified_files": ["backend/showcase/services/user_service.py"],
  "updated_symbols": 12,
  "skipped_lower_confidence": 2,
  "skipped_needs_human": 3,
  "unchanged": 45
}
```

### Audit Mode

Audit is a reporting mode, not a pipeline stage. It runs parse + validate internally and produces a human-readable coverage report. Always exits 0 regardless of findings.

- Invoked via: `--stage audit` or `/stark-graph audit`
- Internally runs: parse → validate (in-memory, no intermediate files required)
- Output: text report to stdout + `.stark-graph/audit.json`
- Does not modify source files or post PR comments

```json
{
  "schema_version": "1",
  "total_modules": 50,
  "total_classes": 80,
  "with_docstring": 95,
  "coverage_pct": 73.1,
  "missing": ["backend/showcase/utils/helpers.py:HelperClass"],
  "suppressed": ["backend/showcase/proto/generated_pb2.py"]
}
```

### Stage 5: Parse (per language)

- Input: list of source files (from `--repo` path), repo identity
- Output: `.stark-graph/parse-python.json` (Graph JSON)
- Scripts: `python_parser.py`
- Per-file timeout: 5s. Files exceeding timeout are skipped with a warning.

This is the graph parser. Builds the dependency graph from AST and docstring annotations. If write-back ran first (Stage 4), it operates on the already-updated docstrings in source files.

### Stage 6: Validate (strict)

In MVP (single language), no merge step is needed — parse output is passed directly to validation. Phase 2 extracts `graph_merge.py` to merge multi-language parse outputs before validation.

Validation has two sub-systems:

#### Graph Drift Validation

- Input: `.stark-graph/parse-python.json` (or merged `graph.json` in Phase 2)
- Output: `.stark-graph/validation.json`, exit code 0 (pass) or 1 (fail)
- Script: `drift_validator.py`

Three graph-level validation checks (MVP, module/class scope):

| Check | Meaning | Action |
|-------|---------|--------|
| **STALE** | Docstring declares `Depends: X`, AST finds no import of X | CI fail |
| **MISSING** | AST finds `import X` (intra-repo only), docstring doesn't declare `Depends: X` | CI fail |
| **NO_DOCSTRING** | Class/module has no structured docstring and is not suppressed | CI fail |

`Called by` cross-validation (`BROKEN_XREF`) is **informational in MVP** — reported but not CI-blocking. Promoted to strict in Phase 2 once the convention is established.

Validation output:

```json
{
  "schema_version": "1",
  "status": "FAIL",
  "stale": [{"node": "...:VersionService", "declared": "showcase.indexes.TypesenseIndex", "evidence": null}],
  "missing": [{"node": "...:VersionService", "actual": "showcase.jobs.ReaperJob", "declared": null}],
  "broken_xref": [],
  "no_docstring": ["...:backend/showcase/utils/helpers.py"],
  "suppressed": ["...:backend/showcase/proto/generated_pb2.py"],
  "skipped_files": ["backend/showcase/vendor/large_lib.py"],
  "coverage": {"modules": 12, "with_docstring": 10, "pct": 83.3}
}
```

All node references use full node IDs. Display names are for human readability only.

#### Docstring Correctness Validation

Separate from graph drift, this validates generated function/method-level docstrings against AST facts. This ensures the Hard Rule "every changed symbol must be revalidated" applies to all generated tiers, not just graph-tracked nodes.

- Input: `.stark-graph/generate-report.json`, source files
- Output: appended to `.stark-graph/validation.json` under a `correctness` key
- Script: `correctness_validator.py`

Checks per symbol:
- All parameters in signature appear in Args section
- Return type matches Returns section
- All explicit `raise` statements appear in Raises section
- No contradictions between docstring claims and AST facts

Failures are CI-blocking (exit 1). This validator runs only on symbols that were generated or modified — it does not scan the full repo.

### Stage 7: Diff

- Input: base branch Graph JSON (`.stark-graph/base-parse-python.json`) + PR branch Graph JSON (`.stark-graph/parse-python.json`)
- Output: `.stark-graph/diff.json`
- Script: `graph_differ.py`

**Base graph acquisition:** The orchestrator checks out the base branch in a temporary git worktree, runs the parser, and produces the base graph at `.stark-graph/base-parse-python.json`. The PR branch graph is from Stage 5. Both graphs are identified by commit SHA in their envelope.

**Worktree failure handling:** If `git worktree add` fails (e.g., pending changes, locked worktree from prior run), the orchestrator:
1. Attempts cleanup of stale worktrees: `git worktree prune`
2. Retries once
3. On second failure: skips the diff stage, posts a warning comment ("Dependency diff unavailable — worktree creation failed"), exits 2 (infrastructure error). The validation pipeline is not affected.

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

### Stage 8: PR Comment

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

### Render (Phase 2)

Deferred. The PR comment provides sufficient dependency change visibility for MVP. Renderer added when there's a concrete consumer (UI dashboard, Confluence artifact).

## Docstring Formatting

The formatter (`docstring_formatter.py`) normalizes all generated docstrings to a canonical style before write-back. Rules:

- **Style:** Google-style docstrings (Args/Returns/Raises/Yields/Examples sections)
- **Line width:** 88 characters (matching Black default)
- **Indentation:** 4 spaces, matching the function/class body
- **Section order:** Summary → Description → Args → Returns → Yields → Raises → Examples → Notes
- **Blank lines:** one blank line between summary and first section, one between sections
- **Trailing punctuation:** summary line ends with a period
- **Type annotations:** omitted from Args/Returns if already present in the signature (avoids duplication)
- **Empty sections:** removed (no "Args:" with no arguments listed)

The formatter runs on all generated docstrings regardless of tier. It also validates that the docstring is syntactically valid Python (parseable by `ast.get_docstring()`).

## Confidence Scoring

Two distinct scores, serving different purposes.

### Correctness Score (deterministic)

Derived entirely from code analysis. Binary pass/fail per check:

- Parameters covered in docstring
- Return type documented
- Raised exceptions documented
- Required sections present
- Style/format valid
- Matches annotations and AST

Composite score: fraction of checks passing (0.0 to 1.0). **Hard build failures** enforce correctness.

### Semantic Confidence Score (model/heuristic)

Derived from model output quality signals:

- Summary consistent with test names and caller patterns
- No contradiction with implementation (e.g., docstring says "returns None" but return type is `str`)
- No suspicious vague phrases ("handles various cases", "processes data appropriately")
- No invented guarantees ("thread-safe", "O(1)" without evidence)
- No hallucinated exceptions or side effects

Score: 0.0 to 1.0. Used to decide disposition:

| Score | Action |
|-------|--------|
| ≥ 0.8 | Accept |
| 0.5–0.8 | Downgrade to minimal deterministic docstring |
| < 0.5 | Skip generation, file `needs-human-intent` |

Confidence thresholds are configurable per tier. Protected tier uses higher thresholds (≥ 0.9 to accept).

## CI Integration

The pipeline runs at three boundaries with different scope and cost profiles.

### Local (pre-commit)

Fast, deterministic only:
- Detect changed symbols (`git diff --name-only`)
- Generate templates for new/modified public symbols
- Run style checks on existing docstrings
- No LLM calls — keeps commits fast

### PR CI (GitHub Actions)

Focused on changed files:

```yaml
# .github/workflows/graph-review.yml (sketch)
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  docstring-generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install pydantic
      - run: |
          python stark_graph.py \
            --repo . \
            --stages extract,classify,generate,write-back \
            --write \
            --changed-only \
            --warn  # remove after bootstrap
        # No GH_TOKEN — this job only reads/writes local files

  docstring-validate:
    needs: docstring-generate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: |
          python stark_graph.py \
            --repo . \
            --stages parse,validate \
            --warn
        # No GH_TOKEN — local validation only

  blast-radius:
    needs: docstring-validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: |
          python stark_graph.py \
            --repo . \
            --pr ${{ github.event.pull_request.number }} \
            --stages diff,comment
        env:
          # Only the comment job needs write credentials
          STARK_CLAUDE_PRIVATE_KEY: ${{ secrets.STARK_CLAUDE_PRIVATE_KEY }}
```

**Dependencies:** Python 3.12+, pydantic. No system packages for MVP (graphviz only needed in Phase 2).

**CI authentication:** `github_app.py` reads the GitHub App private key from `STARK_CLAUDE_PRIVATE_KEY` environment variable (base64-encoded PEM) when macOS Keychain is unavailable. In GitHub Actions, store this as a repository secret. The script auto-detects the environment: Keychain on macOS dev machines, env-var on Linux CI runners.

**Credential scoping:** The `docstring-generate` and `docstring-validate` jobs do not need `GH_TOKEN` — they only read/write local files. Only the `blast-radius` job (which posts PR comments) requires the token. This limits the blast radius of credential exposure in jobs that execute repository-controlled code.

PR behavior:
- Regenerate docstrings for changed symbols
- Fail if committed docstrings differ from canonical output (staleness check)
- Comment summary stats and coverage deltas
- Attach low-confidence warnings
- Tag high-risk changes if blast radius is large

### Scheduled (nightly)

Expensive, full-repo:
- Whole-repo extraction + classification + generation
- Drift detection across all symbols
- Dependency annotation audit (coverage trends)
- Backlog creation for `needs-human-intent` symbols
- Configurable: runs weekly by default, nightly for high-churn repos

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

## Hard Rules for No-Review Operation

If the pipeline operates without human review of generated docstrings, these rules are non-negotiable:

1. **Never overwrite a high-confidence existing docstring with a lower-confidence one.**
2. **Never invent exceptions, guarantees, complexity, or side effects.**
3. **When uncertain, emit a shorter docstring, not a richer one.**
4. **Every generated docstring must pass deterministic validation.**
5. **Every changed symbol must be revalidated in CI.**
6. **Docstring drift must fail builds.**
7. **Model output must be normalized by a formatter before commit.**
8. **All repo policy must live in code/config, not only prompts.**

Violations of rules 1–3 are checked by the confidence scorer. Rules 4–6 are enforced by CI. Rules 7–8 are structural constraints on the codebase.

## Versioning

Generated docstrings are build artifacts. Track provenance for debugging regressions.

### What Gets Versioned

| Artifact | Where Tracked | Example |
|----------|--------------|---------|
| Prompt templates | `global/prompts/docgen/` versioned in git | `v3` |
| Generation schema | `scripts/graph/model.py` Pydantic models | Schema version `1` |
| Model selection | `global/config.json` `docgen_model` key | `claude-sonnet-4-6` |
| Confidence thresholds | `global/config.json` `docgen_thresholds` | `{"accept": 0.8, "protected_accept": 0.9}` |
| Generator version | `scripts/graph/docstring_generator.py` | `1.0` |

### Generation Metadata

Stored in CI artifacts (not in source code):

```json
{
  "symbol": "showcase.services.version_service.VersionService",
  "symbol_content_hash": "sha256:abc123",
  "generator_version": "1.0",
  "prompt_version": "v3",
  "model": "claude-sonnet-4-6",
  "correctness_score": 1.0,
  "semantic_confidence": 0.87,
  "fallback_reason": null,
  "generated_at": "2026-04-08T10:00:00Z"
}
```

This metadata enables:
- Debugging why a docstring changed between runs
- Detecting regressions when prompts or models change
- Auditing LLM cost by tier and model

## File Structure

```
scripts/
├── graph/                        # all graph pipeline scripts
│   ├── __init__.py
│   ├── model.py                  # Graph, Node, Edge, ExtractedSymbol Pydantic models
│   ├── python_parser.py          # Python AST + docstring parser (graph nodes/edges)
│   ├── symbol_extractor.py       # Python AST → structured payloads (generation)
│   ├── symbol_classifier.py      # Deterministic tier assignment
│   ├── docstring_generator.py    # Template + LLM slot-filling
│   ├── docstring_formatter.py    # Normalize style, enforce conventions
│   ├── confidence_scorer.py      # Correctness + semantic confidence
│   ├── docstring_writer.py       # Write generated docstrings back to source files
│   ├── correctness_validator.py  # Function-level docstring vs AST validation
│   ├── drift_validator.py        # Graph-level AST vs docstring annotation check
│   ├── graph_differ.py           # base vs PR graph diff + blast radius
│   └── pr_commenter.py           # post diff + blast radius to PR (idempotent)
├── stark_graph.py                # pipeline orchestrator (CLI entry point)

global/
├── prompts/
│   └── docgen/                   # LLM prompt templates for docstring generation
│       ├── summary.md            # summary slot prompt (receives: structured payload JSON)
│       ├── description.md        # description slot prompt (receives: payload + summary)
│       └── examples.md           # examples slot prompt (Protected tier; receives: payload + tests)

skill/
└── stark-graph/
    └── SKILL.md                  # /stark-graph skill wrapper
```

## /stark-graph Skill

The skill wraps `stark_graph.py` for agent invocation:

| Command | Maps to CLI | Behavior |
|---------|-------------|----------|
| `/stark-graph` | `--stages extract,classify,generate,parse,validate` | Local pipeline: generate + validate (no write-back — use `--write` to modify source files; no diff/comment — those require `--pr`) |
| `/stark-graph validate` | `--stages parse,validate` | Drift check only (no generation). Orchestrator auto-runs parse as prerequisite. |
| `/stark-graph audit` | `--stage audit` | Human-readable coverage report. Always exits 0. |
| `/stark-graph diff` | `--stages parse,diff --base main` | Blast radius against main (no comment posting) |
| `/stark-graph pr 123` | `--pr 123 --write` | Full pipeline: generate + write-back + parse + validate + diff + comment |
| `/stark-graph generate` | `--stages extract,classify,generate` | Generate only (no write-back, no validation) |
| `/stark-graph generate --changed-only` | `--stages extract,classify,generate --changed-only` | Generate for changed files only |

## CLI Interface

```bash
# Full pipeline on a repo
stark_graph.py --repo /path/to/stark-showcase/backend

# Individual stages
stark_graph.py --repo /path/to/repo --stage extract
stark_graph.py --repo /path/to/repo --stage classify
stark_graph.py --repo /path/to/repo --stage generate
stark_graph.py --repo /path/to/repo --stage parse
stark_graph.py --repo /path/to/repo --stage validate
stark_graph.py --repo /path/to/repo --stage audit

# Multiple stages
stark_graph.py --repo /path/to/repo --stages extract,classify,generate,validate

# Changed files only (for PR CI)
stark_graph.py --repo /path/to/repo --stages generate,validate --changed-only

# Diff against main
stark_graph.py --repo /path/to/repo --stage diff --base main

# Warn mode — validate but exit 0 even on drift (for phased rollout)
stark_graph.py --repo /path/to/repo --stage validate --warn

# Full PR pipeline (generate + validate + diff + comment)
stark_graph.py --repo /path/to/repo --pr 123

# Full PR pipeline in warn mode (post comment but don't block)
stark_graph.py --repo /path/to/repo --pr 123 --warn

# Override repo identity
stark_graph.py --repo /path/to/repo --repo-name GetEvinced/stark-showcase

# Limit scope to specific directories (for phased strict rollout)
stark_graph.py --repo /path/to/repo --stage validate --include backend/showcase/services/

# Write generated docstrings back to source files
stark_graph.py --repo /path/to/repo --stages extract,classify,generate --write
```

### `--warn` Mode

When `--warn` is passed, the pipeline runs identically but:
- `drift_validator.py` exits 0 instead of 1 on drift findings
- PR comment is prefixed with `Warning: Warn mode — findings reported but not blocking`
- The validation JSON includes `"mode": "warn"` for metrics tracking
- All other stages (diff, comment) run normally

This allows teams to measure false positive rates during bootstrap without blocking PRs. Promote to strict mode by removing `--warn` once the rate is acceptable.

### `--stage` vs `--stages`

`--stage X` runs exactly one stage. `--stages X,Y,Z` runs multiple in sequence. If both are passed, `--stages` takes precedence and `--stage` is ignored. The orchestrator auto-resolves prerequisites: if a stage requires input from a prior stage and that output file is missing, the prerequisite stage runs automatically.

### `--write` Mode

When `--write` is passed, the write-back stage (Stage 4) executes after generation, modifying source files in-place. Without `--write`, generation only produces `generate-report.json` — source files are not touched. This separation prevents accidental source modification during dry-run or audit workflows.

### `--include` Mode

When `--include PATTERN` is passed, only files matching the pattern are processed. Multiple `--include` flags are supported. Patterns use glob syntax relative to `--repo` (e.g., `--include backend/showcase/services/**/*.py`). Validation still runs on matched files only, allowing phased strict rollout by directory.

### `--changed-only` Mode

When `--changed-only` is passed:
- `git diff --name-only HEAD...{base}` determines which files changed
- Only changed files are extracted, classified, and generated
- Validation runs on the full repo (not just changed files) to catch cascading drift

## Testing Strategy

### Unit Tests

| Component | Tests |
|-----------|-------|
| `model.py` | Pydantic model validation: required fields, optional defaults, schema version rejection, ExtractedSymbol serialization |
| `symbol_extractor.py` | Fixture files: function with all annotation types, class with methods, async/generator, decorators, overloads, missing types, syntax errors, encoding issues |
| `symbol_classifier.py` | Tier assignment: private trivial → skip, public simple → template, public complex → llm, exported → protected, override annotation |
| `docstring_generator.py` | Template generation: zero-LLM path produces correct skeleton. LLM path: mock model returns slots, formatter normalizes. Fallback: low-confidence → minimal docstring. |
| `confidence_scorer.py` | Correctness: all checks pass/fail independently. Semantic: vague phrases detected, contradictions flagged, threshold behavior correct. |
| `python_parser.py` | Fixture files: valid module, class with docstring, class without docstring, syntax error file, empty file, `__init__.py`, file >500KB, encoding issues |
| `drift_validator.py` | One fixture per check type: STALE, MISSING, NO_DOCSTRING, clean (zero findings), suppressed node. Assert exact JSON output per fixture. |
| `graph_differ.py` | Fixture graph pairs: added edge, removed edge, added node, removed node, cycle (no infinite loop), depth cap reached |
| `pr_commenter.py` | Mock GitHub API: idempotent update, retry on 429, timeout handling |
| `docstring_writer.py` | Write-back: correct insertion, indentation preservation, backup creation, high-confidence protection (Hard Rule 1) |
| `correctness_validator.py` | Per-check pass/fail: params covered, return documented, raises documented, no contradictions |
| Prompt injection | Grammar validation rejects `Depends: $(curl ...)`, `Depends: '; DROP TABLE`, and other injection payloads. JSON encoding preserves structure. Allowlist filter blocks non-matching values. |

### Integration Tests

- Full pipeline on a fixture repo (committed to `tests/fixtures/graph/`): extract → classify → generate → parse → validate → diff. Assert intermediate JSON files validate against Pydantic models.
- Blast radius on a fixture graph with known cycle: verify no infinite loop, verify counts match expected.
- Generation round-trip: extract symbols from fixture, generate docstrings, write back, re-parse, validate — zero drift.
- Performance: full pipeline on fixture repo completes in <60s (wall clock, single-threaded, no LLM — template tier only). LLM-tier timing validated separately with mock model returning in <100ms.

### Acceptance Criteria

| Component | Criterion |
|-----------|-----------|
| Python parser | Extracts 100% of class and module nodes from stark-showcase backend (verified by manual spot-check of 5 files) |
| Symbol extractor | Extracts all parameters, types, exceptions, decorators for 100% of public functions in stark-showcase backend |
| Classifier | ≤5% of symbols manually judged as wrong tier on stark-showcase |
| Template generator | Zero-LLM docstrings pass correctness validation for 100% of Template-tier symbols |
| LLM generator | Semantic confidence ≥0.8 for ≥80% of LLM-tier symbols on stark-showcase |
| Drift validator | False positive rate <5% on bootstrapped stark-showcase codebase (measured during --warn rollout phase) |
| Full pipeline | Completes in <60s on stark-showcase backend (~50 Python files) on a standard CI runner |
| PR comment | Correctly shows added/removed edges for a test PR with known dependency changes |

## Capacity Baseline

Expected for stark-showcase backend MVP:
- **Files:** ~50 Python files
- **Nodes:** ~50 modules + ~80 classes = ~130 nodes
- **Symbols (generation):** ~200 functions/methods + ~80 classes + ~50 modules = ~330 symbols
- **Tier distribution (estimated):** ~150 skip, ~100 template, ~60 llm, ~20 protected
- **LLM calls per full run:** ~80 (llm + protected tiers)
- **Edges:** ~200 import edges + ~50 docstring depends edges = ~250 edges
- **Graph JSON size:** ~50-100KB
- **Parse time:** <5s (sequential, single-threaded sufficient for MVP scale)
- **Generation time:** <30s for templates, ~30s for LLM calls (batched)
- **Full pipeline:** <60s target including generation and worktree checkout for base graph
- **PR frequency:** ~5-10 PRs/day
- **LLM cost per PR (changed-only):** ~5-10 LLM calls × $0.01 = ~$0.05-0.10

At this scale, sequential parsing, in-memory graph, and full re-parse per PR are acceptable. Incremental parsing (Phase 2) is needed when file count exceeds ~500.

## MVP Scope — stark-showcase backend

Full vertical slice on one repo. Everything works end-to-end before generalizing.

### In Scope
- Python AST extractor (full structured payload for all symbol types)
- Symbol classifier (four tiers, deterministic rules)
- Docstring generator (template path + LLM slot-filling)
- Confidence scorer (correctness + semantic)
- Docstring formatter (normalize style)
- Python parser (ast module, module + class level)
- Graph model (Pydantic, schema_version)
- Drift validator (strict for Depends, informational for Called by)
- Graph differ (base vs PR with blast radius)
- PR comment posting (idempotent, with retry)
- Review domain enrichment (configurable domain list)
- `/stark-graph` skill (with `generate` sub-command)
- LLM prompt templates for summary/description/examples slots
- Docstring writer (write-back to source files)
- Correctness validator (function-level docstring vs AST)
- Docstring convention docs
- Fixture-based test suite (including prompt injection and performance)
- `--audit` mode for bootstrap
- `--warn` mode for phased rollout
- `--changed-only` mode for PR CI efficiency
- Generation metadata in CI artifacts

### Phase 2
- TypeScript parser (sandboxed) + TypeScript extractor
- Function-level nodes and `calls` edges
- Cross-repo graph merge (`graph_merge.py` extracted)
- `changed_edges` in diff output
- `Called by` strict validation (BROKEN_XREF)
- SVG/HTML renderer with accessible markup
- Weekly LLM audit agent
- Incremental parsing (cache by commit SHA)
- Interactive D3 explorer
- Coverage metrics CI artifact
- Generation cache by content hash (skip re-generation for unchanged symbols)
- Retrieval over tests/design docs for richer LLM context

### Phase 3 (GCP)
- Centralized generation service (Cloud Run)
- Generation cache keyed by file hash + symbol hash
- Org-wide reporting (BigQuery dashboards for coverage/drift trends)
- Fleet-wide analytics across all repos
- Shared prompt/model/version policy engine
- Embeddings/retrieval over code/tests/docs for richer context
- Batch generation queue for large repos

### Out of Scope
- LSP integration
- Runtime tracing
- Go/Java/other language parsers
- Graph database storage
- Historical graph diffing (beyond base vs PR)
- LLM-generated docstrings committed directly without deterministic validation

## Bootstrap Strategy

Existing code in stark-showcase has no structured docstrings. Bootstrap path:

1. **Audit:** Run `stark_graph.py --repo ... --stage audit` — generates a report of all classes/modules missing docstrings. Output is plain text + JSON (accessible to all reviewers).
2. **Extract + Classify:** Run the extraction and classification pipeline to understand the symbol landscape. How many skip vs template vs llm vs protected?
3. **Generate drafts:** Run `stark_graph.py --repo ... --stage generate` — produces docstrings for all non-skip symbols. Template-tier symbols get zero-LLM docstrings. LLM-tier symbols get model-assisted docstrings with confidence scores.
4. **Review low-confidence:** Developer reviews only `needs-human-intent` symbols and low-confidence LLM output. Template and high-confidence LLM output can be accepted without review.
5. **Warn mode:** Enable `stark_graph.py --warn` in CI for 1-2 sprints. Reports violations without failing CI. Measure false positive rate.
6. **Strict mode:** When false positive rate <5%, enable strict validation. Start with a subset of directories if needed (`--include backend/showcase/services/`).

Recovery: if a bootstrapped docstring is incorrect, any developer can fix it. `# stark-graph: ignore` provides an escape hatch for nodes that are hard to document (generated code, metaprogramming).

## Operating Model Summary

Uses the canonical tier names from the classifier (Skip, Template, LLM, Protected):

### Skip (~45% of symbols)

- No docstring generated
- Private trivial helpers, test code, generated code

### Template (~30% of symbols)

- Deterministic skeleton from AST — zero LLM calls
- Always passes correctness validation
- Covers simple public functions with clear naming

### LLM-Assisted (~18% of symbols)

- Structured payload sent to model — model fills summary + description slots
- Formatter normalizes output
- Correctness validator checks against AST
- Confidence scorer gates acceptance (≥ 0.8)
- Falls back to template on low confidence

### Protected (~7% of symbols)

- Same as LLM-Assisted but with test names and caller patterns as additional context
- Stricter confidence threshold (≥ 0.9)
- May require human review for first generation
- Never auto-downgrades an existing high-confidence docstring
