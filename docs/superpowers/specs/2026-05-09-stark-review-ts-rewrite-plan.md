# Implementation Plan: TypeScript `/stark-review`

**Spec:** [`2026-05-09-stark-review-ts-rewrite-design.md`](2026-05-09-stark-review-ts-rewrite-design.md)
**Synthesis:** codex plan (winner, 8.0/10) as base + 5 detail fixes from claude's cross-review.
**Date:** 2026-05-09

## 1. Overview

Build a new TypeScript-only `/stark-review` pipeline that reuses the existing
worktree setup/cleanup tools, removes Python from the single-agent hot path,
uses GitHub REST-only interactions through `gh api`, and adds configurable
`--quick` domain selection. Delivery is split into V1 and V1.1:

- **V1** implements config/domain resolution, Codex-only dispatch,
  classification, REST review posting, history persistence, JSON receipts,
  tests, and the `SKILL.md` wrapper.
- **V1.1** adds Claude/Gemini agent ports and enables the fix loop behind
  the documented authorization gate.

## 2. Prerequisites

- Node runtime that supports:
  ```bash
  node --experimental-strip-types tools/stark_review.ts --help
  ```
- GitHub CLI installed and authenticated with the GitHub App token used by this repo:
  ```bash
  GH_TOKEN="${GH_TOKEN:?required}" gh auth status
  GH_TOKEN="${GH_TOKEN:?required}" gh api \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    /repos/OWNER/REPO
  ```
- Agent CLI availability:
  ```bash
  codex --version
  claude --version || true
  gemini --version || true
  ```
- Existing TS worktree helpers present:
  - `tools/review_setup_worktree.ts`
  - `tools/review_cleanup_worktree.ts`
- Trusted config install path available:
  - `~/.claude/code-review/global/config.json`
  - `~/.claude/code-review/prompts/<agent>/`
- Writable runtime dirs:
  ```bash
  mkdir -p ~/.claude/code-review/history
  mkdir -p ~/.claude/code-review/locks
  mkdir -p ~/.claude/code-review/audit
  ```

## 3. Phases

## Phase 1: Config Schema And Prompt Contract

**Goal:** Add additive config fields and canonical prompt contracts without changing existing domain prompts.
**Dependencies:** None
**Estimated effort:** S

### Tasks

1. **Update global config schema defaults** — edit `global/config.json`, add:
   ```json
   {
     "quick_domains": [],
     "default_agent": "codex",
     "test_command": null,
     "untrusted_fix_loop": false,
     "history_retention_days": 90
   }
   ```
   Done when Python tools still load the config and ignore unknown fields.

2. **Add classifier prompts** — create:
   - `global/prompts/codex/classifier.md`
   - `global/prompts/claude/classifier.md`
   - `global/prompts/gemini/classifier.md`

   Contract:
   ```json
   {
     "classification": "fix|false_positive|noise|ignored",
     "classification_reason": "string"
   }
   ```
   Each ≤30 lines, no PR-body execution instruction.

3. **Define reviewer output schema snippet** in `tools/stark_review_lib.ts`:
   ```ts
   export const FINDING_SCHEMA_PROMPT = `Return JSONL findings with fields: ...`;
   ```
   Prepended at prompt-render time. Existing `NN-*.md` files untouched.

### Risks

- Existing Python config loader rejects unknown keys.
- Classifier prompt ambiguity → strict JSON examples + parser tests.

### Verification

```bash
node -e 'JSON.parse(require("fs").readFileSync("global/config.json","utf8")); console.log("ok")'

# Verify Python deep-merge accepts new fields end-to-end via multi_review.py
# (claude review weakness #4: don't just check config_loader; exercise the
# real consumer to catch deep-merge or warn-on-unknown regressions)
SCRIPTS=~/.claude/code-review/scripts
PYTHON="$SCRIPTS/.venv/bin/python3"
"$PYTHON" "$SCRIPTS/multi_review.py" --help >/dev/null 2>&1
"$PYTHON" - <<'PY'
import sys, json
sys.path.insert(0, "scripts")
from config_loader import load_config
cfg = load_config()
for f in ("quick_domains","default_agent","test_command","untrusted_fix_loop","history_retention_days"):
    assert f in cfg, f"missing {f}"
print("ok: all new fields present, no warnings")
PY
```

## Phase 2: Core Library Helpers

**Goal:** Implement pure, testable helpers for config, domains, prompts, severity, IDs, and receipt/history shapes.
**Dependencies:** Phase 1
**Estimated effort:** M

### Tasks

1. **Create `tools/stark_review_lib.ts`** with shared types:
   ```ts
   export type AgentName = "claude" | "codex" | "gemini";
   export type Severity = "critical" | "high" | "medium" | "low";
   export type Classification = "fix" | "false_positive" | "noise" | "ignored";
   export type Finding = {
     id: string;
     domain: string;
     agent: AgentName;
     severity: Severity;
     file: string | null;
     line: number | null;
     title: string;
     body: string;
     classification?: Classification;
     classification_reason?: string;
     extra?: Record<string, unknown>;
   };
   export type ResolvedConfig = { ... };
   ```

2. **Implement config loading**:
   ```ts
   export function loadTrustedConfig(args: {
     home: string;
     configRoot: string;   // invoker's CWD before worktree
     repoRoot: string;     // git -C $configRoot rev-parse --show-toplevel
   }): ResolvedConfig
   ```
   Read global from `~/.claude/code-review/global/config.json`, walk org
   overrides from `configRoot` upward to `$HOME`, read repo override from
   `<repoRoot>/.code-review/config.json`. **Never** resolve config from
   inside PR-controlled worktree content.

3. **Implement domain selection**:
   ```ts
   export function selectDomains(args: {
     mode: "default" | "quick" | "explicit";
     explicitDomains?: string[];
     config: ResolvedConfig;
     promptRoot: string;
     agentResolver: (domain: string) => AgentName;
   }): string[]
   ```
   `--domains` wins over `--quick`; `--quick` errors if `quick_domains` empty.

4. **Implement agent resolution**:
   ```ts
   export function resolveAgentsForDomains(args: {
     domains: string[];
     forcedAgent?: AgentName;
     config: ResolvedConfig;
   }): Record<string, AgentName>
   ```
   Precedence: `--agent` > `domain_agents[D]` > `default_agent` > `codex`.

5. **Implement finding IDs**:
   ```ts
   export function findingId(domain: string, agent: AgentName, title: string): string
   ```
   `sha256(domain|agent|normalized-title).slice(0, 12)`.
   `normalized-title` = lowercase, collapse whitespace, strip punctuation.

6. **Implement severity helpers**:
   ```ts
   export function severityMeetsThreshold(severity: Severity, threshold: Severity): boolean
   ```
   Order: `critical > high > medium > low`.

7. **Implement prompt resolution/rendering**:
   ```ts
   export function renderReviewPrompt(args: {
     agent: AgentName;
     domain: string;
     promptRoots: PromptRoots;
     prTitle: string;
     prBody: string;
     prDiff: string;
   }): string
   ```
   Resolution order: repo override > global agent prompt > shared `prompts/domains/`.
   Includes `agent.md` + domain prompt + `FINDING_SCHEMA_PROMPT` + PR context.

### Risks

- Config-root semantics easy to weaken: keep `configRoot` required.
- Prompt filename lookup may drift from Python: test `01-architecture.md → architecture`.

### Verification

```bash
node --test tools/stark_review_lib.test.ts
```

## Phase 3: Agent Ports

**Goal:** Add V1 Codex support and clear Claude/Gemini fail-fast stubs.
**Dependencies:** Phase 2
**Estimated effort:** S

### Tasks

1. **Create `tools/agent_codex.ts`** — port `scripts/codex_utils.py`:
   ```ts
   export function buildCommand(prompt: string, model?: string): {
     cmd: string;
     args: string[];
     stdin: string;
     env?: Record<string, string>;
   }
   export function parseOutput(stdout: string): { findings: Finding[]; parseErrors: string[] }
   ```
   Build `codex exec --json` with high reasoning effort. Parse JSONL,
   preserve unknown fields under `extra`, drop malformed individual records
   (return them in `parseErrors`).

2. **Create `tools/agent_claude.ts`** — same exports, both throw:
   ```ts
   Error("agent claude not implemented in the TS path yet; use /stark-team-review for multi-agent review or wait for V1.1")
   ```

3. **Create `tools/agent_gemini.ts`** — same shape, equivalent gemini message.

4. **Implement dynamic agent module loading** in `tools/stark_review.ts`:
   ```ts
   async function loadAgentPort(agent: AgentName): Promise<AgentPort>
   ```
   Resolve all domains' agents BEFORE dispatch; fail fast if any resolves to a V1 stub.

### Risks

- Agent JSONL shape may vary: keep parser narrow around required fields.
- Stub behavior could surprise users: release notes + `SKILL.md` stderr point to `/stark-team-review`.

### Verification

```bash
node --test tools/stark_review.test.ts --test-name-pattern='agent dispatch'
```

## Phase 4: Dispatcher Pipeline V1

**Goal:** Implement `tools/stark_review.ts` through classify, history, posting, and receipt output, with no fix-loop edits.
**Dependencies:** Phases 1–3
**Estimated effort:** L

### Tasks

1. **Create CLI parser** in `tools/stark_review.ts` accepting:
   - Required: `--pr`, `--repo`, `--base`, `--worktree`, `--config-root`
   - Optional: `--agent`, `--quick`, `--domains`, `--dry-run`, `--no-fix-loop`,
     `--allow-untrusted-fix-loop`, `--max-rounds`, `--json`

   V1 behavior: fix loop is always disabled. `--allow-untrusted-fix-loop` is
   parsed and warns "fix loop not enabled in V1". `--domains` and `--quick`
   conflict deterministically (`--domains` wins).

2. **Implement trusted GitHub reads**:
   ```ts
   async function ghJson(path: string, opts?: GhOptions): Promise<unknown>
   async function ghText(args: string[]): Promise<string>
   ```
   Endpoints used (REST only):
   - `gh pr view <N> --repo <repo> --json title,body`
   - `gh pr diff <N> --repo <repo>`
   - `gh api --paginate /repos/{o}/{r}/pulls/{n}`
   - `gh api --paginate /repos/{o}/{r}/pulls/{n}/files`
   - `gh api --paginate /repos/{o}/{r}/pulls/{n}/reviews`

   Always pass `GH_TOKEN` through allowed env if present.

3. **Implement concurrency-capped dispatch**:
   ```ts
   async function dispatchDomains(args: DispatchArgs): Promise<DispatchResult>
   ```
   Use `runtime.max_concurrent_agents` (default 3). Each invocation gets:
   allowlisted env only, temp dir under `runtime.temp_dir_prefix`, worktree
   path as arg/context (never as cwd).

4. **Implement finding parsing semantics** — apply `severity_overrides[domain]`
   after parse. Required fields: `severity`, `title`, `domain`. Failure tiers:
   - Tier 1 (per-domain partial): non-zero exit OR unparseable stdout for one
     domain → that `(domain, agent)` enters `failed_results[]`. Other domains
     continue. Round-end exit non-zero, but `ok: true` in receipt shape.
   - Tier 2 (total round failure): every domain failed → terminal receipt
     `{ok: false, error: {code: "dispatch_failure"}}`.
   - Tier 3 (per-finding parse error): malformed individual record → drop
     it, append to `parse_errors[]`, continue with siblings.

5. **Implement classifier stage**:
   ```ts
   async function classifyFinding(finding: Finding, ctx: ClassifierContext): Promise<Finding>
   ```
   If `file && line`, read ±20 lines from worktree. If `file === null`, pass
   only structured finding data. On classifier failure, attach
   `classification: "fix"`, `classification_reason: "classifier_failed: <err>"`.
   Abort terminally if classifier errors ≥ 5 in one round. Classifier never
   receives raw PR diff/body.

6. **Implement history writer**:
   ```ts
   async function writeRoundHistory(round: RoundHistory): Promise<string>
   ```
   Path: `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json`.
   Round number = max existing + 1. Schema matches spec exactly. Written
   even in dry-run.

7. **Implement history retention pruning** — on startup, read
   `history_retention_days`. If `0`, skip. Otherwise prune per-PR history
   dirs older than N days under `~/.claude/code-review/history`. Best-effort;
   failures become receipt events, not terminal errors.

8. **Implement REST review posting**:
   ```ts
   async function postReview(args: PostReviewArgs): Promise<PostReviewResult>
   ```

   **Inline-vs-body routing** (claude review weakness #2):
   - Use changed-file set from `/pulls/{n}/files` (paginated).
   - For each finding: if `classification === "fix"` AND `severity ≥ threshold`:
     - If `file && line && file ∈ changedFiles`: emit as inline comment
       (`side: "RIGHT"`, `path: file`, `line: line`).
     - Else (file is null, line is null, OR file not in changedFiles):
       **demote to top-level review body, do not drop**. The body section
       lists these under a "Cross-cutting / out-of-diff findings" heading
       with `file:line` (or "(no anchor)") rendered for context.

   Use one POST per round:
   ```bash
   GH_TOKEN="${GH_TOKEN:?required}" gh api -X POST \
     -H "Authorization: Bearer ${GH_TOKEN}" \
     -H "Accept: application/vnd.github+json" \
     /repos/OWNER/REPO/pulls/PR/reviews \
     --input -
   ```
   Payload uses `event: "COMMENT"`, `body`, `comments[]`. `--dry-run` skips
   POST but records intended payload summary in receipt.

9. **Implement idempotency lock with explicit ordering** (claude review weakness #1):
   ```
   sequence:
     1. acquire flock at ~/.claude/code-review/locks/{org}-{repo}-{pr}.lock
        (blocking ≤30s; fail with error.code: "lock_held" if exceeded)
     2. GET /repos/{o}/{r}/pulls/{n}/reviews (paginated)
     3. scan for marker:
        <!-- stark-review:round=N:agent=A:run=HASH -->
     4. if marker found → record duplicate_detected event, skip POST
        if not found → POST review
     5. release flock
   ```
   The lock MUST be acquired before step 2 and released after step 4. This
   is the ordering that collapses the GET→POST race.

   **Run hash composition** (claude review weakness #3) — `HASH` is computed
   over exactly these fields, sorted and JSON-stringified:
   ```
   HASH = sha256(json.stringify({
     domains: agents_resolved keys, sorted,
     agents_resolved,
     severity_overrides,
     fix_threshold
   }))
   ```
   Unrelated config fields (cost, runtime knobs, observability) do NOT feed
   the hash. This makes legitimate re-runs with the same review-affecting
   config produce the same hash (so duplicate detection works) while config
   edits to actual review parameters force a new review.

10. **Implement retry policy** — retry POST and list endpoints on:
    - `403` with `X-RateLimit-Remaining: 0`
    - `429`
    - `5xx`

    Backoff: 1s, 4s, 16s. Honor `Retry-After`. After 3 attempts, append to
    `unposted_reviews[]` and continue.

11. **Implement receipts and stderr summary** — JSON success shape:
    ```json
    {
      "ok": true,
      "schema_version": 1,
      "repo": "...",
      "pr": 123,
      "agent": "codex",
      "agents_resolved": {...},
      "domains": [...],
      "rounds": [{ "round": 1, "findings": [...], "summary": {...},
                   "failed_results": [], "parse_errors": [],
                   "classifier_errors": [], "duration_ms": ... }],
      "fixes_pushed": false,
      "comments_posted": 7,
      "unposted_reviews": [],
      "history_files": [...]
    }
    ```
    Failure shape: `{ok: false, schema_version: 1, repo, pr, error: {code, message, ...}, rounds: [...]}`.
    Non-terminal partial failure: exit non-zero, `ok: true`, `failed_results` non-empty.
    Terminal failure: `ok: false`. `--json` writes machine receipt to stdout, human summary to stderr.

### Risks

- GitHub inline anchors may reject valid-looking lines: demote uncertain anchors to body.
- Race between GET reviews and POST: collapsed by local flock + remote marker.
- Partial failure semantics may confuse callers: SKILL.md must inspect both `ok` and `failed_results`.

### Verification

```bash
node --test tools/stark_review.test.ts

# Hard guard against GraphQL slipping in
grep -RE "gh api graphql|/graphql" tools/stark_review.ts tools/stark_review_lib.ts tools/agent_*.ts && exit 1 || true

# End-to-end dry-run smoke
GH_TOKEN="${GH_TOKEN:?required}" node --experimental-strip-types tools/stark_review.ts \
  --pr 123 \
  --repo OWNER/REPO \
  --base main \
  --worktree /tmp/stark-review-worktree \
  --config-root "$PWD" \
  --agent codex \
  --dry-run \
  --json
```

## Phase 5: Skill Wrapper Migration

**Goal:** Replace `/stark-review` Python orchestration with the TS tool while preserving setup and cleanup behavior.
**Dependencies:** Phase 4
**Estimated effort:** M

### Tasks

1. **Rewrite `skill/stark-review/SKILL.md`** — keep preflight, PR arg parsing,
   repo detection, base branch detection. Capture original trusted CWD
   **before** worktree setup runs:
   ```bash
   CONFIG_ROOT="$(pwd)"
   # ... then setup worktree ...
   node --experimental-strip-types "$TOOLS/stark_review.ts" \
     --pr "$PR_NUM" \
     --repo "$REPO" \
     --base "$BASE" \
     --worktree "$WORKTREE_PATH" \
     --config-root "$CONFIG_ROOT" \
     ${AGENT:+--agent "$AGENT"} \
     ${QUICK:+--quick} \
     ${DRY_RUN:+--dry-run} \
     --json
   ```
   `multi_review.py` is no longer referenced by `stark-review`.

2. **Add `--quick` parsing** — recognize `--quick`, pass through to TS tool.
   Document `--domains` escape hatch in args section.

3. **Update failure handling** — parse receipt `ok`. If `ok === false`, surface
   `error.code`, `error.message`, exit non-zero. If any
   `rounds[*].failed_results` non-empty, surface domains/agents and exit
   non-zero. Otherwise print review summary.

4. **Confirm `install.sh` behavior** — run `./install.sh --status`. If
   `tools/` is already symlinked, no change needed.

### Risks

- Wrapper may pass PR-controlled cwd as config root if captured too late: capture **before** setup.
- Users on `--agent claude/gemini` hit V1 stub: message points to `/stark-team-review`.

### Verification

```bash
./install.sh --status

# --quick smoke (will error if quick_domains empty in config)
GH_TOKEN="${GH_TOKEN:?required}" node --experimental-strip-types tools/stark_review.ts \
  --pr 123 \
  --repo OWNER/REPO \
  --base main \
  --worktree /tmp/stark-review-worktree \
  --config-root "$PWD" \
  --quick \
  --dry-run \
  --json
```

## Phase 6: Test Suite And Fixtures

**Goal:** Lock the behavior with focused node:test coverage and recorded integration fixtures.
**Dependencies:** Phases 2–5
**Estimated effort:** L

### Tasks

1. **`tools/stark_review_lib.test.ts`** — config precedence, domain modes,
   empty `quick_domains`, agent precedence, prompt override order, severity
   threshold, stable finding IDs, `run` hash determinism (claude weakness #3
   surface).

2. **`tools/stark_review.test.ts`** — Codex command construction;
   Claude/Gemini stub errors; JSONL parse success + malformed records;
   partial dispatch failure; total dispatch failure; classifier fallback;
   classifier abort at 5 errors; dry-run post skip; **inline-vs-body
   demotion** (file not in changed-file set → body, not dropped); fork PR
   still posts review (push gating is V1.1); `--paginate` on files/reviews;
   retry handling; receipt schema (success + failure shapes); **lock
   ordering** (assert acquire-before-GET, release-after-POST via fake
   filesystem clock).

3. **History parity fixture** — store `tools/fixtures/history/python-round-1.json`
   produced by `multi_review.py`. Test loads it and asserts field-for-field
   match against TS writer output.

4. **Fake binaries for tests** — `tools/fixtures/bin/{gh,codex,git}`. Tests
   prepend fixture dir to `PATH`.

5. **Opt-in integration tests** — gated on `STARK_REVIEW_E2E=1`. Scenarios:
   happy dry-run, fix-loop-denied V1 warning, dispatch failure. Use replayed
   `gh api` responses through fake `gh`.

### Risks

- Tests brittle around stderr text: assert structured receipt fields first.
- Fake `gh` may drift from real `gh`: weekly smoke against sandbox PR.

### Verification

```bash
node --test tools/stark_review_lib.test.ts tools/stark_review.test.ts
STARK_REVIEW_E2E=1 node --test tools/stark_review.test.ts
```

## Phase 7: V1 Smoke And Release

**Goal:** Prove V1 works on a low-risk PR before replacing default `/stark-review`.
**Dependencies:** Phases 1–6
**Estimated effort:** S

### Tasks

1. **Run local dry-run against sandbox PR**:
   ```bash
   GH_TOKEN="${GH_TOKEN:?required}" node --experimental-strip-types tools/stark_review.ts \
     --pr SANDBOX_PR \
     --repo OWNER/REPO \
     --base main \
     --worktree /tmp/stark-review-sandbox \
     --config-root "$PWD" \
     --agent codex \
     --dry-run \
     --json
   ```

2. **Run posting smoke test** — use a PR where review comments are acceptable.
   Confirm: one review posted, marker present, repeated run skips duplicate
   (verifying §4 task 9 ordering), no GraphQL endpoint called.

3. **Update docs/release notes** — call out:
   - `/stark-review` is TS-only in V1
   - V1 supports Codex only
   - Claude/Gemini users → `/stark-team-review`
   - fix loop parsed but disabled until V1.1
   - `--quick` requires `quick_domains` in config

### Risks

- GitHub rejects payload due to anchor edge cases: demote rejected inline comments and retry one body-only review.
- Users expect fix loop: release note states V1 explicitly does not edit or push.

### Verification

```bash
GH_TOKEN="${GH_TOKEN:?required}" gh api \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  --paginate \
  /repos/OWNER/REPO/pulls/SANDBOX_PR/reviews
```

## Phase 8: V1.1 Agent Ports

**Goal:** Implement Claude and Gemini TS ports after Codex V1 is stable.
**Dependencies:** Phase 7
**Estimated effort:** M

### Tasks

1. **Replace `tools/agent_claude.ts` stub** — port `scripts/claude_utils.py`
   command construction. Same `buildCommand` / `parseOutput` interface. Keep
   under ~100 LOC.

2. **Replace `tools/agent_gemini.ts` stub** — port CLI builder from
   `scripts/gemini_utils.py`. Drop session-isolation complexity not needed
   for single-agent path.

3. **Add tests for both ports** — assert command args, parse behavior, agent
   precedence with mixed `domain_agents`.

### Risks

- CLI flag drift: each port is ~100 LOC so changes are one-file.
- Mixed-agent review posts need marker clarity: include per-domain
  `agents_resolved` in receipt and review body summary.

### Verification

```bash
node --test tools/stark_review.test.ts --test-name-pattern='claude|gemini'

GH_TOKEN="${GH_TOKEN:?required}" node --experimental-strip-types tools/stark_review.ts \
  --pr SANDBOX_PR --repo OWNER/REPO --base main \
  --worktree /tmp/stark-review-sandbox --config-root "$PWD" \
  --agent claude --dry-run --json
```

## Phase 9: V1.1 Fix Loop

**Goal:** Enable authorized fix-loop execution with explicit-path staging, trusted tests, push safety, and audit logging.
**Dependencies:** Phase 7 (Phase 8 helpful but not strictly required for Codex-only fix loop)
**Estimated effort:** L

### Tasks

1. **Implement authorization gate**:
   ```ts
   export function evaluateFixLoopGate(args: {
     testCommand: string | null;
     prHeadIsFork: boolean;
     maintainerCanModify: boolean;
     allowUntrustedFixLoop: boolean;
     noFixLoop: boolean;
     explicitAllowUntrusted: boolean;
   }): FixLoopGateResult
   ```
   Gate requires: trusted `config.test_command`, same repo OR explicit
   `--allow-untrusted-fix-loop`, not `--no-fix-loop`. Default denial = soft
   skip. Explicit opt-in rejected = terminal `auth_denied`. **No test
   command is ever read from `CLAUDE.md` or `package.json`.**

2. **Define fixer prompt contract** — structured input only:
   ```json
   {
     "findings": [
       { "file": "...", "line": 1, "severity": "high", "title": "...", "body": "..." }
     ]
   }
   ```
   No PR body. No PR diff. Agent must return:
   ```json
   { "modified_files": ["src/foo.ts"], "summary": "..." }
   ```

3. **Implement serial fixer execution** — one finding (or grouped findings)
   per run, serially. Env allowlist + per-invocation temp dir. Worktree path
   passed explicitly.

4. **Implement path validation and staging**:
   ```ts
   export function validateStagePaths(worktree: string, paths: string[]): string[]
   ```
   Reject: absolute paths outside worktree, `..` traversal, symlinks whose
   real-path resolves outside worktree. Use `fs.realpathSync` on each path
   AND on each ancestor directory before staging. Stage only:
   ```bash
   git -C "$WORKTREE" add -- "$file1" "$file2"
   ```
   **Never use `git add -A`.**

5. **Implement push target resolution** with authed fork-remote
   construction (claude review weakness #5) — from `GET /pulls/{n}`:
   `head.ref`, `head.repo.full_name`, `head.repo.clone_url`,
   `head.repo.fork`, `maintainer_can_modify`.

   Same-repo PR:
   ```bash
   git -C "$WORKTREE" push origin HEAD:"$HEAD_REF"
   ```

   Fork PR with maintainer-can-modify — construct authed clone URL
   carefully and never log it:
   ```ts
   // Construct in-process; never echo, never write to a shell variable.
   const authedCloneUrl = `https://x-access-token:${GH_TOKEN}@github.com/${head.repo.full_name}.git`;
   // Pass via process spawn args, not via shell expansion.
   await git(["remote", "add", "stark-fork-push", authedCloneUrl]);
   try {
     await git(["push", "stark-fork-push", `HEAD:${head.ref}`]);
   } finally {
     await git(["remote", "remove", "stark-fork-push"]);
   }
   ```
   The audit log records the action with `head.repo.full_name` and
   `head.ref` only — **never the authed URL**. Token redaction in any
   stderr capture is mandatory.

   Non-fast-forward push → terminal `error.code: "push_conflict"`. Never
   `--force`.

6. **Run trusted tests** — execute exactly `config.test_command`. Do not
   resolve from PR files. On failure: keep worktree, exit non-zero,
   `error.code: "test_failure"`.

7. **Implement commit and rerun** — commit with
   `git -C "$WORKTREE" commit -m "fix: address review findings (round N)"`,
   push after tests pass, rerun from prompt rendering. Stop at
   `--max-rounds` (default 3).

8. **Implement audit log** — append JSONL to
   `~/.claude/code-review/audit/{org}/{repo}/{pr}.jsonl`. Events: file
   edits, staged files, commits, pushes, posted reviews, skips/denials.
   Shape: `{"ts": "ISO", "action": "commit", "round": 1, "files": [], "sha": "..."}`.
   Token values are NEVER logged.

### Risks

- Prompt injection through findings: mitigated by structured-only fixer prompt.
- Symlink path escape: realpath validation on path AND ancestors before staging.
- Concurrent user commits: non-fast-forward aborts without force push.
- Token leakage via fork-push remote URL: redaction is non-negotiable.

### Verification

```bash
node --test tools/stark_review.test.ts --test-name-pattern='fix loop|stage|push|audit'

# Negative test: assert authed URL never appears in stderr or audit log
node --test tools/stark_review.test.ts --test-name-pattern='token redaction'

GH_TOKEN="${GH_TOKEN:?required}" gh api \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  /repos/OWNER/REPO/pulls/SANDBOX_PR
```

## 4. Integration Points

- `skill/stark-review/SKILL.md` owns user-facing command parsing, worktree
  setup, and cleanup. **Must capture trusted `--config-root` before worktree
  setup.**
- `tools/stark_review.ts` owns the full review pipeline after worktree setup.
- `tools/stark_review_lib.ts` is the shared contract for config, prompts,
  findings, receipts, and history. Drift here breaks tests and dispatcher.
- `tools/agent_*.ts` expose exactly:
  ```ts
  buildCommand(prompt: string, model?: string)
  parseOutput(stdout: string): { findings: Finding[]; parseErrors: string[] }
  ```
- GitHub REST contract:
  - `/pulls/{n}` — PR metadata, fork detection
  - `/pulls/{n}/files` — changed files (paginated; drives inline-vs-body routing)
  - `/pulls/{n}/reviews` — idempotency check (paginated)
  - `POST /pulls/{n}/reviews` — comment posting
- History contract stays schema-compatible with `multi_review.py`'s
  `save_round_history()` (asserted by Phase 6 fixture test).
- Fix-loop V1.1 depends on `config.test_command`; if missing, fixes skip
  rather than infer from PR-controlled files.
- Lock + remote marker check + receipt `unposted_reviews[]` must land
  together (one without the others is unsafe).

## 5. Testing Strategy

- **Unit first**: config merge, domain selection, prompt resolution,
  severity threshold, finding IDs, agent command builders, parsers, run-hash
  determinism.
- **Pipeline second**: dispatch partial/total failure, classifier fallback
  and abort, receipt success/failure shapes, history writer, lock ordering,
  inline-vs-body demotion.
- **GitHub interaction third**: fake `gh` with replayed REST responses,
  pagination, idempotency marker, dry-run behavior, retry policy.
- **V1.1 fix loop last**: gate decisions, trusted-test-command-only,
  explicit staging, symlink/path traversal rejection, push conflict
  handling, audit log append, token redaction.
- **Integration**: opt-in via `STARK_REVIEW_E2E=1`. Weekly CI against
  replayed fixtures + one sandbox smoke.

## 6. Rollback Plan

| Phase | Rollback |
|-------|----------|
| 1 | Remove added config fields and classifier prompts. Python unaffected. |
| 2–4 | Leave new `tools/*.ts` unused or revert. No user-facing change until SKILL.md migrates. |
| 5 | Revert `skill/stark-review/SKILL.md` to Python invocation. Keep TS files. |
| 6 | Remove or skip failing tests. Don't roll back runtime unless tests reveal prod risk. |
| 7 | Revert SKILL.md wrapper to Python. `/stark-team-review` and Python files untouched. |
| 8 | Restore Claude/Gemini stubs. Codex V1 remains usable. |
| 9 | Default `--no-fix-loop` back on. Posting + history intact. Disable fix-loop execution via config flag while preserving parser. |
