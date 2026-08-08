# /stark-handoff — prompt-file handoffs for fresh executors

- **Date:** 2026-08-08
- **Status:** accepted (design approved in-session; ticket opened at PR time)
- **Tier:** feature — spec only, no ADR (no architectural boundary moves)
- **Sibling:** `/stark-handover`. Handover = disk state, same task, resume in
  place. Handoff = a **prompt file** a fresh executor starts from — another
  session, another repo, another agent, or this session post-`/compact`.

## Intent

Since 2026-07-11 Aryeh has hand-asked for **46+** self-contained prompt files
in `~/Code/.scratch` (3 written 2026-08-08 alone): continuation prompts after
`/compact`, fix dispatches into other repos, fork/parallel-work briefs,
brainstorm/replan prompts, deep-research prompts, one codex implementation
prompt. The ritual is stable — three recurring grammars, one quality rubric —
but unwritten: every draft re-invents structure, and quality rides on the
drafting session happening to remember the rubric. This skill writes the
ritual down.

## Boundary

**IN:**

- New protocol skill `skill/stark-handoff/SKILL.md` + `references/` templates.
  **Zero new TS** — no chains, no tracker, no state machine to engine-ify.
- Verbs: `write` (default) · `list` · `use [name]` · `launch <name>`.
  `use` and `launch` fire **only on explicit invocation** — nothing automatic.
- Five types → three skeletons: `continuation`/`fork` → execution;
  `fix` → investigation; `brainstorm`/`research` → inquiry.
- The 9-check research-prompt rubric applied at draft time; `--fresh-eyes`
  dispatches exactly ONE `/stark-fresh-eyes` pass, findings applied once.
- Storage root: `STARK_HANDOFF_ROOT` env > `handoff.root` in
  `~/.claude/code-review/config.json` > `~/Code/.scratch`. Filename
  `<slug>-prompt.md` (matches the corpus's current convention; collision →
  `-2` suffix). Machine-readable header comment (below).
- Same-change edits: strip the "handoff" trigger word from
  `skill/stark-handover/SKILL.md`'s description; update repo `CLAUDE.md` +
  `AGENTS.md`.

**OUT:**

- No TS engine or unit tests — `tools/skill_smoke_test.test.ts` is the gate.
- No model auto-invocation (`disable-model-invocation: true`, like the sibling).
- No `launch` for inquiry types: brainstorm prompts require Aryeh interactive
  (their own text says "ask questions one at a time"); research prompts run in
  web deep-research tools. Refuse with the reason.
- No deep-research API dispatch — the file is the product.
- Not a `/stark-build` replacement: `launch` is for bounded missions (a fix, a
  next slice). Spec-tier work goes through `/stark-author` → `/stark-build`.
- No `.human.md` sidecar, no `docs/plans/`, no scheduled/cron anything.

## Non-derivable context

- **Corpus:** `~/Code/.scratch/*prompt*.md` — 46 files, 2026-07-11 →
  2026-08-08, plus handoff-shaped files without the suffix
  (`2026-07-31-kotodama-g3-next-step.md`, `miro-list-group-items-fix-plan-2026-08-04.md`).
- **Analyzed specimens** (the three grammars): `draupnir-S7-S8-prompt.md`
  (execution), `fix-meridian-gcp-cost-advisory-lock-flake-prompt.md`
  (investigation), `alfred-human-plane-brainstorm-prompt.md` (inquiry).
- **Rubric:** memory `research-prompt-rubric` (stark-skills project memory) —
  9 checks, extracted 2026-07-25; max ONE zero-context review pass, never a
  round 3 (fleet-burn autopsy).
- **Sibling to mirror:** `skill/stark-handover/SKILL.md` — Help block,
  Guards section, phase structure, `disable-model-invocation: true`. Its
  description **currently claims the "handoff" trigger word** — take it back.
- **Skill mandates:** every skill honors `--help` via `standards/help.md`;
  `tools/skill_smoke_test.test.ts` asserts frontmatter, name/dir match, and
  that every referenced in-repo file resolves.
- **Distribution gotcha:** a new skill is invisible to bifrost auto-sync until
  its bundle membership lands — `catalog/stark-ops/bundle.yaml` in
  `21StarkCom/bifrost` (stark-handover's bundle, verified 2026-08-08).

## Behavior contract

- WHEN `/stark-handoff` (or `write`) is invoked, the skill SHALL mine the
  conversation (handover-style extraction checklist), select the type (from
  `--type` or the ask; state the choice, don't interrogate), draft against the
  type's skeleton + shared spine, self-check against the 9-check rubric, write
  `{root}/<slug>-prompt.md` with the header comment, and report the path plus
  the type-appropriate delivery instruction.
- WHEN `--fresh-eyes` is given, the skill SHALL dispatch ONE
  `/stark-fresh-eyes` pass on the written file, apply the findings once, and
  stop — never a second pass.
- WHEN `use <name>` runs, the skill SHALL read the file fully, render a 5–8
  line brief, recreate the payload's task list (TaskCreate, in order), run any
  verify-state commands the prompt names, and start on the first item.
- WHEN `use` runs bare, the skill SHALL filter candidates by header-comment
  repo == current repo (newest wins); zero matches → refuse and `list`.
  Bare `use` SHALL NOT cross repos.
- WHEN `launch <name>` runs on an execution or investigation type, the skill
  SHALL start a headless `claude -p` in the target repo with **stdin closed**
  (`</dev/null` — the stark-build lesson), backgrounded, log beside the prompt
  file (`<slug>-launch.log`), and report PID + log path + how to monitor.
  Permission mode: `--permission-mode acceptEdits` default, flag passthrough;
  never `--dangerously-skip-permissions`.
- WHEN `launch` targets a brainstorm or research prompt, the skill SHALL
  refuse, naming the reason.
- WHEN the ask is "save context to resume this same task here", the skill
  SHALL route to `/stark-handover` and stop.
- WHEN `list` runs, the skill SHALL table the root's prompt files from their
  header comments: name, type, repo, date — newest first.

## The header comment

First line of every generated file, paste-safe (invisible when rendered),
greppable by `list`/`use`:

```
<!-- stark-handoff repo=21StarkCom/draupnir type=continuation date=2026-08-08 -->
```

`repo` is the **target** repo (org/name, or absolute path when no remote).

## The shared spine (all types)

1. **Envelope/payload split** — one or two lines to Aryeh above a `---` rule
   (where to paste it, which repo/dir to start the session in); the payload
   below the rule is everything the executor sees.
2. **Read-first pointers** with line numbers and a per-doc *why*.
3. **Established vs NOT-established** — verified facts (with measurements)
   separated from suspected mechanisms; "verify this yourself rather than
   trusting me" where re-derivation is cheap.
4. **Binding constraints** — "these are not preferences": branch+PR, ticket
   rule, per-repo gotchas learned this session (lint traps, CI shape,
   merge-tool exit codes).
5. **Anti-goals** — the failure modes the executor must refuse.
6. **Evidence bar** — what the deliverable must show (real numbers, RED→GREEN
   proof, run ids), never "it works".

## The three skeletons

**Execution** (`continuation`, `fork`): mission + ordering and *why*
(sequential vs parallel-safe); where-things-stand (worktree, branch, done
table with commits + tickets, gate numbers); per-task detail with spec quotes
verbatim + done-when commands; load-bearing facts marked "do not re-derive";
the discipline established in prior sessions; what comes after. `fork` adds:
the boundary with the peer session's slice, and the rebase/conflict rule.

**Investigation** (`fix`): locator block (repo, test, `file:line`, impl
`file:line`); what happened (evidence, run ids, verbatim failure text); what
is established (proven mechanism, source-quoted) vs what is NOT (including
honest non-repro attempts, tabulated); **the decisive experiment FIRST** with
an explicit stop-if-wrong branch ("still passes → your model is wrong, stop");
candidate fixes with a recommendation and the design point that drives it;
deliverables (issue + PR + evidence requirements); constraints.

**Inquiry** (`brainstorm`, `research`): destination vs first slice; where it
sits in the repo's own vision (docs, ADRs, with line refs); what exists today
+ verify-yourself; canonical ids/tables (names drift, ids don't); hard
constraints; a strawman decomposition marked "redraw it if it's wrong";
tensions to resolve *with* Aryeh, not around him; open questions for the
receiver to sequence one at a time. `research` additionally hardens rubric
checks 4–8: calibration cases, source tiers, MEASURED > OBSERVED > OPINION,
traceability, bounded deliverable (structure + word budget).

## Guards

- Same-task-same-repo resume ask → `/stark-handover`, say so, stop.
- Never launch inquiry types; never auto-launch anything.
- Bare `use` never crosses repos.
- Max ONE fresh-eyes pass per file revision; findings dispositioned once.
- Not in plan mode — this skill writes files.

## Tasks (DAG)

| # | Task | Files | Done-when |
|---|------|-------|-----------|
| T1 | SKILL.md: frontmatter, Help, Guards, four verbs, write/use/launch/list phases | `skill/stark-handoff/SKILL.md` | `npm test` smoke green (frontmatter parses, name matches dir, help protocol referenced) |
| T2 | Templates: spine + three skeletons + rubric checklist | `skill/stark-handoff/references/{spine,skeleton-execution,skeleton-investigation,skeleton-inquiry,rubric-checklist}.md` | every reference resolves in the smoke test; T1 links them |
| T3 | Take "handoff" back from the sibling | `skill/stark-handover/SKILL.md` | `grep -ci handoff skill/stark-handover/SKILL.md` → 0 |
| T4 | Docs same-change | `CLAUDE.md`, `AGENTS.md` | `/stark-handoff` entry present in both |
| T5 | bifrost membership (separate repo, follow-up PR) | `bifrost:catalog/stark-ops/bundle.yaml` | marketplace lists stark-handoff after sync |

T1+T2 are one PR with T3+T4. T5 is its own PR in `21StarkCom/bifrost` after
this one merges.

## Closing verification

```bash
npm test   # skill_smoke_test walks every skill incl. stark-handoff
grep -ci handoff skill/stark-handover/SKILL.md   # expect 0
grep -c "stark-handoff" CLAUDE.md AGENTS.md      # expect ≥1 each
```

## Deviations

Append-only; entries carry date + reason.

*(none yet)*
