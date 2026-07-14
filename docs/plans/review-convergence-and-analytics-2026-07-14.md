# Review Convergence & Analytics Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each slice is its own PR — do not batch slices.

**Goal:** Close the "unreviewed last mutation" hole in the three review cycles, make timed-out domains impossible to mistake for clean ones, make every run leave crash-proof per-run analytics, and stop the growth breaker from punishing legitimate growth.

**Architecture:** Four independent slices over the shared doc-review dispatcher (`tools/stark_review_doc.ts` + `_lib` + `_analytics_lib`), the PR-review dispatcher (`tools/stark_review.ts`), and the skill contracts (`skill/stark-review-spec`, `skill/stark-review-plan`, `skill/stark-review`). Judgment moves out of SKILL.md prose into the TS receipt (coverage, ok semantics); persistence moves from end-of-run to incremental per-run; a new diff-scoped convergence pass becomes the terminal phase (ADR 0022).

**Tech Stack:** TypeScript (node `--experimental-strip-types`), `node:test`, codex/claude CLI dispatch, GitHub App auth via `tools/github_app_lib.ts`.

## Global Constraints

- **Branch + PR for every change, no exceptions.** Each slice = its own branch + draft PR; merge once green. Never push to `main`.
- **TypeScript only.** No Python. No new npm dependencies (`tools/package.json` stays dependency-free beyond devDeps).
- **Test live.** A slice is not done until the dispatcher/skill ran end-to-end against a real document (and, where the slice touches posting, a real PR). Local typecheck is not validation.
- **Docs in the same change.** Every slice updates `CLAUDE.md` (repo) and the touched `SKILL.md`s in the same PR.
- **Tests:** `cd tools && npm test` (runs `check-rest-only.sh` + `node --experimental-strip-types --test *.test.ts`). Typecheck: `cd tools && npm run typecheck`.
- **Do not regress the posting contract:** every finding lands on the PR as its own resolvable thread, gets fixed, gets resolved (`tools/review_doc_findings.ts`). Convergence findings flow through the same pipeline.
- **Analytics contract (binds every slice):** every review run — spec, plan, PR — leaves an analytics record; per-run, never clobbered; persisted incrementally (crash leaves partials); write failures surfaced in the receipt, never swallowed; schema-stable JSON (input for `/stark-review-improvement`).
- **Plugin seam:** skills reference tools via `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}`; never hardcode repo paths in SKILL.md. Live validation runs the repo checkout's dispatcher directly (changes are not live in installed plugins until marketplace publish).
- **Receipt consumers must be swept in the same slice that changes semantics:** `skill/stark-review-spec/SKILL.md` Phases 3–5, `skill/stark-review-plan/SKILL.md` Phases 3–5, `skill/stark-review/SKILL.md`, `tools/review_doc_findings.ts` (`collectFindings`), `skill/stark-review-improvement/SKILL.md` (history reader), `skill/stark-phase-execute/SKILL.md` (history reader).

## Current state (verified 2026-07-14, `main` @ c35a558)

| Fact | Anchor |
|---|---|
| Timed-out domain → `{findings: [], error: "timeout"}`; run continues if ≥1 domain succeeded | `tools/stark_review_doc.ts:364,458,1106-1121` |
| `DEFAULT_TIMEOUT_SEC = 600`, `WING_TIMEOUT_SEC = 900`; same ceiling every round, no retry state | `tools/stark_review_doc.ts:75-76` |
| Per-round `failed_results` in receipt; `exitCode = 1` on any failure; but `ok: !dispatchFailureEarlyExit` stays `true` | `tools/stark_review_doc.ts:1453-1457` |
| Skill Phase 4 hard-aborts on ANY dispatch failure (prose gate, blunt → gets softened in practice) | `skill/stark-review-plan/SKILL.md:235-239` |
| Rounds persist **once, after the loop**; crash loses all rounds + receipt | `tools/stark_review_doc.ts:1418-1426` |
| History dir is per-doc, **no run id → each run clobbers the last** | `tools/stark_review_doc_lib.ts:718-732` |
| Analytics sidecar written end-of-run; write failure swallowed (log-only catch) | `tools/stark_review_doc.ts:1442-1450` |
| PR cycle persists history incrementally per round (`<org>/<repo>/<pr>/round-N.json`) but has **no analytics** | `tools/stark_review.ts:1178-1241,3417` |
| PR cycle: non-final fixes re-reviewed next round; **final round's fix only test-gated** | `skill/stark-review/SKILL.md:327-328` |
| Growth breaker: `max_doc_growth_ratio: 2.0` hard-aborts; `non_convergent` is an independent abort | `tools/stark_review_doc_analytics_lib.ts:142-164` |
| Phase 5 (5a post → 5b hand-fix → 5c summary) is terminal — 5b mutations never reviewed | `skill/stark-review-spec/SKILL.md:258-373` |
| Doc-review per-domain `duration_s` IS persisted per round | `tools/stark_review_doc.ts:1533` |
| Finding classifications exist: doc `ignored/recurring/noise/fix`; PR `fix/noise/false_positive/ignored` | `tools/stark_review_doc_lib.ts:355-391` |

---

# Slice 1 — coverage tracking, timeout escalation, honest reporting (PR 1, ship first)

**Why first:** cheapest, independent, and currently producing false clean bills of health.

### Task 1.1: Pure coverage + timeout helpers in `stark_review_doc_lib.ts`

**Files:**
- Modify: `tools/stark_review_doc_lib.ts` (append after `persistRoundsHistory`, ~line 753)
- Test: `tools/stark_review_doc_lib.test.ts` (extend if exists, else create)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 1.2 and 1.3):
  ```ts
  export interface DomainCoverage {
    attempts: number;
    completions: number;
    timeouts: number;
    last_error: string | null;
  }
  export interface CoverageReport {
    domains: Record<string, DomainCoverage>;
    gaps: string[]; // sorted keys of domains with attempts > 0 && completions === 0
  }
  export function computeCoverage(
    rounds: ReadonlyArray<{ results: ReadonlyArray<{ domain: string; error: string | null }> }>,
    allDomains: readonly string[],
  ): CoverageReport;
  export function nextDomainTimeout(currentSec: number, baseSec: number): number; // min(base*3, current*2)
  export function scaleTimeoutForDocSize(baseSec: number, docChars: number): number;
  export const TIMEOUT_SCALE_CHARS = 16_000; // 1× at ≤16k chars, linear up, capped at 3× base
  export function deriveRunOutcome(opts: {
    dispatchFailureEarlyExit: boolean;
    coverageGaps: readonly string[];
  }): { ok: boolean; exitCode: 0 | 1; error: { code: string; message: string } | null };
  ```

- [ ] **Step 1: Write failing tests** in `tools/stark_review_doc_lib.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCoverage, nextDomainTimeout, scaleTimeoutForDocSize, deriveRunOutcome,
} from "./stark_review_doc_lib.ts";

test("computeCoverage: clean run has no gaps", () => {
  const rounds = [{ results: [{ domain: "viability", error: null }, { domain: "security", error: null }] }];
  const c = computeCoverage(rounds, ["viability", "security"]);
  assert.deepEqual(c.gaps, []);
  assert.equal(c.domains.viability!.completions, 1);
});

test("computeCoverage: domain that only ever timed out is a gap", () => {
  const rounds = [
    { results: [{ domain: "viability", error: "timeout" }, { domain: "security", error: null }] },
    { results: [{ domain: "viability", error: "timeout" }, { domain: "security", error: null }] },
  ];
  const c = computeCoverage(rounds, ["viability", "security"]);
  assert.deepEqual(c.gaps, ["viability"]);
  assert.equal(c.domains.viability!.timeouts, 2);
  assert.equal(c.domains.viability!.last_error, "timeout");
});

test("computeCoverage: timeout then success is NOT a gap (transient)", () => {
  const rounds = [
    { results: [{ domain: "viability", error: "timeout" }] },
    { results: [{ domain: "viability", error: null }] },
  ];
  const c = computeCoverage(rounds, ["viability"]);
  assert.deepEqual(c.gaps, []);
  assert.equal(c.domains.viability!.timeouts, 1);
  assert.equal(c.domains.viability!.completions, 1);
});

test("computeCoverage: parse_error-only domain is a gap", () => {
  const c = computeCoverage([{ results: [{ domain: "ssot", error: "parse_error" }] }], ["ssot"]);
  assert.deepEqual(c.gaps, ["ssot"]);
});

test("nextDomainTimeout escalates 600→1200→1800 and caps at 3× base", () => {
  assert.equal(nextDomainTimeout(600, 600), 1200);
  assert.equal(nextDomainTimeout(1200, 600), 1800);
  assert.equal(nextDomainTimeout(1800, 600), 1800);
});

test("scaleTimeoutForDocSize: 1× small docs, linear growth, 3× cap", () => {
  assert.equal(scaleTimeoutForDocSize(600, 8_000), 600);
  assert.equal(scaleTimeoutForDocSize(600, 28_000), 1050);
  assert.equal(scaleTimeoutForDocSize(600, 200_000), 1800);
});

test("deriveRunOutcome: gaps → ok=false, exit 1, coverage_gap error", () => {
  const r = deriveRunOutcome({ dispatchFailureEarlyExit: false, coverageGaps: ["viability"] });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.error!.code, "coverage_gap");
});

test("deriveRunOutcome: transient-only failures → ok=true, exit 0", () => {
  const r = deriveRunOutcome({ dispatchFailureEarlyExit: false, coverageGaps: [] });
  assert.deepEqual(r, { ok: true, exitCode: 0, error: null });
});
```

- [ ] **Step 2: Run to verify failure:** `cd tools && node --experimental-strip-types --test stark_review_doc_lib.test.ts` → FAIL (exports missing).
- [ ] **Step 3: Implement** in `tools/stark_review_doc_lib.ts`:

```ts
// ─── Coverage + adaptive timeouts (slice 1) ─────────────────────────────

export interface DomainCoverage {
  attempts: number;
  completions: number;
  timeouts: number;
  last_error: string | null;
}

export interface CoverageReport {
  domains: Record<string, DomainCoverage>;
  gaps: string[];
}

/** Aggregate per-domain completion across every round of a run. A domain
 * that was attempted but never completed in ANY round is a coverage gap —
 * the review it was responsible for never happened. */
export function computeCoverage(
  rounds: ReadonlyArray<{ results: ReadonlyArray<{ domain: string; error: string | null }> }>,
  allDomains: readonly string[],
): CoverageReport {
  const domains: Record<string, DomainCoverage> = {};
  for (const d of allDomains) domains[d] = { attempts: 0, completions: 0, timeouts: 0, last_error: null };
  for (const round of rounds) {
    for (const r of round.results) {
      const c = domains[r.domain] ?? (domains[r.domain] = { attempts: 0, completions: 0, timeouts: 0, last_error: null });
      c.attempts++;
      if (r.error === null) c.completions++;
      else {
        if (r.error === "timeout") c.timeouts++;
        c.last_error = r.error;
      }
    }
  }
  const gaps = Object.keys(domains)
    .filter((d) => domains[d]!.attempts > 0 && domains[d]!.completions === 0)
    .sort();
  return { domains, gaps };
}

/** Doubling escalation capped at 3× base: 600 → 1200 → 1800 → 1800. */
export function nextDomainTimeout(currentSec: number, baseSec: number): number {
  return Math.min(baseSec * 3, currentSec * 2);
}

export const TIMEOUT_SCALE_CHARS = 16_000;

/** Scale the base lead timeout with document size: 1× up to 16k chars,
 * linear above, capped at 3× base. A 200-line spec reviews fine at 600s;
 * a 700-line plan starved at the same ceiling. */
export function scaleTimeoutForDocSize(baseSec: number, docChars: number): number {
  const scaled = Math.round(baseSec * (docChars / TIMEOUT_SCALE_CHARS));
  return Math.min(baseSec * 3, Math.max(baseSec, scaled));
}

/** Single source of truth for run outcome: coverage gaps are a failed run. */
export function deriveRunOutcome(opts: {
  dispatchFailureEarlyExit: boolean;
  coverageGaps: readonly string[];
}): { ok: boolean; exitCode: 0 | 1; error: { code: string; message: string } | null } {
  if (opts.dispatchFailureEarlyExit) {
    return {
      ok: false,
      exitCode: 1,
      error: { code: "dispatch_failure", message: "All lead reviewers failed in a round; see rounds[].failed_results" },
    };
  }
  if (opts.coverageGaps.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      error: { code: "coverage_gap", message: `domains never completed a review in any round: ${opts.coverageGaps.join(", ")}` },
    };
  }
  return { ok: true, exitCode: 0, error: null };
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** `feat(review-doc): coverage + adaptive-timeout helpers`.

### Task 1.2: Wire coverage + escalation into the dispatcher

**Files:**
- Modify: `tools/stark_review_doc.ts` — `runLeadReview` (~735), round loop (~1090), final round (~1361), receipt assembly (~1453-1478), `errorReceipt` (~1599), Receipt type (~930-983), stderr summary (~1793-1800)

**Interfaces:**
- Consumes: Task 1.1 exports.
- Produces (receipt schema additions relied on by Task 1.4 and slices 2/3):
  ```ts
  interface Receipt {
    // ... existing ...
    coverage: Record<string, DomainCoverage>;
    coverage_gaps: string[];
  }
  ```
  `runLeadReview` opts change: `timeoutSec: number` → `timeoutSecFor: (domain: string) => number`.

- [ ] **Step 1:** Change `runLeadReview` opts to `timeoutSecFor` and pass `timeoutSec: opts.timeoutSecFor(domain)` at both reviewer call sites (`:765,771`).
- [ ] **Step 2:** In `dispatchDocReview`, before the round loop:

```ts
const effectiveBase = scaleTimeoutForDocSize(opts.leadTimeoutSec, originalDoc.length);
if (effectiveBase !== opts.leadTimeoutSec) {
  log(`lead timeout scaled for doc size: ${opts.leadTimeoutSec}s → ${effectiveBase}s (${originalDoc.length} chars)`);
}
const domainTimeouts = new Map<string, number>(domainKeys.map((d) => [d, effectiveBase]));
const timeoutSecFor = (d: string): number => domainTimeouts.get(d) ?? effectiveBase;
```

Pass `timeoutSecFor` to every `runLeadReview` call (round loop `:1101`, final round `:1373`). After each `runLeadReview` result set (both call sites):

```ts
for (const r of leadResults) {
  if (r.error === "timeout") {
    const cur = domainTimeouts.get(r.domain) ?? effectiveBase;
    const next = nextDomainTimeout(cur, effectiveBase);
    if (next > cur) log(`timeout escalation: ${r.domain} ${cur}s → ${next}s on next attempt`);
    domainTimeouts.set(r.domain, next);
  }
}
```

- [ ] **Step 3:** Replace outcome derivation (`:1453-1457`):

```ts
const coverageReport = computeCoverage(receiptRounds, domainKeys);
const outcome = deriveRunOutcome({
  dispatchFailureEarlyExit,
  coverageGaps: coverageReport.gaps,
});
```

Receipt gains `coverage: coverageReport.domains`, `coverage_gaps: coverageReport.gaps`, `ok: outcome.ok`, `error: outcome.error`; return `exitCode: outcome.exitCode`. Delete `anyFailedResults`. `errorReceipt` early-exit paths set `coverage: {}`, `coverage_gaps: []`.

- [ ] **Step 4:** Stderr summary line (`:1799`) appends `coverage_gaps=${receipt.coverage_gaps.join(",") || "none"}`.
- [ ] **Step 5:** `cd tools && npm run typecheck` → clean. Commit `feat(review-doc): per-domain coverage + timeout escalation in dispatch`.

### Task 1.3: Analytics knows about coverage

**Files:**
- Modify: `tools/stark_review_doc_analytics_lib.ts` — `HealthFlag` union (~55), `buildAnalytics` opts + output (~203-250), `renderAnalyticsMarkdown` (~257+)
- Modify: `tools/stark_review_doc.ts` — `buildAnalytics` call site (~1431)
- Test: `tools/stark_review_doc_analytics_lib.test.ts` (extend)

**Interfaces:**
- Produces: `HealthFlag` gains `"coverage_gap"`; `ReviewAnalytics` gains `coverage_gaps: string[]`; `buildAnalytics` opts gain `coverageGaps: string[]`.
- Grade rule: any flag ⇒ ≥ `degraded` (existing `gradeFromFlags` behavior); `coverage_gap` must never grade `healthy`. `runaway` unchanged.

- [ ] **Step 1: Failing test:** a run with `coverageGaps: ["viability"]` and otherwise healthy stats → `analytics.grade === "degraded"`, `flags` include `"coverage_gap"`, `coverage_gaps` deep-equals `["viability"]`.
- [ ] **Step 2:** Implement: add flag when `opts.coverageGaps.length > 0`; thread into output; markdown render adds a **Coverage** section (`- **Coverage gap:** viability — 0/3 rounds completed (3 timeouts)` per gap, `- **Coverage:** all N domains completed` otherwise; per-domain counts come from receipt, pass them in as `coverage: Record<string, DomainCoverage>`).
- [ ] **Step 3:** Tests pass; commit `feat(review-doc): coverage gaps cap the analytics grade`.

### Task 1.4: Re-key the skill gates + docs

**Files:**
- Modify: `skill/stark-review-spec/SKILL.md` (Phase 3 exit codes ~199-206 equivalent, Phase 4 ~227-257, 5c summary ~351-366)
- Modify: `skill/stark-review-plan/SKILL.md` (same phases, `:183-240,335-353`)
- Modify: `CLAUDE.md` (stark_review_doc.ts bullet + the two skill bullets)

**Interfaces:** Consumes receipt fields `coverage_gaps`, `coverage`, `ok`, `error` from Task 1.2.

- [ ] **Step 1:** Phase 3 exit-code doc becomes: `0` — ok (transient dispatch failures allowed if every domain completed at least once); `1` — terminal failure OR coverage gap; `2` — bad CLI arguments.
- [ ] **Step 2:** Phase 4 parse block — replace the FAILED_LIST hard-fail with:

```bash
GAPS=$(parse 'out.push(((d.coverage_gaps)||[]).join(", "));')
TRANSIENT=$(parse '
const gaps=new Set(d.coverage_gaps||[]);
for (const r of (d.rounds||[]))
  for (const f of (r.failed_results||[]))
    if (!gaps.has(f.domain)) out.push(`round ${r.round}: ${f.agent}/${f.domain} — ${f.error}`);
')

failed=0
if [ "$OK" = "false" ]; then error "Review failed: $ERR_CODE — $ERR_MSG"; failed=1; fi
if [ -n "$GAPS" ]; then error "COVERAGE GAP — these domains never completed a review in any round: $GAPS"; failed=1; fi
if [ -n "$TRANSIENT" ]; then warn "Transient dispatch failures (domain recovered in another round):"; printf '  %s\n' "$TRANSIENT" >&2; fi
if [ -n "$WING_ERRORS" ]; then error "Wing fixer issues:"; printf '  %s\n' "$WING_ERRORS" >&2; failed=1; fi
[ "$failed" -ne 0 ] && exit 1
```

(Blocking = `ok=false` / coverage gap / wing errors. Transient failures warn and continue — this removes the incentive to soften the gate.)
- [ ] **Step 3:** 5c wing summary gains a coverage line: `Coverage: all {N} domains completed` or `⚠️ COVERAGE GAP: {domain} (0/{attempts}, {timeouts} timeouts)` — sourced from receipt.
- [ ] **Step 4:** CLAUDE.md: document coverage/escalation in the `stark_review_doc.ts` entry and both skill bullets. Commit `feat(review-skills): coverage-gap gate replaces any-failure abort`.

### Task 1.5: Live validation (required before PR is marked ready)

- [ ] **Step 1 — forced gap:** in a throwaway git repo with a tiny committed doc:

```bash
node --experimental-strip-types ~/Code/21Stark/stark-skills/tools/stark_review_doc.ts \
  --doc docs/specs/tiny.md --prompts-dir spec-review --repo-dir . \
  --prompts-base ~/Code/21Stark/stark-skills/global/prompts \
  --lead-timeout 5 --rounds 1 --dry-run
```

Expected: every domain times out at 5s; receipt has `ok:false`, `error.code:"coverage_gap"`, all domains in `coverage_gaps`, exit code 1; escalation log lines `5s → 10s` appear before the final-review round.
- [ ] **Step 2 — clean run:** same doc, `--lead-timeout 600 --rounds 1` (no `--dry-run`): `ok:true`, `coverage_gaps: []`, exit 0, analytics sidecar shows "all domains completed", grade `healthy`.
- [ ] **Step 3:** `cd tools && npm test` green, `npm run typecheck` clean.

---

# Slice 2 — run-record durability + analytics everywhere (PR 2)

### Task 2.1: Per-run history dirs (stop the clobbering)

**Files:**
- Modify: `tools/stark_review_doc_lib.ts` — `buildHistoryDir` (`:718-732`), `persistRoundsHistory` (`:734-753`)
- Modify: `tools/stark_review_doc.ts` — call sites (`:1413-1426,1444-1446`)
- Test: `tools/stark_review_doc_lib.test.ts`

**Interfaces:**
```ts
export function newRunId(now?: Date): string;              // "20260714-153012-<pid>"
export function buildHistoryDir(opts: {
  home: string; promptsDir: string; docPath: string; runId: string; // runId NEW, required
}): string;                                                  // <base>/<slug>/<runId>
export function updateLatestPointer(slugDir: string, runId: string): void; // atomic symlink swap; best-effort on FS without symlinks (writes latest.txt)
export function pruneRunDirs(slugDir: string, keep: number): string[];      // returns pruned run-ids, mtime-desc keep
```
- Receipt gains `run_id: string`; `history_dir` now points at the run dir.
- Config: `history_keep_runs: number` added to `DocReviewConfig` (default `20`).
- **Consumer sweep (same PR):** `skill/stark-review-improvement/SKILL.md:39-68` ("most recent history directory" → resolve `<slug>/latest`, fallback newest-mtime run dir), `skill/stark-phase-execute/SKILL.md:67,431` (same), `skill/stark-review-spec-improvement/SKILL.md` (inherits), `tools/spec_review_summary.ts` if it reads history (verify with `rg -n "history" tools/spec_review_summary.ts`).

- [ ] Tests: `buildHistoryDir` includes runId; `updateLatestPointer` repoint is atomic (old target still resolvable until rename); `pruneRunDirs` keeps N newest, never touches `latest`; two sequential run ids never collide (pid + seconds).
- [ ] Implement, typecheck, commit `feat(review-doc): per-run history dirs with latest pointer + retention`.

### Task 2.2: Incremental persistence (crash leaves partials, not nothing)

**Files:**
- Modify: `tools/stark_review_doc.ts` — round loop (`:1090-1275`), coherence (`:1277-1359`), final round (`:1361-1411`), end-of-run (`:1413-1450`)

**Interfaces:**
- New helper in the CLI file:
  ```ts
  function persistRunSnapshot(opts: {
    historyDir: string; docPath: string; promptsDir: string;
    rounds: PersistedRound[]; models: Record<string, string>;
    analytics: ReviewAnalytics | null;   // partial until final
    phase: "round" | "coherence" | "final";
  }): string | null;                     // error message on failure, null on success
  ```
  Behavior: `mkdir -p` once at run start; after **every** `persistedRounds.push(...)` and after coherence, rewrite `rounds.json` + `analytics.json` via tmp-file + `fs.renameSync` (atomic); partial analytics carry `"partial": true` until the final write. At end: also write `receipt.json` (full receipt — today it exists only on stdout) and the `<doc>.review-analytics.md` sidecar (existing behavior).
- Receipt gains `persistence_errors: string[]` — every failed write appends `"{phase}: {message}"`; the skill Phase 4 prints them as warnings (never blocks, but never silent).
- The `historyDir` is computed **before** the round loop (needs Task 2.1's `runId`).

- [ ] Test (unit): `persistRunSnapshot` writes atomically (no partial JSON on simulated interrupt — write to tmp then rename asserted via injected fs errors), error string returned on EACCES.
- [ ] Live: run a real 1-round review, `kill -9` the process mid-round-2 of a 2-round run, verify `rounds.json` holds round 1 + `analytics.json` has `"partial": true`. Then a clean run: `receipt.json` present, `partial` absent.
- [ ] Commit `feat(review-doc): incremental round+analytics persistence, receipt.json in history`.

### Task 2.3: PR-cycle analytics parity

**Files:**
- Modify: `tools/stark_review_doc_analytics_lib.ts` — add `buildCodeReviewAnalytics`
- Modify: `tools/stark_review.ts` — receipt assembly (`:3105-3135`), history writer area (`:1178-1241`)
- Test: `tools/stark_review_doc_analytics_lib.test.ts`

**Interfaces:**
```ts
export interface CodeReviewAnalytics {
  kind: "code-review";
  repo: string; pr: number; run_at: string;
  grade: HealthGrade; flags: HealthFlag[];
  coverage_gaps: string[];                     // domains that never completed
  per_domain: Record<string, {
    attempts: number; completions: number; timeouts: number;
    total_duration_s: number;
    findings_by_classification: Record<string, number>; // fix/noise/false_positive/ignored
  }>;
  total_duration_s: number;
  rounds: number;
}
export function buildCodeReviewAnalytics(opts: {
  repo: string; pr: number; runAt: string;
  rounds: readonly ReceiptRound[]; // the existing PR-cycle round type, tools/stark_review.ts:2012
}): CodeReviewAnalytics;
```
- Written to `historyDir(home, repo, pr)/analytics.json` (same per-PR dir the round files use — additive; `stark_review.history.test.ts` fixtures untouched) + rendered `analytics.md`, and embedded in the receipt as `analytics`.
- Growth ratios are doc-review concepts — deliberately absent here; the shared `HealthGrade`/`HealthFlag` types are reused so `/stark-review-improvement` reads one vocabulary.
- Write failure → receipt `persistence_errors` (same contract as Task 2.2).

- [ ] Test: rounds with one never-completing domain → `coverage_gaps` nonempty, grade `degraded`; classification counts aggregate across rounds; durations sum.
- [ ] Live: run `/stark-review`'s dispatcher against a real small PR (draft PR on this repo works), verify `analytics.json` + `analytics.md` in the per-PR history dir and the receipt `analytics` block.
- [ ] Commit `feat(stark-review): process analytics for the PR cycle`.

### Task 2.4: Resume design note (design-only in this slice)

- [ ] Add `docs/specs/review-run-resume-2026-07-XX.md` stub is **NOT** written — instead the plan-of-record is: resume consumes `receipt.json` + `rounds.json` from the newest run dir; resume unit = round; preconditions: same doc SHA as `rounds.json`'s last `fix.commit_sha`, clean worktree. Implementation is deferred to its own PR after slices 1–3 land; do not build it inside slice 2.

---

# Slice 3 — convergence pass + phase-contract change (PR 3)

**ADR:** `docs/adr/0022-convergence-pass-terminal-phase.md` (lands with the plan PR; status flips to Accepted when this slice merges).

### Task 3.1: Record where "last reviewed" is

**Files:**
- Modify: `tools/stark_review_doc.ts` — after final round (`:1411`), receipt type + assembly

**Interfaces:**
- Receipt gains `last_reviewed_sha: string | null` (HEAD after the final review-only round; the final round reviewed `currentDoc`, which equals HEAD when `commitFixes` is on) and `final_reviewed_doc: "final-reviewed-doc.md"` — the reviewed content snapshot written into the run history dir (robust when fixes weren't committed).

```ts
let lastReviewedSha: string | null = null;
if (!opts.dryRun) {
  const head = await runGit(["rev-parse", "HEAD"], opts.repoDir, 15);
  lastReviewedSha = head.code === 0 ? head.stdout.trim() : null;
  // snapshot the exact reviewed content into the run dir
  fs.writeFileSync(path.join(historyDir, "final-reviewed-doc.md"), currentDoc);
}
```

- [ ] Commit `feat(review-doc): record last-reviewed SHA + doc snapshot`.

### Task 3.2: `--converge` mode in the dispatcher

**Files:**
- Modify: `tools/stark_review_doc.ts` — CLI args (`:1726+`), new `dispatchConvergence` function
- Create: `global/prompts/spec-review/convergence.md`, `global/prompts/plan-review/convergence.md`
- Test: `tools/stark_review_doc_lib.test.ts` (prompt builder), live validation below

**Interfaces:**
- CLI: `--converge --base <sha> [--doc ... --prompts-dir ... --repo-dir ... --prompts-base ...]`. Mutually exclusive with the fix-loop flags (`--rounds`, `--no-coherence`).
- Behavior: `git diff <base>..HEAD -- <docPath>` + full current doc → **one** lead dispatch (same lead agent/model resolution, `timeoutSecFor` from slice 1 with the doc-size scale) using `convergence.md`; findings parse with the existing `parseReviewerOutput`; emits a normal `Receipt` whose single round has `kind: "convergence"` and `domain: "convergence"` per finding — so `review_doc_findings.ts post/resolve` work **unchanged**.
- Empty diff → `ok: true`, zero findings, summary string `"converged: empty delta"` in the receipt error=null path; still writes analytics (`convergence` round in the run dir — reuses the run-id layout from slice 2 with a fresh run id).
- `convergence.md` prompt contract (both prompts-dirs, shared body): reviews ONLY the delta for (1) contradictions with unchanged text, (2) broken cross-references, (3) claims the rest of the document now falsifies, (4) findings "resolved" in prose but not substance; outputs the standard findings JSON; explicitly instructed that zero findings is a valid, expected output.

**Bounded recursion (owned by the skill, Task 3.3):** one convergence pass; a second only if the first produced `high`/`critical`; never a third.

- [ ] Live validation (the reproduction from the incident): take a reviewed doc, hand-edit a contradiction in after the final round (e.g. change a commit-branching rule in one section, leave the "no X anywhere" claim in another), commit, run `--converge --base <last_reviewed_sha>` → the contradiction comes back as a finding. Then revert, run again → zero findings, `converged: empty delta`.
- [ ] Commit `feat(review-doc): --converge mode — diff-scoped terminal review`.

### Task 3.3: Skills get Phase 6 (converge) — phase contract change

**Files:**
- Modify: `skill/stark-review-spec/SKILL.md`, `skill/stark-review-plan/SKILL.md` — new Phase 6 after 5b/5c; summary claims move to Phase 6
- Modify: `CLAUDE.md` — both skill bullets + pipeline description

**Contract (from ADR 0022):**
1. Phase 5 (post / fix / resolve) runs exactly as today, including 5b manual fixes and pushes.
2. **Phase 6 — Converge:** run `--converge --base <receipt.last_reviewed_sha>`; post its findings via `review_doc_findings.ts post` (same map file, same per-App authorship); fix + resolve each (5b rules apply, including AskUserQuestion on ambiguity); if any finding was `high`/`critical`, run one more converge over the new delta; then post the summary.
3. Summary states the convergence claim explicitly: `Converged — delta reviewed, N findings (all resolved)` or `Converged — delta reviewed, clean`. A run that skipped convergence (dispatch failure) must say so: `NOT converged — delta unreviewed`.

- [ ] Update both SKILL.mds with exact bash (converge invocation + findings loop reusing the 5a/5b blocks by reference), renumber "Debugging" section anchors, update the skill frontmatter description lines.
- [ ] Flip ADR 0022 status to Accepted. Commit `feat(review-skills): convergence pass is the terminal phase (ADR 0022)`.

### Task 3.4: PR cycle — final fix gets reviewed

**Files:**
- Modify: `tools/stark_review.ts` — after the fix loop / test gate, before receipt assembly (`:3105`)
- Create: `global/prompts/codex/convergence.md` (PR-review flavor: reviews a code diff, not a doc)

**Interfaces:**
- New receipt block `convergence: { ran: boolean; base_sha: string | null; findings: number; posted: boolean; error: string | null } | null`.
- Behavior: if the **final** round applied fixes (commits exist after the last full review), run one review dispatch over `git diff <sha-before-final-fix>..HEAD` with `convergence.md`; findings post through the existing posting path (classification pipeline unchanged); findings ≥ `fix_threshold` trigger ONE fixer pass + test gate; no further recursion. Non-final rounds are untouched (already re-reviewed by the next round).
- [ ] Live: run against a real PR where the final round applies a fix; verify the convergence block in the receipt and the posted findings.
- [ ] Commit `feat(stark-review): convergence review of the final round's fix`.

---

# Slice 4 — growth breaker: warn on growth, stop on growth+non-convergence (PR 4)

### Task 4.1: Composite signal in the analytics lib

**Files:**
- Modify: `tools/stark_review_doc_analytics_lib.ts` — `evaluateGuards` (`:122-164`), grade mapping (`:170`)
- Test: `tools/stark_review_doc_analytics_lib.test.ts`

**Interfaces:**
- `evaluateGuards` return gains `growth_ack_required: boolean`.
- New behavior matrix (thresholds unchanged, `max_doc_growth_ratio: 2.0`, `non_convergent_rounds: 2`):

| Signal state | Today | New |
|---|---|---|
| growth > 2× alone | **abort**, grade runaway | flag `runaway_growth`, `growth_ack_required: true`, **no abort**, grade `degraded` |
| findings non-declining alone | abort, grade runaway | unchanged (abort — the wing is spinning) |
| growth > 2× AND non-declining | abort | abort, reason names both signals |

- [ ] Tests: three matrix rows asserted (abort flag, reason text, grade, ack flag). The incident case (2.63× growth, findings declining) → no abort, `degraded`, ack required.
- [ ] Commit `fix(review-doc): growth alone warns; growth+non-convergence hard-stops`.

### Task 4.2: Operator ack at the skill layer

**Files:**
- Modify: `tools/stark_review_doc.ts` — thread `growth_ack_required` into the receipt + analytics
- Modify: `skill/stark-review-spec/SKILL.md`, `skill/stark-review-plan/SKILL.md` — Phase 4 addition
- Modify: `CLAUDE.md`

**Contract:** when receipt `analytics.growth_ack_required` is true, the skill STOPS before Phase 5 and asks the operator via `AskUserQuestion`: "Doc grew {ratio}× (limit 2×) but findings are declining — legitimate gap-filling or padding?" Options: **Continue (growth is legitimate)** / **Stop here (inspect the doc)**. The answer is recorded in the 5c summary (`growth acked by operator` / run stopped). Headless contexts (automation fleet) treat missing ack as Stop.

- [ ] Live: rerun a spec review over the incident doc (or any thin doc that legitimately >2×'s); verify no abort, ack question fires, run completes after ack, summary carries the ack line.
- [ ] Commit `feat(review-skills): operator ack for growth warnings`.

---

## Analytics contract — enforcement map

| Requirement | Enforced by |
|---|---|
| Every run leaves a record (spec/plan/PR) | Slice 2 (2.1–2.3); convergence runs: slice 3 (3.2, 3.4) |
| Per-run, never clobbered | 2.1 (run-id dirs + latest pointer + retention) |
| Crash-proof | 2.2 (incremental atomic writes) |
| Write failures surfaced | 2.2/2.3 (`persistence_errors` in receipts) |
| Time + signal/noise content | 2.3 (`per_domain` durations, classification counts); slice 1 (coverage feeds grade) |
| Schema-stable input for `/stark-review-improvement` | 2.1 consumer sweep + `kind` discriminator on analytics JSON |

## Validation matrix (test live — per slice, before ready-for-review)

| Slice | Live proof |
|---|---|
| 1 | Forced-timeout run → `coverage_gap` receipt, exit 1, grade cap; clean run → `ok`, exit 0 |
| 2 | `kill -9` mid-run → partials on disk; clean run → `receipt.json` + analytics; PR-cycle run → analytics in per-PR dir |
| 3 | Hand-edited contradiction after final round → converge catches it; revert → `converged: empty delta`; PR cycle final-fix diff reviewed |
| 4 | Incident-shaped doc (2.6× growth, declining findings) → no abort, ack flow, completed run |

## Risks / notes

- **Exit-code semantic change (slice 1):** transient failures no longer exit 1. Swept consumers: both doc-review SKILL.md Phase 3/4 (updated in-slice); `review_doc_findings.ts` ignores exit codes (reads receipt); automation fleet prompts reference `/stark-review` not the doc dispatcher (verify with `rg -l "stark_review_doc" automation/` in-slice).
- **History layout change (slice 2)** breaks any hardcoded `<slug>/rounds.json` reader — the consumer sweep in 2.1 is mandatory, and `latest` keeps one-hop compatibility.
- **Convergence cost (slice 3):** one lead dispatch per run (two worst-case). Diff-scoped prompt keeps tokens small. Acceptable per the analytics-contract economics; measured by slice 2's analytics.
- **marketplace-sync:** each merged slice republishes plugins; installed-plugin behavior lags merge until `/plugin update` — live validation always runs the repo checkout directly.
