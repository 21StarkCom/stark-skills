# Implementation Plan — stark-write-spec (contract-bounded spec authoring)

## 1. Overview

Build the pipeline's missing **stage 0**: a spec-authoring skill + headless lead/wing dispatcher that turns intent into a spec satisfying a fixed **Spec Contract**, then hands off to `/stark-review-spec`. The approach deliberately **mirrors `tools/plan_dispatch.ts`** (lead drafts text, wing returns a JSON verdict, bounded revise loop, no worktree, no tool use) — reusing its already-exported dispatch primitives from `copilot_dispatch.ts` rather than extracting a shared lib (rule of three not yet met).

Key architectural decisions:
- **Completeness is a closed contract, not an open critique.** The wing emits one status per contract section from a closed enum; the host parser drops unknown section ids. The loop is bounded by construction — no growth breakers/coherence/analytics-grading needed.
- **The 9 section ids are a fixed, host-side typed literal** (`SECTION_IDS`) — the code's authority, not read from the asset at runtime. `contract.md` is the canonical *prose* encoding; a binding test parses the asset and asserts it matches `SECTION_IDS` so drift fails tests rather than silently widening the accepted set. An asset-added 10th id is still rejected until `SECTION_IDS` is deliberately edited.
- **The wing verdict is a distinct schema (`items`/`done`/`summary`), not the approve/revise/block shape** — so it needs its own JSON extractor (`extractContractVerdictJson`); the existing `extractVerdictJson` only returns objects containing a `"verdict"` key and cannot parse this schema.
- **Agents are text-in/text-out with no tool access.** Both the Claude lead and the Claude wing dispatch through the repo's **no-tools least-privilege command configuration** (mirroring the fold decider / verify refuter: `disallowedTools` disables Bash/Edit/Write/Read/WebFetch/WebSearch/Task/NotebookEdit, and `allowedTools` is empty) — enforcing the spec's no-tool agent boundary at the command layer. This is asserted by a named test (`test_agent_commands_expose_no_tools`).
- **Host owns all trust:** `done` recomputed over the full 9-id set (never trusted from the wing), the slug is **deterministically derived host-side from the `--out` path** (`deriveSlugFromOut`), git/PR by the host only.
- **Landing is a host helper, not skill prose** — `tools/write_spec_land.ts` owns branch adoption, commit recovery, push, existing-PR lookup, PR-body marker merge, and `prCreate`, so idempotency and lead-App selection are unit-testable. **Branch adoption happens *before* the spec is written** (a `prepare-branch` subcommand the skill runs pre-dispatch), so the dispatcher writes the spec onto the already-adopted branch — never onto whatever branch the operator happened to be on. **`--dry-run` skips both `prepare-branch` and `publish` entirely** (no git side effects, per the spec's no-side-effect dry-run contract).
- **Only the PR is App-authored, not the commit** — the spec commit uses the repo's configured git identity (the workspace per-repo `Aryeh Stark <aryeh@21stark.com>`); the *PR* is created/edited with the lead App's token.
- **PR body is merged, not overwritten** — an existing PR body has only the owned `<!-- stark-write-spec -->` marker block replaced (or appended if absent); all other content is preserved (`mergePrBody`).
- **Landing is create-or-adopt idempotent** — retriable branch/PR flow that never force-pushes.

Phases build inside-out: config + contract asset → parser/normalizer + minimal record writer (the structural bound + durable exit, pure/unit-tested) → dispatch loop → history extension (incremental rounds, retention, cost) → skill + landing helper → docs/ADR. Each phase is independently testable and delivers a working increment.

## 2. Prerequisites

- Confirm these exports exist and their signatures match before Phase 3/4/5 (signatures below verified against the current source):
  - `tools/copilot_dispatch.ts`: `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `shouldFallbackToApiKey`, `releaseAgentTempDir`, `parseCodexJsonl`, `parseGeminiJson`, `isPlainObject`, `resolveModel`, `isAgentEnabled`, `VALID_AGENTS`, `AgentName`, `buildClaudeCmd` (supports `outputFormat: "json"`, `allowedTools`, and `disallowedTools`). **Not** `extractVerdictJson` (it hard-requires a `"verdict"` key — see Phase 2 Task 1).
  - `tools/stark_review_doc_lib.ts`: `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs`.
  - `tools/stark_handover_lib.ts`: `sanitizeSlug`.
  - `tools/github_app_lib.ts`: `prCreate(repo, opts)` (draft-by-default: `draft ?? true`), `getToken(opts: { app?, owner? })`, `prList(repo, state, app)` (returns all open PRs — **no head filter**, filter client-side), `apiPatch(pathStr, body, app, owner)`, `apiGet(pathStr, app, owner)` (to fetch an existing PR's current body before merge), `AppName`.
  - `tools/cost_lib.ts`: `computeDispatchCost(model, inputTokens, outputTokens)`.
  - Confirm the repo's **no-tools command flags** on `buildClaudeCmd` (the fold decider in `red_team_fold_lib.ts::dispatchDecider` and the verify refuter in `red_team_verify_lib.ts` are the reference call sites — read one before Phase 3 and copy its `disallowedTools` string verbatim into a `NO_TOOLS` const).
  - Verify command (run before writing importing code):
    ```
    node --experimental-strip-types -e "import('./tools/copilot_dispatch.ts').then(m=>console.log(Object.keys(m).sort().join('\n')))"
    ```
    Repeat per module (`github_app_lib.ts`, `stark_review_doc_lib.ts`, `cost_lib.ts`, `stark_handover_lib.ts`), grepping the printed list for each name above.
- Read `tools/plan_dispatch.ts` end-to-end as the reference implementation before Phase 3.

**Parallel with Phase 1:** authoring `contract.md` and the `{claude,codex}/{generate,verify,revise}.md` prompts (Phase 2 Task 2) can proceed alongside the config section (Phase 1) — no code dependency between them.

## 2.5 Global Constraints

- **No new Python** — TypeScript only, run via `node --experimental-strip-types`.
- **Agents at v1:** `claude` (lead default) + `codex` (wing default) only. `gemini` is **rejected at argument validation in both layers** with a clear unsupported-agent error until gemini prompts ship. Dispatcher core stays agent-generic via `VALID_AGENTS`.
- **No tool use — text-in/text-out.** All Claude dispatches (lead + wing) use the repo's no-tools least-privilege configuration: `NO_TOOLS` const (copied verbatim from the fold decider's `disallowedTools`) passed as `disallowedTools`, with `allowedTools` empty. Codex dispatches run `exec -s read-only`. Asserted by `test_agent_commands_expose_no_tools`.
- **Wing runs codex at `xhigh`** reasoning effort (deliberate; not spec-to-plan's `medium`).
- **Model ids never hardcoded** — resolve through `resolveModel()` / `getModelId()`.
- **All immutable-asset reads go through `assetPromptsDir()`** (zero-argument; join `"write-spec"` onto its return) — never a hardcoded `~/.claude/code-review` path; mutable state via `stateRoot()`.
- **`max_rounds` default = 3**; `max_input_chars` default = 200000; `history_keep_runs` default = 20.
- **Slug is host-derived from `--out`**, never model-chosen and never a separate source of truth: `deriveSlugFromOut(outPath)` (Phase 3) parses the canonical `docs/specs/YYYY-MM-DD-<slug>-spec.md` shape. The skill computes the out path from the resolved topic + any `--out` override (Phase 5), then passes only `--out`; the dispatcher recovers the slug from it for the receipt + history path.
- **The 9 fixed section ids** (verbatim, the `SECTION_IDS` literal): `intent`, `scope`, `interfaces`, `behavior`, `ssot`, `security`, `test-plan`, `accessibility`, `open-questions`.
- **Status enum** (verbatim): `satisfied | underspecified | missing | over_scoped | n_a`.
- **`final_verdict` enum** (verbatim): `contract_satisfied | max_rounds_unsatisfied | lead_empty_draft | unchanged_revision | wing_unparseable`.
- **Lead-agent → GitHub App mapping** (verbatim, used only for the PR token): `claude → stark-claude`, `codex → stark-codex`. No hardcoded App.
- **Draft PR by default** (`prCreate`, `draft ?? true`); `--ready` opts out, `--no-pr` skips. **Only the PR is App-authored; the commit uses the repo's configured git identity.**
- **`--dry-run` performs no git and no file writes outside the scratchpad** — the skill skips `prepare-branch` and `publish`; the dispatcher skips all LLM calls, all writes outside the scratchpad, and creates no history dir.
- **Every non-crash exit still writes the spec file and the receipt** (non-dry runs).
- **Acceptance is a skill-layer resolution, never a dispatcher-receipt rewrite** — the accepted-gaps summary is emitted by the skill (Phase 5 Task 3), the dispatcher's receipt exit contract is uniform and untouched.
- **Docs updated in the same change** (CLAUDE.md + ADR).

## 3. Phases

---

### Phase 1: Config section + contract prompt asset
**Goal:** `write_spec` config resolves with defaults; the canonical contract asset exists and is discoverable.
**Dependencies:** none
**Estimated effort:** S

#### Tasks

1. **Add `write_spec` config section to `stark_config_lib.ts`**
   - What: add `DEFAULT_WRITE_SPEC` and a `getWriteSpecConfig()` accessor following the existing section-accessor pattern (deep merge against defaults). No locked-fields machinery — that stays `getRedTeamConfig`-specific.
   - Files: `tools/stark_config_lib.ts`
   - Interfaces — **Consumes:** the existing `DEFAULT_*` + section-accessor pattern, `getModelId`. **Produces:** `DEFAULT_WRITE_SPEC` const and `getWriteSpecConfig(): WriteSpecConfig` returning `{ lead_agent, wing_agent, wing_reasoning_effort, max_rounds, timeout_s, wing_timeout_s, max_input_chars, history_keep_runs, open_pr }` with the Global-Constraints defaults.
   - Test: `test_write_spec_config_defaults` (in `tools/stark_config_lib.test.ts`) — accessor returns the documented defaults with no config file; a partial override deep-merges.
   - Acceptance: defaults match the spec's config block exactly.

2. **Author the Spec Contract asset**
   - What: write `global/prompts/write-spec/contract.md` — the canonical prose encoding of the 9-section list, each with its **Done-when bar** and a short **review lens** distilled from the corresponding `spec-review` domain prompt (bounded checklist, NOT an open hunt). Include the `n_a`-with-reason rule and the Scope-declaration anti-inflation anchor. Section ids appear in a machine-parseable form: each section header is `## <id> — <Title>` so the binding test can extract ids with `^## ([a-z-]+) —`.
   - Files: `global/prompts/write-spec/contract.md`
   - Interfaces — **Produces:** a markdown asset whose section-id list is asserted (by `test_contract_ids_match_asset`, Phase 2) to equal the host `SECTION_IDS` literal. The asset is *documentation authority*, not runtime authority.
   - Test: covered by `test_contract_ids_match_asset` in Phase 2.
   - Acceptance: all 9 ids present with a done-when bar + lens each, each under a `## <id> — Title` header; no config-overridable language.

#### Risks
- Lens text drifts from actual `spec-review` domain prompts: mitigate by copying each domain's checklist, not paraphrasing its intent.

#### Verification
- `node --experimental-strip-types --test tools/stark_config_lib.test.ts` green (includes `test_write_spec_config_defaults`).
- Asset resolves via `assetPromptsDir()` (zero-arg; join `"write-spec"`):
  ```
  node --experimental-strip-types -e "import('./tools/asset_root_lib.ts').then(m=>{const path=require('node:path');const fs=require('node:fs');const p=path.join(m.assetPromptsDir(),'write-spec','contract.md');console.log(p, fs.existsSync(p));})"
  ```
  prints the resolved path and `true`.

---

### Phase 2: Wing verdict parser + agent prompts (the structural bound)
**Goal:** the closed-enum verdict parser exists with a fixed host-side id set, fully unit-tested; agent prompts drafted.
**Dependencies:** Phase 1
**Estimated effort:** M

#### Tasks

1. **`SECTION_IDS` literal + `extractContractVerdictJson` + `normalizeContractVerdict` + host `done` recomputation in `write_spec_lib.ts`**
   - What: create `tools/write_spec_lib.ts`.
     - Define `SECTION_IDS` as a **typed literal tuple** — `export const SECTION_IDS = ['intent','scope','interfaces','behavior','ssot','security','test-plan','accessibility','open-questions'] as const;` with `export type SectionId = typeof SECTION_IDS[number];`. The parser reads from this literal, **never** from `contract.md` at runtime.
     - **`extractContractVerdictJson(text): Record<string, unknown> | null`** — a contract-shaped JSON extractor. The existing `copilot_dispatch.ts::extractVerdictJson` cannot be reused: it only returns a candidate object when `"verdict" in obj`, whereas a contract verdict has keys `items` / `done` / `summary` and **no** `verdict` key. `extractContractVerdictJson` reuses the same balanced-brace + fenced-block candidate scan (extract a shared `collectJsonCandidates(text): string[]` helper in `copilot_dispatch.ts` and call it from both — preferred over copying, to avoid drift) but accepts the **last** candidate that parses to a plain object containing an `items` **array** and a `done` key. Returns `null` when none matches.
     - **`normalizeContractVerdict(raw)`**: given the extracted object, drop items whose `section` ∉ `SECTION_IDS` (record in `dropped_sections`); coerce unknown `status` → `underspecified`; a known id **absent** from `items` → synthesized `missing`; `n_a` without a non-empty `note`/reason string → `underspecified`. Recompute `done` over the full `SECTION_IDS` set (`done = every id present and status ∈ {satisfied, n_a}`) via `computeDone` — never trust the wing's `done`. An asset-added 10th id is dropped as unknown until `SECTION_IDS` is edited (drift caught by the test below, not silently accepted).
   - Files: `tools/write_spec_lib.ts` (new); `tools/copilot_dispatch.ts` (add exported `collectJsonCandidates`).
   - Interfaces — **Consumes:** `isPlainObject`, `collectJsonCandidates` from `copilot_dispatch.ts`. **Produces:** `SECTION_IDS: readonly SectionId[]`, `STATUS_VALUES`, `type ContractVerdict = { items: {section: SectionId, status: string, note: string}[], done: boolean, summary: string }`, `extractContractVerdictJson(text): Record<string, unknown> | null`, `normalizeContractVerdict(raw): { verdict: ContractVerdict, droppedSections: string[] }`, `computeDone(items): boolean`.
   - Test (all in `tools/write_spec_lib.test.ts`):
     - `test_contract_verdict_extracted` — a fenced block holding `{"items":[{"section":"scope","status":"satisfied","note":""}],"done":false,"summary":"x"}` (no `verdict` key) is returned by `extractContractVerdictJson` **before** normalization; a control string carrying only an approve/revise/block `{"verdict":"approve"}` object returns `null` (proves the two extractors are distinct and the contract one doesn't grab the wrong shape).
     - `test_parser_drops_unknown_sections` (a 10th id → dropped, in `dropped_sections`, `done` from the 9).
     - `test_status_enum_rejects_unknown` (bad status → `underspecified`).
     - `test_done_recomputed_from_items` (wing `done:true` + one non-`satisfied`/`n_a` item → host `done=false`).
     - `test_partial_verdict_fails_closed` (omitted known id → `missing`; reason-less `n_a` → `underspecified`; never false `done`).
     - `test_contract_ids_match_asset` (parse `## ([a-z-]+) —` headers from `contract.md` via `assetPromptsDir()`+join and assert the set === `SECTION_IDS`; an asset with a 10th header **fails** this test while `normalizeContractVerdict` still drops that id at runtime — proving code, not asset, is authority).
   - Acceptance: all six parser tests green; `SECTION_IDS` is the sole runtime id authority; a valid contract verdict parses before normalization; asset drift fails the binding test.

2. **Author `{claude,codex}/{generate,verify,revise}.md` prompts**
   - What: write the six per-agent prompts under `global/prompts/write-spec/`. `generate.md` — draft against the contract. `verify.md` — contract check → verdict JSON (explicitly NOT a review; closed enum; never free-form findings; preamble: "you check a checklist, you do not open findings"; must output the exact `{items,done,summary}` shape). `revise.md` — revise only non-satisfied sections; carry the #677 playground-scope discipline block + "unknown you cannot resolve → Open Questions, never invent"; `over_scoped` items → **remove** content.
   - Files: `global/prompts/write-spec/{claude,codex}/{generate,verify,revise}.md`
   - Interfaces — **Consumes:** `contract.md` (all prompts reference the canonical section list by the same ids). **Produces:** prompt assets loaded by the dispatcher in Phase 3.
   - Test: `test_prompts_reference_canonical_ids` — every `verify.md`/`generate.md`/`revise.md` mentions each `SECTION_IDS` id at least once (binds prompts to the literal alongside the asset).
   - Acceptance: `verify.md` output contract matches the `ContractVerdict` schema; naming (`generate`/`revise`/`verify`) as specified.

#### Risks
- Wing prompt drifts toward critique: mitigate via the `verify.md` name + the explicit checklist-not-findings preamble.

#### Verification
- `node --experimental-strip-types --test tools/write_spec_lib.test.ts` green (extractor + parser + drift + prompt-binding tests).

---

### Phase 3: Lead/wing dispatch loop + durable exit writer
**Goal:** `tools/write_spec.ts` runs the bounded loop headlessly with no-tools agents, derives the slug from `--out`, writes the spec + a minimum receipt on every non-crash exit, and emits the receipt JSON.
**Dependencies:** Phase 2
**Estimated effort:** L

> Ordering fix: this phase owns the **minimum** durable writer (spec file + `receipt.json` in the run dir) because Phase 3's termination acceptance requires spec+receipt on disk at every non-crash exit. Phase 4 *extends* the same writer with per-round incremental `rounds.json`, the `latest` pointer, retention, and cost — it does not introduce persistence from scratch.

#### Tasks

1. **Slug derivation + dispatch loop in `write_spec_lib.ts` + `write_spec.ts` CLI**
   - What: implement `runWriteSpec(opts)` and the CLI.
     - **`deriveSlugFromOut(outPath): string`** — the canonical slug contract. Parse the basename against `^\d{4}-\d{2}-\d{2}-(?<slug>.+)-spec\.md$`; return the `slug` group. **Throw** a clear error (`out path must match docs/specs/YYYY-MM-DD-<slug>-spec.md; got <basename>`) when it does not match — the dispatcher never invents a slug and never accepts a `--slug` flag (single source of truth is the host-computed out path from Phase 5). The receipt `slug` and the history path `stateRoot()/history/write-spec/<slug>/<run-id>/` both come from this one call.
     - `runWriteSpec`: round 1..N — lead drafts/revises against the contract, wing verifies → `ContractVerdict`. Early-exit on `done`. On non-`done`: pass lead its prior draft + **only** non-satisfied items (with notes) + `revise.md`. Malformed wing JSON (`extractContractVerdictJson` returns `null`, or `normalizeContractVerdict` throws) → **one** retry with a format reminder, second failure → terminate `wing_unparseable` (draft preserved). Detect `lead_empty_draft`, `unchanged_revision` (byte-identical revise). Compute `final_verdict`.
     - **Contract composition (finding: agents have no file tools).** The agent prompts *reference* the contract but cannot read it — so `composePrompt(agentPromptText, contractText)` reads `contract.md` **once** at dispatch start (`readFile(path.join(assetPromptsDir(), "write-spec", "contract.md"))`) and **prepends its full contents** (under a `## Spec Contract (authoritative — the 9 sections and their done-when bars)` header) into **every** generate/verify/revise request, before the per-agent template and the intent brief. The canonical done-when bars + review lenses thus reach the lead and wing in-band, not by reference. `runWriteSpec` fails fast if `contract.md` is missing/empty. Test `test_contract_text_reaches_agents`: stub the dispatch layer, assert the composed prompt string for a generate, a verify, and a revise call each contains a sentinel line from `contract.md` (proves composition, not mere reference).
     - CLI parses `--intent-brief --out [--lead --wing --lead-model --wing-model --max-rounds --timeout --wing-timeout --dry-run --json]` (**no `--slug`** — derived from `--out`); reject `gemini` at validation with `unsupported agent: gemini (claude|codex only at v1)`. `--dry-run` assembles/prints the planned dispatch (including the derived slug) and exits (no LLM, no writes outside scratchpad, no run record).
   - **No-tools least-privilege dispatch + exact per-agent commands + output parsers:**
     - Define `const NO_TOOLS = <verbatim disallowed-tools string from the fold decider>` at module top (Bash/Edit/Write/Read/WebFetch/WebSearch/Task/NotebookEdit).
     - **Lead (claude):** `buildClaudeCmd({ promptArg: <prompt>, outputFormat: "json", allowedTools: "", disallowedTools: NO_TOOLS })` — **JSON output format** (unlike `plan_dispatch.ts`'s text lead) so Phase 4 can read the `usage` block, **and no tool access**. The draft text is the envelope's `result` field. Add `parseClaudeJson(raw): { text: string, usage: { input_tokens: number, output_tokens: number } | null }` in `write_spec_lib.ts`: `JSON.parse` the stdout, return `{ text: obj.result ?? "", usage: obj.usage ?? null }`; on parse failure return `{ text: raw, usage: null }` (a text-mode fallback never crashes the loop).
     - **Lead (codex, when `--lead codex`):** `run` with the codex command (`exec -s read-only`), text via `parseCodexJsonl`.
     - **Wing (codex default):** codex `exec -s read-only` at `model_reasoning_effort="xhigh"`; verdict text via `parseCodexJsonl`, then `extractContractVerdictJson` → `normalizeContractVerdict`.
     - **Wing (claude, when `--wing claude`):** `buildClaudeCmd({ outputFormat: "json", allowedTools: "", disallowedTools: NO_TOOLS })`, text via `parseClaudeJson(...).text`.
   - Minimum durable writer: `writeExitArtifacts(runDir, specText, receipt)` writes the spec to `--out` and `receipt.json` to the run dir (atomic tmp+rename via `writeJsonAtomic`) on **every** non-crash return, including all terminal verdicts. This is the base Phase 4 extends.
   - Files: `tools/write_spec_lib.ts`, `tools/write_spec.ts` (new CLI)
   - Interfaces — **Consumes:** `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `shouldFallbackToApiKey`, `releaseAgentTempDir`, `parseCodexJsonl`, `parseGeminiJson`, `buildClaudeCmd`, `resolveModel`, `isAgentEnabled`, `VALID_AGENTS`, `AgentName` (`copilot_dispatch.ts`); `getWriteSpecConfig`, `getModelId` (`stark_config_lib.ts`); `assetPromptsDir`, `stateRoot` (`asset_root_lib.ts`); `writeJsonAtomic` (`stark_review_doc_lib.ts`); `extractContractVerdictJson`, `normalizeContractVerdict` (Phase 2). **Produces:** `deriveSlugFromOut(outPath): string`; `runWriteSpec(opts): Promise<WriteSpecReceipt>`; `parseClaudeJson(raw)`; `buildLeadCmd`/`buildWingCmd` (the command builders, exported for the no-tools test); `type WriteSpecReceipt`; `type FinalVerdict`; `writeExitArtifacts(...)`.
   - Test (`tools/write_spec_lib.test.ts`, stubbed `run` for deterministic agent output):
     - `test_derive_slug_from_out` — `docs/specs/2026-07-20-example-spec.md` → `example`; a non-conforming path (`/tmp/foo.md`) throws the documented error; a multi-word slug (`2026-07-20-multi-word-topic-spec.md` → `multi-word-topic`) round-trips.
     - `test_agent_commands_expose_no_tools` — `buildLeadCmd({agent:'claude',...})` and `buildWingCmd({agent:'claude',...})` produce argv containing the `NO_TOOLS` `disallowedTools` string and an **empty** `allowedTools` (assert no `Read`/`Glob`/`Grep`/`Bash`/`Write` token is grantable); the codex builders include `-s read-only`. Proves the no-tool boundary at the command layer.
     - `test_early_exit_single_pass` (clean draft → exactly 1 lead + 1 wing call, `contract_satisfied`).
     - `test_over_scoped_routes_to_revise` (`over_scoped` item in the revise payload with cut semantics).
     - `test_parse_claude_json_envelope` (a canned `{"result":"…","usage":{"input_tokens":10,"output_tokens":20}}` → `{text, usage}`; a non-JSON stdout → `{text:raw, usage:null}`).
     - `test_termination_max_rounds`, `test_termination_empty_draft`, `test_termination_unchanged_revision`, `test_termination_wing_unparseable` (each → right `final_verdict`, `ok=false`, non-zero exit, and **spec + receipt.json on disk** — asserts `writeExitArtifacts` ran, and the run dir path used the slug from `deriveSlugFromOut`).
   - Acceptance: `ok === (final_verdict === "contract_satisfied")`; non-`contract_satisfied` exits non-zero with `error.code`; spec + `receipt.json` present after every terminal verdict; the receipt `slug` + history path both derive from `--out`; both Claude commands expose no tools; the lead claude command uses `--output-format json` and its text comes from `result`.

2. **Intent brief assembly + truncation**
   - What: read the `--intent-brief PATH` file; enforce `max_input_chars` cap — source material truncates with an explicit marker (`\n\n<!-- TRUNCATED: source material exceeded max_input_chars -->`), Ask/Constraints/Target never truncated.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `write_spec.max_input_chars`. **Produces:** `assembleBriefForDispatch(briefText, cap): string`.
   - Test: `test_intent_brief_truncation` — oversize source material truncates with the marker; ask/constraints preserved verbatim.
   - Acceptance: brief never exceeds cap; marker present iff truncated.

#### Risks
- Loop churn: bounded by `max_rounds` + `unchanged_revision` breaker; the closed-enum verdict prevents section growth.
- Wing agent-env drift from `plan_dispatch.ts`: mitigate by reusing the exact imported primitives, not reimplementing env isolation.

#### Verification
- `node --experimental-strip-types --test tools/write_spec_lib.test.ts` green (slug + no-tools + loop + claude-envelope + all four termination + truncation tests).
- **Dry-run preserves git state byte-for-byte + creates no output/history** (capture-before / compare-after, works in a pre-existing dirty tree):
  ```
  printf '## Ask\nauthor a spec for X\n' > /tmp/brief.md
  OUT="/tmp/wsdry-$(date +%s)-spec.md"                 # unique, outside the repo tree
  HIST="$(node --experimental-strip-types -e "import('./tools/asset_root_lib.ts').then(m=>console.log(m.stateRoot()))")/history/write-spec"
  BEFORE_HIST="$(ls -1 "$HIST" 2>/dev/null | sort)"     # slug dirs present before, if any
  git status --porcelain > /tmp/ws-git-before.txt       # capture full status, not a count
  node --experimental-strip-types tools/write_spec.ts --intent-brief /tmp/brief.md --out "$OUT" --dry-run
  git status --porcelain > /tmp/ws-git-after.txt
  diff /tmp/ws-git-before.txt /tmp/ws-git-after.txt && echo "git-state-unchanged OK"   # byte-for-byte
  test ! -e "$OUT" && echo "no-out-file OK"
  [ "$BEFORE_HIST" = "$(ls -1 "$HIST" 2>/dev/null | sort)" ] && echo "no-history-dir OK"
  ```
  All three lines print: the working tree is identical before and after (proving dry-run made no changes even in a dirty worktree), no spec file was created, and no history dir appeared.

---

### Phase 4: Run record extension (incremental history + cost)
**Goal:** every non-dry run leaves an incrementally-persisted, reproducible record; the receipt carries accurate cost across every agent invocation.
**Dependencies:** Phase 3
**Estimated effort:** M

#### Tasks

1. **Per-agent token accounting + cost aggregation**
   - What: capture input/output token counts per agent invocation and aggregate into receipt `cost_usd`. The base text parsers do not surface usage, so add `extractAgentUsage(agent, rawOutput): AgentUsage` reading each agent's native usage fields:
     - **claude** — via `parseClaudeJson(rawOutput).usage` (Phase 3 dispatches lead/claude-wing with `--output-format json`): `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }`. If `usage` is `null` (text fallback path), return `{0,0}` + a `cost_notes[]` entry.
     - **codex** — sum the JSONL `token_count` events; take `input_tokens` + `output_tokens` from the final/last usage event.
     - **gemini** — (deferred agent, but keep the branch generic) read `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
     - Any absent usage field → `{inputTokens:0, outputTokens:0}` and push `{invocation, reason:"usage_unavailable"}` to receipt `cost_notes[]` — cost degrades to a floor, never crashes.
   - Aggregation rule: `cost_usd = Σ over every invocation` — each lead draft/revise call, each wing verify call, **and each parse-retry re-dispatch** — of `computeDispatchCost(model, usage.inputTokens, usage.outputTokens)`, where `model` is the resolved id for that invocation's agent. Every invocation appends an `{agent, model, inputTokens, outputTokens, cost_usd}` row to receipt `cost_breakdown[]`.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `computeDispatchCost` (`cost_lib.ts`); `parseClaudeJson` (Phase 3); raw agent output already captured by the dispatch loop. **Produces:** `type AgentUsage = {inputTokens:number, outputTokens:number}`; `extractAgentUsage(agent: AgentName, rawOutput: string): AgentUsage`; receipt fields `cost_usd`, `cost_breakdown[]`, `cost_notes[]`.
   - Test: `test_receipt_cost_counts_all_invocations` — a stubbed 2-round run (lead×2, wing×2) plus one wing parse-retry → `cost_breakdown` has 5 rows and `cost_usd` equals the sum of `computeDispatchCost` over all 5 (retry included); `test_usage_extraction_per_agent` — a canned claude JSON envelope and codex JSONL each yield the expected token pair; a usage-less output yields `{0,0}` + a `cost_notes` entry.
   - Acceptance: receipt cost includes every lead call, wing call, and retry; claude usage is read from the JSON envelope Phase 3 emits; missing usage degrades to floor with a note, never crashes.

2. **Incremental history + retention**
   - What: extend `writeExitArtifacts`/the loop to write history under `stateRoot()/history/write-spec/<slug>/<run-id>/` (slug from `deriveSlugFromOut`) — `rounds.json` written atomically **after every round** (partial-safe), `receipt.json` rewritten after every round and at exit, plus `brief.md` (the assembled brief copied in at dispatch), a `latest` pointer, and `history_keep_runs` retention pruning. Receipt gains per-round durations and `persistence_errors[]` (never fatal). Dry runs create no history dir.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs` (`stark_review_doc_lib.ts`); `stateRoot` (`asset_root_lib.ts`); `write_spec.history_keep_runs`. **Produces:** history dir layout + `latest` pointer; `persistence_errors[]` in the receipt.
   - Test: `test_receipt_incremental_persistence` — after a simulated round-2 crash (throw inside round 3), `rounds.json` holds 2 rounds and `receipt.json` reflects rounds-so-far; `test_history_retention` — creating `history_keep_runs + 2` run dirs prunes to `history_keep_runs`, `latest` points to the newest; `test_persistence_error_non_fatal` — a stubbed write-failure surfaces in `persistence_errors` and the run still returns its verdict.
   - Acceptance: after any round, `rounds.json` + `receipt.json` on disk; retention prunes correctly; write failure is non-fatal and surfaced.

#### Risks
- Partial writes on crash: mitigated by atomic tmp+rename (reusing `writeJsonAtomic`).

#### Verification
- `node --experimental-strip-types --test tools/write_spec_lib.test.ts` green (cost + usage + incremental + retention + non-fatal tests).

---

### Phase 5: Skill interactive layer + landing helper
**Goal:** `/stark-write-spec` assembles inputs, resolves gaps in one question round, then honors/computes the out path, derives the slug, adopts the branch (skipped on dry-run), dispatches, lands a lead-App-authored draft PR via a testable host helper that merges (not overwrites) an existing PR body, emits a skill-layer summary (including any accepted gaps), and hands off.
**Dependencies:** Phase 3 (dispatcher), Phase 4 (record)
**Estimated effort:** L

> Ordering fix (finding #1): the single `AskUserQuestion` round runs **first** — because it may supply the topic/slug or a non-standard `--out` path that the rest of the flow depends on. Only after answers are in does the skill honor/validate `--out` (or compute the default path), derive the slug, adopt/create the branch, and dispatch. On a real (non-dry) run the branch is adopted **before** the spec is written so the dispatcher writes onto the target branch; `--dry-run` skips `prepare-branch` and `publish` entirely. The abort path leaves the prepared branch for inspection.

#### Tasks

1. **`skill/stark-write-spec/SKILL.md`**
   - What: author the skill. **Ordered** phases (order is load-bearing — inputs and the question round resolve before any path/slug/branch work):
     1. `## Help` block (references `standards/help.md`).
     2. Preflight: `node --experimental-strip-types tools/preflight.ts --workflow write-spec`.
     3. **Assemble inputs (no side effects):** parse `$ARGUMENTS` into the raw prompt/source path and flags (`--out`, `--lead`, `--wing`, `--dry-run`, `--ready`, `--no-pr`, `--json`, model/round overrides); read the source doc if a path was given; distill chat-context decisions. Do **not** compute a slug or path yet.
     4. **One `AskUserQuestion` round — before any path/slug/branch resolution** (≤4 load-bearing gaps: **topic/slug**, **scope declaration** if not inferable, **non-standard out path** if the operator wants one) — **enforced answer-once**: the skill asks at most one round and never re-prompts the same field. Skipped entirely in headless/`--json` mode (pre-dispatch unknowns flow to Open Questions instead).
     5. **Honor or compute the out path (post-answers):** if `--out PATH` was passed on the CLI **or supplied by the question round**, validate it against the canonical `docs/specs/YYYY-MM-DD-<slug>-spec.md` shape by running `node --experimental-strip-types tools/write_spec_land.ts validate-out --out "<PATH>"` (prints the extracted slug or exits non-zero with the deriveSlugFromOut error message) and use that PATH + slug. **Else** compute the default: `SLUG=$(node --experimental-strip-types tools/write_spec_land.ts resolve-slug --topic "<topic>")` and `OUT="docs/specs/$(date +%F)-$SLUG-spec.md"`. Either way the out path is now fixed and its slug known; the dispatcher re-derives the same slug from `--out` via `deriveSlugFromOut`, so the two agree by construction.
     6. **Dry-run branch:** if `--dry-run` is present, **skip `prepare-branch`**, run the dispatcher with `--dry-run` (which itself writes nothing), and **skip `publish`** — the run has zero git and zero out-of-scratchpad file effects. State this explicitly in the skill prose.
     7. **Non-dry only — adopt/create the target branch BEFORE dispatch:** `node --experimental-strip-types tools/write_spec_land.ts prepare-branch --slug "$SLUG"` (Task 2) — errors on a dirty tree, else checks out or creates `write-spec/<slug>`.
     8. **Assemble intent brief** (prompt + source doc + distilled chat context + constraints + resolved Target: out path + slug → session scratchpad file).
     9. **Dispatch:** `node --experimental-strip-types tools/write_spec.ts --intent-brief PATH --out "$OUT" …` (writes the spec onto the already-adopted branch; on dry-run, `--dry-run` is appended and nothing is written).
     10. **Non-dry only — Land + summarize:** `node --experimental-strip-types tools/write_spec_land.ts publish …` (Task 2), then emit the skill-layer summary (Task 3).
   - Files: `skill/stark-write-spec/SKILL.md`
   - Interfaces — **Consumes:** `tools/write_spec_land.ts` (`resolve-slug`, `validate-out`, `prepare-branch`, `publish`), `tools/write_spec.ts`, `tools/preflight.ts`, `standards/help.md`, `AskUserQuestion`. **Produces:** the `/stark-write-spec` skill surface with the documented CLI flags.
   - Test: `skill_smoke_test.test.ts` picks it up (frontmatter parses, `name:` matches dir, `standards/help.md` referenced, tool refs resolve, `write_spec.ts --help` + `write_spec_land.ts --help` exit clean). Plus the named path/order guards colocated in `write_spec_land_lib.test.ts`: `test_validate_out_extracts_slug` and `test_skill_dry_run_no_git` (below, pure guards).
   - Acceptance: `--help` prints purpose/usage/arguments and stops (side-effect-free); the question round runs **before** slug/out/branch resolution; a `--out` override (from CLI or the answer round) is honored and validated; the default path is computed only when no override exists; on `--dry-run` neither `prepare-branch` nor `publish` runs (no git side effects); on a real run the branch is adopted before dispatch; skill validates.

2. **`tools/write_spec_land.ts` — create-or-adopt idempotent landing helper (with PR-body merge)**
   - What: a host CLI owning all git + PR side effects (making idempotency + lead-App selection + body-merge unit-testable). Subcommands:
     - **`resolve-slug --topic "<t>"`** → prints `sanitizeSlug(t)`.
     - **`validate-out --out PATH [--json]`** → run `deriveSlugFromOut(PATH)` (imported from `write_spec_lib.ts`); on match print the extracted slug (JSON `{ "slug": "…", "out": PATH }` under `--json`) and exit 0; on mismatch exit non-zero with the documented `out path must match docs/specs/YYYY-MM-DD-<slug>-spec.md; got <basename>` error. This is how the skill honors + validates an operator-supplied `--out` before it becomes the dispatcher's `--out`.
     - **`prepare-branch --slug SLUG [--json]`** → adopt-or-create, run **before** the spec is written (never on dry-run — the skill gates it):
       1. Refuse on a dirty tree: if `git status --porcelain` is non-empty, exit non-zero with `working tree not clean; commit or stash before authoring`.
       2. `git rev-parse --verify --quiet write-spec/<slug>` — **local branch exists:** `git checkout write-spec/<slug>`, then **fetch + fast-forward** from the remote so regeneration never starts off a stale commit (and the later plain push can't be rejected): `git fetch origin write-spec/<slug>` and, if the remote ref exists, `git merge --ff-only origin/write-spec/<slug>`; a **non-fast-forwardable** local branch (genuine divergence) is a hard error surfaced to the operator — never force-reset, never a parallel branch. **Else if** `git ls-remote --heads origin write-spec/<slug>` is non-empty → `git fetch origin write-spec/<slug> && git checkout -B write-spec/<slug> origin/write-spec/<slug>`; **else** `git checkout -b write-spec/<slug>`. (`planBranchAction(localExists, remoteExists)` returns `checkout-ff` | `checkout-track` | `create` accordingly; `test_branch_adopt_or_create` covers all three, and `test_stale_local_ff` asserts the existing-local path fetches and fast-forwards.)
     - **`publish --spec PATH --slug SLUG --lead <claude|codex> --run-receipt PATH [--accepted-gaps PATH] [--ready] [--no-pr] [--json]`** → commit/push/PR (branch already current from `prepare-branch`):
       1. **Commit (no empty, no dup), repo git identity:** `git add <spec>`. If `git diff --cached --quiet` (nothing staged), **skip the commit** and proceed to push. Else `git commit -m "spec(<slug>): author via stark-write-spec"`. **The commit uses the repo's configured `user.name`/`user.email` — NOT App-authored.**
       2. **Push:** `git push -u origin write-spec/<slug>` (plain push, never `--force`). Remote already having the commit → no-op success.
       3. **Existing-PR lookup + create-or-adopt (App-authored, body merged):** resolve the lead-App token owner via `getToken({ app: appForLead(lead) })`. List open PRs with `prList(repo, "open", appForLead(lead))` and **filter client-side** (`pickPrForHead`) for `pr.head.ref === "write-spec/<slug>"`. 
          - **If one exists:** fetch its **current body** via `apiGet("/repos/" + repo + "/pulls/" + pr.number, appForLead(lead))`, compute the merged body `mergePrBody(existingBody, ownedBlock)` (Task-defined below), then `apiPatch("/repos/" + repo + "/pulls/" + pr.number, { body: mergedBody }, appForLead(lead))`. **The whole body is never blindly overwritten** — only the owned marker block is replaced or appended. **Adopted-draft readiness (finding):** if `--ready` and the adopted PR is a draft (`apiGet` returned `draft:true`), also mark it ready — App installation tokens **cannot** un-draft (`prReady` via the App 403s), so this one call shells `gh pr ready <n> --repo <repo>` under the **ambient user identity** (the documented merge-path pattern), never the App token. Idempotent: an already-ready PR (or `--ready` absent) skips it. Test `test_adopted_draft_ready_uses_gh` asserts `gh pr ready` fires once for a draft-under-`--ready` and never otherwise.
          - **Else** `prCreate(repo, { head: "write-spec/<slug>", title, body: ownedBlock, draft: !ready, app: appForLead(lead) })` unless `--no-pr`.
       - `ownedBlock` = the `<!-- stark-write-spec -->` … `<!-- /stark-write-spec -->` fenced block built by `buildOwnedBlock(receipt, acceptedGaps)`: final contract-status table + per-round summary + `accepted_gaps[]` (from `--accepted-gaps PATH` when present), wrapped in the open/close markers.
       - `mergePrBody(existingBody, ownedBlock)`: if `existingBody` contains a `<!-- stark-write-spec -->…<!-- /stark-write-spec -->` span, **replace that span in place** (regex on the paired markers, non-greedy); otherwise **append** `\n\n` + `ownedBlock` to the end of `existingBody`. All non-owned content is preserved verbatim. An empty/undefined `existingBody` → just `ownedBlock`.
       - `appForLead(lead)`: `claude → 'stark-claude'`, `codex → 'stark-codex'` (typed `AppName`) — no hardcoded App.
   - Files: `tools/write_spec_land.ts`, `tools/write_spec_land_lib.ts` (pure logic: `appForLead`, `planBranchAction`, `shouldSkipCommit`, `buildOwnedBlock`, `mergePrBody`, `pickPrForHead`, `shouldRunGitStep`)
   - Interfaces — **Consumes:** `deriveSlugFromOut` (`write_spec_lib.ts`, for `validate-out`); `prCreate`, `getToken`, `prList`, `apiGet`, `apiPatch`, `AppName` (`github_app_lib.ts`); `sanitizeSlug` (`stark_handover_lib.ts`); the run receipt JSON from Phase 3/4; the optional accepted-gaps JSON file. **Produces:** `appForLead(lead: 'claude'|'codex'): 'stark-claude'|'stark-codex'`; `planBranchAction(localExists, remoteExists): 'checkout'|'checkout-track'|'create'`; `shouldSkipCommit(stagedDiffEmpty: boolean): boolean`; `pickPrForHead(openPrs, headRef): {number,url}|null`; `buildOwnedBlock(receipt, acceptedGaps): string`; `mergePrBody(existingBody: string, ownedBlock: string): string`; `shouldRunGitStep(dryRun: boolean): boolean`; a `publish` result `{branch, committed:boolean, pushed:boolean, pr:{number,url,app}|null}`.
   - Test (`tools/write_spec_land_lib.test.ts`, pure-fn assertions):
     - `test_lead_app_mapping` (`appForLead('claude')==='stark-claude'`, `appForLead('codex')==='stark-codex'`).
     - `test_validate_out_extracts_slug` — `validate-out` accepts a canonical `docs/specs/2026-07-20-example-spec.md` and yields slug `example`; a non-conforming `--out` fails with the `deriveSlugFromOut` error (proves the skill's honor-`--out` path shares the one slug contract).
     - `test_branch_adopt_or_create` (`planBranchAction` → `checkout`/`checkout-track`/`create` for the three combos).
     - `test_commit_idempotent` (`shouldSkipCommit(true)===true`; `shouldSkipCommit(false)===false`).
     - `test_pick_pr_for_head` (`pickPrForHead` returns the matching-head PR, `null` otherwise — proves the client-side filter compensating for `prList`'s missing head param).
     - `test_pr_body_merge_preserves_other_content` — the proving test for finding #4: `mergePrBody("intro text\n\n<!-- stark-write-spec -->\nOLD\n<!-- /stark-write-spec -->\n\ntrailer text", "<!-- stark-write-spec -->\nNEW\n<!-- /stark-write-spec -->")` returns a body where `intro text` and `trailer text` are **preserved verbatim**, `OLD` is gone, and `NEW` is present exactly once; `mergePrBody("plain body no marker", ownedBlock)` **appends** the block and keeps `plain body no marker`; `mergePrBody("", ownedBlock)===ownedBlock`; a second `mergePrBody` on the already-merged result is idempotent (still one owned block, trailer intact).
     - `test_dry_run_skips_git_steps` (`shouldRunGitStep(true)===false`, `shouldRunGitStep(false)===true` — encodes that dry-run performs no `prepare-branch`/`publish`).
     - Live coverage of the real git/PR surface is the DoD e2e.
   - Acceptance: `validate-out` honors + validates an operator `--out` against the one slug contract; PR created/edited by the lead's App per the mapping; the commit is NOT App-authored (repo identity); an existing PR body has only the owned block replaced/appended (all other content preserved), never wholesale overwritten; re-run adopts the same branch/PR; a run that died post-commit/pre-push is retried by re-invoking `prepare-branch`+`publish`; `accepted_gaps[]` flow from `--accepted-gaps` into the owned block.

3. **Skill-layer gap resolution + accepted-gaps summary contract**
   - What: on `max_rounds_unsatisfied`, offer via `AskUserQuestion`: (1) **Answer the gaps** → enrich brief, re-dispatch **once** (hard bound, enforced by a flag the skill sets so a second max-rounds cannot re-offer answer); (2) **Accept with gaps** → append the unsatisfied items verbatim to the spec's Open Questions, write them to a scratchpad `accepted-gaps.json`, then `publish --accepted-gaps <that-file>`, and emit the skill summary (below) with `outcome:"authored_with_accepted_gaps"`, exit 0; (3) **Abort** → **skip `publish`**; the branch is already prepared (Task 1), left checked out for inspection with the draft spec on disk; emit the skill summary with `outcome:"aborted"`; exit 1. Headless/`--json`: skip gap-fill (pre-dispatch unknowns → Open Questions), max-rounds **auto-resolves to accept-with-gaps** with `headless_auto_accept:true` in the summary. On `contract_satisfied` the summary carries `outcome:"contract_satisfied"` and an empty `accepted_gaps[]`. The dispatcher exit contract stays uniform (acceptance is skill-layer, never rewrites the dispatcher receipt).
   - **Skill output/summary contract (the finding-#2 requirement)** — the skill, on every terminal path, prints a single JSON object to stdout (distinct from the dispatcher receipt; the dispatcher receipt is read from `--run-receipt` and echoed unmodified under `dispatcher_receipt`), shape:
     ```json
     {
       "skill": "stark-write-spec",
       "outcome": "contract_satisfied | authored_with_accepted_gaps | aborted",
       "spec_path": "docs/specs/2026-07-20-example-spec.md",
       "slug": "example",
       "final_verdict": "contract_satisfied | max_rounds_unsatisfied | …",
       "accepted_gaps": [ { "section": "test-plan", "status": "underspecified", "note": "no named test for the revise path" } ],
       "headless_auto_accept": false,
       "pr": { "number": 0, "url": "…", "app": "stark-claude" },
       "dispatcher_receipt": { "…": "the Phase 3/4 receipt echoed verbatim, never rewritten" }
     }
     ```
     `accepted_gaps[]` = the exact non-`satisfied`/`n_a` `contract_status` items the skill appended to Open Questions (empty on `contract_satisfied` and on `aborted`). `headless_auto_accept` = `true` only on the headless max-rounds auto-accept path, else `false`. The interactive accept path emits the same shape with `headless_auto_accept:false`. In non-`--json` mode the skill renders the same fields as a short human summary but the JSON object is the contract for downstream tooling.
   - Files: `skill/stark-write-spec/SKILL.md`, plus `applyAcceptedGaps(specText, unsatisfiedItems): string` and `buildSkillSummary(args): SkillSummary` in `tools/write_spec_land_lib.ts` (both pure, testable).
   - Interfaces — **Consumes:** the dispatcher receipt's `final_verdict` + `contract_status`; the resolved `pr` result from `publish`. **Produces:** `applyAcceptedGaps(...)` (appends items under the spec's `## Open Questions`); `buildSkillSummary({ outcome, receipt, acceptedGaps, headlessAutoAccept, pr }): SkillSummary` (the JSON contract above, echoing `receipt` verbatim under `dispatcher_receipt`); the scratchpad `accepted-gaps.json` consumed by `publish --accepted-gaps`.
   - Test (`tools/write_spec_land_lib.test.ts`):
     - `test_accept_with_gaps_mutation` (`applyAcceptedGaps` appends each unsatisfied item verbatim under Open Questions, creating the section if absent, idempotent on re-apply).
     - `test_answer_once_bound` (`nextGapAction(priorAnswered, verdict)` returns `answer` only when `!priorAnswered`, else `accept`/`abort`).
     - `test_headless_auto_accept` (`resolveHeadlessGapAction(verdict)==='accept'` for `max_rounds_unsatisfied`).
     - `test_abort_skips_publish` (`shouldPublish(action)` returns `false` for `abort`, `true` for `accept`).
     - **`test_skill_summary_emits_accepted_gaps`** (the finding-#2 proving test) — `buildSkillSummary` for an `accept` outcome emits `outcome:"authored_with_accepted_gaps"`, `accepted_gaps[]` equal to the receipt's non-`satisfied`/`n_a` `contract_status` items (verbatim `section`/`status`/`note`), `headless_auto_accept:false`, and `dispatcher_receipt` **byte-identical** to the input receipt (proves the summary never rewrites it); the headless variant (`buildSkillSummary({...headlessAutoAccept:true})`) sets `headless_auto_accept:true`; the `contract_satisfied` variant emits `accepted_gaps:[]` and `outcome:"contract_satisfied"`.
   - Acceptance: each branch behaves as specified; answer offered at most once; headless has no operator prompt and auto-accepts with `headless_auto_accept:true`; abort opens no PR but leaves the prepared branch + draft spec on disk; the skill emits the summary JSON on every terminal path with `accepted_gaps[]` populated from the receipt and the dispatcher receipt echoed unmodified.

#### Risks
- Chat-context distillation quality (skill-only, can't be unit-tested): mitigate by keeping distillation scoped to explicit decisions and parking anything uncertain under Open Questions.
- Injection: **none added** — the intent brief is operator-authored, not adversarial (stated explicitly so review-spec's security domain doesn't manufacture a gate).

#### Verification
- `node --experimental-strip-types --test tools/write_spec_land_lib.test.ts` green (lead-App mapping, validate-out slug, branch adopt, commit idempotency, PR head-filter, **PR-body merge preserving other content**, dry-run skips git, accept-with-gaps, answer-once, headless auto-accept, abort-skips-publish, **skill-summary emits accepted_gaps without rewriting the receipt**).
- `node --experimental-strip-types --test tools/skill_smoke_test.test.ts` green (picks up the new skill; `write_spec.ts`/`write_spec_land.ts --help` exit clean).
- Live e2e (playground rules — real surface, one run), exact commands:
  ```
  printf '## Ask\nauthor a spec for a trivial CLI greeting tool\n## Target\ntopic: e2e-greeting\n' > /tmp/ws-e2e-brief.md
  SLUG=$(node --experimental-strip-types tools/write_spec_land.ts resolve-slug --topic "e2e-greeting")
  OUT="docs/specs/$(date +%F)-$SLUG-spec.md"
  node --experimental-strip-types tools/write_spec_land.ts validate-out --out "$OUT"   # prints slug, exits 0
  node --experimental-strip-types tools/write_spec_land.ts prepare-branch --slug "$SLUG"
  node --experimental-strip-types tools/write_spec.ts --intent-brief /tmp/ws-e2e-brief.md --out "$OUT" --json > /tmp/ws-e2e-receipt.json
  node --experimental-strip-types tools/write_spec_land.ts publish --spec "$OUT" --slug "$SLUG" --lead claude --run-receipt /tmp/ws-e2e-receipt.json --json
  ```
  A draft PR opens on `write-spec/$SLUG`, authored by stark-claude. Re-run the `publish` line a second time and confirm the PR body's owned block is replaced in place (no duplication, any manually-added body text preserved). Then run `/stark-review-spec "$OUT"`.

---

### Phase 6: Docs + ADR
**Goal:** the change is documented in the same PR.
**Dependencies:** Phases 1–5 landed behaviorally
**Estimated effort:** S

#### Tasks

1. **Update CLAUDE.md + write the ADR**
   - What: add `/stark-write-spec` to the pipeline skill list (as stage 0, before review-spec), add `tools/write_spec.ts`/`write_spec_lib.ts`/`write_spec_land.ts`/`write_spec_land_lib.ts` to the TS-tools section, add `global/prompts/write-spec/` to the prompts layout, add the `write_spec` config section note. Write ADR `docs/adr/NNNN-spec-authoring-contract-bounded.md` (MADR-lite). Determine `NNNN` via `ls docs/adr/ | sort | tail -1` + 1.
   - Files: `CLAUDE.md`, `AGENTS.md` (only if it mirrors the skill list — check first), `docs/adr/NNNN-spec-authoring-contract-bounded.md`
   - Interfaces — n/a (docs).
   - Test: n/a.
   - Acceptance: pipeline list, TS tools, prompts layout, config all reflect the new stage; ADR uses the next monotonic `NNNN`.

#### Verification
- `rg -n "stark-write-spec" CLAUDE.md` returns hits in both the pipeline skill list and the TS-tools section.
- `rg -n "global/prompts/write-spec|write_spec config|write_spec section" CLAUDE.md` returns hits.
- `ls docs/adr/*spec-authoring-contract-bounded.md` resolves exactly one file with the next `NNNN`.
- `rg -c "stark-review-spec" AGENTS.md` first — if `AGENTS.md` mirrors the skill list, then `rg -n "stark-write-spec" AGENTS.md` returns a hit; else no change expected.
- `node --experimental-strip-types --test tools/skill_smoke_test.test.ts` still green after doc edits.

## 5. Testing Strategy

Scope-proportional (single-user playground tooling — no E2E pyramid, no load testing):

- **Unit tests carry the weight** — `tools/write_spec_lib.test.ts` covers the contract-verdict extractor (distinct from `extractVerdictJson`), the parser + `SECTION_IDS` drift guard, `deriveSlugFromOut`, the no-tools command builders, the loop/termination matrix, the claude JSON-envelope parser, brief truncation, cost/usage accounting, and incremental persistence, all with a stubbed `run`. `tools/write_spec_land_lib.test.ts` covers lead-App mapping, `validate-out` slug, branch adopt/create, commit idempotency, PR head-filter, **PR-body merge preserving non-owned content**, dry-run-skips-git, accept-with-gaps mutation, answer-once bound, headless auto-accept, abort-skips-publish, and **the skill-summary accepted-gaps contract (emits `accepted_gaps[]` + `headless_auto_accept` without rewriting the dispatcher receipt)** — all pure-function assertions. `tools/stark_config_lib.test.ts` covers the config defaults. Test the extractor + parser + `deriveSlugFromOut` first — the invariants the whole design rests on.
- **`skill_smoke_test.test.ts`** picks up the skill automatically.
- **Live e2e (playground rules — real surface, one run):** the exact command block in Phase 5 — `validate-out` → `prepare-branch` → dispatch → `publish` → re-`publish` (body-merge check) → `/stark-review-spec`. The deterministic tests own every idempotency/mapping/gap-resolution/summary/body-merge/dry-run path; the live run exercises the real git+PR+LLM surface end to end.

Run everything with `npm --prefix tools test` (the package.json lives in `tools/`, not the repo root); targeted runs use `node --experimental-strip-types --test <file>`.

**Success criteria (DoD):**
1. Live-run receipt reaches `contract_satisfied` within 3 rounds.
2. `/stark-review-spec` on an authored spec produces materially fewer round-1 findings than the hand-written baseline (directional spot-check against existing `review-analytics` sidecars).
3. No growth breaker trips when review-spec runs on an authored spec.
4. Docs updated in the same change (Phase 6).

---

*Rollback Plan, Integration Points, monitoring/operational tasks, and infra-provisioning sections are omitted deliberately: this is single-user local tooling with no cloud infra, no shared state, and no migrations — a `git revert` of the branch fully undoes it. Subprocess isolation, the PR/git surface, and history persistence are all inherited from existing siblings, not new infrastructure.*

**Flagged ambiguities (for the wing / review-spec):**
- The spec leaves the **shared lead/wing loop lib** extraction to "rule of three" (Open Question 1) — this plan mirrors `plan_dispatch.ts` rather than extracting, consistent with the spec's stated decision.
- **Automated contract tuning** (Open Question 2) is explicitly v1-deferred to manual operator edits — no task planned.
- **Brainstorm handoff** (Open Question 3) touches a vendored plugin and is deferred — no task planned.
