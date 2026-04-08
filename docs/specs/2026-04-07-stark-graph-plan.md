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
- Existing `github_app.py` auth infrastructure is reused with minimal CI extension (env-var-based token minting for Linux runners where macOS Keychain is unavailable)
- Bootstrap (docstring generation on stark-showcase) runs in parallel with Phases 2-3

### Design Gaps to Resolve Up Front

- **Script location:** Use `scripts/stark_graph.py` to match repo layout (not repo root)
- **Test layout:** Tests in `scripts/test_graph_*.py`, fixtures in `tests/fixtures/graph/`
- **Per-file timeout:** `ast.parse()` is not preemptible in-process; use `subprocess.run(timeout=5)` per file (not threading — threads cannot interrupt CPython C-extension calls)
- **Config key:** Add `graph_enriched_domains` to `global/config.json` (via `discover_config()` hierarchy, not raw file read)
- **Prompt injection:** Add grammar validation tasks in Phase 2 (parser) and Phase 5 (commenter); apply allowlist filter at prompt construction boundary (Phase 6)
- **Docstring convention docs:** Add as a task in Phase 6
- **`--include` flag:** Add to Phase 1 CLI contract (required for Phase 7 partial strict rollout)
- **Gate mode:** Add `graph_gate_mode` config key (enum: `disabled` | `shadow` | `blocking`, default `disabled`) for Phase 6 gate. `disabled` = skip graph entirely (kill switch). `shadow` = run graph, log results, never block. `blocking` = exit 1 stops review. Emergency disable without code deploy
- **CI deployment target:** Workflows deploy to stark-showcase, not stark-skills
- **Existing file verification:** Confirm `scripts/triage_orchestrator.py` exists before Phase 6; if not, create as a thin dispatch wrapper

## 2. Prerequisites

- Python 3.12 in dev environment and CI runners
- `git`, `git worktree`, `gh` installed; `gh auth status` returns authenticated
- `scripts/github_app.py` present and tested (per CLAUDE.md — already exists)
- GitHub Apps already exist: stark-claude (3066738), stark-codex (3066834), stark-gemini (3066689) — no creation needed
- Write access to `GetEvinced/stark-showcase` confirmed (needed for acceptance testing, bootstrap PRs, and CI workflow deployment). **Blocking dependency** — verify before Phase 2
- `scripts/triage_orchestrator.py` — verify exists with `ls scripts/triage_orchestrator.py`. If missing, Phase 6 Task 1 must create it as a thin dispatch wrapper. Determine this now to scope Phase 6 accurately
- `discover_config()` — verify exists in the config loader with `grep -r "def discover_config" scripts/`. Phase 1 Task 4 depends on this

```bash
export REPO_UNDER_TEST="$HOME/git/Evinced/stark-showcase/backend"
export REPO_NAME="GetEvinced/stark-showcase"
export SCRIPTS_DIR="/Users/aryeh/git/Evinced/stark-skills/scripts"

# Create venv if it doesn't exist; fail loudly if Python 3.12 is missing
python3 --version | grep -q "3.12" || { echo "Python 3.12 required"; exit 1; }
python3 -m venv "$SCRIPTS_DIR/.venv"
export PYTHON="$SCRIPTS_DIR/.venv/bin/python3"

# Install all runtime deps (not just pydantic — commenter needs requests/PyJWT)
"$PYTHON" -m pip install "pydantic>=2.0,<3" "requests>=2.28" "PyJWT>=2.0" "cryptography>=3.0" pytest

# Verify
"$PYTHON" -c "import pydantic, requests, jwt; assert pydantic.VERSION.startswith('2'), f'Need pydantic v2, got {pydantic.VERSION}'"

# Preflight: confirm stark-showcase access
gh repo view GetEvinced/stark-showcase --json nameWithOwner -q .nameWithOwner
```

**Dependency pinning:** For CI, create `scripts/requirements-graph.txt` with exact versions and SHA256 hashes. Install via `pip install --require-hashes -r requirements-graph.txt`. This prevents supply-chain drift between dev and CI.

**Can be done in parallel with Phase 1:**
- Scaffold `tests/fixtures/graph/` with a mini-repo fixture (5-10 Python files covering all edge cases)
- Scaffold `tests/fixtures/graph-e2e/` as a disposable fixture repo for Phase 7 E2E tests
- Draft docstring convention documentation for stark-showcase developers
- Begin exploratory audit run on stark-showcase once Phase 2 parser is complete (results are informational only — authoritative baseline runs after Phase 3)

## 3. Phases

---

## Phase 1: Foundation and Contracts
**Goal:** Establish the graph schema, CLI surface, workdir conventions, and exit-code/error contract without changing review behavior.
**Dependencies:** None
**Estimated effort:** M (5 tasks, ~3-5 days)

### Tasks

1. **Define graph and report models in `scripts/graph/model.py`**
   - Implement `Node`, `Edge`, `Graph`, `ValidationReport`, `DiffReport` Pydantic models
   - Enforce schema-major compatibility (`Graph.reject_unknown_version()`)
   - Encode `partial`, `skipped_files`, and full node IDs exactly as designed
   - Add the `Parser` protocol with `parse(paths, repo) -> Graph`, `language()`, `file_patterns()`
   - `Node` fields: `id`, `layer` (enum: module|class), `parent`, `depends`, `publishes`, `called_by`, `file_path`, `line`
   - `Edge` fields: `source`, `target`, `type` (open string), `origin` (enum: ast|docstring)
   - `ValidationReport` must include a `dismissed` field (list of finding IDs marked as false positives) — needed for Phase 7 FP rate tracking
   - Files: `scripts/graph/__init__.py`, `scripts/graph/model.py`
   - Done when: malformed envelopes rejected, valid JSON roundtrips, schema mismatches fail

2. **Scaffold orchestrator with shared workdir/error handling in `scripts/stark_graph.py`**
   - CLI flags: `--repo`, `--repo-name`, `--stage`, `--pr`, `--base`, `--warn`, `--include` (path prefix, repeatable), `--input`, `--output`, `--workdir`
   - Slugged workdir: `.stark-graph/{pr-or-branch}/` — slug normalized: replace `[^a-zA-Z0-9_-]` with `-`, collapse consecutive dashes, max 80 chars; assert `os.path.realpath()` stays within expected prefix before any I/O
   - `--base` validation: reject values not matching `^[a-zA-Z0-9_./:-]+$`; use `--` separator in all git subprocess calls to prevent flag injection
   - Repo identity: derive from `git remote get-url origin`, fallback to `GITHUB_REPOSITORY` env var, then `--repo-name`
   - `--pr` mode base-ref resolution: resolve to a concrete commit SHA (not a branch name, which is mutable). In CI: `git merge-base HEAD origin/$GITHUB_BASE_REF`. Locally: `gh pr view --json baseRefOid --jq .baseRefOid`. Store resolved SHA in workdir as `base-sha.txt`. Fail early (exit 2) if unresolvable
   - Stderr JSON on failure, exit codes 0/1/2 per design
   - Startup sweep: remove any `.stark-graph/*/worktrees/` directories older than 24 hours and run `git worktree prune` (handles SIGKILL orphans from prior runs)
   - Files: `scripts/stark_graph.py`
   - Done when: `--help` documents all modes, dry run creates expected workdir structure

3. **Schema and CLI regression tests**
   - Unit tests for required fields, optional defaults, version rejection, CLI argument validation, slug sanitization (path traversal), `--base` validation (flag injection), `--include` filtering
   - Files: `scripts/test_graph_model.py`, `scripts/test_stark_graph_cli.py`
   - Done when: schema and CLI contract locked before parser logic starts

4. **Add `graph_enriched_domains` and `graph_gate_mode` to config**
   - Add `graph_enriched_domains` key to config with default `["architecture", "correctness", "regression-prevention"]`
   - Add `graph_gate_mode` key (enum: `disabled` | `shadow` | `blocking`, default: `disabled`)
   - Keys must be loadable via `discover_config()` hierarchy (not raw `global/config.json` read)
   - Files: `global/config.json`, config loader if needed
   - Done when: config loads without error; downstream code falls back to defaults when keys absent

5. **Update `install.sh` for new files**
   - Add `scripts/stark_graph.py` and `scripts/graph/` to install references
   - Verify skill discovery with `./install.sh --status`
   - Files: `install.sh`
   - Done when: `./install.sh && ./install.sh --status` shows stark-graph registered

6. **Create `scripts/requirements-graph.txt` dependency lockfile**
   - Pin all graph pipeline runtime deps with exact versions and SHA256 hashes: `pydantic`, `requests`, `PyJWT`, `cryptography`
   - Generate via: `pip install pip-tools && pip-compile --generate-hashes --output-file=scripts/requirements-graph.txt` (from a requirements.in listing the four packages)
   - CI installs from this file: `pip install --require-hashes -r requirements-graph.txt`
   - Files: `scripts/requirements-graph.txt`
   - Done when: `pip install --require-hashes -r scripts/requirements-graph.txt` succeeds in a clean venv

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
**Estimated effort:** L (4 tasks, ~5-8 days)

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
   - Extract the per-file parse logic into `scripts/graph/parse_worker.py` (a standalone script that takes a file path as argv[1], parses it, writes node/edge JSON to stdout). Unit-test the worker independently
   - Run each file parse via `subprocess.run([sys.executable, str(Path(__file__).parent / "graph" / "parse_worker.py"), filepath], timeout=5, capture_output=True)` — use `__file__`-relative path so it works regardless of cwd (including when stark-skills is checked out as `.stark-skills/` in CI)
   - On `TimeoutExpired`: kill child process, record in `skipped_files`, log warning JSON to stderr, continue
   - Do not use `signal.alarm` (not safe in multi-threaded callers) or threading-based timeout (cannot preempt `ast.parse()`)
   - **CI timeout guard:** Before parsing, count `*.py` files. If count > 500, log warning. In diff mode, both head and base are parsed (2x file count). Total parse budget must stay under 10 minutes (of the 15-minute CI timeout). If sequential parse would exceed 5 minutes at 1s/file worst case, switch to `ProcessPoolExecutor(max_workers=4)` with per-file timeout. Document the concurrency ceiling as a config parameter (`graph_max_parse_workers`, default: 1)
   - Files: `scripts/graph/python_parser.py`, `scripts/graph/parse_worker.py`
   - Done when: synthetic hanging-parse fixture is skipped without aborting; worker script has independent unit tests

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

Sanity check: graph is non-empty (≥1 node, ≥1 edge). Spot-check 5 known classes by ID and verify expected edges. If counts seem low, run `find "$REPO_UNDER_TEST" -name "*.py" | wc -l` to compare file count vs node count — investigate if node count < 50% of file count.

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
   - **Runtime-only dependencies:** A docstring `Depends:` entry with no matching AST import is valid (dependency injection, factory patterns, framework callbacks). Do not emit `STALE` for these — emit `RUNTIME_ONLY` (informational). Only emit `STALE` when a docstring entry contradicts an AST-observed import (e.g., lists module A but imports module B). Note: `RUNTIME_ONLY` is indistinguishable from a parser gap (dynamic import the AST walker missed). This is acceptable — the validator should not block on either case. Future improvement: cross-reference with runtime instrumentation to distinguish true runtime deps from parser gaps
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
   - Fixture-per-check: STALE, MISSING, NO_DOCSTRING, RUNTIME_ONLY, clean (zero findings), suppressed, warn mode
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
At Phase 3 completion, no CI callers exist yet — validator is dormant but code is installed. No rollback action required beyond uninstall. (Once Phase 6/7 are live, rollback means: set `graph_gate_mode: disabled` in config, then change CI workflow to `--warn` or `--stage audit`.)

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
   - **Prerequisite:** Full git history required (`fetch-depth: 0` in CI). Add defensive check: `if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then exit 2; fi` (note: `--is-shallow-repository` prints `true`/`false` to stdout, always exits 0 — check the output string, not the exit code)
   - Worktree path uses the resolved base SHA (not branch name) to avoid directory nesting issues from slash-containing branch names (e.g., `feature/foo` → nested dirs). Path: `.stark-graph/{slug}/worktrees/{base_sha_short}`
   - Pre-create guard: if worktree path already exists (SIGKILL orphan from prior run), `git worktree remove --force {path}` and `git worktree prune` before `git worktree add`
   - Run parser in worktree, capture base SHA
   - **Always** clean up worktree in `finally` path, even on failure
   - Files: `scripts/stark_graph.py`
   - Done when: repeated runs leave no orphaned worktrees; interrupted-then-retried runs succeed idempotently

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
   - Retry on 429 or transient errors: exponential backoff with `sleep = max(backoff[attempt], Retry-After header)`, capped at 120s total wait. Do not use fixed 1s/2s/4s schedule — GitHub's `Retry-After` values are commonly 30-120s
   - Per-request timeout 10s. Exit 2 on exhausted retries
   - Escape all repo-derived content (HTML/markdown) before POST
   - Return created/updated comment URL in machine-readable output
   - Files: `scripts/graph/pr_commenter.py`
   - Done when: reruns update same comment, never duplicate

2. **Reuse existing auth adapter with CI support**
   - Call existing token flow in `scripts/github_app.py` (stark-claude bot) for local dev
   - For CI (Linux runners, no macOS Keychain): extend `github_app.py` to mint tokens from env vars (`STARK_APP_ID`, `STARK_INSTALL_ID`, `STARK_PRIVATE_KEY_B64` — base64-encoded PEM, since raw PEM newlines are unreliable in shell env vars) when Keychain is unavailable. Decode: `base64.b64decode(os.environ["STARK_PRIVATE_KEY_B64"])`. This is a required code change — the "reused unchanged" claim does not hold for CI
   - **Auth precedence:** App token (Keychain or env-var) → `GH_TOKEN` fallback. Document this order explicitly. When using GH_TOKEN, emit warning log. GH_TOKEN should be a fine-grained PAT — scope validation is not programmatically feasible (GitHub doesn't expose scopes on fine-grained PATs), so document the required scope (`pull_requests: write` on target repo only) and rely on least-privilege provisioning
   - **Credential rotation:** Document in Phase 7 ops: App private key rotation requires updating both macOS Keychain (`STARK_CLAUDE_PRIVATE_KEY`) and CI secret (`STARK_PRIVATE_KEY_B64`). Recommend 180-day rotation. No automated expiry detection — add to scheduled audit canary check
   - Files: `scripts/graph/pr_commenter.py`, `scripts/github_app.py`
   - Done when: posts through App token locally; posts through env-var-minted App token in CI; GH_TOKEN fallback tested with scope validation

3. **Commenter tests**
   - Mock GitHub API: idempotent update test, retry on 429 test (with Retry-After override), timeout handling
   - Markdown rendering test: verify escaping of special characters from repo content
   - Files: `scripts/test_pr_commenter.py`
   - Done when: all tests pass without requiring live GitHub credentials

4. **Provision CI secrets (prerequisite for live test and Phase 7)**
   - Add `STARK_APP_ID`, `STARK_INSTALL_ID`, `STARK_PRIVATE_KEY_B64` (base64-encoded PEM) secrets to `GetEvinced/stark-showcase` repo settings
   - Verify env-var-based token minting: `STARK_PRIVATE_KEY_B64=$(base64 < key.pem) STARK_APP_ID=3066738 STARK_INSTALL_ID=115648521 "$PYTHON" scripts/github_app.py token`
   - Note: this is the **single provisioning task** — Phase 7 Task 4 wires the toggle but does not re-provision secrets
   - Done when: App token can be minted from env vars without Keychain

5. **Mandatory live PR gate (go/no-go for Phase 6)**
   - Create a disposable test PR on stark-showcase (or a test repo)
   - Post graph comment using both auth paths: (a) macOS Keychain locally, (b) env-var-minted token (simulates CI)
   - Rerun to update same comment (idempotency proof)
   - Run **3 consecutive successful post+update cycles** (not a single run — single success does not prove stability)
   - Verify: hidden marker detection, returned comment URL, correct bot identity
   - **This is a blocking gate** — do not proceed to Phase 6 until live commenting is proven with both auth paths
   - Done when: 3 consecutive successful cycles on a real PR

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
Remove PR-comment stage from workflow. Keep diff/validation as artifacts only. Clean up any existing graph comments on open PRs via marker-keyed delete. If `github_app.py` was modified (Task 2), revert the env-var auth code path to avoid breaking existing review posting.

---

## Phase 6: Review Integration and Skill Wrapper
**Goal:** Wire graph system into PR review pipeline and deliver the `/stark-graph` skill.
**Dependencies:** Phase 5 (including mandatory live PR gate)
**Estimated effort:** M (5 tasks, ~3-5 days)

### Tasks

1. **Add pre-review gate at dispatcher boundary**
   - **Prerequisite:** Confirm `scripts/triage_orchestrator.py` exists. If not, create as a thin dispatch wrapper around `multi_review.py` with its own task
   - Check `graph_gate_mode` config first — if `disabled`, skip graph entirely (kill switch). If `shadow`, run graph but never block. If `blocking`, honor exit codes. Default: `disabled`
   - In `scripts/triage_orchestrator.py`: run `stark_graph.py` before PR-domain dispatch
   - **Gate deploys in shadow mode first (Phase 6):** run `stark_graph.py`, log exit code and outcome, but treat all exit codes as exit 0 (informational only, never block). This is the soak period
   - Exit 2 → log degradation with structured reason code (auth failure, parse failure, worktree failure), continue without graph context. Emit `graph_degraded` metric to CI job summary. If degradation persists across 3+ consecutive PRs, the scheduled audit should surface it via the tracking issue
   - **Blocking behavior (exit 1 → stop review) is only enabled after Phase 7 promotion** — not at Phase 6 deploy time
   - **Validation vs comment separation:** If validation finds drift (would be exit 1) but comment posting fails (exit 2), the gate must not silently stop reviews with no explanation. Either: fall back to normal review with a log entry, or post a fallback status via commit status API
   - Note: existing callers use `triage_orchestrator.py ... || multi_review.py ...` — the gate must return structured success with a `graph_blocked` field, not a non-zero exit code that triggers the `||` fallback
   - Files: `scripts/triage_orchestrator.py`
   - **Shadow mode exit criteria (gate for Phase 7):** Shadow mode runs for minimum 5 business days AND 20 PRs (both conditions must be met). Exit criteria: zero infrastructure failures (exit 2) in last 10 PRs, no graph-caused review pipeline crashes, shadow-logged validation results reviewed on 5 representative PRs (confirm findings are plausible, not false-positive noise). Maximum shadow duration: 15 business days — if criteria not met by then, investigate root cause before extending. Only proceed to Phase 7 CI rollout after shadow soak passes
   - Done when: gate runs in shadow mode on all PRs, logs outcomes, never blocks reviews

2. **Add prompt enrichment to review domains**
   - In `_run_subagent_inner()` in `scripts/multi_review.py`: append `## Dependency Context` section from `diff.json`
   - **Prompt injection protection:** Apply strict allowlist filter (`[a-zA-Z0-9_:./-]+`) to all repo-derived fields from `diff.json` at the point of prompt construction (note: `:` is required because node IDs use `{repo}:{path}:{qualname}` format). Wrap the dependency section in XML-delimited tags (`<dependency-context>...</dependency-context>`) that the prompt instructs the model to treat as data, not instructions. Log any value that fails the filter
   - Token counting: approximate as `len(text) / 4` (intentional approximation — avoids tiktoken dependency). Enforce 2000-token budget: truncate to added/removed edges when exceeded, link to PR comment
   - Gate behind `graph_enriched_domains` config (loaded via `discover_config()`, not raw `global/config.json`)
   - Default: `["architecture", "correctness", "regression-prevention"]`
   - Config override policy: org/repo configs can override this list using the same hierarchy as other config keys
   - Files: `scripts/multi_review.py`
   - Done when: only configured domains receive graph context; injected content is sanitized

3. **Add skill wrapper**
   - Create `skill/stark-graph/SKILL.md` following existing skill conventions
   - Support: `/stark-graph`, `/stark-graph validate`, `/stark-graph audit`, `/stark-graph diff`, `/stark-graph pr 123`
   - Include required skill frontmatter (auto-discovered by installer)
   - Files: `skill/stark-graph/SKILL.md`
   - Done when: skill invocable through installed skill system

4. **Write docstring convention docs**
   - Document the `Depends:`, `Publishes:`, `Called by:` convention
   - Include examples, grammar rules, suppression syntax (`# stark-graph: ignore`)
   - Include quick-fix guide: how to resolve STALE, MISSING, NO_DOCSTRING findings
   - Include false-positive reporting instructions
   - Files: `docs/docstring-convention.md` (or in stark-showcase if preferred)
   - Done when: developers have a canonical reference for bootstrapping docstrings

5. **Write integration tests for gate and enrichment**
   - `test_triage_orchestrator_graph_gate.py`: shadow mode (exit 1 logged but not blocking), config kill switch, exit 2 degradation, validation-fail + comment-fail combined case
   - `test_multi_review_graph_context.py`: enrichment on configured domains only, prompt injection filter, token budget truncation
   - Files: `scripts/test_triage_orchestrator_graph_gate.py`, `scripts/test_multi_review_graph_context.py`
   - Done when: all tests pass

### Risks
- Graph context in every domain increases cost → config gate + hard token cap
- Gate too deep in `multi_review.py` bypasses dispatchers → place gate in `triage_orchestrator.py`
- Prompt injection via crafted class/file names in diff.json → allowlist filter at prompt boundary

### Verification
```bash
"$PYTHON" -m pytest scripts/test_triage_orchestrator_graph_gate.py scripts/test_multi_review_graph_context.py
```

### Rollback
Set `graph_gate_mode: disabled` in config (instant, no code deploy). Then if needed: remove graph call from `triage_orchestrator.py` and `## Dependency Context` injection from `multi_review.py`.

---

## Phase 7: CI Rollout, Bootstrap, and Operations
**Goal:** Safe CI activation. Bootstrap stark-showcase docstrings. Promote from audit → warn → strict.
**Dependencies:** Phase 6
**Estimated effort:** L (5 tasks, ~5-8 days implementation + 10-day minimum warn-mode soak)

### Tasks

**Task execution order: 1 (provision) → 2 (workflow content) → 3 (audit content) → 4 (deploy) → 5 (bootstrap) → 6 (runbook) → 7 (E2E tests).**

1. **Create stark-skills release tag, provision cross-repo auth, wire strict-mode toggle**
   - Cut a release tag on `GetEvinced/stark-skills` (e.g., `stark-graph-v0.1.0`) using `/stark-release`. This is the tag the CI workflow pins to. Bump this tag on each stark-skills release that changes graph code. Use signed tags (`git tag -s`) to prevent tag mutation
   - Create `STARK_SKILLS_TOKEN` secret in stark-showcase — a fine-grained PAT with `contents: read` on `GetEvinced/stark-skills` only
   - CI secrets (App auth) already provisioned in Phase 5 Task 4 — verify they work by minting a token from the CI secret values
   - Create `vars.STARK_GRAPH_STRICT` repository variable (initial value: `false`). Values: `false` (warn mode) | `partial` (strict with `--include`) | `true` (strict on all paths)
   - Add `vars.STARK_GRAPH_INCLUDE_PATH` for the partial-strict scope (default: `backend/showcase/services/`)
   - Done when: tag exists and is signed, all secrets provisioned, variables created

2. **Define CI PR review workflow (graph-review.yml)**
   - Workflow YAML content for deployment in Task 4
   - **Code provisioning:** The workflow checks out stark-skills as a secondary repo using `actions/checkout` with `repository: GetEvinced/stark-skills`, `path: .stark-skills`, `ref: <stark-graph-release-tag>` (pin to release tag from Task 1). Auth: add a `STARK_SKILLS_TOKEN` secret — a fine-grained PAT with `contents: read` scope on `GetEvinced/stark-skills` only (the default `GITHUB_TOKEN` cannot read private repos outside the current repo). All `stark_graph.py` invocations use `.stark-skills/scripts/stark_graph.py`. This ensures CI always runs trusted, pinned code from stark-skills
   - Create `.github/workflows/graph-review.yml`:
     - `on: pull_request` (opened, synchronize)
     - `concurrency: { group: "graph-${{ github.event.pull_request.number }}", cancel-in-progress: true }` — prevents stale-run comment overwrites
     - `timeout-minutes: 15` at job level — bounds blast radius from hangs
     - `permissions: { pull-requests: write, contents: read }` — minimum required
     - Full-history checkout: `actions/checkout` with `fetch-depth: 0` (required for base-ref worktree in Phase 4)
     - Python 3.12, install deps from lockfile: `pip install --require-hashes -r .stark-skills/scripts/requirements-graph.txt` (pydantic, requests, PyJWT, cryptography — all pinned with SHA256 hashes)
     - CI auth step (in trusted comment job only): mint App installation token from `STARK_APP_ID` / `STARK_INSTALL_ID` / `STARK_PRIVATE_KEY_B64` secrets via `.stark-skills/scripts/github_app.py token`, export as `GH_TOKEN`. Auth precedence: App token (always preferred) → GH_TOKEN fallback (only if App auth fails)
     - `env: PR_NUMBER: ${{ github.event.pull_request.number }}` — `$PR` is not automatically defined in GitHub Actions
     - Startup cleanup: `git worktree prune && rm -rf .stark-graph/*/worktrees/` (handles SIGKILL orphans)
     - **`--warn` flag is conditional:** `${{ vars.STARK_GRAPH_STRICT == 'false' && '--warn' || '' }}`. When `STRICT=false`, pass `--warn` (findings are logged but exit code is 0). When `STRICT=true` or `partial`, omit `--warn` (exit code 1 on drift). This is how strict mode actually becomes enforcing
     - **Security: two-job split with explicit boundaries:**
       - **Job 1 (`analyze`):** Checks out PR code + stark-skills (pinned tag). Runs `stark_graph.py --repo . --repo-name $REPO_NAME --pr $PR_NUMBER $WARN_FLAG --stage diff` (where `WARN_FLAG` is set per above conditional; the orchestrator chains parse→validate→diff internally when `--stage diff` is specified; `--stage` is a single value, not repeatable). No secrets, `persist-credentials: false`. Captures the exit code: `stark_graph.py ... ; echo $? > exit-code.txt`. Uploads `validation.json`, `diff.json`, and `exit-code.txt` as artifacts. The job itself always exits 0 (so Job 2 and Job 3 always run)
       - **Job 2 (`comment`, `needs: analyze`):** Downloads artifacts via `actions/download-artifact`. Checks out stark-skills only (pinned tag, no PR code). Mints App token from secrets. Reads `exit-code.txt` to determine validation outcome. Runs `pr_commenter.py` with downloaded JSON. Passes PR number via `github.event.pull_request.number` (available in the same workflow context). This job has `pull-requests: write` and `statuses: write` permissions. It never touches PR-authored code
       - Artifact handoff contract: Job 2 validates artifact JSON against Pydantic schema before posting. If validation fails (corrupted or tampered artifact), skip comment and log error. Job 2 always exits 0 — comment failures must never block merges
       - **Job 3 (`gate`, `needs: analyze`, `if: always()`):** Lightweight job — no checkout, no secrets, no API calls. Uses `if: always()` so it runs even when analyze is cancelled (prevents skipped required check from blocking all PRs). Downloads `exit-code.txt`. If artifact is missing (analyze cancelled/failed), defaults to pass (safe default). Reads `vars.STARK_GRAPH_STRICT`. If strict (`true` or `partial`) AND exit code is 1, Job 3 **fails**. Otherwise passes. Add `graph-review / gate` as a required status check in branch protection. This fully decouples merge gating from comment posting
     - Upload `validation.json` and `diff.json` only (not full `parse-python.json` graph — reduces architecture exposure) with `retention-days: 14`
     - Pin all GitHub Actions by commit SHA
     - Include head SHA in comment marker/body so an older run refuses to overwrite newer-commit output
   - Files: `stark-showcase:.github/workflows/graph-review.yml`
   - Done when: PRs generate validation/diff artifacts and graph comment; 10 consecutive pilot PRs complete in <3 minutes with no runner timeouts

3. **Define scheduled audit workflow (graph-audit.yml)**
   - Create `.github/workflows/graph-audit.yml` in stark-showcase:
     - Weekly cron against `main`
     - `timeout-minutes: 15`
     - `permissions: { contents: read, issues: write }` — needs `issues: write` to open/update tracking issues
     - Code provisioning: same secondary checkout of `GetEvinced/stark-skills` as PR workflow (using `STARK_SKILLS_TOKEN` for private repo access, pinned to same release tag)
     - Startup cleanup: `git worktree prune`
     - Run `--stage audit --warn`
     - Upload validation report with `retention-days: 14`
     - Canary auth check: attempt token fetch and log success/failure before graph pipeline runs
     - **Notification contract:** Post GitHub Actions job summary with coverage stats. If coverage drops below threshold, open/update a tracking issue (not just artifact upload — artifacts that nobody reads are not a signal)
   - Files: `stark-showcase:.github/workflows/graph-audit.yml`
   - Done when: coverage erosion is surfaced via issue/job-summary without waiting for a PR

4. **Deploy workflow files to stark-showcase**
   - Create a PR in `GetEvinced/stark-showcase` containing the `graph-review.yml` (Task 2) and `graph-audit.yml` (Task 3) workflows
   - Merge the workflow PR. Verify the workflow runs (will be no-op initially since `graph_gate_mode` is `disabled` and `vars.STARK_GRAPH_STRICT` is `false`)
   - After at least one successful green run of the workflow, add `graph-review / gate` as a required status check in branch protection. Do NOT add required checks before the workflow has a proven passing run — otherwise all PRs are blocked
   - Done when: both workflows merged, at least one green run observed, required status check added

5. **Bootstrap stark-showcase and promote to strict**
   - Run audit on `backend/showcase` using `/stark-graph audit`
   - **Docstring generation:** Use `/stark-autopilot` with the audit output to draft `Depends:`/`Publishes:`/`Called by:` docstrings in a dedicated bootstrap PR. Include audit report in PR description. Hold bootstrap PR in draft until CI is confirmed stable (allows close-without-merge on rollback). Note: autopilot-generated docstrings may have systematic errors — review a 10% sample before merging to avoid inflating the FP rate during warn mode
   - Review manually
   - **Bootstrap completion gate (before warn mode):** After bootstrap PR is merged, run a full audit. Coverage must be ≥70% (below the 80% threshold, but sufficient for meaningful validation). If coverage is below 70%, the bootstrap is incomplete — do not enable warn mode
   - **FP measurement mechanism:** Before enabling warn mode, implement tracking:
     - Define false positive: a finding where the docstring entry is correct but the validator reports it as STALE/MISSING (e.g., runtime-only dep misclassified)
     - Track via `dismissed` field in validation artifact JSON + a `graph-false-positive` label on reported issues
     - **FP tracking workflow:** PR author reviews graph comment findings. If a finding is incorrect, author adds a `graph-false-positive` label to the PR. The scheduled audit tallies labeled PRs
     - Add FP rate calculation to the scheduled audit: `FP% = labeled_FP_PRs / total_PRs_with_findings`
     - Minimum sample: 20 PRs with findings before promotion is evaluable
   - Enable warn mode; promote to strict when: minimum 10 business days in warn mode AND >=20 PRs with findings processed AND FP rate <5% measured over last 20 PRs (consistent window — not "last 10" in one place and "last 20" elsewhere)
   - **Strict mode toggle:** Use GitHub Actions repository variable (`vars.STARK_GRAPH_STRICT`) rather than editing workflow YAML. Promotion and rollback are then instant variable updates, not PRs. Access control: only repo admins can modify repository variables — this is sufficient gate authority
   - Partial strict: use `--include backend/showcase/services/` for initial scope (flag added in Phase 1). Workflow wires `--include` when `vars.STARK_GRAPH_STRICT == 'partial'` (add `partial` as a third value: `false` | `partial` | `true`)
   - **Strict-mode alerting:** Add a CI step that posts to Slack (or opens an issue) if the strict gate blocks >3 PRs in a single day — provides real-time detection beyond the weekly audit
   - Files: stark-showcase repo
   - Done when: FP rate <5% measured with defined methodology, strict mode enabled via repo variable

6. **Write operations runbook**
   - Document failure modes: graph gate blocks all reviews (set `graph_gate_mode: disabled`), comment posting fails (check App token, check rate limits), worktree creation fails (run `git worktree prune`), parse timeout on large repo (increase `graph_max_parse_workers`), FP rate spikes after strict promotion (set `vars.STARK_GRAPH_STRICT=false`)
   - Include key extraction for CI: `security find-generic-password -s STARK_CLAUDE_PRIVATE_KEY -w | base64` → `STARK_PRIVATE_KEY_B64`
   - Include credential rotation: update macOS Keychain + `STARK_PRIVATE_KEY_B64` secret + `STARK_SKILLS_TOKEN` secret
   - Create `graph-false-positive` GitHub label in stark-showcase for FP tracking
   - Files: `docs/runbooks/stark-graph-ops.md`
   - Done when: runbook covers all documented failure modes with copy-paste remediation commands

7. **Write E2E integration tests**
   - Create `scripts/test_graph_pipeline_integration.py`
   - Uses `tests/fixtures/graph-e2e/` fixture repo (scaffolded in Prerequisites parallel work)
   - Scope: full parse → validate → diff → comment pipeline. For comment tests, use a disposable PR on stark-showcase (or mock the GitHub API if live PRs are not available in CI)
   - Assert correct exit codes, comment idempotency, artifact JSON validates against Pydantic schema, head-SHA stale-run guard works
   - Files: `scripts/test_graph_pipeline_integration.py`
   - Done when: E2E test passes end-to-end

### Risks
- Strict before bootstrap = halted PR throughput → explicit warn-only window + bootstrap completion gate
- Artifact growth → 14-day retention, JSON only (no rendered binaries)
- Autopilot-generated docstrings may systematically inflate FP rate → review 10% sample before merge
- Pinned stark-skills tag may lag behind bug fixes → document tag bump procedure; use semver
- Comment-posting failures in strict mode could become merge-blocking infrastructure failures → comment job (Job 2) always exits 0; the gate decision is in Job 3 (reads exit-code.txt), fully decoupled from comment delivery
- Workflow timeout (15 min) causes analyze job cancellation → gate job (Job 3) uses `if: always()` so it runs even when analyze is cancelled; on cancelled analyze with no exit-code.txt, gate passes (safe default)

### Verification
```bash
"$PYTHON" -m pytest scripts/test_graph_pipeline_integration.py scripts/test_pr_commenter.py
# Verify CI workflow on a test PR
```

### Rollback
1. **Instant:** Set `vars.STARK_GRAPH_STRICT` to `false` (repo variable, no PR needed)
2. **If gate is the issue:** Set `graph_gate_mode: disabled` in config (disables Phase 6 gate too)
3. **If pipeline is broken:** Change workflow to `--warn`, then `--stage audit` if needed
4. **Comment cleanup:** If bad findings were posted, overwrite graph comments with `<!-- stark-graph-comment -->Graph checks rolled back — ignore this comment.` via marker-keyed update
5. Disable scheduled audit until issues fixed
**Rollback trigger:** If review skip rate >10% or FP rate >10% in first week of strict mode, revert `vars.STARK_GRAPH_STRICT` immediately.

---

## 4. Integration Points

| Artifact | Producer | Consumer | Break Signal |
|----------|----------|----------|-------------|
| `parse-python.json` (Graph) | python_parser.py | drift_validator.py, graph_differ.py | Pydantic validation failure |
| `validation.json` (ValidationReport) | drift_validator.py | pr_commenter.py, orchestrator | Schema error, wrong exit code |
| `diff.json` (DiffReport) | graph_differ.py | pr_commenter.py, multi_review.py | Schema error, incomplete blast_radius |
| GitHub App auth | github_app.py | pr_commenter.py | Token failure → exit 2 |
| Pre-review gate | stark_graph.py | triage_orchestrator.py | Wrong exit code → reviews skip/fail; kill switch: `graph_gate_mode` |
| Prompt enrichment | diff.json | multi_review.py | Domain list mismatch; prompt injection if unsanitized |
| `graph_enriched_domains` | discover_config() hierarchy | multi_review.py | Missing key → no enrichment (safe default) |
| `graph_gate_mode` | discover_config() hierarchy | triage_orchestrator.py | Missing key → `disabled` (safe default). Values: `disabled`/`shadow`/`blocking` |
| PR base ref | `--pr` mode | stark_graph.py → graph_differ.py | Resolved to merge-base SHA (CI: `git merge-base HEAD origin/$GITHUB_BASE_REF`; local: `gh pr view --json baseRefOid`); fail early if unresolvable |
| Strict mode toggle | `vars.STARK_GRAPH_STRICT` | graph-review.yml | Repo variable (`false`/`partial`/`true`); instant promotion/rollback; admin-only |
| stark-skills code | `actions/checkout` (pinned tag) | graph-review.yml, graph-audit.yml | Tag not found → workflow fails; bump tag after stark-skills releases |
| CI artifact handoff | Job 1 (`analyze`) → Job 2 (`comment`) | `upload-artifact` / `download-artifact` | Artifact schema validated by Pydantic in Job 2 before posting |

## 5. Testing Strategy

| Level | Timing | Scope |
|-------|--------|-------|
| Unit tests | Each phase | Models, parser fixtures, validator per-check, differ pairs, commenter retry/idempotency |
| Integration tests | Phase 3+ | Full parse → validate → diff on fixture repo |
| Contract tests | Phase 5+ | Mock GitHub API for commenter |
| E2E tests | Phase 7 | Full pipeline on disposable PR, scheduled audit workflow |

Test order follows implementation order. Every phase's verification block must pass before starting the next.

## 6. Rollback Plan

| Phase | Rollback Action | Verification |
|-------|----------------|-------------|
| 1 | Remove `scripts/graph/` and `scripts/stark_graph.py` from install refs | `./install.sh --status` shows no stark-graph |
| 2 | Disable parse/audit invocation; parser remains dormant | `stark_graph.py --stage parse` errors cleanly |
| 3 | No callers exist yet — validator is dormant. No action required | N/A |
| 4 | Disable `--stage diff`; validation works independently. Run `git worktree prune` | `git worktree list` shows no `.stark-graph/` entries |
| 5 | Remove PR-comment stage; keep artifacts only. Clean up existing graph comments via marker-keyed delete. Revert `github_app.py` env-var auth changes if they affect existing review posting | Verify existing review posting still works |
| 6 | Set `graph_gate_mode: disabled` in config (instant). Then remove graph call + enrichment if needed | Confirm next PR triggers review without graph comment |
| 7 | Set `vars.STARK_GRAPH_STRICT=false` (instant), then `graph_gate_mode: disabled`, then `--warn` → `--stage audit`; clean up stale comments via marker. **If fully removing:** also remove `graph-review / gate` from branch protection required checks (otherwise all PRs blocked if workflow is deleted) | Confirm PRs are reviewed normally; confirm required check is not blocking merges |
