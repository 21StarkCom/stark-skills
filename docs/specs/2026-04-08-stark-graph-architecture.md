# stark-graph Architecture — Docstring Pipeline & Dependency Graph

**Date:** 2026-04-08
**Status:** Architecture
**Companion:** `2026-04-07-stark-graph-design.md` (implementation design)

---

## Vision

Docstrings are generated artifacts, not prose to review. The system treats them like compiled output: deterministic where possible, model-assisted where necessary, validated always, enforced in CI. The LLM is a replaceable subroutine — most of the pipeline is code.

## Core Principle

**Use the LLM only for semantic synthesis. Everything else is deterministic code.**

This splits the system into three layers:

```
                    ┌─────────────────────────┐
                    │    Enforcement Layer     │
                    │  CI gates, PR checks,    │
                    │  nightly audits, drift   │
                    │  detection, build fails  │
                    └────────────┬────────────┘
                                 │ validates
                    ┌────────────▼────────────┐
                    │       LLM Layer          │
                    │  Summary sentences,      │
                    │  behavioral descriptions,│
                    │  non-obvious intent,     │
                    │  examples for key APIs   │
                    └────────────┬────────────┘
                                 │ fills slots in
                    ┌────────────▼────────────┐
                    │   Deterministic Layer    │
                    │  AST extraction, typing, │
                    │  templates, formatting,  │
                    │  classification, scoring │
                    └─────────────────────────┘
```

---

## The Ten Guidelines

### 1. Do Not Ask the LLM to Do Extraction

Never let the model infer things that code can extract exactly.

**Code extracts:**
- Parameter names, type hints, defaults
- Raised exceptions (explicit `raise`)
- Async/generator status
- Decorators, overloads
- Return annotations
- Visibility rules (private/public/dunder)
- File/module ownership
- Dependency metadata (imports, inheritance)
- Complexity signals (statement count, branch count)

**The LLM receives a structured JSON payload:**

```json
{
  "name": "fetch_user",
  "visibility": "public",
  "signature": "(self, user_id: str, include_deleted: bool = False) -> User | None",
  "params": [
    {"name": "user_id", "type": "str", "default": null},
    {"name": "include_deleted", "type": "bool", "default": "False"}
  ],
  "return_type": "User | None",
  "raises": ["UserNotFoundError", "DatabaseError"],
  "calls": ["self._repo.get_by_id", "self._cache.invalidate"],
  "tests": ["test_fetch_user_found", "test_fetch_user_not_found"],
  "existing_docstring": null,
  "complexity": {"statements": 12, "branches": 3, "calls": 4}
}
```

This reduces hallucination, cuts token usage, and makes model output auditable against known facts.

**Why this matters:** Models are stochastic. If you ask a model to "extract the parameters from this function," it will sometimes hallucinate a parameter, drop one, or infer wrong types. AST extraction is exact. The pipeline should never trade exactness for convenience.

### 2. Generate Docstrings Only for Code That Matters

Not every symbol deserves model attention. Spending LLM budget on trivial code is waste; worse, it creates opportunities for hallucination with no value.

**Do not spend model budget on:**
- Trivial private helpers (≤3 statements)
- One-line wrappers and delegators
- Obvious property getters/setters
- Generated code (protobuf, ORM models)
- Migrations
- Test-only helpers
- Deprecated code marked for removal

**Classification policy:**

| Symbol Profile | Strategy |
|---------------|----------|
| Private + trivial | Skip entirely |
| Public + simple | Deterministic template (zero LLM) |
| Public + non-trivial | Template skeleton + LLM fills summary/behavior |
| Core / shared / exported API | LLM + stronger validation + tests in context |

The classifier is pure deterministic code — no model calls. It uses statement count, branch count, visibility, `__all__` membership, and consumer count to assign tiers.

### 3. Use a Template-First System

The LLM fills slots in a canonical skeleton. It never writes free-form docstrings from scratch.

**Pipeline:**
1. AST builds the canonical docstring skeleton
2. Rules decide required sections (Args, Returns, Raises, Yields, Examples)
3. LLM fills only: summary sentence, long description, edge-case notes
4. Formatter normalizes output to the project style

**For many functions, the output needs zero LLM:**

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

Summary derived from naming convention (`get_X` → "Get X."). Args from signature. Returns from annotation. Raises from code scan. No model call needed.

**The LLM adds value only when:**
- The function name doesn't reveal intent (`reconcile_versions`, `process_batch`)
- The behavior has non-obvious edge cases
- The interaction between parameters is complex
- Examples would meaningfully help consumers

### 4. Make "No Guess" a Hard Rule

If confidence is low, the pipeline must not invent.

**Allowed outcomes when uncertain:**
- Emit a minimal deterministic docstring (skeleton only)
- Emit a warning marker in the generation report
- Skip generation and file the symbol as `needs-human-intent`
- Label with low confidence for manual review queue

**Never allowed:**
- Invent exceptions the code doesn't raise
- Claim thread-safety, complexity bounds, or side effects without evidence
- Fill in behavioral descriptions with generic filler ("handles various cases")
- Guess at parameter semantics when the name is ambiguous

The safe fallback is not "best effort prose." The safe fallback is "minimal, mechanically correct docstring."

### 5. Separate Correctness from Readability

Two distinct scores that serve different purposes and drive different actions.

**Correctness score** — deterministic, binary per check:

| Check | Source |
|-------|--------|
| Parameters covered | AST signature vs docstring Args section |
| Return documented | AST return annotation vs docstring Returns section |
| Exceptions documented | AST `raise` nodes vs docstring Raises section |
| Sections valid | Style guide required sections present |
| Matches annotations | Docstring claims vs AST facts |

Composite: fraction of checks passing. **Enforce hard build failures on correctness.**

**Semantic confidence score** — heuristic/model-derived:

| Signal | Detection |
|--------|-----------|
| Summary consistent with tests | Test names suggest behavior that matches summary |
| No contradictions | Docstring doesn't claim things the AST disproves |
| No vague phrases | Regex filter for weasel words |
| No invented guarantees | No "thread-safe", "O(1)", etc. without code evidence |

Score 0.0–1.0. Used for disposition decisions (accept, downgrade, skip), **not** for build failures.

### 6. Run Generation at Change Boundaries, Not Only in Editor

Generation happens at three operational boundaries:

**Local (pre-commit):**
- Fast, deterministic only
- Detect changed symbols
- Generate/update templates
- Run style checks
- No LLM calls — keeps commits under 1 second

**PR CI (GitHub Actions):**
- Focused on changed files
- Regenerate docstrings for modified symbols
- Compare committed version with canonical output
- Fail if stale or missing
- Compute blast radius for dependency changes
- Post PR comment with summary

**Scheduled (nightly/weekly):**
- Full-repo extraction and generation
- Drift detection across all symbols
- Coverage trend reporting
- Backlog creation for `needs-human-intent`
- Dependency annotation audit

This mirrors how linting and formatting work: fast locally, enforced in CI, audited periodically.

### 7. Put Most Logic in Code Inside the Repo

The model is a subroutine. The system is code.

**Core components that live in repo-owned Python:**

| Component | Responsibility |
|-----------|---------------|
| Symbol extractor | AST → structured payload for every symbol |
| Symbol classifier | Payload → tier assignment (skip/template/llm/protected) |
| Template engine | Tier + payload → docstring skeleton |
| Docstring formatter | Normalize style, enforce conventions |
| Correctness scorer | Docstring × AST → pass/fail per check |
| Semantic scorer | Docstring × payload → confidence 0.0–1.0 |
| Drift validator | Docstring annotations × import graph → STALE/MISSING/NO_DOCSTRING |
| Dependency graph builder | AST + docstrings → nodes + edges |
| Graph differ | Base graph × head graph → added/removed + blast radius |
| PR commenter | Diff + validation report → idempotent GitHub comment |
| Pipeline orchestrator | CLI → stage sequencing → exit codes |

**The model handles only:**
- Writing the summary sentence
- Writing the long description
- Inferring non-obvious intent from implementation + tests
- Generating examples for important APIs

This ratio — ~11 deterministic components to ~4 model tasks — is the right balance. If the model improves, you benefit. If it degrades, you still have correct skeletons.

### 8. Use GitHub Actions as the Policy Gate

CI is the enforcement point. Not editor plugins, not pre-commit hooks, not human review checklists.

**Typical CI jobs:**

| Job | Trigger | Behavior |
|-----|---------|----------|
| `docstring-generate-changed` | PR open/sync | Regenerate for changed symbols, diff against committed |
| `docstring-validate` | PR open/sync | Full-repo validation (STALE, MISSING, NO_DOCSTRING) |
| `docstring-diff-report` | PR open/sync | Coverage delta, new/removed symbols |
| `blast-radius` | PR open/sync | Dependency change impact analysis |
| `docstring-audit-nightly` | Cron schedule | Full-repo scan, trend reporting, backlog |

**PR behavior:**
- Regenerate for changed symbols
- **Fail if committed docstrings differ from canonical output** (staleness detection)
- Comment summary stats and coverage deltas
- Attach low-confidence warnings as review annotations
- Tag high-risk changes if blast radius exceeds threshold

The "fail if stale" check is the key enforcement: it makes docstrings a build artifact that must be regenerated when code changes, not a separate concern that drifts.

### 9. Use GCP Only Where Centralization Is Worth It

Start in GitHub Actions. Move to GCP only when a specific scaling problem demands it.

**GCP is worth it when you need:**
- Generation across many repos with shared policy
- Caching to avoid re-generating unchanged symbols
- Batch queuing for large repos (>500 files)
- Org-wide dashboards (coverage, drift trends, LLM cost)
- Centralized prompt/model version management
- Embeddings/retrieval for richer context (tests, design docs, related code)

**Recommended split at scale:**

| Layer | Where | Why |
|-------|-------|-----|
| AST parsing, validation, formatting | GitHub Actions (in-repo) | Fast, no external deps, repo-specific |
| Enforcement, diffing, PR comments | GitHub Actions | Coupled to PR lifecycle |
| Expensive generation (LLM calls) | Cloud Run | Cache by content hash, shared model config |
| Reporting and analytics | BigQuery | Cross-repo trends, cost tracking |
| Prompt/policy management | Cloud Storage + Config | Versioned, org-wide |

**For a single repo or small org (1-5 repos):** stay entirely in GitHub Actions. The complexity of a GCP service is not justified until you have scale problems.

### 10. Version Prompts and Outputs Like Build Artifacts

If automation owns the output, you must be able to debug regressions.

**Version these:**

| Artifact | How |
|----------|-----|
| Prompt templates | Files in `global/prompts/docgen/`, versioned in git |
| Generation schema | Pydantic models in `scripts/graph/model.py` |
| Model selection | Config key in `global/config.json` |
| Confidence thresholds | Config key per tier |
| Generator code | Semantic version in module |

**Track per-generation (CI artifact, not source code):**

```json
{
  "symbol": "showcase.services.version_service.VersionService.fetch_user",
  "content_hash": "sha256:abc123",
  "generator_version": "1.0",
  "prompt_version": "v3",
  "model": "claude-sonnet-4-6",
  "correctness_score": 1.0,
  "semantic_confidence": 0.87,
  "tier": "llm",
  "fallback_reason": null,
  "timestamp": "2026-04-08T10:00:00Z"
}
```

Without this, when a docstring regresses after a prompt or model update, you have no trail to diagnose the cause.

---

## Operating Model

### Three Tiers

The pipeline classifies every symbol into one of three tiers. Each tier has a different cost profile, validation strictness, and fallback behavior.

```
┌──────────────────────────────────────────────────┐
│  Tier 3: Protected Surfaces (~5-10% of symbols)  │
│  ─ Core APIs, exports, cross-module interfaces   │
│  ─ LLM with tests in context                     │
│  ─ Confidence ≥ 0.9 to accept                    │
│  ─ No auto-downgrade of existing docstrings      │
│  ─ May require first-time human review            │
├──────────────────────────────────────────────────┤
│  Tier 2: Assisted Generation (~15-30%)            │
│  ─ Public + non-trivial functions                 │
│  ─ Structured payload → LLM fills slots           │
│  ─ Confidence ≥ 0.8 to accept                    │
│  ─ Falls back to template on low confidence       │
├──────────────────────────────────────────────────┤
│  Tier 1: Fully Deterministic (~60-80%)            │
│  ─ Templates from AST, zero LLM calls             │
│  ─ Always passes correctness validation           │
│  ─ Covers: skip, template tiers                   │
│  ─ No model cost, no hallucination risk            │
└──────────────────────────────────────────────────┘
```

### Cost Model

For a typical 50-file Python backend:

| Tier | Symbols | LLM Calls | Cost/Run |
|------|---------|-----------|----------|
| Skip | ~150 | 0 | $0.00 |
| Template | ~100 | 0 | $0.00 |
| LLM-assisted | ~60 | 60 | ~$0.60 |
| Protected | ~20 | 20 | ~$0.40 |
| **Total** | **~330** | **80** | **~$1.00** |

PR runs with `--changed-only` touch ~5-10 symbols: ~$0.05-0.10 per PR.

Nightly full-repo runs: ~$1.00 per repo per night.

### Decision Flow

```
Symbol extracted from AST
        │
        ▼
Is it suppressed? ──yes──► SKIP
        │no
        ▼
Private + trivial? ──yes──► SKIP
        │no
        ▼
Public + simple? ──yes──► TEMPLATE (zero LLM)
        │no
        ▼
Core / exported / ──yes──► PROTECTED (LLM + strict)
high-consumer?
        │no
        ▼
LLM-ASSISTED (LLM + standard confidence)
```

### Pipeline Flow

```
Source files
    │
    ▼
[Extract] ──► Structured payloads (JSON)
    │
    ▼
[Classify] ──► Tiered symbol list
    │
    ▼
[Generate] ──► Docstrings (template or LLM-filled)
    │              │
    │              ├─ Template tier: zero LLM
    │              ├─ LLM tier: payload → model → slots filled
    │              └─ Protected: payload + tests → model → slots filled
    │
    ▼
[Format] ──► Normalized docstrings
    │
    ▼
[Parse] ──► Dependency graph (nodes + edges)
    │
    ▼
[Validate] ──► Drift check (STALE / MISSING / NO_DOCSTRING)
    │
    ▼
[Diff] ──► Blast radius (direct + transitive)
    │
    ▼
[Comment] ──► PR annotation
```

---

## Concrete Stack

### Inside the Repo

```
scripts/graph/
├── model.py                 # Pydantic: Graph, Node, Edge, ExtractedSymbol, Tiers
├── symbol_extractor.py      # AST → structured payloads
├── symbol_classifier.py     # Payload → tier (deterministic rules)
├── docstring_generator.py   # Template engine + LLM slot-filling
├── docstring_formatter.py   # Style normalization
├── confidence_scorer.py     # Correctness (deterministic) + semantic (heuristic)
├── python_parser.py         # AST → graph nodes/edges
├── drift_validator.py       # Docstring annotations × imports → violations
├── graph_differ.py          # Base × head graph → diff + blast radius
├── pr_commenter.py          # Idempotent GitHub PR comments
└── __init__.py

scripts/stark_graph.py       # CLI orchestrator

global/prompts/docgen/       # LLM prompt templates (versioned)
├── summary.md
├── description.md
└── examples.md

global/config.json           # Thresholds, model selection, tier config
```

### In GitHub Actions

```yaml
jobs:
  # Job 1: Generate + validate changed docstrings
  docstring-generate:
    steps:
      - stark_graph.py --stages extract,classify,generate,validate --changed-only

  # Job 2: Full validation (catch cascading drift)
  docstring-validate:
    steps:
      - stark_graph.py --stage validate

  # Job 3: Blast radius analysis
  blast-radius:
    needs: docstring-validate
    steps:
      - stark_graph.py --pr $PR_NUMBER --stages diff,comment

  # Nightly: Full repo audit
  docstring-audit:
    schedule: "0 2 * * 1"  # weekly Monday 2 AM
    steps:
      - stark_graph.py --stages extract,classify,generate,validate,audit
```

### Optional: GCP (Phase 3)

```
Cloud Run
├── /generate  — stateless generation endpoint
│   ├── receives: ExtractedSymbol payload + tier
│   ├── returns: filled docstring + confidence
│   └── caches by content_hash (Cloud Storage)

BigQuery
├── docstring_generations  — per-symbol generation history
├── coverage_snapshots     — per-repo coverage over time
├── drift_violations       — per-repo violation trends
└── cost_tracking          — LLM cost per repo/tier/model

Cloud Storage
├── prompts/v{N}/          — versioned prompt templates
├── cache/{hash}.json      — generation cache
└── config/policy.json     — org-wide generation policy
```

---

## Hard Rules

For a system that operates without human review of generated docstrings, these rules are non-negotiable:

### Safety Rules (enforced by confidence scorer)

1. **Never overwrite a high-confidence existing docstring with a lower-confidence one.** If the current docstring scores 0.9 and the regenerated one scores 0.7, keep the current one.
2. **Never invent exceptions, guarantees, complexity claims, or side effects.** If the AST doesn't show it, the docstring doesn't claim it.
3. **When uncertain, emit a shorter docstring, not a richer one.** Minimal and correct beats detailed and wrong.

### Enforcement Rules (enforced by CI)

4. **Every generated docstring must pass deterministic validation.** Correctness score = 1.0 required for merge.
5. **Every changed symbol must be revalidated in CI.** No skipping validation for "small" changes.
6. **Docstring drift must fail builds.** If the committed docstring doesn't match canonical output for the current code, the build fails.

### Structural Rules (enforced by architecture)

7. **Model output must be normalized by a formatter before commit.** Raw model output never touches the codebase.
8. **All repo policy must live in code/config, not only prompts.** Classification rules, validation checks, confidence thresholds, tier assignments — all in Python code or JSON config, never buried in prompt text.

---

## Phasing

### Phase 1: Deterministic Foundation

Build everything that doesn't need a model:
- AST extractor producing structured payloads
- Symbol classifier (four tiers)
- Template generator (zero-LLM docstrings)
- Docstring formatter
- Correctness validator
- GitHub Action for changed files

**Outcome:** ~60-80% of symbols get correct, automatically generated docstrings with zero LLM cost. Validation catches drift in CI.

### Phase 2: LLM-Assisted Generation

Add the model for meaningful public APIs:
- LLM slot-filling for summary/description
- Confidence scorer (semantic)
- Fallback behavior (low confidence → template)
- PR comments with coverage stats
- `--changed-only` for efficient PR CI

**Outcome:** remaining 20-40% of public symbols get semantically rich docstrings. LLM cost is contained to ~$1/full run.

### Phase 3: Dependency Graph + Blast Radius

Wire docstring annotations into the dependency system:
- Graph parser using `Depends:`/`Publishes:` annotations
- Drift validator (STALE/MISSING/NO_DOCSTRING)
- Graph differ with blast radius
- PR comments with dependency change summaries
- Pre-review gate (block review if drift detected)

**Outcome:** full dependency awareness in PR reviews. Blast radius quantified. Stale dependencies caught automatically.

### Phase 4: Scale + Governance (GCP)

Move expensive operations to centralized services when scale demands:
- Cloud Run generation endpoint with caching
- BigQuery dashboards for coverage trends
- Cross-repo policy management
- Fleet-wide analytics

**Outcome:** org-wide docstring quality with cost control and observability.

---

## What This Architecture Does Not Do

- **No LLM for extraction.** The model never parses code. AST does.
- **No free-form generation.** The model fills slots in templates. It doesn't write from scratch.
- **No generation for trivial code.** Skip tier exists. Not every symbol needs a docstring.
- **No trust without validation.** Every model output passes deterministic checks before commit.
- **No prompt-only policy.** Rules live in code. Prompts are inputs to a subroutine, not the system.
- **No review dependency.** The system must be safe to run unattended. Hard rules enforce this.
- **No GCP dependency for MVP.** GitHub Actions is sufficient. GCP is additive, not foundational.

---

## Relationship to Existing stark-graph Design

This architecture document establishes the principles and operating model. The companion design document (`2026-04-07-stark-graph-design.md`) provides:

- Pydantic model definitions and JSON schemas
- Exact CLI flags and exit codes
- Stage-by-stage data contracts
- Blast radius algorithm specification
- Testing strategy with fixture definitions
- Capacity baselines and cost projections
- Bootstrap strategy for existing codebases
- PR comment format and idempotency

The architecture tells you **why** and **what**. The design tells you **how**.
