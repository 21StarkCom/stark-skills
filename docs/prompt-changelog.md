# Prompt Changelog

Tracks improvements to review prompts based on stark-review assessments.

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
