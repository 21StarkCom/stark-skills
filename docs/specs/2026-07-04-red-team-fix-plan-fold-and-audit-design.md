# Red-Team Fix-Plan Fold + Audit — Design

- **Date:** 2026-07-04
- **Status:** Approved (design) — ready for implementation plan
- **Owner:** Aryeh
- **Related:** `docs/specs/2026-05-01-stark-red-team-fix-plan-and-insights-design.md` (fix-plan generator), `docs/specs/2026-04-27-red-team-followups.md` (FU-rt8 human-review accept lifecycle — the pattern this mirrors), `global/prompts/red-team/fix-plan.md` (move schema)

---

## 1. Context & problem

The red-team committee already generates a **fix plan** (2–6 architectural "moves") after a challenge and renders it into the `<artifact>.red-team.md` sidecar and the PR comment. Two problems, established from the audit DB (`~/.claude/code-review/history/forged-review/forged_review_metrics.db`, 201 runs / 1,412 findings):

1. **The fix-plan audit is silently broken (a regression).** Since week 20 (when `fix_plan.enabled` was flipped to `true`), **166/166 run rows record `fix_plan_status = "pending"`, with `fix_plan_md` / `fix_plan_json` NULL and `fix_plan_cost_usd` = 0.** The live audit write `auditPersistRun` (`tools/red_team_lib.ts:1614`) calls `recordRedTeamRun` **without any `fix_plan_*` fields**, so the insert falls back to its `fix_plan_status ?? "pending"` default (`tools/red_team_audit_lib.ts:332`). The correct builder `buildRunPayload` (`red_team_lib.ts:2572`, threads `fix_plan_status`) and the backfillers `recordFixPlan` / `updateFixPlan` exist but have **zero live callers** — they are exercised only by `red_team_lib.test.ts`, so the test suite is green while production writes blanks. Separately, `cost_usd` is hardcoded `0` in **two** places: the challenge result (`red_team_lib.ts:1182`) and the fix-plan result (`red_team_lib.ts:2438`). Net: every fix-plan telemetry field has been unusable since the feature shipped — we cannot answer "is the fix plan used?" because the meter is unplugged.

2. **Nothing consumes the fix plan.** Red-team is challenge-only (no fix loop, by design). The fix plan is advisory text a human may or may not read — and given most runs fire from automation/CCR triggers into sidecars, adoption is likely low and, per (1), unmeasured. There is no apply step, no acceptance record, no feedback signal (unlike human-review *halts*, which got the `red_team_accept` / `red_team_status` lifecycle via FU-rt8).

**Intent (from the owner):** keep the fix plan **and** fix its audit; then add a step where **the artifact's authoring agent selectively folds moves into the spec/plan — with review and context — rather than blanket-accepting all of them.** The fix plan becomes *input to the author's judgment*, not an auto-applied patch.

---

## 2. Goals

- **G1 — Truthful fix-plan audit.** Persist the real `fix_plan_status`, `fix_plan_md`, `fix_plan_json`, and a **computed** `fix_plan_cost_usd` on every run. One write path, no dead builders.
- **G2 — Real cost accounting.** Replace both hardcoded `cost_usd = 0` sites with a token×rate computation from `MODEL_RATES`.
- **G3 — Selective, reasoned fold.** A new `/stark-red-team-fold <artifact>` skill in which the **authoring agent** (Claude by default) triages each move — `accept` / `modify` / `reject` — with a rationale grounded in the artifact + source spec, applying only what it accepts.
- **G4 — Reviewable output, never auto-merged.** Fold produces a revised artifact on a branch + a per-move decision log + a PR the human reviews. Rejected moves change nothing.
- **G5 — Disposition audit.** Persist every per-move decision (disposition + rationale), so "is the fix plan used?" becomes a query, and accept/reject rates per persona/failure-mode feed the separate noise-reduction workstream.
- **G6 — `--fold` convenience.** A `--fold` flag on `/stark-red-team-spec` / `/stark-red-team-plan` that runs the challenge, then invokes the fold skill on the produced sidecar. The standalone skill is the reusable unit; the flag is sugar.
- **G7 — Contain the decider.** The decider is untrusted-input-facing: it runs token-less on `<<<RED_TEAM_INPUT>>>`-delimited content, and the host validates every patch target and owns PR publication. A poisoned artifact can at most propose a bad patch (caught by host validation + the human diff), never reach credentials or publishing power.

## 3. Non-goals — what this is **not**

- **Not** an auto-applier. No move is ever applied without an explicit, recorded disposition, and no PR is ever auto-merged.
- **Not** a multi-round fold loop. One triage pass; the human reviews the PR. (Contrast the copilot/plan lead-wing revise loops — deliberately not adopted here.)
- **Not** a change to the challenge itself. Red-team stays challenge-only; the committee prompts/personas/severity are untouched by this spec.
- **Not** the noise-reduction / severity-calibration / injection-FP work. That is a separate workstream; this spec only *feeds* it (via G5 disposition data).
- **Not** a resurrection of stark-insights telemetry. Audit stays local SQLite only.
- **Not** a backfill of the 166 historical blank rows — their fix-plan content is unrecoverable; they stay as-is (see §4.4).

---

## 4. Workstream A — fix-plan audit wiring

### 4.1 The single write path

Route the live audit write through the already-tested `buildRunPayload` builder and **extend it** to carry the three currently-missing fix-plan fields alongside the status it already threads:

- `fix_plan_status` — the real `FixPlanStatus` from `resolveFixPlan` (`"success"` on generation, `"skipped_disabled"` / `"skipped_clean"` / `"skipped_budget_exhausted"` / `"skipped_kill_switch"` / `"skipped_human_review_only"` / `"skipped_input_too_large"` / `"skipped_challenge_error"` / `"skipped_replay"`, or `"error"`). Never the `"pending"` insert-default.
- `fix_plan_md` — the rendered fix-plan section (`renderFixPlanSection(...)` output), the same text shown in the sidecar.
- `fix_plan_json` — `JSON.stringify(fixPlan)` passed through `sanitizeFixPlanJson` (strips `raw_output`, sorts keys — already implemented at `red_team_audit_lib.ts:280`).
- `fix_plan_cost_usd` — `fixPlan.cost_usd` (now real, per §4.3), or `null` when no plan was generated.

`auditPersistRun` (`red_team_lib.ts:1614`) is refactored to accept the `fixPlanResolution` bundle already in scope at its call site (`red_team_lib.ts:1231–1233`, where `fixPlanResolution` and the rendered fix-plan section both exist) and to build its row via `buildRunPayload`. The divergent inline `recordRun` object is deleted so there is exactly **one** run-row builder. `recordFixPlan` / `updateFixPlan` become genuinely unnecessary for the insert path and are **removed** (dead code) rather than left as a tempting second path — the single INSERT already carries all four columns (`RUN_INSERT_BASE_SQL`, `red_team_audit_lib.ts:294`).

No schema migration for `red_team_runs` — the four columns already exist.

### 4.2 What "success" persists vs. "skipped"

| `resolveFixPlan` outcome | `fix_plan_status` | `fix_plan_md` | `fix_plan_json` | `fix_plan_cost_usd` |
|---|---|---|---|---|
| Plan generated | `success` | rendered section | sanitized JSON | computed |
| Config-disabled / kill-switch | `skipped_disabled` / `skipped_kill_switch` | `null` | `null` | `null` |
| Clean / human-review-only / budget / too-large / challenge-error / replay | the matching `skipped_*` | `null` | `null` | `null` |
| Fix-plan dispatch errored | `error` | `null` | `null` | `null` |

### 4.3 Real cost (G2)

Add a pure helper — proposed `computeDispatchCost(model, inputTokens, outputTokens): number` in a shared spot (e.g. `tools/cost_lib.ts`, or co-located in `red_team_lib.ts` if we keep it local) — using `getModelRates()` (`stark_config_lib.ts:380`, `ModelRate = { input_per_1m_usd, output_per_1m_usd }`, `_fallback` for unknown models):

```
cost = inputTokens / 1e6 * rate.input_per_1m_usd
     + outputTokens / 1e6 * rate.output_per_1m_usd
```

Replace the hardcoded `cost_usd: 0` at `red_team_lib.ts:1182` (challenge result) and `validated.cost_usd = 0` at `red_team_lib.ts:2438` (fix-plan result) with this helper, using each dispatch's real `input_tokens` / `output_tokens`. `gpt-5.5-pro` = $25 / $100 per 1M; `claude-opus-4-8` = $15 / $75 per 1M (both already in `DEFAULT_MODEL_RATES`).

### 4.4 Historical rows

The 166 pre-fix `"pending"` rows carry no recoverable fix-plan content — leave them. Optionally, a one-line migration relabels `fix_plan_status = "pending"` → `"unknown_legacy"` so future queries can cleanly exclude the blind window from adoption stats. Low priority; include only if trivial.

---

## 5. Workstream B — `/stark-red-team-fold` skill + dispatcher

### 5.1 Surface

```
/stark-red-team-fold <artifact> [--source-spec PATH] [--fix-plan-json PATH]
                                [--model ID] [--dry-run] [--no-pr] [--json]
```

- `<artifact>` — the spec/plan the fix plan targets.
- `--source-spec` — the design (for a plan) or requirements (for a design). Auto-discovered from the sidecar's recorded context when omitted; a missing source spec proceeds with a `degraded_context` warning (§8).
- `--fix-plan-json` — override: read the fix plan from an explicit JSON file.
- `--source-run-id` — pin the exact red-team run whose fix plan to fold. Required for the audit-DB fallback (below).
- `--force-stale` — proceed even when the resolved plan's `artifact_hash` no longer matches the current artifact.

**Run selection must be explicit — never silently fold a stale plan (rt4).** Resolution order:

1. `--fix-plan-json` if given.
2. Else the adjacent sidecar `<artifact>.red-team.md`, **only when** its embedded `run_id` and `artifact_hash` still match the current artifact. A hash mismatch (artifact edited since the challenge) errors `stale_fix_plan` unless `--force-stale`.
3. Else the audit DB — **only** with an explicit `--source-run-id` (never "latest row for this artifact", which silently picks a plan from another branch or a pre-edit version).
4. Else error `no_fix_plan_found`.

The chosen `run_id` + `artifact_hash` are printed (and in `--json`, emitted) **before** dispatch, so first-contact behavior is predictable regardless of local state.
- `--model` — override the decider model (default `red_team.fold.model`, i.e. `claude-opus-4-8`).
- `--dry-run` — run the triage and render the decision log, but do not write the artifact, open a PR, or write audit rows.
- `--no-pr` — apply to the branch + write the decision log + audit, but do not open/update a PR (mirrors red-team's `--no-pr-comment`).

New files, mirroring the `red_team_design.ts` / `red_team_lib.ts` split:

- `tools/red_team_fold.ts` — thin CLI.
- `tools/red_team_fold_lib.ts` — orchestrator (context load, dispatch, disposition parse/validate, patch apply, decision-log render, PR post, audit).
- `skill/stark-red-team-fold/SKILL.md` — thin skill wrapper, phase shape mirrored from `stark-red-team-spec` (Preflight → Setup → Dispatch → Render → Persist → Output Contract → Operational controls).
- `global/prompts/red-team/fold.md` — the triage prompt (§6).

### 5.2 The decider is the author, not the challenger

The fold agent is the **authoring agent** — `red_team.fold.model`, default `claude-opus-4-8` (matching the copilot / spec-to-plan lead) — deliberately **distinct from the codex `gpt-5.5-pro` challenger** that produced the fix plan. Rationale: an agent triaging its own suggestions rubber-stamps them; the author has the design intent the challenger lacks. "The original agent" is realized faithfully as *a Claude instance acting as the author, with the full authoring context loaded* (artifact + source spec + the intent visible in the doc) — skills are separate invocations, so a persisted live instance is not available, and this is the closest faithful equivalent.

Dispatch reuses the `copilot_dispatch.ts` primitives (`run`, model resolution, `extractVerdictJson`) as `plan_dispatch.ts` does — **except** the env builder: the decider gets the red-team `scrubEnv` (token-less) instead of `buildAgentEnv`, per the trust boundary in §5.6.

### 5.3 Flow

1. **Load context pack** — line-numbered artifact, source spec, and the fix-plan envelope (`{ summary, moves[], unaddressed_finding_ids, notes, warnings }`; each move `{ id, title, addressed_finding_ids, rationale, sections_touched, new_trade_off }`) plus the underlying findings the moves address (from the sidecar / audit), so the author judges the *concern*, not just the proposed move.
2. **Triage dispatch** — the author emits, per move, a disposition + rationale, and for `accept` / `modify` a surgical `FixerPatch` (§6).
3. **Apply selectively** — host applies accepted/modified patches to a working copy via `applyPatches(doc, patches)` (`stark_review_doc_lib.ts:615`), which enforces unique-`old`-match and returns `{ applied, failures }`. Rejected moves contribute no patch. A patch that fails unique-match enters the existing bounded retry-failures loop; if it still fails, the move is recorded with disposition `apply_failed` (surfaced, never silently dropped).
4. **Render decision log** — `<artifact>.fold.md` (§5.4).
5. **Audit first, then publish (ordering matters — rt2).** Write the fold-run + per-move disposition rows (§7) **before** the PR side-effects, so a crash after commit can never leave an orphan branch/PR with no disposition record. Disposition writes are `INSERT OR REPLACE` keyed on `(fold_run_id, move_id)` so a rerun upserts rather than double-counts.
6. **Open/reuse PR** — branch, commit the revised artifact + `.fold.md`, open-or-edit a PR authored by the fold agent's GitHub App (`claude` → `stark-claude`), reusing the red-team SKILL's Phase-4.2 branch/PR/marker machinery. The PR carries a **deterministic fold marker** `<!-- stark-red-team-fold: source_run_id=<id> artifact=<path> -->` so a rerun of the same fold **edits in place** instead of stacking PRs (mirrors the challenge comment's stage+artifact marker). **Never merged.**

This is the cheap 80% of idempotency (deterministic marker + audit-before-publish + upsert), deliberately **not** a full pending-row resume state machine — the challenge path itself carries no such machinery, and a single-pass playground fold does not warrant it (see §3).

### 5.4 The decision log — `<artifact>.fold.md`

Human-readable record, one section per move:

```markdown
# Fold decision log — <artifact>
Fix plan: <run_id>  ·  Decider: claude-opus-4-8  ·  <N accepted / M modified / K rejected>

## m2 — "Externalize worker directives" — REJECTED
Addresses: rt1
Rationale: The flagged block is the superpowers plan preamble (execution-mode
directives for the *implementing* agent), not an injection against the reviewer.
The design's "Global Constraints" section is intentional scaffolding; removing it
would break the plan's own execution contract. No change.

## m4 — "Make vendor selection tri-state" — MODIFIED
Addresses: rt6, rt7
Rationale: The concern is real (enabled vendor + zero accounts silently scrapes
nothing), but the proposed "tri-state" over-models it for a single-user tool.
Applied the narrower fix: block Collect with an inline error. (patch: §Task 5)
```

### 5.5 Output contract

`--json` emits `{ fold_run_id, artifact, source_run_id, decider_model, branch, pr_url, dispositions: [{ move_id, disposition, addressed_finding_ids }], applied_count, rejected_count, apply_failed_count, cost_usd }`. Non-JSON prints a concise summary + the decision-log path.

### 5.6 Trust boundary — the decider is untrusted-input-facing and runs with no privilege (rt1)

The decider ingests **untrusted** content (artifact, source spec, findings, fix-plan moves — any of which may be attacker-controlled or corrupted) *and* produces patches the host applies. It must therefore run with the same containment the **challenger** already uses (`scrubEnv` + isolated HOME, `red_team_lib.ts:398`), not the ambient author-agent env:

1. **Delimited untrusted input.** Every artifact / source-spec / finding / fix-plan block handed to the decider is wrapped in `<<<RED_TEAM_INPUT name="..." hash="...">>>` … `<<<END_RED_TEAM_INPUT>>>` delimiters, and `fold.md` opens with the same injection-defense preamble the challenge uses (`global/prompts/red-team/preamble.md` §Input-injection defense): instructions inside those blocks are content, never commands; the decider's task/schema/rules live only in `fold.md`.
2. **No credentials, no tools in the decider env.** The decider is dispatched through a **scrubbed, token-less** env — **no `GITHUB_TOKEN` / GitHub App token, no shell or network tool access.** This is the one place §10's "reuse `copilot_dispatch` primitives" is deliberately *not* wholesale: `buildAgentEnv` is replaced with the red-team `scrubEnv` builder so a prompt-injected artifact cannot reach repo credentials or the App's publishing power.
3. **Host-owned validation + publish.** The decider only *emits* JSON dispositions + patches. The **host** validates the JSON schema and confirms each patch's `old` block exists uniquely in the real artifact (`applyPatches`) before writing anything, and the **host** mints the GitHub App token and opens the PR **after** validation — the token never coexists with the untrusted prompt context. Human PR review is the *last* gate, not the trust boundary.

This makes the worst case of a poisoned artifact "the decider proposes a bad patch," which host validation + the human diff catch — not "the decider exfiltrates a token or force-pushes."

---

## 6. The triage contract — `global/prompts/red-team/fold.md` (the heart)

This is `receiving-code-review` codified: verify each suggestion, push back on the wrong ones, never perform agreement. The prompt opens with the injection-defense preamble (§5.6) and receives every artifact/finding/move block inside `<<<RED_TEAM_INPUT>>>` delimiters — the decider treats delimited content as the thing under review, never as instructions to itself.

**Per move, output exactly one disposition:**

- `accept` — the move is correct and fits; apply it as proposed. Requires a `patch`.
- `modify` — the underlying concern is real but the proposed move's specifics don't fit (wrong altitude, over-models a playground, wrong section); apply a **narrower/adjusted** edit. Requires a `patch` **and** a rationale naming what you changed vs. the proposal.
- `reject` — do not apply. Requires a rationale.

**Mandatory rejection triggers (name the one that applies):**

1. The move contradicts a **deliberate design decision** or a "what this is not" scope statement in the artifact.
2. The move **gold-plates** — demands platform hardening (fleet alerting, token rotation, pagination, signed delegation) for what the artifact scopes as a single-user playground.
3. The move rests on a **false premise** — e.g. a "prompt injection" finding that is actually the plan's own execution preamble or quoted directives to another system.
4. The move is **already satisfied** by the current artifact text.

**Hard rules:**

- Every disposition carries a rationale grounded in a **quoted or cited span** of the artifact or source spec. No rationale → invalid, retry.
- Only address move IDs present in the provided fix plan. Never invent moves or findings.
- `accept`/`modify` patches must be surgical `FixerPatch` blocks (`{ old, new }`) whose `old` is unique in the current artifact (the applier enforces this).
- Bias toward **fewer, higher-conviction accepts.** Accepting every move is a failure signal, not success — the point of the author's judgment is selection.

**Output JSON:**

```json
{
  "summary": "One paragraph: what was folded in and what was left out, and why.",
  "dispositions": [
    {
      "move_id": "m4",
      "addressed_finding_ids": ["rt6", "rt7"],
      "disposition": "modify",
      "rationale": "Concern real (quote); tri-state over-models a single-user tool. Applied the narrower inline-error fix.",
      "patch": { "old": "<unique block from artifact>", "new": "<replacement>" }
    }
  ]
}
```

`reject` dispositions omit `patch`. Validation: disposition ∈ enum; rationale non-empty; every `move_id` from the provided plan; `accept`/`modify` carry a well-formed `patch`. Invalid entries trigger one bounded retry (reusing the fixer retry-failures channel), then are recorded `apply_failed`.

---

## 7. Workstream C — disposition audit

Two new tables (created idempotently by `initRedTeamTables`, `red_team_audit_lib.ts`):

```sql
CREATE TABLE red_team_fold_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fold_run_id TEXT NOT NULL UNIQUE,
    source_run_id TEXT NOT NULL,        -- the red_team_runs.run_id whose fix plan was folded
    stage TEXT NOT NULL,
    artifact_relative_path TEXT,
    artifact_hash TEXT,                 -- sha256 of the artifact folded (rt3 provenance / rt4 stale-guard)
    fix_plan_hash TEXT,                 -- sha256 of the fix-plan JSON evaluated (rt3 provenance)
    repo TEXT,
    pr_number INTEGER,
    decider_model TEXT NOT NULL,
    accepted_count INTEGER NOT NULL,
    modified_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL,
    apply_failed_count INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    duration_s REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE red_team_fix_plan_dispositions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fold_run_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,           -- scopes the round-local finding/move ids to their run
    move_id TEXT NOT NULL,
    addressed_finding_ids TEXT NOT NULL,   -- comma-separated finding ids, scoped by source_run_id
    disposition TEXT NOT NULL,             -- accept | modify | reject | apply_failed
    rationale TEXT,                        -- retention-policy applied (excerpt/redact), like findings
    move_snapshot_json TEXT,               -- sanitized copy of the move as evaluated (rt3: self-contained record)
    UNIQUE(fold_run_id, move_id)           -- idempotent upsert on rerun (rt2)
);
CREATE INDEX idx_fix_plan_disp_source ON red_team_fix_plan_dispositions(source_run_id);
CREATE INDEX idx_fix_plan_disp_move   ON red_team_fix_plan_dispositions(disposition);
```

`rationale` and `move_snapshot_json` free-text go through the same retention policy as finding text (`red_team_audit_text_lib.ts` — excerpt-mode default, secret+PII redaction), keeping the classification contract intact. **`move_snapshot_json` + `artifact_hash`/`fix_plan_hash` (rt3)** make each disposition self-contained: the decision survives later sidecar edits, finding-ID reuse across runs, or pruning — you can always prove which exact move and artifact version drove it. Finding linkage stays a `source_run_id`-scoped comma list rather than a normalized junction table — that scope resolves the ID-reuse fragility without over-normalizing single-user SQLite.

**What this enables:** `SELECT disposition, COUNT(*) ... GROUP BY disposition` answers "is the fix plan used?"; joining dispositions → findings → persona/failure_mode surfaces which finding families are consistently rejected (noise) vs. accepted (signal) — direct input to the noise-reduction workstream.

---

## 8. Config additions

New `red_team.fold` section in `DEFAULT_RED_TEAM` (`stark_config_lib.ts`):

```json
"fold": {
  "enabled": true,
  "model": "claude-opus-4-8",
  "timeout_s": 1200,
  "max_input_chars": 200000,
  "max_cost_usd": 15,
  "open_pr": true
}
```

- `enabled` — gates the skill/flag. `true`, but fold only runs on **explicit** invocation (skill or `--fold`); it never auto-runs after a bare red-team challenge.
- `model` — the decider (author) model. Distinct from `red_team.model` (the challenger).
- `max_cost_usd` (rt5) — post-dispatch cost cap for the fold call (mirrors `red_team.per_run_budget_usd`). When the computed decider cost exceeds it, the run records `skipped_budget_exhausted_fold` and does not open a PR. A **cap**, not a full predictive token-preflight/circuit-breaker: because fold is opt-in and never auto-runs (§13), the "automation scales spend" risk rt5 raises is already bounded, so a hard cap suffices for a playground.
- Locked-field treatment consistent with the existing red-team defense (`getRedTeamConfig`): `fold.enabled`, `fold.model` added to the locked set so org/repo overrides can't silently swap the decider or disable it. `timeout_s` / `max_cost_usd` / `open_pr` remain tunable.

---

## 9. Data flow

```
/stark-red-team-spec artifact.md              codex gpt-5.5-pro challenges (unchanged)
  → artifact.md.red-team.md (findings + fix plan)
  → audit: red_team_runs row  ← NOW real fix_plan_status/md/json/cost   [A]
       │  (--fold, or standalone)
       ▼
/stark-red-team-fold artifact.md                                        [B]
  → resolve exact source run (hash-matched sidecar or --source-run-id)   [rt4]
  → load: artifact + source spec + fix-plan moves + underlying findings
      (all wrapped in <<<RED_TEAM_INPUT>>>; decider env is token-less)    [rt1]
  → Claude (author) triages each move: accept / modify / reject + rationale
  → host validates JSON + patch targets → applyPatches() to branch       [rt1]
  → artifact.md.fold.md  (per-move decision log)
  → audit FIRST: red_team_fold_runs + red_team_fix_plan_dispositions     [C, rt2]
  → THEN host mints App token → PR (revised doc + log, stark-claude, NOT merged)
```

---

## 10. Reuse map (do not reinvent)

| Need | Reuse | Location |
|---|---|---|
| Surgical patch apply, unique-match | `applyPatches` / `FixerPatch` | `stark_review_doc_lib.ts:615,418` |
| Bounded retry on failed patches | fixer retry-failures channel | `stark_review_doc_lib.ts:440,478` |
| Author-agent dispatch primitives | `run`, `extractVerdictJson`, gemini/api fallbacks | `copilot_dispatch.ts` (as `plan_dispatch.ts` uses) |
| **Token-less** decider env (rt1) | `scrubEnv` + isolated HOME (swapped in for `buildAgentEnv`) | `red_team_lib.ts:398` |
| Model→cost rates | `getModelRates`, `ModelRate` | `stark_config_lib.ts:132,380` |
| PR open/reuse/marker/author-App | red-team Phase 4.2 machinery + `github_app_lib` | `skill/stark-red-team-spec/SKILL.md` §4.2, `github_app_lib.ts` |
| Fix-plan move/envelope schema | existing types | `red_team_lib.ts`, `global/prompts/red-team/fix-plan.md` |
| Free-text retention/redaction | `red_team_audit_text_lib.ts` | (excerpt + secret/PII) |
| Audit DDL + writes | `initRedTeamTables`, `recordRedTeamRun` pattern | `red_team_audit_lib.ts` |

---

## 11. Error handling & edge cases

- **No fix plan / skipped_*** — fold no-ops with `no_fix_plan_found` (or the skip reason), exit clean. Nothing to fold.
- **Fix plan with 0 moves** — decision log records "no moves"; no diff, no PR.
- **All moves rejected** — a valid, useful outcome. Write `.fold.md` + audit; since there's no artifact diff, skip the doc-diff PR but post the decision log as a comment on the existing red-team PR when one exists (so the author's reasoning is visible), else emit the sidecar only.
- **Patch fails unique-match after retry** — move recorded `apply_failed` in the decision log + audit; other moves still applied. Never silently dropped.
- **Missing source spec** — proceed with a `degraded_context` warning in the log (the author loses some intent signal but the artifact itself is primary).
- **`--no-pr` / non-interactive / CI** — apply to branch + write log + audit; skip PR (mirrors red-team `--no-pr-comment`).
- **`--dry-run`** — triage + render log to stdout; no writes, no PR, no audit.
- **Decider == challenger guard** — if `red_team.fold.model` resolves to the same model id as `red_team.model`, emit a `decider_equals_challenger` warning (independence is the point) but proceed.
- **Stale plan (rt4)** — sidecar `artifact_hash` ≠ current artifact → `stale_fix_plan` error unless `--force-stale`; DB fallback without `--source-run-id` → `source_run_id_required` error. Never silently fold a stale/foreign plan.
- **Budget exhausted (rt5)** — decider cost > `fold.max_cost_usd` → record `skipped_budget_exhausted_fold`, write no patches, open no PR.
- **Rerun / crash-recovery (rt2)** — audit rows are written before PR side-effects and upserted on `(fold_run_id, move_id)`; the deterministic fold marker makes a re-invocation edit the existing PR in place rather than stacking duplicates. Worst case of a mid-run crash is an un-audited branch with no PR, which the next run's marker reconciles — not double-applied patches or double-counted dispositions.

---

## 12. Testing

**Unit:**
- `computeDispatchCost` — known tokens×rate incl. `_fallback` for unknown models.
- Disposition parser/validator — enum, required rationale, `accept`/`modify` require patch, unknown move_id rejected, one-retry then `apply_failed`.
- `applyPatches` integration — accepted patches land, rejected contribute nothing, non-unique `old` → retry/fail path.
- Audit round-trip — fold-run + disposition rows insert and read back; `red_team_runs` now carries real `fix_plan_*` (regression test locking the §4 bug shut).
- Config — `fold.enabled` / `fold.model` locked-field rejection.
- Run selection (rt4) — hash-matched sidecar chosen; mismatch → `stale_fix_plan` unless `--force-stale`; DB fallback without `--source-run-id` → `source_run_id_required`.
- Decider containment (rt1) — the env handed to the decider dispatch contains **no** `GITHUB_TOKEN`/App token (assert the scrubbed env); a patch whose `old` isn't uniquely present is rejected host-side before any write.
- Idempotency (rt2) — a second fold on the same `(fold_run_id, move_id)` upserts (no duplicate rows); budget cap (rt5) → `skipped_budget_exhausted_fold` opens no PR; `move_snapshot_json` (rt3) persists the evaluated move.

**Live (repo rule — local-only is insufficient):**
- Run `/stark-red-team-fold` on a real recent sidecar (e.g. `stark-invoices-collector/.../2026-07-04-popup-background-collector.red-team.md`, which has 8 findings + a 5-move fix plan) against a real branch → real PR → verify: decision log written, some moves accepted + some rejected with rationale, `red_team_runs` shows real `fix_plan_status="success"` + nonzero cost, `red_team_fix_plan_dispositions` populated.
- Confirm the audit fix on a fresh `/stark-red-team-spec` run: the new row is no longer `"pending"`.

---

## 13. Rollout

Playground rules — branch + PR, merge when green, no ceremony.

- **Workstream A (audit + cost)** ships **on** — it's a bugfix; every run benefits immediately.
- **Workstreams B/C (fold skill + disposition audit)** ship as an **opt-in** skill (`red_team.fold.enabled: true` but only runs on explicit `/stark-red-team-fold` or `--fold`). No automatic fold after bare challenges — that would reintroduce the "apply without review" the design exists to prevent.
- Suggested slices (finalized in the implementation plan): **(1)** audit wiring + cost helper + regression test; **(2)** fold dispatcher — **token-less decider env + `<<<RED_TEAM_INPUT>>>` delimiters + host-side patch validation (rt1)**, triage prompt, patch-apply, run-selection with hash guard (rt4), decision log (`--dry-run` first); **(3)** audit-before-publish + disposition tables with provenance/upsert (rt2, rt3) + deterministic-marker PR posting + fold budget (rt5); **(4)** the `--fold` flag on red-team-spec/plan; **(5)** docs (both CLAUDE.md files, the two red-team SKILLs, this repo's skill list).

## 14. Open questions

None blocking. Deferred, non-blocking: whether to expose a `stark`-level query (`red-team fold-stats`) over the disposition table — nice-to-have once data accrues; not in scope here.

---

## 15. Red-team dispositions (this spec was itself challenged)

This spec was run through `/stark-red-team-spec` on 2026-07-04 (`manual-53691c0c0837`, gpt-5.5-pro, 5 findings: 1 critical / 3 high / 1 medium, 0 injection false-positives). Dispositions, folded into the sections above:

| # | Sev | Concern | Disposition | Landed in |
|---|-----|---------|-------------|-----------|
| rt1 | critical | Fold decider ingests untrusted input while reusing token-bearing dispatch primitives — no injection boundary / privilege separation | **Accepted** | §5.6 (delimited input, token-less decider, host-owned validation+publish), §6, §10 |
| rt4 | high | Default plan resolution can silently fold a stale/foreign plan via "latest DB row" | **Accepted** | §5.1 (hash-matched sidecar, explicit `--source-run-id`, `--force-stale`) |
| rt2 | high | No idempotency across dispatch→commit→PR→audit; crash orphans state, rerun double-applies | **Modified** — took deterministic marker + audit-before-publish + upsert; declined the full pending-row resume state machine (heavier than the challenge path itself; YAGNI for a single-pass playground fold) | §5.3, §7 (`UNIQUE(fold_run_id,move_id)`), §11 |
| rt3 | high | Comma-separated finding IDs + no move/artifact snapshot → fragile joins, unprovable provenance | **Modified** — added `move_snapshot_json` + `artifact_hash`/`fix_plan_hash`; kept `source_run_id`-scoped finding list instead of a junction table (over-normalization for single-user SQLite) | §7 |
| rt5 | medium | No fold-specific budget / preflight / circuit breaker | **Modified** — added `fold.max_cost_usd` + `skipped_budget_exhausted_fold`; declined the predictive token-preflight breaker (fold is opt-in / never auto-runs, so spend is already bounded) | §8, §11 |

Note on process: rt2/rt3/rt5 are the exact "concern is real, remedy over-models a playground" case the fold triage contract (§6) is built to handle — accepted in concept, remedy trimmed to altitude, each with a recorded rationale. The full committee findings + these dispositions are posted on the PR.
