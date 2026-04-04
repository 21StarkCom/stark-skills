# Domain Triage — Implementation Plan

**Design doc:** `docs/superpowers/specs/2026-04-04-domain-triage-design.md`
**Author:** Aryeh
**Date:** 2026-04-04
**Status:** Draft
**Synthesized from:** codex (winner, 7.2/10) + claude (6.0/10)

---

## 1. Overview

Build the triage feature in dependency order: deploy the new `triage_decision` schema in `stark-insights` first, then add triage assets and engine code in `stark-skills`, then thread a `--domains` allowlist through the existing dispatch scripts, then introduce the new orchestrator and TUI, then cut the four review skills over to the orchestrator, and only after shadow validation promote the default from `conservative` to `aggressive`.

**Key constraints from the design:**
- Fail-open behavior on all triage failures — triage is an optimization, never a gate
- Zero behavior change when callers bypass the orchestrator
- Hard dependency on the existing review-agent CLIs
- Rollout gate that forbids `aggressive` as default until shadow data shows 40%+ domain reduction with zero missed critical/high findings

**Owner:** Aryeh (all phases). Go/no-go authority for Phase 5 promotion: Aryeh.

**Target timeline:**

| Phase | Target | Duration |
|-------|--------|----------|
| Phase 0: Insights schema | Week 1 | 1 day |
| Phase 1: Engine + assets | Week 1–2 | 4–5 days |
| Phase 2: Orchestrator | Week 2–3 | 4–5 days |
| Phase 3: Skill cutover | Week 3 | 2 days |
| *Bake period* | *Week 3–4* | *5 days minimum* |
| Phase 4: Shadow validation | Week 4 | 3 days |
| Phase 5: Aggressive default | Week 5 | 1 day (canary) → 1 day (global) |

**Repo-specific notes:**
- Tests live in `scripts/test_*.py` — not a separate `tests/` directory
- `install.sh` symlinks the entire `global/prompts` tree — new `global/prompts/triage/` is automatically included
- `global/config.json` has `design_review` but no `plan_review` block — loader defaults are sufficient
- This repo has durable telemetry via `scripts/emit_queue.py`; design specifies direct HTTP POST for V1

## 2. Prerequisites

- Access to both repos: `stark-skills` and `stark-insights`
- Working Python venv at `scripts/.venv/bin/python3` with `pytest`, `pytest-mock`, `requests`
- Authenticated CLIs: `gh`, `claude`, `codex`
- Local insights token at `~/.stark-insights/api-token` for integration tests

Setup validation:
```bash
cd /Users/aryeh/git/Evinced/stark-skills
./install.sh --status
scripts/.venv/bin/python3 -m pytest scripts/test_multi_review.py scripts/test_plan_review_dispatch.py -v
gh auth status

# Pre-flight: verify utility modules exist
grep -rn 'def build_claude_cmd' scripts/ && echo "claude_utils OK" || echo "MISSING: claude_utils"
grep -rn 'def make_clean_env' scripts/ && echo "make_clean_env OK" || echo "MISSING: make_clean_env"
grep -rn 'CODEX_MODEL' scripts/ && echo "codex_utils OK" || echo "MISSING: codex_utils"

# Pre-flight: verify dispatch scripts have JSON-safe output
grep -n 'json.only\|json_only\|--json' scripts/multi_review.py scripts/plan_review_dispatch.py

# Pre-flight: verify findings include domain field
grep -n '"domain"' scripts/multi_review.py scripts/plan_review_dispatch.py
```

If any pre-flight check fails, resolve before starting Phase 1. For `plan_review_dispatch.py`: if it lacks a `--json-only` mode (stdout/stderr separation), add it in Phase 2.1 alongside `--domains`.

---

## Phase 0: Insights Schema (separate repo)

**Goal:** Make `stark-insights` accept `triage_decision` events before `stark-skills` emits them.
**Dependencies:** None. **Must complete before Phase 2 merge.**
**Effort:** S

### Tasks

**0.1 — Register `TRIAGE_DECISION` in stark-insights**

File: `~/git/Evinced/stark-insights/src/stark_insights/models.py`

1. Add `TRIAGE_DECISION = "triage_decision"` to `EventType` enum
2. Add payload schema to `PAYLOAD_SCHEMAS`:
   ```python
   "triage_decision": {
       "review_type": str,
       "repo": str,
       "pr_number": (int, type(None)),
       "mode": str,
       "agent": str,
       "model": str,
       "content_hash": str,
       "input_strategy": str,
       "total_domains": int,
       "static_disabled_domains": list,
       "dispatched_domains": list,
       "skipped_domains": list,
       "decisions": list,
       "triage_duration_s": float,
       "estimated_savings": int,
       "error": (str, type(None)),
   },
   ```
3. Add `"triage_decision": Sensitivity.INTERNAL` to `SENSITIVITY_MAP`
4. Add validation test

**0.2 — Deploy updated stark-insights**

Deploy before merging emitter code in `stark-skills`:
```bash
cd ~/git/Evinced/stark-insights
docker-compose build && docker-compose up -d
# Wait for health check
curl -sS http://localhost:7420/health | jq .status
```

### Verification

```bash
cd ~/git/Evinced/stark-insights
python3 -m pytest -v

TOKEN=$(cat ~/.stark-insights/api-token)
curl -sS -X POST http://127.0.0.1:7420/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"triage_decision","cli":"claude","source":"skill","dedupe_key":"triage:test:1","payload":{"review_type":"pr","repo":"test","pr_number":null,"mode":"full","agent":"none","model":"none","content_hash":"sha256:test","input_strategy":"full","total_domains":9,"static_disabled_domains":[],"dispatched_domains":["architecture"],"skipped_domains":[],"decisions":[],"triage_duration_s":0.0,"estimated_savings":0,"error":null}}'
```

### Rollback

Revert the `stark-insights` schema change and redeploy.

---

## Phase 1: Triage Assets and Engine

**Goal:** Add prompts, domain manifest, triage engine, TUI renderer, and unit test coverage. Zero changes to existing behavior.
**Dependencies:** None (parallel with Phase 0)
**Effort:** L

### Tasks

**1.1 — Create triage prompt assets and domain manifest**

Files (all new):
- `global/prompts/triage/pr-review.md`
- `global/prompts/triage/design-review.md`
- `global/prompts/triage/plan-review.md`
- `global/prompts/triage/domains.json`

Steps:
- Keep prompt text agent-neutral (same prompt for Claude and Codex)
- Structure: role → domain catalogue (auto-injected from manifest) → input content (in `<triage-input>` delimiters) → anti-injection instruction → output JSON format
- Manifest covers all currently discovered PR (9), design (12), and plan (10) domains
- Derive descriptions from domain purpose, not heuristic rules — the design explicitly excludes heuristic triage

Prompt loading path: repo-relative `global/prompts/triage/` during development, installed path `~/.claude/code-review/prompts/triage/` at runtime. Engine accepts a `prompts_root` parameter with installed-path default.

Done when: manifest covers all domains; prompts load without touching existing review prompt directories.

**1.2 — Create `scripts/domain_triage.py`**

File: `scripts/domain_triage.py` (new)

Types:
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
    confidence: float    # 0.0–1.0
    reason: str

@dataclass
class TriageResult:
    mode: Literal["aggressive", "conservative", "full"]
    agent: Literal["claude", "codex", "none"]
    model: str
    review_type: Literal["pr", "design", "plan"]
    verdicts: list[DomainVerdict]
    dispatched_domains: list[str]
    skipped_domains: list[str]
    duration_s: float
    error: str | None
    input_strategy: Literal["full", "summary"]
    content_hash: str        # SHA-256 of original input

def triage_domains(
    content: str,
    review_type: Literal["pr", "design", "plan"],
    domains: dict[str, DomainMeta],
    mode: Literal["aggressive", "conservative", "full"] = "aggressive",
    agent: Literal["claude", "codex"] = "claude",
    disabled_domains: list[str] | None = None,
    conservative_threshold: float = 0.8,
    timeout: int = 45,              # LLM inference timeout — 45s allows for large prompts
    prompts_root: str | None = None,  # default: ~/.claude/code-review/prompts/triage/
) -> TriageResult:
```

Implementation flow:
1. Validate `mode` and `agent` — raise `ValueError` on invalid
2. Compute `content_hash = hashlib.sha256(content.encode()).hexdigest()`
3. Full-mode short-circuit: return all domains, no LLM call, `agent="none"`, `model="none"`
4. Remove `disabled_domains` from candidate set (engine owns filtering)
5. Summarize large inputs (>120K chars): PR diffs → per-file stats from `diff --git` boundaries + first 50 lines per file (cap 20 files, sorted by change size descending); documents → headings + first paragraph per section
6. Load prompt template, inject domain catalogue from `domains.json` manifest
7. Wrap content in `<triage-input type="diff|document">` delimiters
8. Dispatch to agent CLI via `subprocess.run(timeout=timeout)`. Use `build_claude_cmd()` from `claude_utils` for Claude, Codex pattern from `codex_utils`. Environment via `make_clean_env()`.
9. On `TimeoutExpired` or non-zero exit: retry once after 2s, then fall back to full mode
10. Parse JSON response (handle raw JSON, markdown-fenced JSON, double-encoded strings — reuse pattern from `_parse_plan_findings`)
11. Validate response: missing domains → relevant (fail-open); unknown domains → ignored; duplicates → keep first; confidence → clamp [0, 1]
12. Apply mode logic: aggressive = explicit yes needed; conservative = confident no needed (threshold from config)
13. On any failure after retry: return full-mode fallback result with `error` set. Save raw output to `~/.claude/code-review/history/triage-errors/` (0o600, rotate max 50, 7-day TTL)

Done when: `triage_domains(content, "pr", domains, mode="full")` returns all domains with no subprocess calls; `agent="gemini"` raises `ValueError`; all unit tests pass.

**1.2a — Domain slug alignment check**

After creating `domains.json` and before writing tests, verify that manifest keys match what the dispatch scripts discover:
```bash
scripts/.venv/bin/python3 -c "
import sys, json; sys.path.insert(0, 'scripts')
from multi_review import _discover_domains, GLOBAL_PROMPTS_DIR
from plan_review_dispatch import _discover_plan_domains
manifest = json.load(open('global/prompts/triage/domains.json'))
pr_domains = set(_discover_domains().keys())
plan_domains = set(_discover_plan_domains().keys())
design_prompts = str(GLOBAL_PROMPTS_DIR).replace('prompts', 'prompts/design-review')
# Compare and report mismatches
for rtype, discovered in [('pr-review', pr_domains), ('plan-review', plan_domains)]:
    manifest_keys = set(manifest.get(rtype, {}).keys())
    missing = discovered - manifest_keys
    extra = manifest_keys - discovered
    if missing: print(f'WARNING: {rtype} missing from manifest: {missing}')
    if extra: print(f'WARNING: {rtype} extra in manifest: {extra}')
    if not missing and not extra: print(f'{rtype}: OK ({len(discovered)} domains)')
"
```

This check must pass before Phase 1.4 tests are written.

**1.3 — Create `scripts/triage_tui.py`**

File: `scripts/triage_tui.py` (new)

Pure rendering module, no business logic. The orchestrator calls TUI functions.

Features:
- `TUIConfig` dataclass: `color`, `emoji`, `plain` flags
- Auto-detect `NO_COLOR` env var and non-TTY (`sys.stdout.isatty()`)
- `--plain` mode: no ANSI, no emojis, no box-drawing. Replace emojis with `[OK]`, `[SKIP]`, `[FAIL]`, `[RUN]`. Replace `╔═╗` with `===`.
- Functions: `render_banner()`, `render_triage_section()`, `render_dispatch_section()`, `render_summary_section()`, `render_insights_section()`
- Color scheme per design spec (green PR, magenta design, blue plan, etc.)

Done when: output matches the design TUI mockup; `NO_COLOR=1` produces zero ANSI sequences; `--plain` produces zero emojis/box-drawing.

**1.4 — Unit tests**

Files: `scripts/test_domain_triage.py` (new), `scripts/test_triage_tui.py` (new)

**Triage engine tests (17):**

| Test | Assert |
|------|--------|
| `test_full_mode_skips_llm` | No subprocess calls, all domains returned |
| `test_aggressive_filters_irrelevant` | Only `relevant: true` in `dispatched_domains` |
| `test_conservative_keeps_low_confidence` | `relevant: false, confidence < 0.8` kept |
| `test_conservative_threshold_configurable` | Custom threshold respected |
| `test_missing_verdicts_fail_open` | Omitted domains treated as relevant |
| `test_duplicate_verdicts_first_wins` | First occurrence kept |
| `test_confidence_clamped` | <0 → 0, >1 → 1 |
| `test_unknown_domains_ignored` | Not in candidate set → dropped |
| `test_disabled_domains_excluded` | Static exclusions applied |
| `test_zero_domains_exits_clean` | Empty dispatched_domains is valid |
| `test_invalid_mode_raises` | `ValueError` on `mode="random"` |
| `test_invalid_agent_raises` | `ValueError` on `agent="gemini"` |
| `test_parse_valid_json` | Correct DomainVerdict list |
| `test_parse_json_with_prose_wrapper` | JSON in markdown fences parsed |
| `test_parse_malformed_json_fallback` | Fallback to full mode |
| `test_content_hash_computed` | SHA-256 matches |
| `test_large_input_summarized` | `input_strategy: "summary"` |

**TUI tests (4):**

| Test | Assert |
|------|--------|
| `test_no_color_strips_ansi` | `NO_COLOR=1` → no ANSI in output |
| `test_non_tty_strips_ansi` | Mock `isatty()=False` → no ANSI |
| `test_plain_mode_strips_emojis` | `--plain` → no emoji chars |
| `test_plain_mode_ascii_borders` | `--plain` → no box-drawing chars |

### Risks

- **Prompt-local path vs installed path:** Engine defaults to installed path (`~/.claude/code-review/prompts/triage/`), but tests must work before install. Accept `prompts_root` parameter with installed-path fallback.
- **Domain manifest drift:** If new review domains are added to prompt directories but not to `domains.json`, they'll get fallback descriptions but still be triaged. Add a CI check later, not blocking for V1.
- **Full-mode typing:** `TriageResult.agent` is `"none"` for full mode locally; insights payload uses the same. Keep consistent.

### Verification

```bash
cd /Users/aryeh/git/Evinced/stark-skills
scripts/.venv/bin/python3 -m pytest scripts/test_domain_triage.py scripts/test_triage_tui.py -v
scripts/.venv/bin/python3 -c "import sys; sys.path.insert(0,'scripts'); from domain_triage import triage_domains; print('import OK')"
```

### Rollback

Remove `scripts/domain_triage.py`, `scripts/triage_tui.py`, `global/prompts/triage/`. No production behavior affected.

---

## Phase 2: Dispatch Plumbing and Orchestrator

**Goal:** Add `--domains` allowlist to existing dispatch scripts. Build the orchestrator that owns triage → dispatch → TUI → insights emission.
**Dependencies:** Phase 1. Phase 0 must be deployed before this phase merges (verify with Phase 0 curl command at start of Phase 2).
**Effort:** L

### Tasks

**2.1 — Add `--domains` arg to dispatch scripts** (do this first — orchestrator depends on it)

Files:
- `scripts/multi_review.py`
- `scripts/plan_review_dispatch.py`

Steps for `multi_review.py`:
1. Add `--domains` CLI arg (comma-separated domain slugs)
2. Thread through to `review_pr()` and `review_pr_single()`: `domains_allowlist: list[str] | None = None`
3. When provided: `active_domains = domains_allowlist` (bypass discovery + disabled_domains)
4. When omitted: existing behavior unchanged
5. Confirmed chain: `main()` → `review_pr(domains_allowlist=...)` → `run_review_round(domains=active_domains)`

Steps for `plan_review_dispatch.py`:
1. Add `--domains` CLI arg
2. Thread to `dispatch_plan_review()`: `domains_allowlist: list[str] | None = None`
3. When provided: filter discovered domains to the allowlist
4. When omitted: unchanged

Add regression tests to existing `scripts/test_multi_review.py` and `scripts/test_plan_review_dispatch.py`.

**2.2 — Add `triage` config block and deep-merge support**

Files:
- `global/config.json`
- `scripts/multi_review.py` (add `"triage"` to `DEEP_MERGE_FIELDS` at line ~135)

Add to `global/config.json`:
```json
"triage": {
    "mode": "conservative",
    "agent": "claude",
    "timeout": 45,
    "conservative_confidence_threshold": 0.8,
    "insights_url": "http://localhost:7420"
},
"design_review": {
    ... existing ...,
    "triage": { "mode": "conservative" }
},
"plan_review": {
    ... add if missing ...,
    "triage": { "mode": "conservative" }
}
```

Note: initial default is `conservative` (not `aggressive`) per rollout plan. Both `design_review` and `plan_review` get explicit triage overrides so the Phase 5 global flip can be scoped per review type.

Merge semantics: per-review-type `triage` blocks deep-merge on top of global `triage`. Add `"triage"` to `DEEP_MERGE_FIELDS` in `multi_review.py`. The orchestrator performs triage config merge — dispatch scripts don't need to know about triage config.

**2.3 — Create `scripts/triage_orchestrator.py`** (depends on 2.1 and 2.2)

File: `scripts/triage_orchestrator.py` (new)

CLI arguments per design: `--type`, `--pr`, `--repo`, `--file`, `--base`, `--triage`, `--triage-agent`, `--agents`, `--disabled-domains`, `--timeout`, `--single`, `--shadow`, `--dry-run`, `--json`, `--plain`, `--no-color`.

Orchestration flow:
1. Parse args, load config (hierarchical), merge triage config
2. Resolve input: for PR type, use `git diff {base}...HEAD` (same source as dispatch scripts, not `gh pr diff`). For design/plan, `Path(file).read_text()`.
3. Discover domains for review type (import discovery functions from dispatch scripts)
4. Call `triage_domains()` — engine handles disabled_domains, mode logic, fallback
5. Render triage TUI section
6. Build dispatch command with review-type-specific mapping:
   - `pr` → `multi_review.py --pr $PR --repo $REPO [--single] --domains $DOMAINS`
   - `design` → `plan_review_dispatch.py --prompts-dir design-review --config-section design_review --file $FILE --domains $DOMAINS`
   - `plan` → `plan_review_dispatch.py --prompts-dir plan-review --file $FILE --domains $DOMAINS`
7. In `--shadow` mode: `--shadow` implies `--dry-run` (never post live PR comments). Dispatch ALL domains but annotate each finding with `triage_would_skip: bool` based on the triage verdict. Annotation requires findings to include a `domain` field (verified in pre-flight).
8. Run dispatch subprocess with execution timeout (default: 10 minutes, configurable). Capture JSON on stdout, TUI/progress on stderr. For `plan_review_dispatch.py`: pipe JSON to stdout (add `--json-only` if missing in Phase 2.1).
9. Render dispatch and summary TUI sections
10. Emit `triage_decision` event: read token from `~/.stark-insights/api-token`, POST to `{insights_url}/events` with `Authorization: Bearer $TOKEN` header. Connect timeout 2s, read timeout 3s, catch all exceptions.
11. Return structured result (for `--json`) or exit

**Shadow mode output schema** — each finding gains:
```json
{ "domain": "security", "severity": "high", "title": "...", "triage_would_skip": false }
```

**Argument pass-through:** `--agents`, `--disabled-domains`, `--timeout`, `--single`, `--base`, and `--round` are forwarded to the dispatch subprocess. The orchestrator must explicitly build the subprocess argv. `--tournament` is NOT supported in V1 — skills using `--tournament` continue to call dispatch scripts directly.

Zero-domain handling: if `dispatched_domains` is empty **and the user did not explicitly request zero domains**, fall back to full mode (dispatch all). This prevents a hallucinating triage model from silently suppressing all reviews. Log a warning. If the user explicitly passed `--domains ""`, respect it and exit 0.

JSON mode: TUI output goes to stderr, JSON to stdout. Never mix.

**2.4 — Integration and failure tests**

Files: `scripts/test_triage_orchestrator.py` (new), `scripts/test_triage_failures.py` (new)

**Orchestrator tests (7):**

| Test | Assert |
|------|--------|
| `test_pr_review_end_to_end` | Mock gh + dispatch → exits 0, TUI has all sections |
| `test_design_review_end_to_end` | Real file + mock dispatch → exits 0 |
| `test_plan_review_end_to_end` | Real file + mock dispatch → exits 0 |
| `test_shadow_mode_dispatches_all` | Triage skips 5 domains, dispatch still gets all |
| `test_dry_run_triage_only` | Dispatch subprocess never called |
| `test_json_output_schema` | Valid JSON, has `triage`, `dispatch`, `findings`, `summary` keys |
| `test_domains_arg_passthrough` | Dispatch subprocess argv includes `--domains architecture,security` |

**Failure tests (5):**

| Test | Assert |
|------|--------|
| `test_timeout_retries_then_fallback` | Retried once, all domains dispatched |
| `test_parse_error_saves_debug_file` | File in `triage-errors/`, 0o600 permissions |
| `test_agent_unavailable_fallback` | `FileNotFoundError` → full mode |
| `test_insights_unavailable_continues` | `requests.post` raises → exits 0, review completes |
| `test_orchestrator_crash_skill_fallback` | (manual verification via skill SKILL.md) |

### Risks

- **JSON stdout contamination:** Dispatch scripts may print to stdout. Use `--json-only` flag (confirmed existing in `multi_review.py`). Capture stderr separately.
- **Double filtering:** Only the engine removes `disabled_domains`. Dispatchers receive the final domain list via `--domains` — they should not re-apply `disabled_domains`.
- **Config merge ownership:** `plan_review_dispatch.py` uses `_load_plan_review_config()` which doesn't know about triage. The orchestrator owns triage config merge.

### Verification

```bash
# Regression tests
scripts/.venv/bin/python3 -m pytest scripts/test_multi_review.py scripts/test_plan_review_dispatch.py -v

# New tests
scripts/.venv/bin/python3 -m pytest scripts/test_triage_orchestrator.py scripts/test_triage_failures.py -v

# Config valid
python3 -m json.tool global/config.json > /dev/null && echo "JSON valid"

# Smoke tests
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --help
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type design \
  --file docs/superpowers/specs/2026-04-04-domain-triage-design.md \
  --triage conservative --dry-run
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type design \
  --file docs/superpowers/specs/2026-04-04-domain-triage-design.md \
  --triage full --dry-run
```

### Rollback

Set `triage.mode` to `"full"` everywhere. Dispatch scripts still work without `--domains`. Revert orchestrator if needed.

---

## Phase 3: Skill Cutover

**Goal:** Route all four review skills through the orchestrator with explicit fallback to direct dispatch.
**Dependencies:** Phase 2
**Effort:** M

### Tasks

**3.1 — Update SKILL.md files**

Files:
- `skill/stark-review/SKILL.md`
- `skill/stark-team-review/SKILL.md`
- `skill/stark-review-design/SKILL.md`
- `skill/stark-review-plan/SKILL.md`

Pattern for each skill: replace direct dispatch invocation with orchestrator call. Use executable fallback (not a comment):

```bash
# Primary: route through triage orchestrator with automatic fallback
$PYTHON $SCRIPTS/triage_orchestrator.py --type pr --pr $PR_NUMBER --repo $REPO --single \
  || $PYTHON $SCRIPTS/multi_review.py --pr $PR_NUMBER --repo $REPO
```

The `||` ensures that if the orchestrator exits non-zero (crash, import error, arg parse failure), the direct dispatch runs instead.

Mapping:
| Skill | `--type` | `--single` | Old script | Notes |
|-------|----------|-----------|------------|-------|
| stark-review | pr | yes | multi_review.py (single mode) | |
| stark-team-review | pr | no | multi_review.py | |
| stark-review-design | design | no | plan_review_dispatch.py --prompts-dir design-review | `--tournament` stays on direct dispatch for V1 |
| stark-review-plan | plan | no | plan_review_dispatch.py --prompts-dir plan-review | `--tournament` stays on direct dispatch for V1 |

**Contract preservation:** The orchestrator's `--json` output must be wire-compatible with what the skill currently parses from the dispatch scripts. If the skill reads `results[].findings[]`, the orchestrator's JSON must include the same structure. `--dry-run` must mean "dispatch but don't post" (not "triage only") when called from a skill context. `--round` must pass through to the dispatch script.

**3.2 — Update eval/golden artifacts (same commit as 3.1)**

First, discover which files need updating:
```bash
find skill/ tests/ -name '*.json' | xargs grep -l 'multi_review\|plan_review_dispatch' 2>/dev/null
```

All SKILL.md changes and eval/golden updates must be in **one atomic commit** to avoid CI failure windows.

Done when: evals and golden snapshots reference orchestrator commands.

**3.3 — Run install.sh**

After merge, verify symlinks are correct:
```bash
./install.sh
./install.sh --status
ls -la ~/.claude/code-review/prompts/triage/  # should show manifest + prompts
ls -la ~/.claude/code-review/scripts/triage_orchestrator.py  # should be symlinked
```

### Risks

- **Skill docs drift:** Update eval/golden in same commit as SKILL.md changes.
- **Install surface:** `install.sh` already symlinks entire `global/prompts` and `scripts` — no new symlink rules needed. Validate with `--status`.

### Verification

```bash
# Golden file tests
scripts/.venv/bin/python3 -m pytest scripts/test_golden_files.py -v 2>/dev/null || echo "No golden tests"

# Dry-run each skill path
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type pr --pr 1 --repo GetEvinced/stark-skills --dry-run --single --json
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type pr --pr 1 --repo GetEvinced/stark-skills --dry-run --json
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type design --file docs/superpowers/specs/2026-04-04-domain-triage-design.md --dry-run
scripts/.venv/bin/python3 scripts/triage_orchestrator.py --type plan --file docs/superpowers/specs/2026-04-04-domain-triage-design.md --dry-run
```

### Rollback

Restore SKILL.md files to direct-dispatch commands. Revert eval/golden. Rerun `install.sh`.

---

## Phase 4: Shadow Validation

**Goal:** Prove triage is safe before promoting to aggressive default.
**Dependencies:** Phase 3 + minimum 5-day bake period. During the bake period, run 2-3 shadow PRs manually and inspect `--json` output to confirm triage is producing sane verdicts.
**Effort:** M

### Tasks

**4.0 — Bake period verification (5 days after Phase 3 merge)**

Run manual spot-checks during the bake period:
```bash
# Spot-check: does triage produce reasonable verdicts?
scripts/.venv/bin/python3 scripts/triage_orchestrator.py \
  --type pr --pr $RECENT_PR --repo GetEvinced/$REPO --shadow --json \
  2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Domains: {len(d[\"triage\"][\"dispatched_domains\"])}/{len(d[\"triage\"][\"dispatched_domains\"])+len(d[\"triage\"][\"skipped_domains\"])} dispatched, triage: {d[\"triage\"][\"duration_s\"]:.1f}s')"
```

If anything looks off, investigate before proceeding with 4.1.

**4.1 — Run shadow validation across all review types**

Pre-identify the sample from historical data (don't wait for new PRs):

**PR reviews (20 PRs):**
Select across 3+ repos with diverse change profiles (small <50 lines, medium 50-500, large 500+; frontend, backend, config-only, docs-only).

```bash
mkdir -p /tmp/shadow-validation
for PR in $PR_LIST; do
  scripts/.venv/bin/python3 scripts/triage_orchestrator.py \
    --type pr --pr $PR --repo $REPO --shadow --json \
    2>/tmp/shadow-validation/pr-$REPO-$PR-stderr.log \
    > /tmp/shadow-validation/pr-$REPO-$PR.json
done
```

Note: `--shadow` implies `--dry-run` — no live PR comments posted.

**Design reviews (5 design docs):**
```bash
for DOC in $DESIGN_DOCS; do
  scripts/.venv/bin/python3 scripts/triage_orchestrator.py \
    --type design --file "$DOC" --shadow --json \
    2>/tmp/shadow-validation/design-$(basename $DOC)-stderr.log \
    > /tmp/shadow-validation/design-$(basename $DOC).json
done
```

**Plan reviews (5 plan docs):**
```bash
for DOC in $PLAN_DOCS; do
  scripts/.venv/bin/python3 scripts/triage_orchestrator.py \
    --type plan --file "$DOC" --shadow --json \
    2>/tmp/shadow-validation/plan-$(basename $DOC)-stderr.log \
    > /tmp/shadow-validation/plan-$(basename $DOC).json
done
```

**4.2 — Analyze results with `scripts/analyze_shadow.py`**

New script: `scripts/analyze_shadow.py` reads all shadow JSON files and computes gate metrics.

```bash
scripts/.venv/bin/python3 scripts/analyze_shadow.py /tmp/shadow-validation/ \
  --output docs/triage-shadow-validation.md
```

Output: machine-readable pass/fail plus human-readable `docs/triage-shadow-validation.md`.

Gate criteria — **all must pass for each review type separately:**
- Average skip rate ≥ 40%
- Zero missed critical/high findings (a "miss" = finding with severity critical or high from a `triage_would_skip: true` domain)
- p95 triage latency < 10s

**If gate partially fails** (e.g., PR passes but design fails): promote `aggressive` only for the passing review type. Keep `conservative` for the failing type. Investigate and re-run.

**4.3 — Commit validation artifact**

```bash
git add docs/triage-shadow-validation.md scripts/analyze_shadow.py
git commit -m "docs: triage shadow validation results"
```

Done when: gate artifact committed with passing results for all review types.

### Risks

- **Weak sample:** Require minimum 3 repos, mix of change sizes, include at least 2 docs-only and 2 config-only PRs.
- **False confidence from retries:** Measure `triage_duration_s` from orchestrator output, not wall-clock.
- **Shadow artifacts naming collision:** Use `{type}-{repo}-{pr_or_filename}.json` to avoid overwrites.
- **Insights down during shadow:** Shadow results are captured in local JSON files, not dependent on insights availability.

### Rollback

Keep `conservative` as default. Shadow validation can be re-run at any time.

---

## Phase 5: Aggressive Default

**Goal:** Promote to aggressive mode via canary, then globally.
**Dependencies:** Phase 4 gate passed. Go/no-go authority: Aryeh.
**Effort:** S

### Tasks

**5.1 — Canary: enable aggressive for one repo**

Pick one high-traffic repo. Add to its `.code-review/config.json`:
```json
{ "triage": { "mode": "aggressive" } }
```

Run normally for 3-5 days. Monitor via stark-insights:
- Triage fallback rate (error field non-null) — should be < 5%
- Skip rate — should match shadow validation expectations
- No user-reported missed reviews

**5.2 — Promote globally (after canary passes)**

File: `global/config.json`

Per-review-type promotion (only promote review types that passed the gate):
```json
"triage": {
    "mode": "aggressive",
    ...
}
```

This is a one-line config change. No code changes bundled in this commit.

**5.3 — Commit and deploy**

```bash
git add global/config.json
git commit -m "config: promote triage default from conservative to aggressive

Shadow validation passed:
- Skip rate: X% (>40% gate)
- Missed critical/high: 0
- p95 triage latency: Xs (<10s gate)
Canary: $REPO for N days, no issues"
./install.sh
```

### Rollback

Change `mode` back to `"conservative"` or `"full"` in `global/config.json`. Per-repo override: add `"triage": {"mode": "full"}` to `.code-review/config.json`.

**Rollback triggers:**
- Triage fallback rate > 15% over 24 hours
- Any user report of a missed critical/high finding
- Triage latency p95 > 15s sustained for 1 hour

---

## 3. Integration Points

| Interface | Contract | Breakage Signal |
|-----------|----------|----------------|
| Engine → dispatch scripts | Domain slugs from triage must match keys from `_discover_domains()` | Domains silently skipped or over-dispatched |
| Orchestrator → config | `"triage"` in `DEEP_MERGE_FIELDS` | Repo overrides replace entire triage block, dropping defaults |
| Orchestrator → insights | Payload must match `stark-insights/models.py` schema | Events rejected (but review continues) |
| Skills → orchestrator | SKILL.md commands and eval snapshots must switch together | Users bypass triage, rollout metrics meaningless |
| Install → runtime | `install.sh` symlinks cover `global/prompts/triage/` and new scripts | Skills can't find prompts at installed path |

## 4. Testing Strategy

**Unit tests** (Phase 1):
- `scripts/test_domain_triage.py` — 17 tests: parser, fail-open, summarization, hashing, retry/fallback, retention
- `scripts/test_triage_tui.py` — 4 tests: ANSI stripping, plain mode, JSON-safe output

**Dispatch regression** (Phase 2):
- Extend `scripts/test_multi_review.py` and `scripts/test_plan_review_dispatch.py` for `--domains`

**Integration tests** (Phase 2):
- `scripts/test_triage_orchestrator.py` — 7 tests: end-to-end PR/design/plan, shadow, dry-run, JSON schema, passthrough
- `scripts/test_triage_failures.py` — 5 tests: timeout retry, parse error, agent unavailable, insights timeout, skill fallback

**E2E validation** (Phase 4):
- 20 real PRs + 5 design docs + 5 plan docs across 3+ repos with `--shadow --json`
- `scripts/analyze_shadow.py` computes gate metrics from shadow JSON files
- Gate artifact committed as `docs/triage-shadow-validation.md`

## 5. Rollback Plan

| Phase | Rollback | Trigger |
|-------|----------|---------|
| Phase 0 | Revert stark-insights schema, redeploy | Schema validation failures in insight tests |
| Phase 1 | Delete new files. No production impact (dead code) | Unit test failures |
| Phase 2 | Set `triage.mode: "full"` globally. Dispatch scripts work without `--domains` | Integration test failures or dispatch regressions |
| Phase 3 | Restore SKILL.md to direct-dispatch, revert eval/golden, rerun install.sh | >5% of skill invocations fail within 30 min of deploy |
| Phase 4 | Keep `conservative` or set `"full"` | Gate criteria not met |
| Phase 5 | Change config back from `aggressive` to `conservative` — one-line diff | Fallback rate >15% / 24h, any missed critical/high, p95 triage >15s / 1h |

**Execution order for Phase 3 rollback:** (1) revert SKILL.md + golden files, (2) commit, (3) rerun `install.sh`. Do not run install.sh between steps — that creates an inconsistency window.
