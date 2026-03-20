# Review Retrospective — rename-project Skill Design

**Spec:** `docs/superpowers/specs/2026-03-19-rename-project-design.md`
**Date:** 2026-03-19
**Review rounds:** 3 fix rounds + 1 partial final round (spec), 1 fix round (plan)

## Design Evolution

What changed through the review process and why.

| Round | Change | Trigger |
|-------|--------|---------|
| 1→2 | Major structural rewrite: input validation, resumable execution, step reordering, bare-name replacement, cross-repo scoping, verification, CI/CD scanning, auto-commit, concrete API invocation, dynamic symlink detection, case-only rename | Agents identified 4 critical gaps and 45 high-severity findings in initial draft |
| 2→3 | Precision refinements: custom lookarounds replacing \b, .github/workflows/ exclusion, specific-file git adds, resume point correction, sibling cleanliness prereq, install.sh prereq check, absolute path symlink matching | Agents found false-match risk in hyphenated names and unsafe commit patterns |
| 3→final | Platform portability: GH_TOKEN single-line export, python3 over readlink -f, verification exclusion alignment, case-only rename local existence skip | Agents identified macOS-specific failures and false positive verification output |
| plan-1 | Implementation specifics: REPO_ROOT anchoring, resume table naming, repo ID for idempotency, sed→Perl, broader symlink scan, exact path matching, array quoting, skill path exclusions | Plan review found 9 implementation gaps not visible at spec level |

## Decisions Defended

Design choices that were challenged by reviewers and held.

| Decision | Challenge | Rationale |
|----------|-----------|-----------|
| No rollback runbook | All agents across all rounds flagged missing rollback mechanism | Rare operation; git history + resume logic + GitHub API rename-back is sufficient |
| No checkpoint/journal file | Agents wanted state manifest tracking step completion | SKILL.md is a prompt, not a program; observable state detection is simpler and sufficient |
| Sibling auto-commit default | All agents flagged auto-committing to sibling repos as risky | User explicitly requested this as the skill's core purpose |
| No exit-code contract | Agents wanted machine-readable exit codes | Skill is invoked interactively by Claude, not by automation |

## Agent Performance

| Agent | Domain | Signal | Notes |
|-------|--------|--------|-------|
| Codex | all | Consistent timeouts (3/4 rounds) | CLI timeout/retry config needs investigation |
| Gemini | scope | parse_error (3/4 rounds) | Prompt file `06-scope.md` likely needs reformatting |
| All | operability | Over-emphasis on enterprise rollback | Prompts calibrated for production services, not dev tools |
| Codex | security | Over-focus on secrets/audit trails | Security prompt needs dev tooling context calibration |
| Codex | feasibility | Flags superpowers as "not available" | Doesn't understand Claude Code plugin architecture |

## Prompt Improvement Candidates

Signals that should feed into `stark-review-improvement`.

| Signal | Level | Target |
|--------|-------|--------|
| Codex timeouts (3/4 rounds) | Global | Codex CLI timeout/retry configuration |
| Gemini scope parse_error (3/4 rounds) | Global | `global/prompts/plan-review/gemini/06-scope.md` |
| Enterprise rollback fixation across all agents | Global | Reduce operability prompts' emphasis on enterprise patterns |
| Codex security miscalibrated for dev tooling | Global | `global/prompts/plan-review/codex/04-security.md` |
| Codex feasibility doesn't understand plugins | Global | `global/prompts/plan-review/codex/02-feasibility.md` |
