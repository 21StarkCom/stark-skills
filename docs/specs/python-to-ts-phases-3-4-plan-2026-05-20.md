# Phases 3 + 4 Implementation Plan — Review-Orchestrator Core

**Date:** 2026-05-20
**Parent spec:** `docs/specs/python-to-ts-migration-2026-05-20.md`
**Scope:** the 7 dispatch-infra modules + 3 orchestrators + their tests.

The parent spec's sequencing step 3 says: *"Phases 3 + 4 — one genuine
project. Write a dedicated implementation plan first."* This is that plan.

## Why a separate plan

Phases 1–2 (the 5 leaves + the `automation/` package) shipped as 6
self-contained slices — each ported a module with at most a telemetry
dependency, swept its callers, deleted the Python, done.

Phases 3–4 are different in kind. `multi_review.py` is ~2,000 lines with a
59 KB test file; `plan_review_dispatch.py` is 29 KB; `plan_to_tasks_validate.py`
is 19 KB. They sit on a 6-module infra layer (`config_loader`, `runtime_env`,
`codex/claude/gemini_utils`, `dispatcher_base`) that exists *only* to serve
them. CLAUDE.md's "prior runs cost 4–5 weeks each" warning is about exactly
this code. It must not be big-banged.

## Current state (after Phases 1–2)

- Ported + Python deleted: `failure_classifier`, `user_token`,
  `validation_gate`, `approach_contract`, `statusline-setup`, the
  `automation/` package.
- Partial TS infra already in the repo:
  - `tools/stark_config_lib.ts` — subset of `config_loader.py` (models,
    red_team locked-fields, model_rates, `discoverConfig`).
  - `tools/agent_claude.ts`, `agent_codex.ts`, `agent_gemini.ts` — partial
    agent-CLI helpers (`agent_codex.test.ts` exists).
- Still Python: the 6 infra modules, the 3 orchestrators, `_emit.py`,
  `conftest.py`, and the Phase-5 test/install files.

## Transition strategy — strangler, not big-bang

The infra Python cannot be deleted while any Python orchestrator imports
it. Rather than one giant swap, use a strangler:

1. **Port the infra to TS first (Phase 3), additively.** The new TS infra
   lands alongside the still-live Python infra. Nothing is deleted. The TS
   infra has its first real consumer the moment slice 4a lands.
2. **Port one orchestrator per slice (Phase 4).** Each TS orchestrator
   imports the TS infra; its Python twin + that twin's Python tests are
   deleted in the same slice; its SKILL.md callers are swept in the same
   slice. The other, not-yet-ported Python orchestrators keep importing the
   Python infra — both stacks coexist.
3. **Final cleanup slice (4d).** Once no Python orchestrator remains, the
   Python infra (`config_loader.py`, `runtime_env.py`, the 3 `*_utils.py`,
   `dispatcher_base.py`, `_emit.py`) has zero importers — delete it and its
   tests in one slice.

Each Phase-4 slice is independently shippable and reviewable. No phase
depends on a later one. No thin Python shims are needed — the two stacks
genuinely coexist during the transition.

## Caller map (verified 2026-05-20 by grep)

| Module | Imported by (Python) | Referenced by (skills/docs) |
|---|---|---|
| `config_loader` | claude/codex/gemini_utils, runtime_env, dispatcher_base, conftest | — (no SKILL.md) |
| `runtime_env` | claude_utils, multi_review, plan_review_dispatch, conftest | stark-gh-user SKILL.md (prose mention only) |
| `codex_utils` | dispatcher_base, all 3 orchestrators | — |
| `claude_utils` | dispatcher_base, multi_review, plan_review_dispatch | — |
| `gemini_utils` | dispatcher_base, multi_review, plan_review_dispatch, plan_to_tasks_validate | — |
| `dispatcher_base` | multi_review, plan_review_dispatch | — |
| `_emit` | config_loader, multi_review, plan_review_dispatch | — |
| `multi_review` | conftest, dispatcher_base*, plan_review_dispatch* | stark-phase-execute, stark-review-improvement, stark-review-design-improvement SKILL.md; stark-gh-user (prose); failure-modes.md |
| `plan_review_dispatch` | plan_to_tasks_validate, dispatcher_base* | stark-review-improvement, stark-review-design-improvement SKILL.md; debugging-dispatch.md refs; evals JSON |
| `plan_to_tasks_validate` | — | stark-plan-to-tasks SKILL.md |

\* `dispatcher_base`/`plan_review_dispatch` only *name* `multi_review` in
comments — not a code import. **Two real cross-orchestrator imports must be
respected:** `plan_to_tasks_validate.py` imports from `plan_review_dispatch.py`,
so slice 4c depends on 4b. (The parent spec's import table for
`plan_to_tasks_validate` — "`codex_utils`, `gemini_utils` only" — is
incomplete; confirm the exact symbols imported from `plan_review_dispatch`
before starting 4c and either port them with 4b or carry them into 4c.)

Before each Phase-4 slice, re-grep its SKILL.md references and distinguish
**invocation sites** (a `python3 .../X.py` command — must be rewritten to
`node --experimental-strip-types .../X.ts`) from **prose mentions** (update
for accuracy; not load-bearing). The `skill_smoke_test.test.ts` REF_RE only
catches `scripts/X.py` / `tools/X.ts` *path* tokens, so bare-filename prose
mentions won't fail CI — sweep them anyway.

## Phase 3 — dispatch infra (additive, no deletions)

Layer order (each slice committable on its own; all are additive):

- **3a — `config_loader` → extend `tools/stark_config_lib.ts`.**
  `stark_config_lib.ts` already covers models / red_team / model_rates /
  `discoverConfig`. Add the remaining `DEFAULT_*` sections (RUNTIME,
  SELF_HEAL, VALIDATION_GATE, SKILL_ACTIVATION, CONTEXT_COMPACTION, COST,
  FORGE, FORGED_REVIEW), the matching section accessors, and `getModelId`.
  Fold the `validation_gate` accessor added ad-hoc in Phase 1.3 into the
  shared surface. Additive — preflight already consumes this file.
- **3b — `runtime_env` → `tools/runtime_env_lib.ts`.** `buildAgentEnv(agent,
  operation)`: allowlist filter, `ANTHROPIC_API_KEY` injection from
  `ANTHROPIC_AGENTS` for claude only, GH-App token via the existing
  `tools/github_app.ts` (already a subprocess boundary — becomes a direct
  import), process-scoped temp dir + stale-dir cleanup + exit cleanup.
- **3c — `codex/claude/gemini_utils` → complete `agent_codex.ts` /
  `agent_claude.ts` / `agent_gemini.ts`.** Finish the existing partials:
  model pinning, `parseJsonlOutput` (codex), `buildClaudeCmd` +
  `makeCleanEnv` (claude → delegates to `runtime_env_lib`), gemini session
  isolation + API-key fallback. `AgentDisabledError` as a shared error.
- **3d — `dispatcher_base` → `tools/dispatcher_base_lib.ts`.**
  `DEFAULT_CONFIG` + REPLACE/ADDITIVE/DEEP_MERGE field sets, `deepMerge`,
  `discoverConfig` (richer than the preflight subset already in
  `stark_config_lib.ts` — keep both or unify), `AGENTS`, `resolveModel`,
  `discoverDomains`, `resolvePrompt`.

## Phase 4 — orchestrators (one slice each; Python deleted per slice)

- **4a — `multi_review.py` → `tools/multi_review.ts` (+ `_lib`).** Biggest
  slice; drags in all of Phase 3's TS infra as its first consumer. Parallel
  sub-agent dispatch (Python `ThreadPoolExecutor` → bounded `Promise`
  pool). Sweep the three SKILL.md invocation sites. Delete `multi_review.py`
  + `test_multi_review.py`; reproduce the high-value cases in
  `multi_review_lib.test.ts` (the 59 KB Python test file is a regression
  spec — port the behaviour-defining cases, not 1:1).
- **4b — `plan_review_dispatch.py` → TS.** Reuses the now-TS infra. Sweep
  callers; delete the Python + `test_plan_review_dispatch.py`. Note: the
  two doc-review skills already moved to `tools/stark_review_doc.ts`
  (per CLAUDE.md), so verify whether any *invocation* site remains or only
  prose/eval references — the live surface may be smaller than it looks.
- **4c — `plan_to_tasks_validate.py` → TS.** Depends on 4b (imports from
  `plan_review_dispatch`). Sweep `stark-plan-to-tasks` SKILL.md; delete the
  Python + `test_plan_to_tasks_validate.py` + `test_spec_extraction.py`.
- **4d — infra teardown.** No Python orchestrator remains → delete
  `config_loader.py`, `runtime_env.py`, `codex/claude/gemini_utils.py`,
  `dispatcher_base.py`, `_emit.py`, and their tests (`test_agent_utils.py`,
  `test_dispatcher_base.py`, `test_runtime_env.py`, `test_red_team_config.py`).

## Test strategy

- Every new `*_lib.ts` gets a `*_lib.test.ts` under `tools/`, run by
  `npm test` (`node --experimental-strip-types --test`).
- Python tests are **behaviour specs, not line-for-line ports.** Reproduce
  the cases that pin observable behaviour; drop cases that only exercise
  Python-specific mechanics.
- Per slice: typecheck (`npm run typecheck`), the slice's own test file,
  and `skill_smoke_test.test.ts` (proves swept SKILL.md refs resolve and
  every referenced TS CLI survives `--help`).
- Live verification per CLAUDE.md: exercise a real `/stark-review` run
  after 4a, a real plan review after 4b, a real `/stark-plan-to-tasks`
  decomposition after 4c — local-only checks are not sufficient.

## Risks

- **`multi_review.py` size.** The single largest risk. If 4a is still too
  big to review, split it: infra-wiring + dispatch loop first, then
  output-rendering / PR-posting. Keep `multi_review.py` live until the
  whole TS replacement is proven.
- **Concurrency semantics.** `ThreadPoolExecutor(max_workers=N)` → a
  bounded async pool. Match `runtime.max_concurrent_agents`; preserve
  per-agent isolation and failure independence.
- **`_emit` import timing.** `_emit.py` is shared by `config_loader.py`
  *and* two orchestrators. It can only be deleted in 4d, after the last
  orchestrator stops importing it — not in Phase 3.
- **Coexistence window.** Between 4a and 4d, TS and Python infra both
  exist. They read the same on-disk config/queue, so they stay consistent;
  do not let them diverge (no behaviour changes during the port).

## Definition of done

`scripts/` contains no `.py` files except `conftest.py` and the Phase-5
teardown targets; all tooling runs on TypeScript. Then Phase 5 removes
`conftest.py`, `test_install_deps.py`, `test_register_triggers.py`, and the
`.venv`/pip machinery from `install.sh`.
