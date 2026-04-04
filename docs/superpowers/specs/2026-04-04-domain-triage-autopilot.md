# Domain Triage — Autopilot Plan

> Implement domain-aware triage for the stark-skills review system. One LLM call before dispatch decides which review domains are relevant, skipping irrelevant ones to save cost and reduce noise.

**Design spec:** `docs/superpowers/specs/2026-04-04-domain-triage-design.md`
**GitHub issues:** #228–#238 (Phases 1–3 of the domain-triage plan)
**Test command:** `python3 -m pytest scripts/ -x -q`

**Prerequisite (done separately):** Phase 0 (#226–#227) registers `TRIAGE_DECISION` in stark-insights. The orchestrator handles insights unavailability gracefully, so this repo's code can merge independently.

---

## Phase 1 — Triage Engine and Assets

### Task 1: Triage prompt assets and domain manifest (#228, 3 SP)

Create `global/prompts/triage/` with 4 files:

**`domains.json`** — canonical domain description manifest covering all review types:

```json
{
  "pr-review": {
    "architecture": "Reviews architecture patterns, design decisions, dependency structure, and component boundaries.",
    "accessibility": "WCAG 2.1 AA compliance, screen reader support, keyboard navigation, color contrast.",
    "correctness": "Logic bugs, off-by-one errors, null handling, edge cases, race conditions.",
    "type-safety": "TypeScript type definitions, API surface contracts, generic constraints.",
    "security": "Authentication, authorization, input validation, secrets handling, OWASP top 10.",
    "test-coverage": "Test quality, missing test cases, assertion completeness, mock appropriateness.",
    "spec-conformance": "Alignment with design spec, API contract adherence, feature completeness.",
    "ui-design-conformance": "Visual design fidelity, component usage, responsive layout, design system compliance.",
    "regression-prevention": "Breaking changes, backward compatibility, migration paths, deprecation handling."
  },
  "design-review": { ... 12 domains from global/prompts/design-review/ directory ... },
  "plan-review": { ... 10 domains from global/prompts/plan-review/ directory ... }
}
```

Discover actual domain slugs by listing existing prompt directories:
- PR: `global/prompts/claude/` (9 domains, pattern `NN-slug.md`)
- Design: `global/prompts/design-review/claude/` (12 domains)
- Plan: `global/prompts/plan-review/claude/` (10 domains)

Write one-sentence descriptions for each domain based on the prompt file contents. The slugs in domains.json must exactly match the filename-derived slugs used by multi_review.py and plan_review_dispatch.py.

**`pr-review.md`**, **`design-review.md`**, **`plan-review.md`** — triage prompts, each containing:
1. Role: triage agent deciding which review domains are relevant
2. Domain catalogue placeholder `{domains}` — injected at runtime from domains.json
3. Input placeholder `{content}` — wrapped in `<triage-input type="diff|document">` delimiters with injection mitigation instruction
4. Output format: JSON with `domains` array, each entry having `domain`, `relevant` (bool), `confidence` (0.0–1.0), `reason` (string)
5. Instructions: assess each domain independently, err toward relevant when uncertain

Prompts are NOT agent-specific — same prompt for Claude and Codex.

**Acceptance criteria:**
- domains.json covers all PR (9), design (12), and plan (10) domains with correct slugs
- Slugs match what `multi_review.py` and `plan_review_dispatch.py` discover from filesystem
- Prompts contain `{domains}` and `{content}` placeholders
- `install.sh --status` shows triage prompts symlinked correctly (update install.sh if needed to symlink `global/prompts/triage/`)

### Task 2: Triage engine — `scripts/domain_triage.py` (#229, 8 SP)

Create `scripts/domain_triage.py` with these types and main function:

```python
from typing import Literal, TypedDict
from dataclasses import dataclass

class DomainMeta(TypedDict):
    order: str
    label: str
    filename: str
    description: str

@dataclass
class DomainVerdict:
    domain: str
    relevant: bool
    confidence: float  # 0.0–1.0
    reason: str

@dataclass
class TriageResult:
    mode: Literal["aggressive", "conservative", "full"]
    agent: Literal["claude", "codex"]
    model: str
    review_type: Literal["pr", "design", "plan"]
    verdicts: list[DomainVerdict]
    dispatched_domains: list[str]
    skipped_domains: list[str]
    duration_s: float
    error: str | None
    input_strategy: Literal["full", "summary"]
    content_hash: str  # SHA-256 of original input

def triage_domains(
    content: str,
    review_type: Literal["pr", "design", "plan"],
    domains: dict[str, DomainMeta],
    mode: Literal["aggressive", "conservative", "full"] = "aggressive",
    agent: Literal["claude", "codex"] = "claude",
    disabled_domains: list[str] | None = None,
    timeout: int = 15,
) -> TriageResult:
```

**Engine flow (implement all 13 steps):**
1. Validate `mode` and `agent` — raise `ValueError` on invalid values
2. If `mode == "full"`, return all domains as relevant immediately (no LLM call)
3. Remove `disabled_domains` from candidate set
4. Load triage prompt for `review_type` from `global/prompts/triage/`
5. Load domain descriptions from `global/prompts/triage/domains.json`
6. Large input summarization (>120K chars):
   - PR diffs: file list with `+lines/-lines` per file + first 50 lines from each modified file (capped at 20 files)
   - Documents: section headings + first paragraph of each section
   - Set `input_strategy = "summary"`, always compute `content_hash` of original input
7. Wrap input in `<triage-input type="diff|document">...</triage-input>` delimiters
8. Dispatch to agent CLI via subprocess with timeout (15s default). On transient failure (429, network timeout), retry once after 2s backoff
9. Parse JSON response — handle: raw JSON, markdown-fenced JSON (```json...```), double-encoded JSON
10. Response validation: unknown domains ignored (warn), missing domains treated as relevant (fail-open, warn), duplicates keep first, confidence clamped to 0.0–1.0
11. Apply mode logic:
    - aggressive: `dispatched = [d for d in verdicts if d.relevant]`
    - conservative: `dispatched = [d for d in verdicts if d.relevant or d.confidence < confidence_threshold]` (threshold default 0.8, from config)
12. Zero-domain guard: if dispatched is empty, that's a valid outcome (changelog-only PRs)
13. Return `TriageResult`

**Failure handling:** On total failure after retry, fall back to full mode with `error` field set. Triage is an optimization, never a gate.

**Agent CLI dispatch:** Look at how `multi_review.py` dispatches to agent CLIs for the subprocess pattern. The triage call sends the prompt + content to one agent and gets back JSON.

### Task 3: TUI renderer — `scripts/triage_tui.py` (#230, 3 SP)

Create `scripts/triage_tui.py` with:

**Configuration:**
```python
@dataclass
class TUIConfig:
    color: bool      # auto-detect from TTY + NO_COLOR env var
    plain: bool      # --plain flag: no emoji, no box-drawing
    json_mode: bool  # --json: suppress TUI, output JSON only
```

**Color scheme** (use ANSI escape codes):
| Element | Color | Emoji | Plain text |
|---------|-------|-------|------------|
| PR Review banner | Green | `\U0001f50d` | `[PR REVIEW]` |
| Design Review banner | Magenta | `\U0001f4d0` | `[DESIGN REVIEW]` |
| Plan Review banner | Blue | `\U0001f4cb` | `[PLAN REVIEW]` |
| Aggressive mode | Yellow | `\u26a1` | `aggressive` |
| Conservative mode | Cyan | `\U0001f6e1\ufe0f` | `conservative` |
| Full mode | Dim | `\U0001f513` | `full` |
| Relevant domain | Green | `\u2705` | `[OK]` |
| Skipped domain | Red | `\u23ed\ufe0f` | `[SKIP]` |
| Dispatch success | Green | `\u2705` | `[OK]` |
| Dispatch failure | Red | `\u274c` | `[FAIL]` |
| Running | Yellow | `\u00b7\u00b7\u00b7` | `[RUN]` |

**Render functions:**
- `render_banner(config, review_type, repo, pr_number, mode, agent, model)` — top banner box
- `render_triage(config, triage_result)` — domain verdicts table
- `render_dispatch_progress(config, agent, domain, status, findings_count, duration)` — live dispatch line
- `render_summary(config, total_findings, by_severity, succeeded, failed, total_duration, triage_duration)` — final summary
- `render_insights(config, success, error)` — insights emission status

**Environment awareness:**
- `NO_COLOR=1` → no ANSI escape sequences
- Non-TTY (piped) → no ANSI
- `--plain` → no ANSI + no emoji + no box-drawing (use `===` dividers instead of `╔═╗`)

**TUI layout** (match the design spec mockup):
```
╔══════════════════════════════════════════════════════════════════════╗
║ \U0001f50d  stark-triage · PR Review · GetEvinced/repo #42               ║
║ \u26a1  Mode: aggressive · Agent: claude · Model: claude-sonnet-4-6    ║
╚══════════════════════════════════════════════════════════════════════╝

── \U0001f3af  Triage ─────────────────────────────────────────────────────────
  \u2705 architecture            relevant   (0.92) new service layer pattern
  \u23ed\ufe0f  accessibility           skip       (0.95) no UI components in diff
  ...
  \U0001f680 Dispatching 4/9 domains  ·  Saving ~10 sub-agent runs
  \u23f1\ufe0f  Triage completed in 4.2s

── \U0001f916  Dispatch ───────────────────────────────────────────────────────
  [ 1/8] \u2705 claude:architecture          4 findings    (6.3s)
  ...

── \U0001f4ca  Summary ────────────────────────────────────────────────────────
  \U0001f4dd 15 findings  ·  \U0001f534 2 critical  ·  \U0001f7e1 5 high  ·  \U0001f7e0 6 medium  ·  \u26aa 2 low
  \u2705 7/8 sub-agents succeeded  ·  \u274c 1 failure
  \u23f1\ufe0f  Total: 38.3s (triage: 4.2s + dispatch: 34.1s)

── \U0001f4e1  Insights ───────────────────────────────────────────────────────
  \u2192 triage_decision event emitted to stark-insights
```

### Task 4: Unit tests for engine and TUI (#231, 5 SP)

Create `scripts/test_domain_triage.py` with 17 tests:

1. `test_full_mode_skips_llm` — mode="full" returns all domains, no subprocess call
2. `test_aggressive_filters_irrelevant` — only `relevant: true` domains dispatched
3. `test_conservative_keeps_low_confidence` — `relevant: false, confidence < 0.8` kept
4. `test_conservative_threshold_configurable` — custom threshold respected
5. `test_missing_verdicts_fail_open` — omitted domains treated as relevant
6. `test_duplicate_verdicts_first_wins` — first occurrence kept
7. `test_confidence_clamped` — values <0 → 0, >1 → 1
8. `test_unknown_domains_ignored` — domains not in candidate set dropped
9. `test_disabled_domains_excluded` — static disabled_domains removed before triage
10. `test_zero_domains_exits_clean` — empty dispatched_domains is valid
11. `test_invalid_mode_raises` — ValueError for invalid mode
12. `test_invalid_agent_raises` — ValueError for invalid agent
13. `test_parse_valid_json` — well-formed response → correct DomainVerdict list
14. `test_parse_json_with_prose_wrapper` — markdown-fenced JSON parsed correctly
15. `test_parse_malformed_json_fallback` — unparseable → fallback to full mode
16. `test_content_hash_computed` — content_hash is SHA-256 of original input
17. `test_large_input_summarized` — >120K chars → input_strategy: "summary"

Create `scripts/test_triage_tui.py` with 4 tests:

1. `test_no_color_strips_ansi` — NO_COLOR=1 → zero ANSI escape sequences
2. `test_non_tty_strips_ansi` — piped output → zero ANSI
3. `test_plain_mode_strips_emojis` — --plain → no emoji, text indicators only
4. `test_plain_mode_ascii_borders` — --plain → no box-drawing characters

Use `unittest.mock.patch` to mock subprocess calls in engine tests. Do NOT mock the engine's internal logic — mock the external CLI subprocess and test the logic around it.

---

## Phase 2 — Dispatch Plumbing and Orchestrator

### Task 5: Add `--domains` allowlist to dispatch scripts (#232, 5 SP)

Modify `scripts/multi_review.py`:
- Add `--domains` CLI argument (comma-separated domain slugs)
- When provided, bypass domain discovery and use the allowlist directly
- When omitted, behavior is IDENTICAL to current code (zero regression)
- Thread the domain list through to the review dispatch functions
- Add `triage` to `DEEP_MERGE_FIELDS` for config merging

Modify `scripts/plan_review_dispatch.py`:
- Add `--domains` CLI argument (same semantics)
- Add `--json-only` flag if not already present — separates JSON output to stdout and progress to stderr
- When `--domains` provided, skip domain discovery and use allowlist
- When omitted, behavior unchanged

Read both files first to understand the current domain discovery pattern and CLI arg parsing before modifying.

**Acceptance criteria:**
- `--domains` shown in `--help` for both scripts
- Passing `--domains architecture,security` dispatches only those two domains
- Omitting `--domains` produces identical behavior to current code
- Existing tests pass with no regressions

### Task 6: Triage config block and deep-merge (#233, 3 SP)

Modify `global/config.json` — add triage block:

```json
{
  "triage": {
    "mode": "conservative",
    "agent": "claude",
    "timeout": 15,
    "conservative_confidence_threshold": 0.8,
    "insights_url": "http://localhost:7420"
  }
}
```

Note: default mode is `conservative` (not aggressive) — aggressive is promoted in Phase 5 after shadow validation.

Add per-review-type overrides:
```json
{
  "design_review": {
    "triage": { "mode": "conservative" }
  },
  "plan_review": {
    "triage": { "mode": "conservative" }
  }
}
```

Add `"triage"` to `DEEP_MERGE_FIELDS` in whichever script handles config merging (check multi_review.py). Deep-merge means repo config `triage.mode: "full"` extends global triage block rather than replacing it.

Read `global/config.json` and the config merge logic before modifying.

**Acceptance criteria:**
- global/config.json validates as valid JSON
- triage block has all 5 fields with correct defaults
- DEEP_MERGE_FIELDS includes "triage"
- Existing tests pass

### Task 7: Triage orchestrator — `scripts/triage_orchestrator.py` (#234, 8 SP)

Create `scripts/triage_orchestrator.py` — the central script owning: triage → dispatch → TUI → insights.

**CLI arguments:**
| Arg | Description | Default |
|-----|-------------|---------|
| `--type` | Review type: `pr`, `design`, `plan` | Required |
| `--pr` | PR number (for `pr` type) | — |
| `--repo` | GitHub repo (`owner/repo`) | Auto-detect from git remote |
| `--file` | Document path (for `design`/`plan` type) | — |
| `--base` | Base branch for PR diff | `main` |
| `--triage` | Triage mode override | From config |
| `--triage-agent` | Agent for triage override | From config |
| `--agents` | Review agents (comma-separated) | From config |
| `--disabled-domains` | Static exclusions | From config |
| `--timeout` | Per sub-agent timeout (seconds) | From config |
| `--no-color` | Disable ANSI colors | Auto-detect TTY |
| `--plain` | Disable colors + emoji + box-drawing | `false` |
| `--json` | Output structured JSON | `false` |
| `--dry-run` | Run triage only, don't dispatch | `false` |
| `--single` | Single-agent mode (1 agent per domain) | `false` |
| `--shadow` | Triage + dispatch ALL domains | `false` |
| `--round` | Review round number (passthrough) | — |

**Orchestration flow (all 11 steps):**
1. Load config (hierarchical: repo → org → global) — reuse existing config loading from multi_review.py
2. Resolve inputs: fetch PR diff via `gh pr diff` or read document file
3. Discover domains for the review type (use existing discovery functions)
4. Call `triage_domains()` from domain_triage.py
5. Render triage TUI section via triage_tui.py
6. If `--shadow`: override dispatched_domains to ALL domains (triage verdicts still logged)
7. If `--dry-run`: render triage results and exit
8. Delegate dispatch to `multi_review.py` (PR) or `plan_review_dispatch.py` (design/plan) with `--domains` allowlist. Build subprocess argv explicitly (no string interpolation). Pass through `--round` if provided.
9. Render dispatch TUI section
10. Render summary TUI section
11. Emit `triage_decision` event to stark-insights (POST to insights_url/events, connect timeout 2s, read timeout 3s — on failure, log warning and continue)

**`--json` output schema:**
```json
{
  "triage": {
    "mode": "...", "agent": "...", "model": "...", "review_type": "...",
    "content_hash": "sha256:...", "input_strategy": "full|summary",
    "dispatched_domains": [...], "skipped_domains": [...],
    "verdicts": [...], "duration_s": 4.2, "error": null
  },
  "dispatch": { "results": [...], "succeeded": 6, "failed": 0 },
  "findings": [...],
  "summary": { "total_findings": 15, "by_severity": {...}, "total_duration_s": 38.3 }
}
```

JSON mode: JSON to stdout, progress to stderr.

**Zero-domain handling:** If triage returns no relevant domains, render TUI message ("Triage found no relevant domains — skipping review"), emit insights event, exit code 0.

Look at how existing dispatch scripts (`multi_review.py`, `plan_review_dispatch.py`) handle config loading, git remote detection, PR diff fetching, and subprocess dispatch. Reuse their patterns.

### Task 8: Integration and failure tests (#235, 5 SP)

Create `scripts/test_triage_orchestrator.py` with 7 tests:

1. `test_pr_review_end_to_end` — orchestrator runs triage + dispatch for PR diff (mock subprocess)
2. `test_design_review_end_to_end` — orchestrator for design doc
3. `test_plan_review_end_to_end` — orchestrator for plan doc
4. `test_shadow_mode_dispatches_all` — --shadow dispatches all domains regardless of triage
5. `test_dry_run_triage_only` — --dry-run runs triage without dispatch
6. `test_json_output_schema` — --json output matches schema
7. `test_domains_arg_passthrough` — --domains passed to dispatch script

Create `scripts/test_triage_failures.py` with 4 tests:

1. `test_timeout_retries_then_fallback` — timeout → 1 retry → fallback to full
2. `test_parse_error_saves_debug_file` — malformed response → file saved to triage-errors/ with 0600 perms
3. `test_agent_unavailable_fallback` — FileNotFoundError → fallback to full
4. `test_insights_unavailable_continues` — insights POST timeout → warning, review completes

Mock external dependencies (subprocess, HTTP calls) but test the orchestration logic thoroughly.

---

## Phase 3 — Skill Cutover

### Task 9: Update review skills and eval artifacts (#236 + #237, 7 SP)

**IMPORTANT: Changes from #236 and #237 must be in the SAME commit.**

Update 4 SKILL.md files to route through orchestrator with `||` fallback:

| Skill | New primary command | Fallback |
|-------|-------------------|----------|
| `skill/stark-review/SKILL.md` | `triage_orchestrator.py --type pr --single` | `\|\| multi_review.py` |
| `skill/stark-team-review/SKILL.md` | `triage_orchestrator.py --type pr` | `\|\| multi_review.py` |
| `skill/stark-review-design/SKILL.md` | `triage_orchestrator.py --type design` | `\|\| plan_review_dispatch.py --prompts-dir design-review` |
| `skill/stark-review-plan/SKILL.md` | `triage_orchestrator.py --type plan` | `\|\| plan_review_dispatch.py --prompts-dir plan-review` |

Read each SKILL.md first to understand where the dispatch invocation currently lives. Replace the dispatch call with `triage_orchestrator.py ... || <original-dispatch-command>`. The `||` ensures orchestrator crashes fall back to direct dispatch.

`--tournament` paths in skills (if any) should still call dispatch scripts directly — tournaments don't use triage.

Pass through all existing CLI args (--pr, --repo, --file, --agents, --timeout, --round, etc.) to the orchestrator.

**Eval/golden artifacts (#237):** Search for any eval files, golden snapshots, or test fixtures that reference `multi_review.py` or `plan_review_dispatch.py` as the primary command for these 4 review skills. Update them to reference the orchestrator. Use `grep -r` to find all references.

### Task 10: Install verification (#238, 1 SP)

Update `install.sh` if needed to symlink:
- `global/prompts/triage/` directory (4 files: domains.json + 3 prompts)
- New scripts: `triage_orchestrator.py`, `domain_triage.py`, `triage_tui.py`

Run `install.sh` and verify:
- `~/.claude/code-review/prompts/triage/` contains all 4 files
- New scripts are symlinked to `~/.claude/code-review/scripts/`
- Updated SKILL.md files are symlinked correctly

Run the full test suite to confirm nothing is broken.
