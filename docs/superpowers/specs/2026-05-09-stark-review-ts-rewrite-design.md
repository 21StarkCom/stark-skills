# Spec: TypeScript rewrite of `/stark-review`

**Date:** 2026-05-09
**Status:** Approved (brainstorming phase)
**Owner:** aryeh.kiovetsky@evinced.com

## Goal

Replace the Python-driven `/stark-review` pipeline with a single dedicated TypeScript tool. The existing Python (`multi_review.py`, `triage_orchestrator.py`, `domain_triage.py`, `*_utils.py`) stays in place because `/stark-team-review` and other skills still use it.

Three motivating constraints from the user:

1. `/stark-review` should be TypeScript-only end to end — no Python on the hot path.
2. All GitHub interactions go through REST endpoints (`gh api <path>`), never `gh api graphql`.
3. Add a `--quick` mode that reviews only the highest-value domains, configured per-repo/org/global.

## Non-goals

- Not migrating `/stark-team-review` or any other skill.
- Not porting triage logic — `/stark-review` drops triage entirely.
- Not replacing the `claude` / `codex` / `gemini` CLIs with native SDK calls. The TS tool still shells out to the agent CLI.
- Not changing prompt files in `global/prompts/<agent>/`.

## Architecture

One new file pair under `tools/`:

- `tools/stark_review.ts` — the dispatcher.
- `tools/stark_review.test.ts` — node:test tests.

`SKILL.md` becomes a thin wrapper (~80 lines):
preflight → arg parse → `review_setup_worktree.ts` → `stark_review.ts` → `review_cleanup_worktree.ts`.

The existing worktree setup/cleanup TS tools (`tools/review_setup_worktree.ts`, `tools/review_cleanup_worktree.ts`) are reused unchanged.

## CLI surface

```
node --experimental-strip-types tools/stark_review.ts \
  --pr <N> --repo owner/name --base <branch> --worktree <path> \
  [--agent claude|codex|gemini]   # default: codex
  [--quick]                        # use config.quick_domains
  [--domains a,b,c]                # explicit domain override (escape hatch)
  [--dry-run]                      # no posts, no commits, no push
  [--no-fix-loop]                  # one round only
  [--max-rounds N]                 # default 3
  [--json]                         # machine-readable receipt to stdout
```

`--quick`, `--domains`, and the default ("all enabled") are mutually exclusive in
that order: `--domains` wins; otherwise `--quick`; otherwise default.

Default agent is **codex** (matches today's `domain_agents` config which routes
the six PR-review domains to Codex).

## Pipeline

The tool owns the full pipeline. Each stage emits a structured event for the JSON receipt.

### 1. Resolve config

Read `~/.claude/code-review/global/config.json`, then deep-merge org override
(`<git-root>/.code-review/config.json` walking up to `$HOME`), then repo override
(`<repo-root>/.code-review/config.json`). Same precedence as `dispatcher_base.py`.

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

Schema bump: add `quick_domains: []` to `global/config.json`. Empty by default.

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
  domain: string;
  agent: "claude" | "codex" | "gemini";
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  title: string;
  body: string;
};
```

**Fail closed** if any agent invocation exits non-zero or stdout is not valid
JSON/JSONL. Surface failed `(domain, agent)` pairs in the receipt and exit
non-zero. Never report the PR as clean on partial failure.

Apply `severity_overrides[domain]` after parse.

### 6. Classify

For each finding:

1. Read `±20` lines around `file:line` from the worktree.
2. Single agent call (same agent, short prompt) returns `{classification, classification_reason}` where classification ∈ `fix | false_positive | noise | ignored`.
3. Attach to finding.

Classifier prompt lives at `global/prompts/<agent>/classifier.md` (new file, ~30 lines per agent). Override resolution same as domain prompts.

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

For each `fix` finding with severity ≥ `fix_threshold`, build a review with inline
comments and POST it:

```
gh api -X POST /repos/{owner}/{repo}/pulls/{n}/reviews \
  -f event=COMMENT \
  -f body="..." \
  -f comments='[{"path":"…","line":…,"body":"…"}, …]'
```

Skip when `--dry-run`. For fork PRs (detected via `GET /repos/{o}/{r}/pulls/{n}` →
`head.repo.fork === true`), skip unless `maintainer_can_modify === true`.

GitHub endpoints used (REST only — no GraphQL):

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/repos/{o}/{r}/pulls/{n}` | PR meta, fork detection, base sha |
| GET | `/repos/{o}/{r}/pulls/{n}/files` | Filter findings to changed files |
| POST | `/repos/{o}/{r}/pulls/{n}/reviews` | Post review with inline comments |

`gh pr view` and `gh pr diff` stay (already REST under the hood per `gh` source).

### 9. Fix loop

If any `fix` finding has severity ≥ `critical` or `high`:

1. Edit files in the worktree to address them. (For now: spawn the agent CLI with a "fix this finding" prompt per finding; serial.)
2. Run the project test command. Resolution order:
   - `config.test_command` if set
   - `CLAUDE.md` `## Commands` first command containing `test`
   - `package.json` `scripts.test` → `npm test`
   - else: report "no test command" and stop without committing.
3. If tests pass: `git add -A && git commit -m "fix: address review findings" && git push origin HEAD:<branch>`.
4. Re-run from step 3 (Render prompts). Cap at `--max-rounds` (default 3).
5. If tests fail: keep worktree, exit non-zero, do not claim clean.

`--no-fix-loop` short-circuits this stage entirely.

### 10. Output

Stdout receipt (JSON when `--json`):

```json
{
  "ok": true,
  "repo": "…",
  "pr": 123,
  "agent": "codex",
  "domains": ["…"],
  "rounds": [
    { "round": 1, "findings": [...], "summary": {...}, "duration_ms": 12345 }
  ],
  "fixes_pushed": false,
  "comments_posted": 7,
  "history_files": ["~/.claude/code-review/history/…/round-1.json"]
}
```

Plus a human-readable summary block on stderr (matching today's "Review Complete" format).

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
  "quick_domains": ["security", "behavior"],
  "test_command": null
}
```

`quick_domains` empty by default — repos/orgs override. Missing or empty + `--quick` → tool errors with a pointer to the config field.

## Testing

`tools/stark_review.test.ts` covers:

- Config merge (global/org/repo precedence).
- Domain selection: default, `--quick` (populated and empty), `--domains`.
- Prompt rendering: override resolution.
- Agent dispatch: mock spawn, assert correct CLI args per agent.
- Finding parse: valid JSONL, malformed JSONL fails closed, non-zero exit fails closed.
- Classification: attaches fields, handles agent error.
- History write: round-N auto-increment, schema match.
- Comment posting: dry-run skips, fork-without-maintainer-modify skips, REST payload shape.
- Fix loop: stops at `--max-rounds`, stops on test failure, `--no-fix-loop`.

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

## Open questions

None for the spec — design is settled. Implementation plan will surface details
(e.g., exact prompt text for the classifier, fork-PR maintainer detection
mechanics).
