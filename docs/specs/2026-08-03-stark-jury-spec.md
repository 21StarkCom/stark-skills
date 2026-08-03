# stark-jury - fan the writing skills across a model panel, merge anchored, audit everything

- **Date:** 2026-08-03
- **Status:** draft (awaiting author review)
- **Branch:** `spec/stark-jury`
- **accepted-base:** _stamp on acceptance_

## Intent

One new skill, `stark-jury`, owns the model-comparison matrix for the four
post-related skills (`stark-voice`, `stark-story-edit`, `stark-blog-sharpen`,
`stark-story-judge`). It dispatches a skill + input to a three-model panel in
parallel, mechanically verifies each candidate against the skill's own iron
rules, stores every run as an auditable artifact, and hands the surviving
candidates to the CALLING SESSION, which performs the anchored merge (rewrite
skills) or writes the agreement report (judge). The existing four skills are
untouched: their SKILL.md files become payloads the jury dispatches, never
edited.

The design deliberately reuses the architecture the author already ran in
production and wrote up in "Best-of-3 with a judge" (transcript-optimizer,
2026-06-11): fan out where models disagree, merge anchored to the source
under no-add/no-remove rules, never score prose with a scalar, drop failed
candidates on a ladder, audit every call.

Decided in the brainstorm (2026-08-03):

1. **Language: TypeScript.** `tools/agent_claude.ts`, `tools/agent_codex.ts`
   and `tools/agent_gemini.ts` already solve per-vendor auth, env allowlists
   and command construction; `tools/stark_config_lib.ts` already carries model
   ids, pricing and capacity ceilings. Go would reimplement three auth paths
   to gain nothing.
2. **One new skill owns the whole matrix.** Not a per-skill wrapper, not a
   judge-only calibrator. The four writing skills stay as they are.
3. **Two modes, split by skill class.** `voice`/`edit`/`sharpen` are
   subjective-rewrite stages and get the ANCHORED MERGE. `story-judge` runs
   in CALIBRATION mode: three scorecards, an agreement report, never a merge,
   never an average - the judge skill's own iron rules (no third judge, no
   averaging, stricter verdict stands) forbid anything else.
4. **The calling session is the merger.** No fourth API call. The session
   sees the source and all surviving candidates together and the author
   watches the reconciliation happen.
5. **The panel is parametric, model AND effort per seat.** Defaults:
   `claude=claude-opus-5:max`, `codex=gpt-5.5-pro:xhigh`,
   `gemini=gemini-3.1-pro-preview:default`. (The author moved the Claude seat
   from Fable 5 to Opus 5 during the brainstorm.)
6. **A mechanical rule verifier gates candidates before the merge** (approach
   B with C folded in: the verifier is a pure module inside the jury tool,
   extracted to a standalone binary only when a second consumer appears).

## IN / OUT boundary

**IN**

- `skill/stark-jury/SKILL.md` - the method: payload assembly, dispatch,
  verify, anchored-merge contract, calibration-report contract, cost note.
- Five TS modules under `tools/`: `jury_panel.ts`, `jury_dispatch.ts`,
  `jury_verify.ts`, `jury_store.ts`, `jury.ts` (CLI), plus `node:test` suites
  for each.
- An effort passthrough added to `agent_claude.ts` (the only dispatcher
  without one).
- Run storage under `~/.claude/code-review/history/jury/`.
- Bundle wiring, CROSS-REPO: the bundle source manifests live in the bifrost
  repo (`~/Code/21Stark/bifrost/bundles/*.json`, schemaVersion 1), and
  `stark-write.json` DOES NOT EXIST there - the stark-write catalog entry is
  orphaned from the plugin pipeline entirely, which is why it cannot be
  enabled. T6 creates `bundles/stark-write.json` in bifrost carrying
  `stark-story-edit`, `stark-blog-sharpen`, `stark-story-judge` and
  `stark-jury`, in a separate bifrost PR.
- Live smoke on a cheap panel.

**OUT (deliberately)**

- Any edit to the four writing skills' SKILL.md files.
- Publishing, Firestore writes, or any stark-personal site machinery. The
  jury reads a file; the session exports a post to a file first.
- Automatic winner-picking or automated quality scoring of prose. "Scoring
  prose is fake precision" - the verifier checks RULES, not quality.
- Storing a merge as canon. The merge lands in the run dir; what reaches the
  site is the author's paste, through the existing publish path.
- A Go implementation.
- Effort-sweep automation (running the same seat at two efforts side by
  side). The panel spec supports it later; v1 ships no sweep driver.
- A hard pre-dispatch cost cap. v1 reports cost per run and per call;
  projection-based refusal is future work.
- Enabling `stark-write@bifrost` in `~/.claude/settings.json` - operator
  action, not repo code. Recorded here so it is not forgotten: without it the
  bundle's skills stay uninvocable on this machine.

## Non-derivable repo context (read before building)

- **The dispatchers are the reuse surface.** `agent_claude.ts` /
  `agent_codex.ts` / `agent_gemini.ts` own vendor auth (subscription /
  keychain / Vertex-or-oauth), env allowlisting (`AGENT_ENV_ALLOWLIST` in
  `agent_env_lib.ts`), and command construction. The jury builds on their
  exported builders; it must not shell out to raw `claude`/`codex`/`gemini`
  strings of its own.
- **`stark_config_lib.ts` is the model SSOT.** Panel validation resolves
  every seat against its pricing table (`claude-opus-5`, `gpt-5.5-pro`,
  `gemini-3.1-pro-preview` all present today) and capacity table
  (`max_output_tokens`, `context_window`). A model id absent from BOTH tables
  is a panel-spec error at parse time, before any call.
- **Codex effort is a `-c` override, not a flag.** codex-cli 0.128.0+ removed
  `--reasoning-effort`; the working form is
  `-c model_reasoning_effort="xhigh"` (already used by `agent_codex.ts` at
  "high" and by stark-story-judge's second-judge dispatch at "xhigh").
- **The claude CLI has NO effort passthrough in `agent_claude.ts` today.**
  The interactive `/effort` command persists a settings-level knob; the
  headless mechanism (a CLI flag vs a `--settings` JSON key) must be
  DISCOVERED against the installed CLI in T1, not assumed. Whatever the
  mechanism, it must be additive - existing agent_claude call sites keep
  their behavior when no effort is given.
- **Headless subprocess scars, all inherited from the fleet:** every dispatch
  carries `</dev/null` (an open stdin hangs codex forever - measured 5h14m);
  codex and gemini run from an EMPTY temp cwd (`--skip-git-repo-check
  -s read-only`; a populated cwd invites the model to read it); gemini needs
  the per-call `GEMINI_CLI_HOME` setup that `agent_gemini.ts` already
  provides (`setupGeminiHome`).
- **The four payload skills live at `skill/<name>/SKILL.md`** in this repo.
  `stark-voice`'s installed copy (`~/.claude/skills/stark-voice/SKILL.md`)
  is byte-identical to the repo copy as of 2026-08-03; the repo copy is the
  one the jury reads (single source of truth).
- **stark-story-judge's iron rules are load-bearing for calibration mode:**
  one dispatch per judge per revision, no third-judge tiebreak, no averaging
  of totals, stricter verdict stands, every score carries a verbatim quote.
  Calibration REPORTS disagreement; it never resolves it.
- **Tests are `node:test`** (`import { test } from "node:test"`), run via
  `node --experimental-strip-types --test <files>`. No vitest here, no
  package.json test script - CI workflows in this repo do not run the suite;
  the closing verification runs locally.
- **The run-history root already exists:** `~/.claude/code-review/history/`
  is where stark-build keeps run state. Jury runs are operator state, never
  repo content - same reasoning as the stark-personal theme backups.

## Behavior contract (EARS-shaped)

- WHEN `jury.ts run --skill <s> --input <file>` is invoked with a valid
  panel, the tool SHALL dispatch the skill payload + input to every seat in
  parallel, each with stdin closed, capturing stdout, exit code, tokens,
  latency, computed cost and a prompt hash per seat.
- The prompt SHALL be byte-identical across seats (the story-judge
  discipline, generalized), assembled as: the skill's SKILL.md body, a
  mode-specific task framing, and the input document. It SHALL carry no
  author identity, no repo paths, and no publish machinery beyond what the
  skill file itself contains.
- WHEN a seat's process fails (non-zero exit, timeout, empty output), the
  run SHALL continue with the surviving seats and record the failure in the
  manifest; the failed seat SHALL appear in the report as FAILED, never
  silently dropped.
- WHEN a candidate arrives, the verifier SHALL evaluate the skill's rule
  table (below) and mark the candidate CLEAN or DISQUALIFIED with named
  violations. Disqualification is mechanical; the session never overrides it
  by judgment, only by fixing the rule.
- The failure ladder SHALL be: zero surviving CLEAN candidates - the run
  errors loudly with every violation listed; exactly one - its output is the
  result and the session performs NO merge ("arbitrating one opinion is
  theater"); two or more - the session merges (rewrite skills) or reports
  (judge).
- WHEN the skill is `story-judge`, the tool SHALL never merge, average, or
  rank the scorecards. The session's `report.md` SHALL contain: the score
  matrix per dimension, the spread, each verdict with the stricter-stands
  resolution, findings named independently by 2+ judges (convergence), and
  disagreements left open.
- WHEN the skill is a rewrite skill, the session's merge SHALL be anchored:
  the source document is the ground truth, no content added that the source
  does not contain, no content removed that the skill's job did not require
  removing, and every disqualified candidate excluded whole - its clean
  sentences do not get cherry-picked.
- Every run SHALL persist under
  `~/.claude/code-review/history/jury/<name>/<run-id>/` with the layout
  below, and `jury.ts list`/`show` SHALL read only that store.
- The tool SHALL never write to any git repo, any skill file, or any
  Firestore document.

## Verifier rule table (jury_verify.ts - pure, no I/O)

| Rule | Applies to | Check | Severity |
|---|---|---|---|
| em-dash zero | all four | any U+2014 in candidate | DISQUALIFY |
| en-dash creep | all four | U+2013 count > source count | warning |
| numbers frozen | edit, sharpen | every number token in candidate (digits, normalized for commas/%/$/units) appears in source; "arithmetic is authorship" | DISQUALIFY |
| cut-only | sharpen | candidate word count <= source word count | DISQUALIFY |
| no new numbers | voice | number tokens in candidate but absent from the brief | warning (voice drafts from a brief; a number may be legitimately requested - the session decides) |
| quote anchoring | judge | every dimension row carries a quoted span appearing verbatim (whitespace-normalized) in the source | DISQUALIFY (the skill's own law: "a score without a quote is invalid") |
| scorecard shape | judge | 7 dimension scores 0-3, total /21, verdict from the enum | DISQUALIFY |
| AI-tell lexicon | voice, sharpen | hits from the shared tell list (delve, leverage, tapestry, "it's worth noting", ...) | warning |

Warnings travel with the candidate into the merge; only DISQUALIFY removes
it. The rule table is data (one exported structure), so adding a rule or a
skill is a table row, not new machinery.

## Run store layout

```
~/.claude/code-review/history/jury/<name>/<run-id>/
  manifest.json     # skill, input path+hash, panel (model+effort per seat),
                    # timestamps, per-seat outcome, totals (tokens, cost)
  input.md          # the source document as dispatched
  prompt.md         # the byte-identical payload sent to every seat
  candidates/
    claude.md  codex.md  gemini.md          # raw outputs
    claude.meta.json ...                    # tokens/cost/latency/rc/hash
  verify/
    claude.json ...                         # CLEAN|DISQUALIFIED + violations
  merge.md          # session-written (rewrite skills)
  report.md         # session-written (judge calibration)
  audit.jsonl       # one row per LLM call, append-only, written before exit
```

`run-id` = UTC timestamp. `<name>` defaults to the input file's basename.
The manifest is written FIRST (before dispatch) so a crashed run leaves a
diagnosable directory, and rewritten complete at the end.

## Module boundaries

| Module | Purpose | Depends on |
|---|---|---|
| `jury_panel.ts` | parse/validate the panel spec (`seat=model:effort,...`), resolve defaults, reject ids missing from the config tables | `stark_config_lib.ts` |
| `jury_dispatch.ts` | parallel fan-out, per-seat capture, timeout, the failure ladder's call-level half | `agent_claude/codex/gemini.ts` |
| `jury_verify.ts` | the rule table; `(skillId, source, candidate) -> {verdict, violations[]}`; pure functions, no I/O, no network | nothing |
| `jury_store.ts` | run-dir layout, manifest, audit rows | `node:fs` |
| `jury.ts` | CLI: `run`, `list`, `show`; wires the above; prints the session handoff (paths + verify verdicts) | all of the above |

`SKILL.md` owns everything the SESSION does after the tool returns: the
anchored-merge contract, the calibration-report contract, the
one-clean-candidate short-circuit, and the instruction to write `merge.md` /
`report.md` back into the run dir.

## Task DAG

Sequential unless noted. Each done-when is machine-checkable and runs from
the repo root.

- **T1 - claude effort passthrough.** Discover the installed CLI's headless
  effort mechanism (flag vs `--settings` key) against `claude --help` and a
  live probe; wire it into `agent_claude.ts` as an optional field; no
  behavior change when absent.
  *Done-when:* `node --experimental-strip-types --test tools/agent_claude.test.ts` green (new cases: effort present in the built command in the discovered form; absent by default).
- **T2 - `jury_verify.ts` + tests.** The full rule table above,
  table-driven tests including: em-dash hit, number normalization
  ($1,013 == 1013), cut-only boundary, quote whitespace-normalization, a
  judge scorecard missing one quote, warnings vs disqualify.
  *Done-when:* `node --experimental-strip-types --test tools/jury_verify.test.ts` green.
- **T3 - `jury_panel.ts` + `jury_store.ts` + tests.** Panel parsing,
  default resolution, unknown-id rejection; store layout, manifest-first
  write, audit append.
  *Done-when:* `node --experimental-strip-types --test tools/jury_panel.test.ts tools/jury_store.test.ts` green.
- **T4 - `jury_dispatch.ts` + tests.** (depends on T1) Command construction
  per seat via the agent builders (asserted, not executed), parallel
  execution with injected fake runners, the ladder: all-fail error, one
  survivor, partial failure recorded.
  *Done-when:* `node --experimental-strip-types --test tools/jury_dispatch.test.ts` green.
- **T5 - `jury.ts` CLI + tests.** (depends on T2-T4) `run` end-to-end with
  fake runners, `list`, `show`, the handoff block format.
  *Done-when:* `node --experimental-strip-types --test tools/jury.test.ts` green.
- **T6 - `skill/stark-jury/SKILL.md` + bundle wiring (cross-repo).** The
  skill doc (method, both mode contracts, payload rules, cost note: expect
  $1-3 per run per skill at max/xhigh effort) lands in stark-skills. The
  bundle manifest is a SEPARATE PR on the bifrost repo: create
  `bundles/stark-write.json` (schemaVersion 1, modeled on
  `bundles/stark-analyze.json`) listing `stark-story-edit`,
  `stark-blog-sharpen`, `stark-story-judge`, `stark-jury`, then run the
  repo's sync/generate step so `catalog/` and `dist/` regenerate. Operator
  step after merge: flip `stark-write@bifrost` on in
  `~/.claude/settings.json` `enabledPlugins`.
  *Done-when (stark-skills half):* `test -f skill/stark-jury/SKILL.md` AND
  `node --experimental-strip-types --test tools/*.test.ts` green.
  *Done-when (bifrost half):* `node -e "const d=require('./bundles/stark-write.json');const n=new Set(d.artifacts.map(a=>a.name));for(const x of ['stark-story-edit','stark-blog-sharpen','stark-story-judge','stark-jury'])if(!n.has(x))process.exit(1)"` exits 0 in the bifrost repo.
- **T7 - live smoke, cheap panel.** (depends on T5) One real run of
  `blog-sharpen` over a fixture post on a cheap panel (e.g.
  `claude=claude-haiku-4-5:default,codex=gpt-5.5:low,gemini=gemini-3.1-flash:default`
  - exact cheap ids resolved against the config tables at build time),
  gated behind `JURY_SMOKE=1`.
  *Done-when:* `JURY_SMOKE=1 node --experimental-strip-types tools/jury.ts run ...` exits 0 and the run dir contains 3 candidate files, 3 verify verdicts and a complete manifest.

**Closing verification (held-out):**
`node --experimental-strip-types --test tools/jury_verify.test.ts tools/jury_panel.test.ts tools/jury_store.test.ts tools/jury_dispatch.test.ts tools/jury.test.ts tools/agent_claude.test.ts`
plus the T7 smoke command.

## Risks

- **The claude effort mechanism is the only genuine unknown.** T1 is first
  and discovers it against the real CLI. If no headless mechanism exists,
  the Claude seat runs at its default effort and the panel spec records
  `effort: unsupported` honestly - the run is still valid, the manifest
  says what actually happened.
- **Reasoning-heavy seats are slow and expensive.** xhigh/max bill thinking
  as output tokens; a 2,000-word post can cost $1-3 per run and take
  minutes per seat. Mitigation: cost and latency land in every manifest,
  the smoke uses a cheap panel, and the cost note is in SKILL.md where the
  operator reads it before running the 45-post corpus.
- **Number-extraction false positives** (dates, version strings, code
  spans). The verifier normalizes and exempts fenced code (the publish
  gate's `stripCodeFences` precedent); residual false DISQUALIFYs surface in
  `verify/*.json` with the offending token named, so they are diagnosable
  and the rule table is one edit away.
- **Vendor CLI drift** (codex flag removal happened once already). The
  dispatch layer pins to the agent builders; a CLI change breaks in ONE
  module with tests that assert command shape.

## Deviations (append-only)

_None yet._
