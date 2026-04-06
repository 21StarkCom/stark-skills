# Prompt Changelog

Tracks improvements to review prompts based on stark-team-review assessments.

## 2026-04-06 — ADR hallucination guard, design-doc type calibration

**Source:** PR #264 in GetEvinced/stark-skills
**Prompts dir:** default (PR code review)
**Assessment:** 53-55% signal-to-noise across 2 rounds; Codex fabricated ADR-0014/-0015/-0017 references (10 FPs); Codex type-safety flagged spec pseudo-code types as missing enums (5 noise)

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/codex/agent.md` | Added VERIFY BEFORE CITING rule to ADR-Aware Review section | Codex fabricated ADR numbers it never read from the filesystem (10 false positives across 2 rounds, 4 domains) |
| `global/prompts/codex/07-spec-conformance.md` | Added external document verification rule to Critical rules | Spec-conformance domain cited non-existent ADRs (4 FPs) — reinforces agent-level guard |
| `global/prompts/codex/04-type-safety.md` | Added design doc exclusion to Do NOT flag section | Codex flagged `str`/`dict` in spec pseudo-code as missing enums/typed payloads (5 noise across 2 rounds) |

### Validation
- [x] Prompt syntax OK
- [x] Python compiles
- [x] Config valid JSON

---

## 2026-04-05 — Cross-agent dedup, spec context injection, generator protocol, severity overrides

**Source:** PR #179 in GetEvinced/stark-data-core
**Prompts dir:** default (PR code review)
**Assessment:** 61% signal-to-noise; 5 agent×domain pairs flagged same dual-cache issue; 5 noise items would have been filtered with spec context; agents missed critical Strawberry generator protocol bug

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `scripts/multi_review.py` | Two-pass dedup: exact key grouping + fuzzy proximity merge (±5 lines, Jaccard title overlap ≥0.5) | 5 agent×domain pairs flagged identical `stats.py` dual-cache issue |
| `scripts/multi_review.py` + `global/config.json` | Added `context_files` config field and `resolve_context_files()` — auto-discovers spec/design docs via glob patterns | 5 noise items would have been filtered if agents had the spec document |
| `{claude,codex,gemini}/03-correctness.md` | Added "Framework Generator Protocols" section — Strawberry `contextlib.contextmanager` yield/send caveat | No agent caught `result = yield` returns None inside `@contextmanager` |
| `org/evinced/config.json` | Added `title_patterns` under `security` severity overrides for "unbounded memory" and "global state singleton" | Security prompts flagged spec-approved architecture as high severity |
| `scripts/multi_review.py` | Extended `apply_severity_overrides()` to support `title_patterns` substring matching | Enable org-level severity caps for known spec-addressed patterns |

### Validation
- [x] Prompt syntax OK
- [x] Python compiles
- [x] Config valid JSON

---

## 2026-04-04 — DB enum coercion FP + existing-test detection FP

**Source:** PR #141 in GetEvinced/stark-data-core
**Prompts dir:** default (PR code review)
**Assessment:** 33% signal-to-noise; 3 false positives on enum construction from DB enum values flagged as "unsafe coercion"; 1 false positive flagging missing test that already existed

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `{claude,codex,gemini}/03-correctness.md` | Added bullet: DB enum columns guarantee valid values, don't flag Python enum construction from them | 3× FP on `TeamTypeEnum(info.type)` where source is a PG enum column |
| `{claude,codex,gemini}/06-test-coverage.md` | Added bullet: verify no existing test covers the symbol before reporting | 1× FP flagging missing test for `TeamTypeEnum` when `test_team_type_enum_values` already existed |

### Validation
- [x] Prompt syntax OK
- [x] No Python logic changes
- [x] No config changes

---

## 2026-04-03 — Codex noise reduction (test-coverage, architecture, ui-design) + claude a11y scope calibration

**Source:** PR #194 in GetEvinced/design-system-core (widget grid review round 2)
**Prompts dir:** default (PR code review)
**Assessment:** 27% signal-to-noise; codex test-coverage, architecture, and ui-design-conformance all 100% noise; claude accessibility had scope-exceeding enhancement findings

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `codex/06-test-coverage.md` | Require concrete "this will break when..." scenario for every test gap | All 4 codex test findings were generic suggestions with no break scenario |
| `codex/08-ui-design-conformance.md` | Check 3-5 nearby files for established patterns before flagging | Both findings were false positives — flagged Tailwind usage that's the project convention |
| `codex/01-architecture.md` | In fix PRs, only flag architecture issues with correctness/regression risk | Both findings suggested refactoring for single-consumer patterns in a targeted fix PR |
| `claude/02-accessibility.md` | Added scope calibration: enhancements beyond PR scope tagged `[enhancement]`, severity -1 | 1/3 claude a11y findings was valid but scope-exceeding |

### Validation
- [x] Prompt syntax OK
- [x] No Python changes
- [x] No config changes

---

## 2026-04-03 — Cross-domain dedup + codex ui-design-conformance scope fix

**Source:** PR #178 in GetEvinced/stark-skills (33 codex findings, 36% cross-domain duplicates)
**Prompts dir:** default (PR code review)
**Assessment:** Codex ui-design-conformance produced 7 findings on a pure backend PR (security bugs, correctness bugs — zero UI issues). 12 of 33 findings were duplicated across domains (unsigned webhook in 3 domains, disabled_paths in 4 domains, etc.).

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/codex/08-ui-design-conformance.md` | Rewrote to match Claude's stronger version — bolded scope rules, explicit "no UI = empty array and stop", structured checklist | 7 off-scope findings on pure backend PR; weak scope instruction was ignored |
| `global/prompts/codex/agent.md` | Added "Cross-Domain Dedup" section — defer to specialized domain reviewer | 36% of findings duplicated across domains |
| `global/prompts/claude/agent.md` | Added same "Cross-Domain Dedup" section | Consistency across agents; prevents future duplication |

### Validation
- [x] Prompt syntax OK
- [x] Tests pass (554 passed)
- [x] Config valid JSON

## 2026-04-03 — Fix codex dispatch cwd, add scope calibration for small PRs

**Source:** PR #135 in GetEvinced/stark-data-core
**Prompts dir:** default (PR code review)
**Assessment:** All 9 codex dispatches failed with `cli_error` (missing cwd → "not inside a trusted directory"). 4 claude domains (architecture, type-safety, spec-conformance, regression-prevention) took 800-990s each with zero findings on a 489-line CRUD API PR.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `scripts/multi_review.py` | Pass `cwd=git_root` in `--pr` path | Codex CLI requires git repo cwd; was inheriting parent process cwd (often non-repo) |
| `global/prompts/claude/01-architecture.md` | Add Scope Calibration section | 813s with zero findings on simple CRUD PR |
| `global/prompts/claude/04-type-safety.md` | Add Scope Calibration section + Python early-exit | 945s with zero findings; TypeScript-focused domain wasted on Python PR |
| `global/prompts/claude/07-spec-conformance.md` | Add Scope Calibration section | 793s with zero findings on PR that met all criteria |
| `global/prompts/claude/09-regression-prevention.md` | Add Scope Calibration section (new-files-only early-exit) | 966s with zero findings; PR only added files, no regressions possible |

### Validation
- [x] Prompt syntax OK
- [x] Python compiles
- [x] Config valid JSON

## 2026-04-01 — Batch: scope enforcement, self-refuting findings, infra-repo awareness

**Source:** 4 unapplied assessments — infra-ai-platform #4, infra-sentinel #20, infra-sentinel #23, infra-pulse #162
**Prompts dir:** default (PR code review)
**Assessment:** Recurring patterns: agents flag pre-existing code (scope leak), codex requests CI for declarative config repos, claude produces self-refuting findings, inconsistent scope enforcement across agents.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/claude/agent.md` | Added CRITICAL SCOPE RULE (only review files in diff, pre-existing issues only if interacting with new code) | Claude lacked scope enforcement that Gemini already had |
| `global/prompts/codex/agent.md` | Added same CRITICAL SCOPE RULE | Codex flagging pre-existing conditions in infra-sentinel #20, infra-ai-platform #4 |
| `global/prompts/claude/01-architecture.md` | Added "Do NOT Flag" rule for dependency-update PRs | Noise on version bumps in infra-sentinel #20 |
| `global/prompts/codex/05-security.md` | Added "Pre-existing vs Introduced" rule | Codex flagging pre-existing security patterns not changed by PR |
| `global/prompts/codex/06-test-coverage.md` | Added infra/config repo awareness (skip test demands for .tf/.yml/.alloy) | Impractical CI fixture requests for Terraform/Grafana/Alloy config |
| `global/prompts/claude/03-correctness.md` | Added self-consistency rule (don't report findings your own analysis refutes) | Claude self-refuting findings in infra-pulse #162 |
| `global/prompts/gemini/05-security.md` | Strengthened scope rule: pre-existing patterns out of scope | Gemini reviewing pre-existing code in infra-ai-platform #4 |

### Validation
- [x] Prompt syntax OK
- [x] Markdown structure preserved
- [x] 7 files, 12 insertions, 1 deletion

## 2026-04-01 — Scope bleed and severity calibration

**Source:** PR #99 in GetEvinced/stark-data-core (lint fixes + Phase 5 validation tests)
**Prompts dir:** default (PR code review)
**Assessment:** 16% signal-to-noise (5 issues / 32 not-real). Gemini spec-conformance produced 14 false positives by reviewing the entire codebase against the design spec instead of scoping to the PR diff. Codex test-coverage rated schema introspection tests as "critical" because they don't execute underlying logic.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/gemini/07-spec-conformance.md` | Added diff-scoping rule: "ONLY review code that appears in the diff" | 14 false positives about pre-existing terraform/metrics deviations not touched by this PR |
| `global/prompts/codex/06-test-coverage.md` | Added calibration: schema/signature tests are valid, rate at most medium | 2 findings rated "critical" for tests that intentionally validate API surface, not behavior |

### Validation
- [x] Prompt syntax OK
- [x] Markdown structure preserved

## 2026-03-28 — Backend stack coverage: security, correctness, test-coverage prompts

**Source:** PR #48 in GetEvinced/stark-agents (Python MCP server — 30 commits, 12K+ lines)
**Prompts dir:** default (PR code review)
**Assessment:** 61% signal-to-noise (28 issues / 46 evaluated). All prompts were frontend/React-centric. Claude security produced 21 findings (50%+ noise at medium/low) because backend patterns weren't in checklist. Gemini returned 0 findings in 4/6 domains. Codex test-coverage flagged unit tests for not being integration tests.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/{claude,codex,gemini}/05-security.md` | Added "Backend & Server" checklist (command injection, credential exposure, SSRF, IAM, OIDC) and "API Surface Calibration" (only flag validation at public API boundaries) | 7 noise findings from flagging input validation on internal classes. Backend patterns (shell injection, token in URLs) were missed by codex/gemini because not in checklist |
| `global/prompts/claude/05-security.md` | Added ASGI framework exclusion (raw ASGI callables are standard patterns) | 2 false positives on `request._send` and ASGI integration |
| `global/prompts/{claude,codex,gemini}/03-correctness.md` | Added "Concurrency & Async" (TOCTOU, non-atomic ops, lock races) and "Cross-Module Contracts" (field name mismatches, wrong kwargs) | Gemini was only agent to catch TOCTOU race. 3 agents independently found src.id/source_id mismatch but only because it was obvious — checklist should explicitly guide this |
| `global/prompts/{claude,codex,gemini}/06-test-coverage.md` | Added "Stack Adaptation" section (Python backend patterns) and unit test scope rule | Codex flagged 2 valid unit tests as critical for "not exercising the real pipeline." React-specific items (props, Stories, getByRole) irrelevant to Python backend |

### Validation
- [ ] Prompt syntax OK
- [ ] No orchestrator changes
- [ ] No config changes

---

## 2026-03-28 — Design review noise reduction: scope calibration, dedup hardening, Claude severity

**Source:** Design review of stark-automations (`docs/specs/2026-03-28-stark-automations-design.md`)
**Prompts dir:** design-review
**Assessment:** Signal-to-noise at 29% (60 issues / 208 total findings). 52 scope-creep false positives from agents flagging Phase 2 / future concerns. Same finding (e.g., shell sandbox) surfaced in 3-5 domains per agent. Claude generated 67% more findings than Codex (82 vs 49).

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/design-review/{claude,codex,gemini}/03-scope.md` | Added "Scope Calibration" section with 3 checks and explicit "Do NOT flag" list | 52 findings were scope creep — agents flagged deferred Phase 2 items, security controls proportionate to threat model, and operational tooling within stated scope |
| `global/prompts/design-review/{claude,codex,gemini}/agent.md` | Added "Hard rule" paragraph to Deduplication section | Same root cause (e.g., shell sandbox insufficiency) appeared in 3-5 domains per agent. Existing dedup instruction was too soft. |
| `global/prompts/design-review/claude/agent.md` | Added "Severity Calibration" section with concrete severity gates | Claude produced 82 findings vs Codex's 49. Many Claude highs were actually mediums or lows. Added: "If you cannot articulate the concrete failure scenario, it is not high." |

### Validation
- [x] Prompt syntax OK (all markdown well-formed)
- [x] No orchestrator changes
- [x] No config changes

---

## 2026-03-23 — Gemini scope restriction, plan/spec awareness, cross-domain dedup

**Source:** PR #50 in GetEvinced/stark-skills + plan review of stark-signals
**Assessment:** Gemini reviewed files outside PR diff (70% out-of-scope). Security domain re-flagged known plan-level design decisions. Both plan-review agents produced 15+ duplicate findings for the same auth issue across domains.

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/gemini/agent.md` | Strengthened diff scope rule — findings on unchanged files will be discarded | 7/10 Gemini findings were on files not in the PR diff |
| `global/prompts/*/05-security.md` (all 3) | Added Plan/Spec Files section — distinguish planned code from shipped code | Security domain treated code blocks in .md plans as production vulnerabilities |
| `global/prompts/codex/agent.md` | Added plan/spec file awareness | Codex flagged implementation details in plan code blocks as PR-level bugs |
| `global/prompts/plan-review/*/agent.md` (all 3) | Added cross-domain amplification rule | Both agents repeated the same auth finding 15+ times across security, operability, feasibility, etc. |

### Validation
- [x] Prompt syntax OK (all markdown well-formed)
- [x] No orchestrator changes
- [x] No config changes

---

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
| `skill/stark-team-review/SKILL.md` | Added step 1.5: push local changes before creating worktree | Review agents were diffing against stale remote HEAD, missing local fixes |

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
