# Refactor-planner dispatcher

A TypeScript multi-agent dispatcher that produces `REFACTOR_PLAN.md` +
`REFACTOR_BACKLOG.json` by splitting analysis into **focused subagents** instead
of asking one agent to hold the whole repository in context. It's the
infrastructure backing the single-agent `stark-refactor-plan` skill: same two
artifacts, same planning-only guarantee, but each subagent sees only a small,
relevant context pack.

## Why this exists

The pure-skill path asks one agent to inventory the repo, reason about
architecture, find duplication and dead code, and write the plan — all in one
context. On a large repo that degrades. The dispatcher instead:

- runs a **deterministic host scan** (no LLM) for the facts an LLM gets wrong —
  the directory tree, language/commands, the import graph, cycles, TODO markers,
  god-modules;
- builds a **focused context pack per agent** (size-capped), so no agent ever
  receives the whole tree;
- **host-owns conflict resolution and the structured backlog** — agents supply
  findings and prose; the host assembles the typed tasks (with a real
  dependency DAG: tests before moves, moves before deletes) and **validates**
  before writing.

## Run it

No `pnpm` in this repo — invoke with `node --experimental-strip-types`:

```bash
# Inventory + planned subagent jobs, NO LLM calls (always safe, fast)
node --experimental-strip-types tools/refactor_planner.ts --mode dry-run

# Full multi-agent planning workflow -> REFACTOR_PLAN.md + REFACTOR_BACKLOG.json
node --experimental-strip-types tools/refactor_planner.ts --mode run --provider claude

# Validate an existing REFACTOR_BACKLOG.json (schema + DAG + enum + path checks)
node --experimental-strip-types tools/refactor_planner.ts --mode validate
```

Add `--json` for a machine-readable receipt on stdout (human summary stays on
stderr). `--help` lists every flag.

## Modes

| Mode | LLM? | Writes | Use |
|------|------|--------|-----|
| `dry-run` | no | `.refactor-planner/{inventory.json, context-packs/, run-summary.json}` | Inspect what would run; cheap and deterministic |
| `run` | yes | the two root artifacts + all intermediates | Produce the plan |
| `validate` | no | nothing | Gate an existing backlog (CI-friendly) |

## Configuration

Provider and model are resolved from flags → env → default; nothing is
hardcoded into business logic.

| Setting | Flag | Env | Default |
|---------|------|-----|---------|
| Provider | `--provider claude\|codex\|noop` | `REFACTOR_PLANNER_PROVIDER` | `claude` |
| Model | `--model <id>` | `REFACTOR_PLANNER_MODEL` | repo `resolveModel()` for the provider |
| Timeout (s) | — | `REFACTOR_PLANNER_TIMEOUT_SEC` | `600` |
| Prompts dir | `--prompts-dir <dir>` | `STARK_REFACTOR_PROMPTS` | `assetPromptsDir()/refactor-planner` |
| Exclusions | `--exclude a,b,c` (additive) | — | `.git node_modules dist build coverage .next .nuxt target vendor __pycache__ …` |
| Concurrency | `--max-concurrency <n>` | — | `4` |
| Partial runs | `--allow-partial` | — | off |

**Failure semantics:** with a real provider (`claude`/`codex`), if any subagent
fails or returns unparseable output the run **fails and writes no artifacts** —
rather than silently emitting a partial/empty plan marked successful. Pass
`--allow-partial` to accept a degraded plan from whatever did succeed. The `noop`
provider never fails, so it always produces (empty) artifacts.

**Subagent sandboxing:** Claude subagents run with **no filesystem tools** and
Codex in a read-only, network-disabled sandbox — the host already embeds every
excerpt an agent needs, so untrusted repo content can't steer an agent into
reading local secrets.

`--provider noop` runs the full pipeline deterministically with **no LLM** —
every agent returns a schema-valid empty result. Useful for testing the wiring
and for a smoke run in CI.

## Pipeline

```
RepositoryDiscovery → ContextPlanner → FocusedSubagentFanout (wave 1, parallel)
  → ResultNormalizer → CrossCheckAndConflictResolver
  → PlanSynthesizer (wave 2: target-arch → phase-planner → synthesis)
  → JsonBacklogValidator → ArtifactWriter
```

Ten subagents (`global/prompts/refactor-planner/*.md`): repository-inventory,
command-discovery, architecture, dependency-health, duplication, dead-code,
test-risk (wave 1, parallel); target-architecture, phase-planner,
artifact-synthesis (wave 2, sequential — each reasons over the prior's output).

## Module map (`tools/`)

| File | Responsibility |
|------|----------------|
| `refactor_planner.ts` | CLI entry (arg parse, receipt printing, exit codes) |
| `refactor_planner_lib.ts` | Orchestrator: the pipeline + the three modes |
| `refactor_planner_discovery.ts` | Deterministic host scan → `RepoInventory` |
| `refactor_planner_context.ts` | Per-agent focused context packs (size-capped) + cycle detection |
| `refactor_planner_provider.ts` | `AgentProvider` interface + claude/codex/noop providers + JSON extraction |
| `refactor_planner_synth.ts` | Conflict resolution + deterministic `PlanModel` assembly |
| `refactor_planner_artifacts.ts` | Render `REFACTOR_PLAN.md` + build `REFACTOR_BACKLOG.json` + planning-only writer |
| `refactor_planner_schemas.ts` | Types, enums, runtime validators, the backlog gate |
| `refactor_planner_lib.test.ts` | Full test suite (discovery, validators, gate, conflicts, modes) |

## Conflict resolution (host-owned, conservative)

Tie-breakers, in order: **keep > delete**, **test before move**, **move before
delete**, **evidence > inference**, **smaller PRs > rewrites**. Examples the host
catches and corrects: a file flagged dead that is an entry point or has inbound
imports (kept); a duplicate whose "delete" target is its own canonical survivor
(downgraded to merge); a target directory that both allows and forbids the same
dependency (treated as forbidden). Every resolution is recorded in the receipt
and surfaced in the plan's Open Questions.

## Limitations

- **No real LLM is invoked unless `--provider claude` (or `codex`) is set** and
  that CLI is installed + enabled in config. With `noop`, artifacts are valid but
  empty — wiring proof, not a real plan.
- The import graph is strongest for JS/TS relative imports; non-relative and
  other-language imports are not resolved into edges, so cycle/dead-code evidence
  is best-effort outside JS/TS. The agents still reason over excerpts.
- The host assembles the **structured** backlog; agents own findings + prose.
  This is deliberate — it guarantees a valid, DAG-correct backlog rather than
  trusting an LLM to emit perfect JSON for the gate.
- Planning-only: the dispatcher writes exactly `.refactor-planner/` and the two
  root artifacts. It never edits, moves, or deletes source. Discovery is fully
  static (manifest parsing, no command execution), so the dispatcher itself never
  runs target-repo build/test scripts.
