# Prompt Changelog

Tracks improvements to review prompts based on stark-review assessments.

## 2026-03-23 — Fix Gemini CLI dispatch + noise reduction

**Source:** PR #56 in GetEvinced/infra-ai-platform
**Assessment:** All 6 Gemini agents failed with cli_error — Vertex AI auth needed GOOGLE_CLOUD_LOCATION=global. Architecture domain flagged deliberate zero-dep trade-offs and editor configs. Test-coverage domain flagged scripts with built-in --check mode.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `scripts/multi_review.py` | Added `GOOGLE_CLOUD_LOCATION=global` to Gemini subprocess env | Vertex AI defaults to us-central1 where model isn't available |
| `scripts/multi_review.py` | Added `_get_gemini_api_key()` + fallback retry with API key on Vertex AI failure | Resilience — fallback to API key auth from macOS Keychain |
| `scripts/plan_review_dispatch.py` | Same two fixes as multi_review.py | Same Gemini dispatch pattern |
| `global/prompts/*/01-architecture.md` | Added "Do NOT Flag" for zero-dep regex parsing and editor configs | False positives on deliberate design trade-offs |
| `global/prompts/*/06-test-coverage.md` | Added rule: scripts with `--check`/`--verify` modes have implicit coverage | False positive on generator with built-in validation |

### Validation
- [x] Python compiles (both orchestrators)
- [x] Gemini API key stored in macOS Keychain (`GEMINI_API_KEY`)
- [x] Prompt markdown structure preserved

---

## 2026-03-20 — Noise reduction: test-coverage, type-safety, correctness

**Source:** PR #18 in GetEvinced/infra-sentinel (4 review rounds), plus assessments from 6 other repos
**Assessment:** 23% signal-to-noise ratio. Claude test-coverage generated 9-10 "add tests" findings per round (all noise). Codex type-safety flagged missing .d.ts on plain JS 5 consecutive times. Codex correctness flagged Terraform moved blocks on greenfield 5 consecutive times.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/claude/06-test-coverage.md` | Added "Critical Rules" section: don't suggest tests without concrete bug risk; classify runtime errors as correctness bugs | Claude framed actual bugs as "no tests" and generated pure-noise "add tests" findings every round |
| `global/prompts/codex/04-type-safety.md` | Added "Do NOT flag" for .d.ts on plain JS packages | Codex flagged missing .d.ts on internal JS library with no TS consumers — 5 consecutive false positives |
| `global/prompts/codex/03-correctness.md` | Added "Do NOT flag" for Terraform moved blocks on greenfield projects | Codex flagged state migration on a brand new repo with no existing Terraform state — 5 consecutive false positives |

### Also Applied (skill change)

| File | Change | Reason |
|------|--------|--------|
| `skill/stark-review/SKILL.md` | Added step 1.5: push local changes before creating worktree | Review agents were diffing against stale remote HEAD, missing local fixes |

### Validation
- [x] Prompt syntax OK
- [x] No Python changes
- [x] No config changes

## 2026-03-17 — Gemini diff scoping fix

**Source:** PR #89 in GetEvinced/infra-pulse
**Assessment:** Gemini reviewed entire codebase instead of PR diff — all 12 findings targeted unchanged files. Claude and Codex correctly scoped to diff (0 findings, accurate).

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/gemini/agent.md` | Replaced `git diff main...HEAD` with `git diff <base>...HEAD`; added "ONLY review files in the diff" constraint | Agent was using hardcoded `main` instead of the actual base ref; no scope constraint existed |
| `global/prompts/gemini/01-architecture.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `global/prompts/gemini/02-accessibility.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `global/prompts/gemini/03-correctness.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `global/prompts/gemini/04-type-safety.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `global/prompts/gemini/05-security.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `global/prompts/gemini/06-test-coverage.md` | `main` → `<base>` | Domain prompt had same hardcoded ref |
| `scripts/multi_review.py` | Gemini branch in `_run_subagent()` now prepends `git diff {base}...HEAD` instruction (same pattern as Claude) | Orchestrator wasn't injecting `base` into Gemini's prompt |

### Validation
- [x] Prompt syntax OK
- [x] Python compiles
- [x] No config changes needed

## 2026-03-23 — Plan review noise reduction

**Source:** infra-ai-platform plan reviews (registry spec: 5.7% S/N, docs rebuild: 3.9% S/N)
**Assessment:** ~100 findings/round noise floor driven by scope false positives, security misunderstanding of terraform_remote_state, and cross-domain duplication

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `*/05-scope.md` (all 3 agents) | Added "Before You Begin" section: check Non-Goals, respect explicit scope, understand roadmaps | Agents repeatedly flagged items listed in Non-Goals as scope creep |
| `*/03-security.md` (all 3 agents) | Added "Infrastructure-as-Code Context" for remote_state, labels, empty maps | Codex flagged terraform_remote_state outputs as public API exposure |
| `*/agent.md` (all 3 agents) | Added "Deduplication" instruction: don't repeat findings across domains | Same agent raised identical finding in 3+ domains (~30/round) |
| `scripts/plan_review_dispatch.py` | Added post-dispatch cross-domain dedup by (section, title, agent) | Backup dedup in case agent-level instruction isn't followed |

### Expected Impact
- Scope noise: ~40% reduction (Non-Goals and explicit scope findings eliminated)
- Security noise: ~20% reduction (remote_state and label findings eliminated)
- Cross-domain duplication: ~30% reduction (dedup instruction + orchestrator filter)
- Target: noise floor drops from ~100/round to ~40-50/round
