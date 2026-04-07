# stark-graph — Implementation Plan

**Date:** 2026-04-07
**Design:** `docs/specs/2026-04-07-stark-graph-design.md` (v1, Approach B)
**Target:** stark-showcase backend (full vertical slice)
**Synthesized from:** codex (winner, 7.4/10) + claude (5.2/10)

---

## 1. Overview

Build `stark-graph` as a staged Python pipeline inside stark-skills. Seven phases, each delivering a working, testable increment:

1. **Foundation** — schema, CLI, contracts
2. **Parser** — Python AST + docstring extraction + audit mode
3. **Validator** — drift detection, warn mode, coverage thresholds
4. **Differ** — base-vs-head graph diff, blast radius
5. **Commenter** — idempotent PR comments via GitHub App
6. **Integration** — pre-review gate, prompt enrichment, skill wrapper
7. **Rollout** — CI workflows, bootstrap, warn→strict promotion

Key architectural decisions:
- Pydantic models are the source of truth for all inter-stage contracts
- The orchestrator (`stark_graph.py`) is the only code that knows the pipeline sequence; stages are pure JSON transformations
- `--warn` mode is a flag the orchestrator passes through, not logic scattered across stages
- Existing `github_app.py` auth infrastructure is reused unchanged
- Bootstrap (docstring generation on stark-showcase) runs in parallel with Phases 2-3

### Design Gaps to Resolve Up Front

- **Script location:** Use `scripts/stark_graph.py` to match repo layout (not repo root)
- **Test layout:** Tests in `scripts/test_graph_*.py`, fixtures in `tests/fixtures/graph/`
- **Per-file timeout:** `ast.parse()` is not preemptible in-process; use subprocess wrapper
- **Config key:** Add `graph_enriched_domains` to `global/config.json`
- **Prompt injection:** Add grammar validation tasks in Phase 2 (parser) and Phase 5 (commenter)
- **Docstring convention docs:** Add as a task in Phase 6

## 2. Prerequisites

- Python 3.12 in dev environment and CI runners
- `pydantic` (only non-stdlib dependency for MVP)
- `scripts/github_app.py` present and tested (per CLAUDE.md — already exists)
- stark-claude[bot] GitHub App credentials in CI secrets
- Access to `GetEvinced/stark-showcase` for acceptance testing
- `git`, `git worktree`, and `gh` installed

```bash
export REPO_UNDER_TEST="$HOME/git/Evinced/stark-showcase/backend"
export REPO_NAME="GetEvinced/stark-showcase"
export SCRIPTS_DIR="/Users/aryeh/git/Evinced/stark-skills/scripts"
export PYTHON="$SCRIPTS_DIR/.venv/bin/python3"

"$PYTHON" -m pip install pydantic pytest
```

**Can be done in parallel with Phase 1:**
- Scaffold `tests/fixtures/graph/` with a mini-repo fixture (5-10 Python files covering all edge cases)
- Draft docstring convention documentation for stark-showcase developers
- Begin audit run on stark-showcase once Phase 2 parser is complete

## 3. Phases

---

## Phase 1: Foundation and Contracts
**Goal:** Establish the graph schema, CLI surface, workdir conventions, and exit-code/error contract without changing review behavior.
**Dependencies:** None
**Estimated effort:** M (3-4 tasks)

### Tasks

1. **Define graph and report models in `scripts/graph/model.py`**
   - Implement `Node`, `Edge`, `Graph`, `ValidationReport`, `DiffReport` Pydantic models
   - Enforce schema-major compatibility (`Graph.reject_unknown_version()`)
   - Encode `partial`, `skipped_files`, and full node IDs exactly as designed
   - Add the `Parser` protocol with `parse(paths, repo) -> Graph`, `language()`, `file_patterns()`
   - `Node` fields: `id`, `layer` (enum: module|class), `parent`, `depends`, `publishes`, `called_by`, `file_path`, `line`
   - `Edge` fields: `source`, `target`, `type` (open string), `origin` (enum: ast|docstring)
   - Files: `scripts/graph/__init__.py`, `scripts/graph/model.py`
   - Done when: malformed envelopes rejected, valid JSON roundtrips, schema mismatches fail

2. **Scaffold orchestrator with shared workdir/error handling in `scripts/stark_graph.py`**
   - CLI flags: `--repo`, `--repo-name`, `--stage`, `--pr`, `--base`, `--warn`, `--input`, `--output`, `--workdir`
   - Slugged workdir: `.stark-graph/{pr-or-branch}/`
   - Repo identity: derive from `git remote get-url origin`, fallback to `GITHUB_REPOSITORY` env var, then `--repo-name`
   - Stderr JSON on failure, exit codes 0/1/2 per design
   - Files: `scripts/stark_graph.py`
   - Done when: `--help` documents all modes, dry run creates expected workdir structure

3. **Schema and CLI regression tests**
   - Unit tests for required fields, optional defaults, version rejection, CLI argument validation
   - Files: `scripts/test_graph_model.py`, `scripts/test_stark_graph_cli.py`
   - Done when: schema and CLI contract locked before parser logic starts

### Risks
- Schema drift between stages → mitigate with single shared model module
- CLI ambiguity around `graph.json` → always write `parse-python.json`, orchestrator copies to `graph.json` for downstream

### Verification
```bash
"$PYTHON" scripts/stark_graph.py --help
"$PYTHON" -m pytest scripts/test_graph_model.py scripts/test_stark_graph_cli.py
```

### Rollback
Remove `scripts/stark_graph.py` and `scripts/graph/` from install references. No runtime behavior changed yet.

---

## Phase 2: Python Parser and Audit Mode
**Goal:** Produce correct module/class graphs from Python source. Make bootstrap auditing usable on stark-showcase.
**Dependencies:** Phase 1
**Estimated effort:** L (4 tasks)

### Tasks

1. **Implement Python AST parser in `scripts/graph/python_parser.py`**
   - Walk `*.py` files; create module nodes and `ast.ClassDef` class nodes
   - Node IDs: `{repo}:{relative_path}` (module), `{repo}:{relative_path}:{qualname}` (class)
   - Collect `imports` and `inherits` edges from AST with `origin: "ast"`
   - Parse `Depends:`, `Publishes:`, `Called by:` case-insensitively from docstrings
   - Validate metadata values against grammar `[a-zA-Z0-9_.]+`; reject and log non-matching
   - Populate all three node fields (`depends`, `publishes`, `called_by`) — not just edges
   - Emit `depends` edges (origin: docstring) from `Depends:` field only
   - Honor `# stark-graph: ignore` suppression annotation
   - Skip files >500KB, files failing `ast.parse()` → record in `skipped_files`
   - Files: `scripts/graph/python_parser.py`
   - Done when: output validates against Graph schema; fixtures cover valid, empty, `__init__.py`, syntax error, encoding, large, suppressed

2. **Implement real per-file timeout**
   - Run each file parse in a subprocess wrapper with 5s timeout
   - On timeout: record in `skipped_files`, log warning JSON to stderr, continue
   - Portable: use threading-based timeout (not `signal.alarm`) for CI compatibility
   - Files: `scripts/graph/python_parser.py`
   - Done when: synthetic hanging-parse fixture is skipped without aborting

3. **Add audit-mode output in orchestrator**
   - `--stage audit`: run parse + non-blocking docstring audit
   - Print human-readable missing-docstring report + machine-readable JSON
   - Always exit 0 (unlike validate which exits 1 on drift)
   - Audit reports only `NO_DOCSTRING` and coverage — not STALE/MISSING
   - Files: `scripts/stark_graph.py`
   - Done when: stark-showcase gets usable missing-docstring report without touching CI gates

4. **Parser unit tests**
   - One test per fixture: valid module, class with docstring, class without, syntax error, empty, `__init__.py`, >500KB, encoding issue, suppressed node
   - Assert node IDs match format, docstring grammar rejection logs warning
   - Files: `scripts/test_python_parser.py`, `tests/fixtures/graph/`
   - Done when: all fixture tests pass

### Risks
- Import resolution false positives from relative imports → normalize relative paths before comparison
- Parser performance from subprocess timeouts → sequential for MVP scale, subprocess only per file

### Verification
```bash
"$PYTHON" scripts/stark_graph.py --repo "$REPO_UNDER_TEST" --repo-name "$REPO_NAME" --stage parse
"$PYTHON" scripts/stark_graph.py --repo "$REPO_UNDER_TEST" --repo-name "$REPO_NAME" --stage audit
"$PYTHON" -m pytest scripts/test_python_parser.py
```

Expected: node count ≥130, edge count ≥200 for stark-showcase backend. Spot-check 5 known classes.

### Rollback
Disable parse/audit invocation from any workflow. Parser remains dormant safely.

---

## Phase 3: Drift Validator, Warn Mode, Coverage Thresholds
**Goal:** Make `Depends:` validation authoritative and safe to bootstrap in warn mode.
**Dependencies:** Phase 2
**Estimated effort:** M (4 tasks)

### Tasks

1. **Implement strict validation in `scripts/graph/drift_validator.py`**
   - Compare docstring `depends` entries to AST-derived import edges
   - Resolution: qualified names to node IDs with exact/prefix match; report ambiguity candidates on 0-match or multi-match
   - Emit `STALE`, `MISSING`, `NO_DOCSTRING`, `broken_xref` (informational), `suppressed`, `skipped_files`, `coverage`
   - `Called by` is informational only — reported, not CI-blocking
   - All node references use full node IDs in output
   - Files: `scripts/graph/drift_validator.py`
   - Done when: JSON output matches design example; exit 1 only for domain failures in strict mode

2. **Add warn-mode behavior in orchestrator**
   - `--warn`: preserve findings but force exit 0
   - Annotate validation JSON with `"mode": "warn"`
   - Prepend warn banner for downstream comment rendering
   - Files: `scripts/stark_graph.py`
   - Done when: same broken fixture returns exit 1 strict, exit 0 warn, identical findings

3. **Add coverage-threshold enforcement**
   - Configurable threshold in `global/config.json` (default: 80%)
   - Low coverage = warning in comments and audits (not hard-fail)
   - Files: `scripts/graph/drift_validator.py`, `global/config.json`
   - Done when: threshold behavior is test-covered and visible in validation output

4. **Validator unit tests**
   - Fixture-per-check: STALE, MISSING, NO_DOCSTRING, clean (zero findings), suppressed, warn mode
   - Build Graph objects programmatically (not real source files)
   - Assert exact JSON structure per fixture
   - Integration test: full parse → validate on fixture mini-repo
   - Files: `scripts/test_drift_validator.py`, `scripts/test_graph_integration.py`
   - Done when: all fixture tests pass, integration pipeline exits correctly

### Risks
- Missing docstrings fail everything day-one → audit + warn modes land first
- Ambiguous qualified-name matching confuses devs → return candidate node IDs, not just display names

### Verification
```bash
"$PYTHON" scripts/stark_graph.py --repo "$REPO_UNDER_TEST" --repo-name "$REPO_NAME" --stage validate --warn
"$PYTHON" -m pytest scripts/test_drift_validator.py scripts/test_graph_integration.py
```

### Rollback
Switch all callers to `--warn` or `--stage audit`. Stop honoring exit 1 as blocking.

---

## Phase 4: Graph Diff and Blast Radius
**Goal:** Diff head vs base graphs reliably. Compute blast radius without contaminating the caller's checkout.
**Dependencies:** Phase 3
**Estimated effort:** M (3 tasks)

### Tasks

1. **Implement graph diffing and blast radius in `scripts/graph/graph_differ.py`**
   - Compare nodes and edges between base and head graphs
   - Emit `added_edges`, `removed_edges`, `added_nodes`, `removed_nodes`
   - Blast radius via **reverse BFS** from changed nodes (follow incoming edges):
     - `direct`: depth 1 — immediate callers/importers
     - `transitive`: BFS up to `transitive_depth_cap` (default 5), cycle-safe visited set
     - `depth_cap_reached`: boolean flag
     - `event_subscribers`: nodes whose `depends` reference a module containing a changed node with `publishes`
   - Label counts as "confirmed minimum"
   - `DiffReport` model validated by Pydantic
   - Files: `scripts/graph/graph_differ.py`
   - Done when: fixture pairs produce stable diff JSON; cycle fixtures terminate

2. **Add base-graph acquisition to orchestrator**
   - Create temp detached worktree for base ref: `.stark-graph/{slug}/worktrees/{base_ref}`
   - Run parser in worktree, capture base SHA
   - **Always** clean up worktree in `finally` path, even on failure
   - Files: `scripts/stark_graph.py`
   - Done when: repeated runs leave no orphaned worktrees or stale artifacts

3. **Differ unit tests**
   - Fixture graph pairs: added edge, removed edge, added node, removed node
   - Cycle fixture: verify no infinite loop, verify counts match
   - Depth cap fixture: verify `depth_cap_reached: true`
   - Files: `scripts/test_graph_differ.py`
   - Done when: all fixture tests pass

### Risks
- Worktree leaks on CI retry/cancellation → deterministic temp paths + unconditional cleanup
- Blast-radius overcount from mixed edge types → centralize traversal filter in one tested function

### Verification
```bash
"$PYTHON" scripts/stark_graph.py --repo "$REPO_UNDER_TEST" --repo-name "$REPO_NAME" --stage diff --base main
"$PYTHON" -m pytest scripts/test_graph_differ.py
```

### Rollback
Disable `--stage diff` and stop creating base worktrees. Validation still works independently.

---

## Phase 5: Idempotent PR Commenting
**Goal:** Post or update a single dependency comment per PR using existing GitHub App auth.
**Dependencies:** Phase 4
**Estimated effort:** M (3 tasks)

### Tasks

1. **Implement commenter in `scripts/graph/pr_commenter.py`**
   - Render markdown from `diff.json` and `validation.json`
   - Include collapsed `<details>` edge list table
   - Detect hidden marker `<!-- stark-graph-comment -->` for idempotent update
   - Retry on 429 or transient errors: 1s/2s/4s backoff, respect `Retry-After`
   - Per-request timeout 10s. Exit 2 on exhausted retries
   - Escape all repo-derived content (HTML/markdown) before POST
   - Return created/updated comment URL in machine-readable output
   - Files: `scripts/graph/pr_commenter.py`
   - Done when: reruns update same comment, never duplicate

2. **Reuse existing auth adapter**
   - Call existing token flow in `scripts/github_app.py` (stark-claude bot)
   - For CI: support `GH_TOKEN` env var as fallback when Keychain unavailable
   - Files: `scripts/graph/pr_commenter.py`, `scripts/github_app.py` (only if helper needed)
   - Done when: posts through same credential path as review posting

3. **Commenter tests**
   - Mock GitHub API: idempotent update test, retry on 429 test, timeout handling
   - Markdown rendering test: verify escaping of special characters from repo content
   - Files: `scripts/test_pr_commenter.py`
   - Done when: all tests pass without requiring live GitHub credentials

### Risks
- Rate limiting during reruns → hidden-marker updates + bounded retries
- Markdown injection from repo content → escape values before POST

### Verification
```bash
"$PYTHON" -m pytest scripts/test_pr_commenter.py
# Live test (requires PR and credentials):
export GH_TOKEN=$("$PYTHON" scripts/github_app.py --app stark-claude token)
"$PYTHON" scripts/stark_graph.py --repo "$REPO_UNDER_TEST" --repo-name "$REPO_NAME" --pr $PR_NUMBER --warn
```

### Rollback
Remove PR-comment stage from workflow. Keep diff/validation as artifacts only.

---

## Phase 6: Review Integration and Skill Wrapper
**Goal:** Wire graph system into PR review pipeline and deliver the `/stark-graph` skill.
**Dependencies:** Phase 5
**Estimated effort:** M (4 tasks)

### Tasks

1. **Add pre-review gate at dispatcher boundary**
   - In `scripts/triage_orchestrator.py`: run `stark_graph.py` before PR-domain dispatch
   - Exit 0 → continue review
   - Exit 1 → stop review, rely on graph validation comment (saves tokens)
   - Exit 2 → log degradation, continue without graph context
   - Files: `scripts/triage_orchestrator.py`
   - Done when: reviews skip on known drift, degrade gracefully on infrastructure failures

2. **Add prompt enrichment to review domains**
   - In `_run_subagent_inner()` in `scripts/multi_review.py`: append `## Dependency Context` section from `diff.json`
   - Enforce 2000-token budget: truncate to added/removed edges when exceeded, link to PR comment
   - Gate behind `graph_enriched_domains` config in `global/config.json`
   - Default: `["architecture", "correctness", "regression-prevention"]`
   - Files: `scripts/multi_review.py`, `global/config.json`
   - Done when: only configured domains receive graph context

3. **Add skill wrapper**
   - Create `skill/stark-graph/SKILL.md` following existing skill conventions
   - Support: `/stark-graph`, `/stark-graph validate`, `/stark-graph audit`, `/stark-graph diff`, `/stark-graph pr 123`
   - Include required skill frontmatter (auto-discovered by installer)
   - Files: `skill/stark-graph/SKILL.md`
   - Done when: skill invocable through installed skill system

4. **Write docstring convention docs**
   - Document the `Depends:`, `Publishes:`, `Called by:` convention
   - Include examples, grammar rules, suppression syntax
   - Files: `docs/docstring-convention.md` (or in stark-showcase if preferred)
   - Done when: developers have a canonical reference for bootstrapping docstrings

### Risks
- Graph context in every domain increases cost → config gate + hard token cap
- Gate too deep in `multi_review.py` bypasses dispatchers → place gate in `triage_orchestrator.py`

### Verification
```bash
"$PYTHON" -m pytest scripts/test_triage_orchestrator_graph_gate.py scripts/test_multi_review_graph_context.py
```

### Rollback
Remove graph call from `triage_orchestrator.py`. Remove `## Dependency Context` injection from `multi_review.py`.

---

## Phase 7: CI Rollout, Bootstrap, and Operations
**Goal:** Safe CI activation. Bootstrap stark-showcase docstrings. Promote from audit → warn → strict.
**Dependencies:** Phase 6
**Estimated effort:** L (3 tasks)

### Tasks

1. **Add CI workflow**
   - Create `.github/workflows/graph-review.yml`:
     - `on: pull_request` (opened, synchronize)
     - Full-history checkout, Python 3.12, pydantic install
     - `stark_graph.py --pr $PR --warn` during bootstrap
     - Upload `.stark-graph/**` as CI artifact (14-day retention)
   - Files: `.github/workflows/graph-review.yml`
   - Done when: PRs generate validation/diff artifacts and graph comment without affecting other workflows

2. **Add scheduled audit workflow**
   - Create `.github/workflows/graph-audit.yml`:
     - Weekly cron against `main`
     - Run `--stage audit --warn`
     - Upload validation report
     - Post warning (not fail) if coverage drops below threshold
   - Files: `.github/workflows/graph-audit.yml`
   - Done when: coverage erosion visible without waiting for a PR

3. **Bootstrap stark-showcase and promote to strict**
   - Run audit on `backend/showcase`
   - Generate draft docstrings in a dedicated bootstrap PR
   - Review manually
   - Enable warn mode for 1-2 sprints; measure false-positive rate
   - When FP rate <5%: remove `--warn`, optionally starting with `--include backend/showcase/services/`
   - Files: stark-showcase repo
   - Done when: false positives <5%, strict mode blocking confidently

### Risks
- Strict before bootstrap = halted PR throughput → explicit warn-only window
- Artifact growth → 14-day retention, JSON only (no rendered binaries)

### Verification
```bash
"$PYTHON" -m pytest scripts/test_graph_pipeline_integration.py scripts/test_pr_commenter.py
# Verify CI workflow on a test PR
```

### Rollback
Change workflow back to `--warn`, then `--stage audit` if needed. Disable scheduled audit until issues fixed.

---

## 4. Integration Points

| Artifact | Producer | Consumer | Break Signal |
|----------|----------|----------|-------------|
| `parse-python.json` (Graph) | python_parser.py | drift_validator.py, graph_differ.py | Pydantic validation failure |
| `validation.json` (ValidationReport) | drift_validator.py | pr_commenter.py, orchestrator | Schema error, wrong exit code |
| `diff.json` (DiffReport) | graph_differ.py | pr_commenter.py, multi_review.py | Schema error, incomplete blast_radius |
| GitHub App auth | github_app.py | pr_commenter.py | Token failure → exit 2 |
| Pre-review gate | stark_graph.py | triage_orchestrator.py | Wrong exit code → reviews skip/fail |
| Prompt enrichment | diff.json | multi_review.py | Domain list mismatch |
| `graph_enriched_domains` | global/config.json | multi_review.py | Missing key → no enrichment |

## 5. Testing Strategy

| Level | Timing | Scope |
|-------|--------|-------|
| Unit tests | Each phase | Models, parser fixtures, validator per-check, differ pairs, commenter retry/idempotency |
| Integration tests | Phase 3+ | Full parse → validate → diff on fixture repo |
| Contract tests | Phase 5+ | Mock GitHub API for commenter |
| E2E tests | Phase 7 | Full pipeline on disposable PR, scheduled audit workflow |

Test order follows implementation order. Every phase's verification block must pass before starting the next.

## 6. Rollback Plan

| Phase | Rollback Action |
|-------|----------------|
| 1 | Remove `scripts/graph/` and `scripts/stark_graph.py` from install refs |
| 2 | Disable parse/audit invocation; parser remains dormant |
| 3 | Switch all callers to `--warn` or `--stage audit` |
| 4 | Disable `--stage diff`; validation works independently |
| 5 | Remove PR-comment stage; keep artifacts only |
| 6 | Remove graph call from `triage_orchestrator.py` and enrichment from `multi_review.py` |
| 7 | Change workflow to `--warn` → `--stage audit`; disable scheduled audit |
