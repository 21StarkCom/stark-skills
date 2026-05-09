# Spec: TypeScript rewrite of `/stark-review`

**Date:** 2026-05-09
**Status:** Approved (brainstorming phase)
**Owner:** aryeh.kiovetsky@evinced.com

## Goal

Replace the Python-driven `/stark-review` pipeline with a single dedicated TypeScript tool. The existing Python (`multi_review.py`, `triage_orchestrator.py`, `domain_triage.py`, `*_utils.py`) stays in place because `/stark-team-review` and other skills still use it.

Three motivating constraints from the user:

1. `/stark-review` should be TypeScript-only end to end — no Python on the hot path.
2. All GitHub interactions go through REST endpoints (`gh api <path>`), never `gh api graphql`. `gh pr view --json` and `gh pr diff` are permitted because their underlying transport is REST (`gh` shells out to `/repos/.../pulls/{n}` and `/repos/.../pulls/{n}.diff` respectively, never to the GraphQL endpoint). The "no GraphQL" rule is about the wire protocol, not about avoiding `gh pr` subcommands.
3. Add a `--quick` mode that reviews only the highest-value domains, configured per-repo/org/global.

## Non-goals

- Not migrating `/stark-team-review` or any other skill.
- Not porting triage logic — `/stark-review` drops triage entirely.
- Not replacing the `claude` / `codex` / `gemini` CLIs with native SDK calls. The TS tool still shells out to the agent CLI.
- Not changing the existing per-domain prompt files in `global/prompts/<agent>/NN-*.md`. (A new `classifier.md` per agent is added — see §6.)

## Trust and security model

PR-author-controllable inputs and reviewer infrastructure are kept separate.
This is a hard rule, not a guideline.

**Trusted inputs (sourced from outside the PR head):**

- `~/.claude/code-review/global/config.json` (installed via `install.sh` from this repo).
- Prompt files under `~/.claude/code-review/prompts/<agent>/`.
- Org-level overrides under `<git-root>/.code-review/` resolved by walking up
  to `$HOME` from the **invoker's CWD before the worktree was created** — never
  from inside the worktree.
- Test command resolution from `config.test_command` only. **Not from
  `CLAUDE.md` `## Commands`** (PR-controllable) and not from `package.json`
  `scripts.test` (PR-controllable). If `config.test_command` is unset and the
  PR is not from the repo's own collaborator-write set, the fix loop is
  disabled for that run.

**Untrusted inputs (PR-controllable, never executed or used to resolve config):**

- The PR diff, PR body, and any file content read from the worktree.
- `.code-review/`, `CLAUDE.md`, `package.json`, and any other file that may
  exist on the PR head.

**Fix-loop authorization gate.** The fix loop runs only when **all** of:

1. `config.test_command` is set (trusted source), AND
2. The PR head is not a fork (`head.repo.fork === false`) **or** the user
   passed `--allow-untrusted-fix-loop` explicitly (escape hatch, off by
   default), AND
3. `--no-fix-loop` was not passed.

Denial behavior:

- If the user did **not** explicitly request the fix loop (default invocation
  with no `--no-fix-loop`): denial is **soft** — emit a `fix_loop_skipped`
  event with the failing gate condition, finish posting findings, exit 0.
- If the user explicitly opted in via `--allow-untrusted-fix-loop`: denial is
  **terminal** — exit non-zero with `error.code: "auth_denied"` so the user
  knows their opt-in was rejected.

Otherwise the tool reports findings and stops without editing files.

**Fork PRs.** Posting review comments on fork PRs uses the GitHub App token
against the upstream repo (always allowed). Pushing fix commits to a fork
requires both `head.repo.fork === true` + `maintainer_can_modify === true` +
the explicit gate above; otherwise fixes are skipped, not pushed.

**Prompt-injection containment.** The PR diff and body are concatenated into
review prompts but never into the **fix-loop prompt** (see §9) — the fixer
agent receives only the structured `Finding` records the reviewer produced,
plus the file contents the agent itself reads via its tools. This breaks the
"attacker-text → fix prompt" path.

**Subprocess isolation.** Each agent CLI invocation runs with an env
allowlist (`runtime.subagent_env_allowlist` from the trusted config) and a
per-invocation temp dir under `runtime.temp_dir_prefix`. The worktree path is
passed as an argument; we never `cd` to a path that came from the PR.

## Architecture

New files under `tools/`:

- `tools/stark_review.ts` — the dispatcher and pipeline owner.
- `tools/stark_review.test.ts` — node:test tests.
- `tools/agent_codex.ts` — TS port of `scripts/codex_utils.py` (build CLI args, parse JSONL).
- `tools/agent_claude.ts` — TS port of `scripts/claude_utils.py`.
- `tools/agent_gemini.ts` — TS port of `scripts/gemini_utils.py`.
- `tools/stark_review_lib.ts` — pure helpers (config merge, domain selection,
  prompt rendering, severity comparison) for unit-testability.

(Total: 6 new files. The three agent ports are intentionally tiny, ≤100 LOC
each — see §4 — and would otherwise be inlined and untestable.)

**Phasing.** Three new files land in V1:

- `tools/stark_review.ts`, `tools/stark_review_lib.ts`, `tools/agent_codex.ts`.

Two stub files land in V1 to reserve their public surface:

- `tools/agent_claude.ts`, `tools/agent_gemini.ts` each export the same
  `buildCommand` / `parseOutput` interface as `agent_codex.ts` but the
  implementations throw `Error("agent <name> not implemented in the TS path
  yet; use /stark-team-review for multi-agent review or wait for V1.1")`.

`stark_review.ts` resolves the agent module dynamically; the stubs ensure
V1 fails fast and clearly when `--agent claude` / `--agent gemini` is passed,
rather than silently falling through to codex.

**Documented opt-out.** Users who relied on `--agent claude` or
`--agent gemini` against the old Python path are pointed at
`/stark-team-review` (which keeps the Python pipeline). The stub error
message names this skill explicitly. Release notes call out the regression.

V1.1 lands `agent_claude.ts` + `agent_gemini.ts` implementations.

**Fix loop is also V1.1, not V1.** V1 ships with `--no-fix-loop` as the
default behavior — the flag is accepted but always-on. The
`--allow-untrusted-fix-loop` flag is parsed but warns "fix loop not enabled
in V1". This bounds V1 surface area to: dispatch + classify + post + history.
The trust model, audit log, and authorization gate all remain documented so
V1.1 is a config flip, not a redesign. V1.1 turns the fix loop on.

`SKILL.md` becomes a thin wrapper (~80 lines):
preflight → arg parse → `review_setup_worktree.ts` → `stark_review.ts` → `review_cleanup_worktree.ts`.

The existing worktree setup/cleanup TS tools (`tools/review_setup_worktree.ts`, `tools/review_cleanup_worktree.ts`) are reused unchanged.

## CLI surface

```
node --experimental-strip-types tools/stark_review.ts \
  --pr <N> --repo owner/name --base <branch> --worktree <path> \
  --config-root <path>             # invoker's CWD (trusted source for .code-review/)
  [--agent claude|codex|gemini]    # default resolved per-domain (see precedence below)
  [--quick]                        # use config.quick_domains
  [--domains a,b,c]                # explicit domain override (escape hatch)
  [--dry-run]                      # no posts, no commits, no push
  [--no-fix-loop]                  # disable fix loop entirely
  [--allow-untrusted-fix-loop]     # opt-in for fork PRs; off by default
  [--max-rounds N]                 # default 3
  [--json]                         # machine-readable receipt to stdout
```

`--quick`, `--domains`, and the default ("all enabled") are mutually exclusive in
that order: `--domains` wins; otherwise `--quick`; otherwise default.

**Agent selection precedence.** Per-domain, the agent for a domain `D` is:

1. `--agent <name>` if passed → forces all domains to this agent.
   `config.domain_agents` is bypassed entirely.
2. Else `config.domain_agents[D]` if set → use that.
3. Else `config.default_agent` → use that.
4. Hard-coded fallback: `codex`.

Per-domain resolution happens once at startup; the resolved map is included
in the receipt as `agents_resolved`. In V1 only `codex` is implemented in
the TS path (see Architecture phasing); resolving to `claude` or `gemini`
fails fast with the documented stub error before any dispatch runs.

The "default agent codex" claim earlier in the spec refers to step 3/4: if
neither `--agent` nor a per-domain mapping resolves, the agent is codex.
`--agent` overrides everything. There is no other source of truth.

`--allow-untrusted-fix-loop` opts into the fix loop on fork PRs (see Trust
section). Off by default.

## Pipeline

The tool owns the full pipeline. Each stage emits a structured event for the JSON receipt.

### 1. Resolve config

Read `~/.claude/code-review/global/config.json`, then deep-merge org override
(`<git-root>/.code-review/config.json` walking up to `$HOME`), then repo override
(`<repo-root>/.code-review/config.json`). Same precedence as `dispatcher_base.py`.

**Resolved from the invoker's CWD before the worktree was created**, never
from inside the worktree (see Trust model). The skill captures the original
CWD and passes it to the tool as `--config-root <path>`.

Fields consumed:

| Field | Type | Purpose |
|---|---|---|
| `domain_agents` | `Record<string,string>` | Per-domain default agent (when `--agent` omitted). |
| `disabled_domains` | `string[]` | Skip these. |
| `extra_domains` | `string[]` | Add these (pulled from `prompts/domains/`). |
| `severity_overrides` | `Record<string,string>` | Per-domain severity rewrite. |
| `fix_threshold` | `"critical"\|"high"\|"medium"\|"low"` | Lowest severity that triggers a fix. |
| `runtime.max_concurrent_agents` | `number` | Concurrency cap. Default 3. |
| `quick_domains` | `string[]` | **NEW.** Domains used by `--quick`. |
| `default_agent` | `string` | **NEW.** Used when neither `--agent` nor `domain_agents[D]` resolves. Defaults to `"codex"`. |
| `test_command` | `string \| null` | **NEW.** Trusted source for the fix-loop test command. |
| `untrusted_fix_loop` | `bool` | **NEW.** Org-level toggle for `--allow-untrusted-fix-loop` default. Defaults `false`. |

Schema bump: add `quick_domains: []`, `default_agent: "codex"`,
`test_command: null`, `untrusted_fix_loop: false` to `global/config.json`.
`quick_domains` is empty by default — repos/orgs override.

### 2. Pick domains

```
if --domains: parse CSV, validate each exists in prompts/<agent>/.
elif --quick: use config.quick_domains. Empty/missing → error.
else: discover prompts/<agent>/NN-*.md, subtract disabled_domains, add extra_domains.
```

Domain ID derivation matches Python: `01-architecture.md` → `architecture`.

### 3. Render prompts

Per domain, concat:

1. `prompts/<agent>/agent.md` (preamble)
2. `prompts/<agent>/NN-<domain>.md`, with override resolution:
   repo `.code-review/prompts/<agent>/<file>` → global `prompts/<agent>/<file>` →
   shared `prompts/domains/<file>`.
3. PR context block: `gh pr view <N> --repo <repo> --json title,body` + `gh pr diff <N> --repo <repo>`.

### 4. Dispatch in parallel

Concurrency-capped `Promise.all` (default 3). For each domain, spawn the agent CLI:

- **claude**: `claude --print --output-format=stream-json …` — TS port of `build_claude_cmd` from `scripts/claude_utils.py` (~50 LOC).
- **codex**: `codex exec --json …` with reasoning effort high — TS port of `scripts/codex_utils.py` (~40 LOC).
- **gemini**: TS port of `scripts/gemini_utils.py`'s CLI builder (~80 LOC, drop session-isolation complexity not needed for single-agent path).

Each port lives next to `stark_review.ts`:
- `tools/agent_claude.ts`
- `tools/agent_codex.ts`
- `tools/agent_gemini.ts`

Each exports two functions: `buildCommand(prompt, model)` and `parseOutput(stdout): Finding[]`.

### 5. Parse findings

Schema:

```ts
type Finding = {
  id: string;                      // sha256(domain|agent|normalized-title) prefix-12.
                                    // Title-only (file/line excluded) so renames + line-shifts
                                    // don't break the round-N → round-N+1 "recurring" match.
                                    // For file:null cross-cutting findings, file/line are
                                    // already absent so the same hash is used.
  domain: string;
  agent: "claude" | "codex" | "gemini";
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;             // null for cross-cutting findings (no file anchor)
  line: number | null;             // null when file is null OR finding is file-level
  title: string;
  body: string;
};
```

`file: null` findings are accepted (e.g. cross-cutting architecture concerns).
They land in history and the receipt but **are not posted as inline review
comments** — they go in the review's top-level `body` instead (see §8).

**Failure semantics — three tiers, no contradiction:**

1. **Per-domain partial failure** (one agent invocation fails, others succeed):
   add the `(domain, agent)` to that round's `failed_results[]`, keep the
   other domains' findings, **continue the round**, and at the end of the
   round set the process exit code to non-zero. The receipt is `ok: true`
   in shape but `rounds[i].failed_results.length > 0` — consumers that want
   "all-or-nothing cleanliness" check this field. The PR is never reported
   clean while `failed_results` is non-empty.

2. **Total round failure** (every domain failed): emit the failure receipt
   shape (`ok: false`, `error.code: "dispatch_failure"`) and exit non-zero
   without proceeding to classification or posting.

3. **Schema parse failure** for a single finding within an otherwise valid
   stdout: drop the finding, add a record to `parse_errors[]` on that round,
   keep going. The other findings from that domain are still used.

If an agent emits fields the parser doesn't recognize, they are preserved
in `extra` and the finding is still accepted. If required fields
(`severity`, `title`, `domain`) are missing, that finding falls into tier 3.
If stdout is not parseable JSON/JSONL at all, that's tier 1 (the whole
domain failed).

Apply `severity_overrides[domain]` after parse.

### 6. Classify

For each finding:

1. If `file && line`: read `±20` lines around `file:line` from the worktree.
   If `file: null`: skip the file read; pass only the finding body.
2. Single agent call (same agent, short prompt) returns
   `{classification, classification_reason}` where
   classification ∈ `fix | false_positive | noise | ignored`.
3. Attach to finding.

**Classifier failure handling** (resolves the conflict with §5's fail-closed
contract): if the classifier call fails or returns malformed JSON, the
finding is attached with `classification: "fix"` and
`classification_reason: "classifier_failed: <error>"`. This is fail-safe
(default to "treat as real"), not fail-closed (don't kill the run for a
classifier hiccup). The error is logged and surfaced in the receipt's
`classifier_errors` field. Five or more classifier errors in one round abort
the run.

Classifier prompt lives at `global/prompts/<agent>/classifier.md` (new file,
~30 lines per agent — added in this PR). Override resolution same as domain
prompts. (This is the one prompt-file change permitted by the non-goals; the
existing per-domain `NN-*.md` prompts are untouched.)

### 7. Persist history

Write `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json`. Schema-compatible with `multi_review.py`'s `save_round_history()`:

```json
{
  "schema_version": 1,
  "repo": "owner/name",
  "pr": 123,
  "round": 1,
  "mode": "single",
  "agent": "codex",
  "domains": ["security", "behavior"],
  "findings": [ … with classification … ],
  "summary": { "total": N, "critical": N, "high": N, "medium": N, "low": N },
  "started_at": "ISO",
  "completed_at": "ISO"
}
```

Round number = max existing `round-N.json` in that dir + 1.

### 8. Post comments (REST only)

For each `fix` finding with severity ≥ `fix_threshold` AND `file && line`,
build a review with inline comments and POST it. File-anchored findings whose
`file` is not in the PR's changed-file set are demoted to top-level body
items (commenting on unchanged files is rejected by the API). Cross-cutting
findings (`file: null`) and out-of-diff findings appear in the review body.

**Idempotency.** Each round POSTs at most one review, gated by both an
in-process lock and a remote check. Sequence:

1. Acquire the per-PR file lock at
   `~/.claude/code-review/locks/{org}-{repo}-{pr}.lock` (flock-based,
   blocking ≤30s, then fail with `error.code: "lock_held"`).
2. Re-read `GET /repos/{o}/{r}/pulls/{n}/reviews` (paginated) and search for
   a review whose body contains the marker
   `<!-- stark-review:round=<N>:agent=<agent>:run=<sha256-of-config-and-domains> -->`.
   The `run` hash makes the marker unique per (round, agent, config snapshot)
   so a re-run with different domains posts a new review and isn't
   misclassified as a duplicate.
3. If found → skip POST, record `duplicate_detected` event in receipt, release lock.
4. If not found → POST review, release lock.

The lock collapses the GET→POST race when two concurrent invocations target
the same PR. Without it the marker check is best-effort, not a guarantee.

```
gh api -X POST /repos/{owner}/{repo}/pulls/{n}/reviews \
  --input -  <<JSON
{
  "event": "COMMENT",
  "body":  "<!-- stark-review:round=1:agent=codex -->\n\n<summary>\n\n<cross-cutting findings>",
  "comments": [
    { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
JSON
```

Use `--input -` with stdin JSON (not `-f comments='[...]'` shell
interpolation) to avoid shell-escape brittleness with finding bodies that
contain quotes or newlines.

`line`/`side` follow the GitHub Reviews API rules: `side: "RIGHT"` plus the
new file's line number for additions; `side: "LEFT"` for deletions. The
`file:line` we receive from the agent is always against the PR head, so
`side: "RIGHT"`.

**Pagination** is handled for every list endpoint: `gh api --paginate`
follows `Link: rel="next"` automatically. Used for both
`/pulls/{n}/files` and `/pulls/{n}/reviews`.

**Rate limits / 5xx.** Retry on `403` with `X-RateLimit-Remaining: 0`,
`429`, and `5xx` with exponential backoff (1s, 4s, 16s; 3 attempts max).
Secondary rate-limit (`Retry-After` header) is honored. After the cap, the
post is skipped and recorded in the receipt's `unposted_reviews[]`.

Skip all posting when `--dry-run`. For fork PRs (detected via
`GET /repos/{o}/{r}/pulls/{n}` → `head.repo.fork === true`), posting still
works under the GitHub App token (the upstream repo grants permission), so
fork detection only gates the *fix-loop push*, not the review post.

GitHub endpoints used (REST only — no GraphQL):

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/repos/{o}/{r}/pulls/{n}` | PR meta, fork detection, base sha, branch name |
| GET | `/repos/{o}/{r}/pulls/{n}/files` | Filter findings to changed files (paginated) |
| GET | `/repos/{o}/{r}/pulls/{n}/reviews` | Idempotency check (paginated) |
| POST | `/repos/{o}/{r}/pulls/{n}/reviews` | Post review with inline comments |

`gh pr view` and `gh pr diff` stay (already REST under the hood per `gh` source).

### 9. Fix loop

Authorization: see "Fix-loop authorization gate" in the Trust section. The
loop is skipped (not failed) when the gate denies it.

If authorized AND any `fix` finding has severity ≥ `config.fix_threshold`
(default `medium`; "critical or high" referenced earlier was an example, not
a hardcode):

1. **Build the fix prompt from structured findings only.** For each finding
   the fixer agent receives `{file, line, severity, title, body}` plus the
   agent reading the file via its own tools. The PR diff and PR body are
   **not** included in the fix prompt (prompt-injection containment).
2. Spawn the agent CLI serially per finding to edit the worktree.
3. **Stage explicit paths only** — never `git add -A`. The tool collects the
   set of `file` paths from the findings being fixed plus any path the agent
   reports it modified, validates each is inside the worktree (no `..`
   traversal, no symlink-out-of-tree), and stages only those:
   ```
   git add -- <file1> <file2> ...
   ```
4. **Resolve branch and remote.** From step 1's `GET /pulls/{n}` response we
   already have `head.ref` (branch), `head.repo.full_name`, and
   `head.repo.clone_url`. Push target:
   - **Same-repo PR** (`head.repo.fork === false`): push to `origin HEAD:<head.ref>`.
   - **Fork PR with maintainer-can-modify** (`head.repo.fork === true && maintainer_can_modify === true`):
     add a transient remote `git remote add stark-fork-push <clone_url>`
     authenticated with the GitHub App token, push
     `stark-fork-push HEAD:<head.ref>`, then `git remote remove stark-fork-push`.
     Pushing to `origin` would target the upstream repo and fail.
   - **Fork without maintainer-can-modify**: gate denies; never reach this step.

   On non-fast-forward push (someone else committed to the branch
   concurrently), do NOT force-push. Abort the fix loop, record
   `error.code: "push_conflict"` in the receipt, and surface a message
   directing the user to rebase manually. Force-pushing review-bot commits
   over user work is a category error.
5. Run `config.test_command` (only trusted source — see Trust section).
   If unset, the fix loop is disabled by the auth gate above and we never
   reach this step.
6. If tests pass: `git commit -m "fix: address review findings (round N)"
   && git push <remote> HEAD:<branch>`.
7. Re-run from step 3 of the pipeline (Render prompts). Cap at `--max-rounds`
   (default 3).
8. If tests fail: keep worktree, exit non-zero, do not claim clean.

`--no-fix-loop` short-circuits this stage entirely.

**Audit log.** Every fix-loop action — file edits, stages, commits, pushes,
posted reviews — is appended to `~/.claude/code-review/audit/{org}/{repo}/{pr}.jsonl`
with `{ts, action, round, files?, sha?, review_id?}`. This is in addition to
the per-round JSON.

### 10. Output

Stdout receipt (JSON when `--json`). Two shapes — success and failure — share
the same envelope; `ok` distinguishes them. Consumers should branch on `ok`
before reading `rounds`/`error`.

**Success:**

```json
{
  "ok": true,
  "schema_version": 1,
  "repo": "owner/name",
  "pr": 123,
  "agent": "codex",
  "agents_resolved": { "security": "codex", "behavior": "codex" },
  "domains": ["security", "behavior"],
  "rounds": [
    {
      "round": 1,
      "findings": [...],
      "summary": { "total": N, "critical": N, "high": N, "medium": N, "low": N },
      "failed_results": [],
      "classifier_errors": [],
      "duration_ms": 12345
    }
  ],
  "fixes_pushed": false,
  "comments_posted": 7,
  "unposted_reviews": [],
  "history_files": ["~/.claude/code-review/history/…/round-1.json"]
}
```

**Failure** (any non-recoverable error — dispatch failure, repeated parse
failure, fix-loop gate denied when fix-loop was requested explicitly, push
failure):

```json
{
  "ok": false,
  "schema_version": 1,
  "repo": "owner/name",
  "pr": 123,
  "error": {
    "code": "dispatch_failure" | "parse_failure" | "push_failure"
          | "auth_denied" | "config_missing" | "test_failure",
    "message": "human-readable",
    "domain": "security",      // optional
    "agent": "codex",           // optional
    "stage": "dispatch",        // pipeline stage 1–10
    "details": {}               // free-form
  },
  "rounds": [...]               // partial rounds completed before failure
}
```

`failed_results[]` (per round) and top-level `error` (terminal failure) are
distinct. A round with `failed_results` non-empty + non-zero exit code is a
recoverable-classification (the run continues if other domains succeeded);
a top-level `error` is terminal.

Plus a human-readable summary block on stderr (matching today's "Review
Complete" format).

## SKILL.md changes

- Drop Phases 1–5 detail (now owned by the tool).
- Add `--quick` to the args section.
- Replace the Python invocation with:
  ```bash
  node --experimental-strip-types "$TOOLS/stark_review.ts" \
    --pr "$PR_NUM" --repo "$REPO" --base "$BASE" --worktree "$WORKTREE_PATH" \
    ${AGENT:+--agent "$AGENT"} ${QUICK:+--quick} ${DRY_RUN:+--dry-run} --json
  ```
- Failure handling: read `ok` and `rounds[*].failed_results` from the receipt.

## Config schema additions

`global/config.json` adds:

```json
{
  "quick_domains": [],
  "default_agent": "codex",
  "test_command": null,
  "untrusted_fix_loop": false,
  "history_retention_days": 90
}
```

- `quick_domains`: empty by default — repos/orgs override. Missing or empty
  combined with `--quick` → tool errors with a pointer to the config field.
- `default_agent`: used when `--agent` is omitted and `domain_agents[D]` has
  no entry for the domain.
- `test_command`: trusted source for the fix-loop test runner (see Trust
  model). Missing → fix loop is disabled.
- `untrusted_fix_loop`: org-level default for `--allow-untrusted-fix-loop`.
- `history_retention_days`: per-PR history dirs older than this are pruned
  on tool startup (best-effort `find -mtime`); 0 disables pruning.

## Testing

`tools/stark_review.test.ts` and `tools/stark_review_lib.test.ts` cover:

**Unit (lib):**
- Config merge (global/org/repo precedence).
- Domain selection: default, `--quick` (populated and empty → error), `--domains`.
- Agent precedence: `--agent` > `domain_agents[D]` > `default_agent` > `"codex"`.
- Prompt rendering: override resolution (repo > global > shared `domains/`).
- Severity comparison vs `fix_threshold`.
- Finding ID derivation is stable across rounds.

**Unit (per-stage with mocks):**
- Agent dispatch: mock spawn, assert correct CLI args per agent (codex only
  for V1; claude/gemini just assert the "not implemented" guard fires).
- Finding parse: valid JSONL; malformed JSONL → that domain in `failed_results[]`,
  others continue; non-zero exit → terminal `error.code: "dispatch_failure"`.
- Classifier: malformed response → `classifier_failed:` reason, finding kept;
  ≥5 errors → terminal abort.
- Comment posting: dry-run skips, fork detection still posts review (only push
  is gated), REST payload shape uses `--input -` JSON, idempotency marker
  detection skips re-posts of the same `(round, agent)`.
- Pagination: `gh api --paginate` is called for `/files` and `/reviews`.
- Rate-limit retry: 429 + Retry-After + 5xx exponential backoff (mocked clock).
- Fix loop: stops at `--max-rounds`, stops on test failure, `--no-fix-loop`,
  trust gate denial (no `test_command`, fork without `--allow-untrusted-fix-loop`)
  → loop skipped not failed; `git add` only stages whitelisted paths
  (asserted via fake git binary on $PATH).
- Receipt: success and failure shapes both validate against the schema in §10.
- History: round-N auto-increment; schema fields exactly match
  `multi_review.py`'s `save_round_history()` output (asserted by loading a
  recorded fixture).

**Integration (gated by env, opt-in):**
- `STARK_REVIEW_E2E=1` enables a single end-to-end run against a sandbox
  fixture PR (recorded `gh api` responses replayed via a stub `gh` on
  `$PATH`). One happy path, one fix-loop-denied path, one dispatch-failure
  path. Skipped in normal `npm test`; run weekly in CI.

Existing tool test pattern (see `tools/review_setup_worktree.test.ts`) is the
template — node:test, no extra runner.

## Migration

1. Land `tools/stark_review.ts` + tests + agent ports.
2. Add `quick_domains` field to `global/config.json` (empty default) and document in CLAUDE.md.
3. Rewrite `skill/stark-review/SKILL.md` to invoke the TS tool.
4. Update `install.sh` if needed (likely no change — symlink already covers `tools/`).
5. Smoke test against a real low-stakes PR with `--dry-run` first.

Python files and `/stark-team-review` are untouched.

## Risks

- **Schema drift between TS history writer and Python writer.** Mitigation:
  treat the JSON schema in §7 as a contract; add a test that loads a
  `multi_review.py`-produced fixture and asserts our writer matches its keys.
- **Agent CLI flag drift.** `claude`/`codex`/`gemini` CLIs change. Mitigation:
  keep the agent ports under 100 LOC each so a flag change is a one-file fix;
  smoke test in CI weekly.
- **Fix loop runaway.** Hard cap at `--max-rounds` (default 3); never auto-bump.
- **Config divergence with stark-team-review.** Both read the same
  `global/config.json`, so adding `quick_domains` is additive — Python ignores
  unknown fields (`config_loader.py` deep-merges without schema validation).

## Deferred to the implementation plan

These were raised during design review and consciously deferred to the plan
rather than the spec:

- Exact classifier prompt text (per agent).
- Reviewer-prompt schema contract: the existing per-domain prompts already
  request a JSON shape; the plan codifies the canonical schema as a snippet
  prepended to each prompt at render time, so agents emit against an
  explicit contract rather than implicit convention.
- Fixer agent output contract (V1.1): how the fixer reports which files it
  touched so we can stage explicit paths.
- Sandbox depth: §"Trust" uses env allowlist + temp dir. The plan decides
  whether to add `unshare`/`firejail`/Docker on Linux for harder isolation,
  or accept process-level only. V1 ships process-level; sandbox upgrade is
  a follow-up.
- History writer Python-schema parity: the plan includes a fixture-based
  test that loads a `multi_review.py`-produced `round-N.json` and asserts
  field-for-field match with the TS writer's output.
- Inline review anchor edge cases: GitHub's Reviews API has nuances around
  `position` vs `line`, multi-line comments, and unchanged-context anchors.
  The plan enumerates each case with the exact payload shape.

## Open questions

None blocking. The spec is approved-pending-user-review.
