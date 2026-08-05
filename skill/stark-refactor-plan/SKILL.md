---
name: stark-refactor-plan
description: >-
  Plan a codebase refactor without touching code. Inspect a repository and
  produce two artifacts — REFACTOR_PLAN.md and REFACTOR_BACKLOG.json — an
  evidence-based, phased, file-by-file restructuring plan another agent can
  execute. Use whenever the user wants to refactor, restructure, reorganize,
  modularize, clean up, de-duplicate, untangle, find dead code, or assess the
  architecture of a codebase, or asks for a refactor plan / backlog / roadmap —
  even if they don't say "plan" explicitly. Planning only: never modifies,
  moves, renames, or deletes source.
argument-hint: "[target-dir] (defaults to current repo root)"
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-refactor-plan

You are a senior codebase-refactoring agent. Inspect the target repository and
produce an **implementation-ready** refactor plan. The deliverable is two files
that another coding agent can execute step by step **without re-discovering the
codebase** — every claim backed by a real path, symbol, or command.

## Mode: planning only

The whole value of this skill is that it is safe to run on any repo at any time
because it changes nothing but the two planning artifacts. Hold that line.

**Do not** modify, move, rename, delete, or reformat source / test / config /
docs; do not change behavior, apply refactors, or bump dependencies.

**You may** read files; run *static* read-only analysis (directory listing,
`rg`, manifest parsing); and create only the two output files below.

**Running the project's own commands is NOT free.** `npm test`, `npm run
build`, `make`, `pytest`, a `postinstall` hook — on an untrusted repo these
execute arbitrary, attacker-controllable code (package scripts, build hooks,
test fixtures). They are not "read-only" just because they don't write to git.
So:

- **Default to command *discovery*, not command *execution*.** Read the
  commands out of the manifests; you do not need to run them to write the plan.
- **Before running any project command, get explicit user approval** and prefer
  a sandbox with no network and no credential access. Treat a repo you didn't
  author as untrusted.
- Never run a command sourced from a file the repo controls without confirming
  what it does first.

The *only* writes allowed are `REFACTOR_PLAN.md` and `REFACTOR_BACKLOG.json` at
the repo root. If either already exists, show the user a diff-style summary of
what you'd overwrite and confirm before clobbering — these may be a prior run's
work or hand-authored.

## Arguments

**Raw input:** `$ARGUMENTS`

- `[target-dir]` — optional path to the repo to analyze. Default: the current
  repo. Resolve the root with `git rev-parse --show-toplevel` (fall back to the
  given dir / `pwd` if not a git repo) and run everything from there. Do **not**
  assume the target is stark-skills — this skill runs against whatever repo the
  user points it at.

## Two ways to run this

1. **Inline (default, any language).** Do the analysis yourself with the phases
   below. Best for small/medium repos and non-JS/TS stacks.
2. **Multi-agent dispatcher (large repos).** Offload the work to focused
   subagents — a deterministic host scan plus per-agent context packs, so no
   agent holds the whole tree. Same two artifacts, same planning-only guarantee.
   The CLI is `tools/refactor_planner.ts`; full usage in
   [references/dispatcher.md](references/dispatcher.md). Quick start:

   ```bash
   TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
   # see what would run — deterministic, no LLM
   node --experimental-strip-types "$TOOLS/refactor_planner.ts" --mode dry-run --root "$ROOT"
   # full multi-agent run -> REFACTOR_PLAN.md + REFACTOR_BACKLOG.json
   node --experimental-strip-types "$TOOLS/refactor_planner.ts" --mode run --root "$ROOT" --provider claude
   ```

   The dispatcher host-owns conflict resolution and assembles a DAG-valid
   backlog, then gate-validates it before writing. If you use it, review its
   output and skip the inline phases.

## Workflow

### Phase 0 — Safety baseline

Establish you're working on a clean, known state so the "changed nothing" claim
is verifiable.

```bash
ROOT="$(git -C "${TARGET:-.}" rev-parse --show-toplevel 2>/dev/null || echo "${TARGET:-$PWD}")"
cd "$ROOT"
pwd
git status --short    # note pre-existing dirt; you must not add to it
git rev-parse HEAD 2>/dev/null || echo "not a git repo"
```

### Phase 1 — Inventory

Map the repo before reasoning about it. Start broad, then go deep where the
structure is densest.

```bash
find . -maxdepth 4 -type d -not -path '*/.git/*' | sort
find . -maxdepth 4 -type f -not -path '*/.git/*' | sort
```

Skip generated / vendored trees unless they're directly relevant:
`node_modules/ dist/ build/ coverage/ .git/ .next/ .nuxt/ vendor/ target/
__pycache__/`. Then sweep for signal with `rg` (adapt patterns to the detected
language):

```bash
rg -n "TODO|FIXME|HACK|deprecated|legacy|XXX|@ts-ignore|eslint-disable" .
rg -n "^(export |def |class |func |interface |type |module\.exports)" .
```

Cover, at minimum: package/build files, language + framework config, entry
points, domain logic, API/interface layers, infra/adapters, shared utilities,
tests, scripts, CI/CD, dependency manifests, docs, env/config files.

### Phase 2 — Validation discovery

Find the repo's **real** commands before recommending any. Read
`package.json` scripts, `Makefile`, `pyproject.toml`/`requirements.txt`,
`Cargo.toml`, `go.mod`, `pom.xml`/`build.gradle`, `turbo.json`,
`pnpm-workspace.yaml`, CI workflow files, and the project's own docs. Determine
the install / test / lint / typecheck / build / format commands. Where a command
can't be determined, record it as `unknown` and say what evidence is missing —
never invent one.

### Phase 3 — Evidence-based analysis

Work the checklist below. **Every finding must cite a real path and symbol** —
no guessing, no generic advice. If you can't point at the evidence, drop the
finding.

1. Current architecture (as implemented, not as intended)
2. Actual runtime entry points
3. Core domain modules
4. API / interface layers
5. Infrastructure / adapters
6. Shared utilities
7. Cross-cutting concerns
8. Dependency direction
9. Circular or unhealthy dependencies
10. Large files / god modules
11. Duplicate functions or overlapping helpers
12. Dead or unreachable code
13. Inconsistent naming
14. Poor directory placement
15. Mixed responsibilities
16. Test gaps
17. Unsafe-to-refactor areas
18. Files that need stronger tests before they're touched
19. Configuration sprawl
20. Documentation gaps relevant to refactoring

**For a large repo**, fan this out: dispatch read-only `Explore` subagents in
parallel — one per area (entry points, domain, infra, shared utils, tests,
config) — then synthesize their reports into one evidence set. Keep subagents
read-only; they inspect, they don't write.

Apply these principles throughout, and bake them into your recommendations:
preserve behavior; prefer incremental change over rewrites; identify/add tests
*before* moving risky logic; don't invent abstractions without repeated
patterns; make ownership obvious from directory structure; keep dependency
direction simple and enforceable; consolidate duplicated utilities into a
canonical module; remove dead code only on strong evidence; separate domain
logic from infrastructure; centralize config; avoid unscoped
`misc`/`helpers`/`utils` dumping grounds; prefer domain-scoped shared modules
over global ones; make future agent work local and verifiable.

### Phase 4 — Write `REFACTOR_PLAN.md`

Read [references/refactor-plan-template.md](references/refactor-plan-template.md)
and follow its **exact** 14-section structure (summary, current structure,
current architecture, problems table, duplicates table, dead-code table, target
architecture, phased plan, file-by-file execution table, conventions, validation
strategy, first-PR recommendation, do-not-touch-yet, open questions). Fill it
with the real paths, symbols, and commands from Phases 1–3. Write the file at the
repo root.

### Phase 5 — Write `REFACTOR_BACKLOG.json`

Read [references/backlog-schema.md](references/backlog-schema.md) and emit the
machine-readable backlog in that exact shape (`summary`,
`target_architecture`, `tasks[]`, `duplicates[]`, `risky_areas[]`). The two
artifacts must agree — every plan problem/duplicate/phase should map to a
backlog entry. Then **validate** it before finishing:

```bash
python3 -m json.tool REFACTOR_BACKLOG.json > /dev/null && echo "JSON OK"
# fallbacks if python3 is absent: `jq . REFACTOR_BACKLOG.json > /dev/null`
# or `node -e "JSON.parse(require('fs').readFileSync('REFACTOR_BACKLOG.json'))"`
```

For a deeper gate than a JSON syntax check — schema, enum, unique/sequential
ids, `depends_on` DAG (no cycles), and path-existence — run the dispatcher's
validator on the file you just wrote:

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
node --experimental-strip-types "$TOOLS/refactor_planner.ts" --mode validate --root "$ROOT"
```

### Phase 6 — Verify and report

Confirm you wrote exactly the two files and touched nothing else:

```bash
git status --short    # should show only REFACTOR_PLAN.md + REFACTOR_BACKLOG.json (plus any pre-existing dirt from Phase 0)
```

If anything else changed, you violated planning-only mode — revert it and say so.

## Quality bar

The plan is acceptable only if: both files exist at the repo root; no existing
source was modified; the JSON validates; every referenced path/command is real
(or explicitly marked `unknown` with the missing evidence); steps are
file-specific and executable; duplicate/dead-code claims carry evidence; risky
areas are called out; and the first recommended PR is small and low-risk.

A bad step reads "clean up utils." A good step reads: "Move
`src/helpers/date.ts` to `src/shared/date/date-utils.ts`, update imports in
`src/api/orders.ts` and `src/jobs/sync.ts`, then delete the old file once
`npm test` passes."

## Final response

After creating the artifacts, stop. Your final message includes only:

1. Confirmation that `REFACTOR_PLAN.md` and `REFACTOR_BACKLOG.json` were created
2. Confirmation that no source files were modified
3. Whether JSON validation passed
4. A brief summary of the first recommended PR
