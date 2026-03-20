# Prompt Changelog

Tracks improvements to review prompts based on stark-review assessments.

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
