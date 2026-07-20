// `tools/forge_state_lib.ts` — the pure, deterministic, I/O-free state-machine
// core for the `/stark-forge` pipeline orchestrator.
//
// HARD CONSTRAINTS (spec §5/§6, plan §2.5 "Global Constraints"):
//   - No clock: every timestamp is a host-supplied `at: string` param; this file
//     never reads the wall clock.
//   - No LLM calls, no git, no disk I/O, no network. It imports nothing from the
//     filesystem, the state-root resolver, or the write-spec history helpers.
//     All persistence lives in the host module `tools/forge_state.ts`.
//   - Every mutating function returns a NEW `RunState` (input left untouched).
//
// The transition-throw style mirrors `tools/github_projects_lib.ts`
// (`isLegalTransition` / `LEGAL_TRANSITIONS` / `transitionStatus`).

// ---------------------------------------------------------------------------
// Types & enums (T1 — spec §5)
// ---------------------------------------------------------------------------

/** The 8-value closed stage enum (spec §5, plan §2.5). */
export type Stage =
  | "write-spec"
  | "review-spec"
  | "red-team-spec"
  | "spec-to-plan"
  | "review-plan"
  | "red-team-plan"
  | "plan-to-tasks"
  | "copilot";

export type StageStatus = "pending" | "running" | "halted" | "done" | "failed";

export type MergePoint = {
  after_stage: Stage;
  artifact: "spec" | "plan" | "impl";
};

export type Attempt = {
  started_at: string;
  ended_at: string | null;
  outcome: "halted" | "failed" | "crashed";
};

/** Spec's closed artifact shape — NO completion boolean (spec §5, plan §2.5). */
export type StageArtifacts = {
  spec_path?: string;
  plan_path?: string;
  plan_slug?: string;
  issue_numbers?: number[];
};

/** Injected PR-state reader — the sole external dependency (spec §7). */
export type PrReader = (pr: number) => "open" | "merged" | "closed";

export type Gate = { reason: string; detail: string };

export type MergeRecord = { pr: number; merged_by_forge: boolean };

export type StageRecord = {
  stage: Stage;
  status: StageStatus;
  prs: number[];
  merges: MergeRecord[];
  fold_prs: number[];
  artifacts: StageArtifacts;
  gate: Gate | null;
  started_at: string | null;
  ended_at: string | null;
  attempts: Attempt[];
};

export type RepoIdentity = { host: string; owner: string; name: string };

export type RunInput = {
  kind: "intent" | "spec-path" | "plan-path";
  value: string;
};

export type InitialArtifacts = {
  spec_path?: string;
  plan_path?: string;
  plan_slug?: string;
};

export type ArtifactPrs = { spec?: number[]; plan?: number[]; impl?: number[] };

export type RunState = {
  slug: string;
  run_id: string;
  input: RunInput;
  initial_artifacts: InitialArtifacts;
  mode: "in-session" | "driver";
  chain: Stage[];
  merge_points: MergePoint[];
  artifact_prs: ArtifactPrs;
  repo: RepoIdentity;
  default_branch: string;
  created_at: string;
  updated_at: string;
  abandoned_at?: string | null;
  stages: StageRecord[];
};

/**
 * The action a resume must take at the target stage (Phase 4, T1). The pure lib
 * computes exactly one per reachable non-abandoned state:
 *   - `reinvoke`  — re-enter the stage skill (checkpoint absent / plan-to-tasks
 *                   marker absent); executor first does the `failed→running` CAS.
 *   - `advance`   — enter the next `pending` stage (executor does `pending→running`).
 *   - `complete`  — the sliced chain is fully `done`; nothing left to run.
 *   - `merge_only`— checkpointed merge-point stage short of all merges (or an
 *                   open fold PR): retry ONLY the merge, never the stage skill.
 *   - `abandon`   — a documented dead end (author PR merged early / a registry PR
 *                   closed): no in-run continuation; operator runs `abandon`.
 */
export type ResumeAction =
  | "reinvoke"
  | "advance"
  | "complete"
  | "merge_only"
  | "abandon";

/**
 * The resume descriptor — the SOLE command/routing channel both executors (the
 * Phase 5 driver renderer, the Phase 6 in-session SKILL.md) consume. `command`
 * and `requires_base_sync` are populated by the pure lib alone (via
 * `renderStageCommand`/`requiresBaseSync`); executors never call those helpers.
 */
export type ResumeTarget = {
  run_id: string;
  slug: string;
  target_stage: Stage;
  action: ResumeAction;
  reconciled: boolean;
  requires_base_sync: boolean;
  command: string | null;
};

/** Resolved-run descriptor consumed by `initializeRun` (T7). */
export type ResolvedRun = {
  chain: Stage[];
  mergePoints: MergePoint[];
  slug: string;
  input: RunInput;
  initial_artifacts: InitialArtifacts;
  repo: RepoIdentity;
  default_branch: string;
};

// ---------------------------------------------------------------------------
// Errors — coded, so the CLI/tests can assert on `error.code`.
// ---------------------------------------------------------------------------

export class ForgeStateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ForgeStateError";
  }
}

function err(code: string, message: string): ForgeStateError {
  return new ForgeStateError(code, message);
}

// ---------------------------------------------------------------------------
// Static stage classification (T4)
// ---------------------------------------------------------------------------

/** Which artifact a stage's PR belongs to (null = produces no mergeable PR). */
export function stageArtifact(stage: Stage): "spec" | "plan" | "impl" | null {
  switch (stage) {
    case "write-spec":
    case "review-spec":
    case "red-team-spec":
      return "spec";
    case "spec-to-plan":
    case "review-plan":
    case "red-team-plan":
      return "plan";
    case "copilot":
      return "impl";
    case "plan-to-tasks":
      return null;
  }
}

/**
 * The single owner of the base-sync routing rule (plan §2.5): true EXACTLY for
 * the new-artifact stages that must run against updated `main`.
 */
export function requiresBaseSync(stage: Stage): boolean {
  return (
    stage === "spec-to-plan" ||
    stage === "plan-to-tasks" ||
    stage === "copilot"
  );
}

/**
 * Fields §4 requires each stage to record before it may reach `done`
 * (checked by the `running → done` gate; reused by reconciliation).
 */
export function requiredOutputsFor(stage: Stage): string[] {
  switch (stage) {
    case "write-spec":
      return ["spec_path"];
    case "spec-to-plan":
      return ["plan_path", "plan_slug"];
    case "plan-to-tasks":
      return ["issue_numbers"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Transition matrix (T2 — spec §6)
// ---------------------------------------------------------------------------

export const LEGAL_TRANSITIONS: Readonly<
  Record<StageStatus, ReadonlySet<StageStatus>>
> = {
  pending: new Set<StageStatus>(["running"]),
  running: new Set<StageStatus>(["done", "halted", "failed"]),
  halted: new Set<StageStatus>(["running"]),
  failed: new Set<StageStatus>(["running"]),
  done: new Set<StageStatus>(),
};

export function isLegalTransition(from: StageStatus, to: StageStatus): boolean {
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Guard every mutating entry point against an abandoned run. Abandonment is
 * terminal (spec §6: no operation mutates the old run afterward), so
 * `recordOutput`/`transition`/`reconcileRunningStage` reject an abandoned state
 * regardless of the stage's own status (pending/running/…). Only `abandonRun`
 * itself stays reachable — and it is idempotent.
 */
function assertActiveRun(state: RunState, op: string): void {
  if (state.abandoned_at) {
    throw err(
      "run_abandoned",
      `Run '${state.run_id}' (slug '${state.slug}') is abandoned (${state.abandoned_at}); ${op} cannot mutate a terminal run.`,
    );
  }
}

function stageIndex(state: RunState, stage: Stage): number {
  const idx = state.stages.findIndex((s) => s.stage === stage);
  if (idx === -1) {
    throw err(
      "stage_not_in_chain",
      `Stage '${stage}' is not part of this run's chain: ${JSON.stringify(
        state.chain,
      )}`,
    );
  }
  return idx;
}

/** Union two number arrays, dedup, first-seen order preserved. */
function unionDedup(existing: number[], incoming: number[]): number[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const n of incoming) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function isRecorded(value: unknown, field: string): boolean {
  if (field === "issue_numbers") {
    return Array.isArray(value) && value.length > 0;
  }
  return typeof value === "string" && value.length > 0;
}

/**
 * Enforce the `running → done` output/merge/marker gate (T5). Throws on any
 * unmet requirement. Reused by `transition` and `reconcileRunningStage`.
 */
function enforceDoneGate(
  state: RunState,
  stage: Stage,
  readPr?: PrReader,
): void {
  const rec = state.stages[stageIndex(state, stage)];

  // 1. required outputs recorded
  for (const field of requiredOutputsFor(stage)) {
    const value = (rec.artifacts as Record<string, unknown>)[field];
    if (!isRecorded(value, field)) {
      throw err(
        "missing_required_output",
        `Stage '${stage}' cannot reach 'done': required output '${field}' not recorded.`,
      );
    }
  }

  // 2. merge-point gate (registry non-empty, all merged, no open fold)
  const mp = state.merge_points.find((m) => m.after_stage === stage);
  if (mp) {
    if (!readPr) {
      throw err(
        "pr_reader_required",
        `Merge-point stage '${stage}' cannot reach 'done' without a PR-state reader.`,
      );
    }
    const registry = state.artifact_prs[mp.artifact] ?? [];
    if (registry.length === 0) {
      throw err(
        "empty_artifact_prs",
        `Merge-point stage '${stage}' cannot reach 'done': artifact_prs.${mp.artifact} is empty (no vacuous pass).`,
      );
    }
    for (const pr of registry) {
      if (readPr(pr) !== "merged") {
        throw err(
          "merge_pending",
          `Merge-point stage '${stage}' cannot reach 'done': PR #${pr} for '${mp.artifact}' is not merged.`,
        );
      }
    }
    for (const pr of rec.fold_prs ?? []) {
      if (readPr(pr) === "open") {
        throw err(
          "fold_pr_open",
          `Merge-point stage '${stage}' cannot reach 'done': fold PR #${pr} is still open.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// recordOutput — the ONE output/PR-registry mutation owner (T4)
// ---------------------------------------------------------------------------

export function recordOutput(
  state: RunState,
  args: {
    stage: Stage;
    prs?: number[];
    foldPrs?: number[];
    merges?: MergeRecord[];
    artifacts?: Partial<StageArtifacts>;
    at: string;
  },
): RunState {
  assertActiveRun(state, "recordOutput");
  const next = clone(state);
  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];
  const artifact = stageArtifact(args.stage);

  // Output checkpoints are only valid for a RUNNING stage — a completed
  // (done)/pending/halted/failed stage must not append more outputs (e.g. a
  // finished copilot stage cannot register another impl PR after completion).
  if (rec.status !== "running") {
    throw err(
      "stage_not_running",
      `recordOutput requires stage '${args.stage}' to be 'running' (found '${rec.status}').`,
    );
  }

  // A stage that produces no mergeable PR (plan-to-tasks → issues, not a PR)
  // keeps its per-stage `prs`/`fold_prs` permanently empty.
  if (
    artifact === null &&
    ((args.prs && args.prs.length > 0) ||
      (args.foldPrs && args.foldPrs.length > 0))
  ) {
    throw err(
      "no_pr_for_stage",
      `Stage '${args.stage}' produces no PR; prs/fold_prs may not be recorded.`,
    );
  }

  // --- canonical artifact_prs registry (one writing stage per artifact) ---
  if (args.prs && args.prs.length > 0 && artifact !== null) {
    const existing = next.artifact_prs[artifact] ?? [];
    if (existing.length === 0) {
      // opening stage seeds the entry (author stage, or a review stage in a
      // path-based/sliced chain acting as PR opener). spec/plan are the ONE
      // shared PR per artifact — only `impl` (copilot multi-PR) may seed many.
      const seeded = unionDedup([], args.prs);
      if (artifact !== "impl" && seeded.length !== 1) {
        throw err(
          "multiple_seed_prs",
          `Stage '${args.stage}' seeded the '${artifact}' registry with ${seeded.length} PRs; spec/plan allow exactly one shared PR.`,
        );
      }
      next.artifact_prs[artifact] = seeded;
    } else if (artifact === "impl") {
      // incremental union allowed ONLY for the multi-PR impl artifact.
      next.artifact_prs[artifact] = unionDedup(existing, args.prs);
    } else {
      // spec/plan registries are write-once after first PR: a continuation (or
      // crashed-and-re-entering opener) stage may only report PRs already
      // present — a divergent PR forks the one-PR-per-artifact model.
      for (const pr of args.prs) {
        if (!existing.includes(pr)) {
          throw err(
            "adoption_mismatch",
            `Stage '${args.stage}' reported PR #${pr} which does not match the write-once '${artifact}' registry ${JSON.stringify(
              existing,
            )}.`,
          );
        }
      }
      // identical re-report → no change
    }
  }

  // --- per-stage prs (derived observation, union-dedup) ---
  if (args.prs && args.prs.length > 0) {
    rec.prs = unionDedup(rec.prs, args.prs);
  }

  // --- fold_prs (union-dedup) ---
  if (args.foldPrs && args.foldPrs.length > 0) {
    rec.fold_prs = unionDedup(rec.fold_prs, args.foldPrs);
  }

  // --- merges keyed by pr, monotonic (true never overwritten by false) ---
  if (args.merges && args.merges.length > 0) {
    for (const m of args.merges) {
      const found = rec.merges.find((e) => e.pr === m.pr);
      if (!found) {
        rec.merges.push({ pr: m.pr, merged_by_forge: m.merged_by_forge });
      } else if (m.merged_by_forge && !found.merged_by_forge) {
        found.merged_by_forge = true;
      }
      // existing true + incoming false → keep true (monotonic no-op)
    }
  }

  // --- artifacts: scalars write-once, issue_numbers union-dedup ---
  if (args.artifacts) {
    const a = args.artifacts;
    for (const field of ["spec_path", "plan_path", "plan_slug"] as const) {
      const incoming = a[field];
      if (incoming === undefined) continue;
      const current = rec.artifacts[field];
      if (current !== undefined && current !== incoming) {
        throw err(
          "artifact_conflict",
          `Stage '${args.stage}' scalar artifact '${field}' is write-once: '${current}' cannot be overwritten with '${incoming}'.`,
        );
      }
      rec.artifacts[field] = incoming;
    }
    if (a.issue_numbers && a.issue_numbers.length > 0) {
      rec.artifacts.issue_numbers = unionDedup(
        rec.artifacts.issue_numbers ?? [],
        a.issue_numbers,
      );
    }
  }

  // Idempotent re-report: if the patch changed nothing, return an unchanged
  // clone — updated_at is preserved (never bumped by a no-op re-report). `next`
  // was cloned from `state` with the same updated_at, so equality here means
  // no field moved.
  if (JSON.stringify(next) === JSON.stringify(state)) {
    return next;
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// transition — status/gate/timestamps/attempts owner (T2, T3, T5)
// ---------------------------------------------------------------------------

export function transition(
  state: RunState,
  args: {
    stage: Stage;
    expectedStatus?: StageStatus;
    to: StageStatus;
    prs?: number[];
    foldPrs?: number[];
    gate?: Gate;
    artifacts?: Partial<StageArtifacts>;
    at: string;
  },
  readPr?: PrReader,
): RunState {
  assertActiveRun(state, "transition");
  const current = state.stages[stageIndex(state, args.stage)].status;

  // Replay-safe no-op reprint: re-issuing a transition whose `to` already
  // equals the stored status preserves timestamps/attempts (spec §7).
  if (current === args.to) {
    return clone(state);
  }

  // Compare-and-set: commit only when the stored status matches expectation.
  if (args.expectedStatus !== undefined && current !== args.expectedStatus) {
    throw err(
      "expected_status_mismatch",
      `Stage '${args.stage}' expected status '${args.expectedStatus}' but found '${current}'.`,
    );
  }

  if (!isLegalTransition(current, args.to)) {
    const allowed = [...(LEGAL_TRANSITIONS[current] ?? new Set<StageStatus>())];
    throw err(
      "illegal_transition",
      `Illegal transition: '${current}' → '${args.to}' for stage '${args.stage}'. Allowed: ${JSON.stringify(
        allowed,
      )}`,
    );
  }

  // Single-writer discipline: output/PR writes delegate to recordOutput.
  let next =
    args.prs || args.foldPrs || args.artifacts
      ? recordOutput(state, {
          stage: args.stage,
          prs: args.prs,
          foldPrs: args.foldPrs,
          artifacts: args.artifacts,
          at: args.at,
        })
      : clone(state);

  // `running → done` enforces the required-output + merge/marker gate BEFORE
  // committing the status change.
  if (args.to === "done") {
    enforceDoneGate(next, args.stage, readPr);
  }

  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];

  switch (args.to) {
    case "running": {
      // pending→running, or halted/failed→running re-entry. A new episode
      // begins: stamp started_at, clear ended_at + gate, append NOTHING
      // (the prior episode was archived when it ended). prs/fold_prs/artifacts
      // are preserved.
      rec.status = "running";
      rec.started_at = args.at;
      rec.ended_at = null;
      rec.gate = null;
      break;
    }
    case "done": {
      rec.status = "done";
      rec.ended_at = args.at;
      // running→done archives nothing (its timing lives in started/ended_at).
      break;
    }
    case "halted":
    case "failed": {
      if (!args.gate || !args.gate.reason) {
        throw err(
          "gate_required",
          `Transition '${current}' → '${args.to}' for stage '${args.stage}' requires a gate {reason, detail}.`,
        );
      }
      rec.status = args.to;
      rec.ended_at = args.at;
      rec.gate = { reason: args.gate.reason, detail: args.gate.detail ?? "" };
      // Normal episode-end: append exactly ONE attempt (never `crashed`).
      rec.attempts.push({
        started_at: rec.started_at ?? args.at,
        ended_at: args.at,
        outcome: args.to,
      });
      break;
    }
    case "pending":
      // unreachable — no legal transition targets pending
      break;
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// reconcileRunningStage — the ONE AND ONLY writer of a `crashed` attempt (T6)
// ---------------------------------------------------------------------------

export function reconcileRunningStage(
  state: RunState,
  args: {
    stage: Stage;
    to: "done" | "failed" | "halted";
    gate?: Gate;
    observedMerges?: { pr: number }[];
    at: string;
  },
  readPr: PrReader,
): RunState {
  assertActiveRun(state, "reconcileRunningStage");
  const idx0 = stageIndex(state, args.stage);
  const current = state.stages[idx0].status;
  if (current !== "running") {
    throw err(
      "not_running",
      `reconcileRunningStage requires stage '${args.stage}' to be 'running' (found '${current}').`,
    );
  }
  if (args.to !== "done" && args.to !== "failed" && args.to !== "halted") {
    throw err(
      "illegal_transition",
      `reconcileRunningStage target must be one of done|failed|halted (got '${args.to}').`,
    );
  }

  // Record each observed merge that has NO existing entry as {pr,
  // merged_by_forge: false} (monotonic — recordOutput never demotes an existing
  // `true`). Applies to BOTH `→done` and `→halted` reconciliation: an already-
  // merged registry PR is recorded even while the merge overall stays pending
  // (criterion #16 — partial merges are never discarded).
  let next =
    args.observedMerges && args.observedMerges.length > 0
      ? recordOutput(state, {
          stage: args.stage,
          merges: args.observedMerges.map((m) => ({
            pr: m.pr,
            merged_by_forge: false,
          })),
          at: args.at,
        })
      : clone(state);

  // Enforce the same `→done` gate as `transition` (reuse T5).
  if (args.to === "done") {
    enforceDoneGate(next, args.stage, readPr);
  }

  if (args.to !== "done" && (!args.gate || !args.gate.reason)) {
    throw err(
      "gate_required",
      `reconcileRunningStage '${args.to}' for stage '${args.stage}' requires a gate {reason, detail}.`,
    );
  }

  const idx = stageIndex(next, args.stage);
  const rec = next.stages[idx];

  // Append EXACTLY ONE crashed attempt for the crashed episode. This is the
  // sole site in the codebase that produces a crashed-outcome attempt.
  rec.attempts.push({
    started_at: rec.started_at ?? args.at,
    ended_at: null,
    outcome: "crashed",
  });

  // Apply the resolving transition IN THE SAME CALL, bypassing transition's
  // normal episode-end append so the episode is archived once, never twice.
  rec.status = args.to;
  rec.ended_at = args.at;
  if (args.to === "done") {
    rec.gate = null;
  } else {
    rec.gate = { reason: args.gate!.reason, detail: args.gate!.detail ?? "" };
  }

  next.updated_at = args.at;
  return next;
}

// ---------------------------------------------------------------------------
// Phase 2 — Chain resolution (T1, issue #755)
// ---------------------------------------------------------------------------

/** The default author→review chain, in canonical order (spec §2, 6 stages). */
const DEFAULT_CHAIN: Stage[] = [
  "write-spec",
  "review-spec",
  "spec-to-plan",
  "review-plan",
  "plan-to-tasks",
  "copilot",
];

/**
 * Where each `--red-team` stage is inserted (spec §2, criterion 3):
 * red-team-spec directly after review-spec, red-team-plan directly after
 * review-plan — yielding the full 8-stage chain.
 */
const RED_TEAM_INSERTS: ReadonlyArray<{ after: Stage; insert: Stage }> = [
  { after: "review-spec", insert: "red-team-spec" },
  { after: "review-plan", insert: "red-team-plan" },
];

/** The stage an input kind's auto-detected chain starts at (spec §1). */
function entryStageFor(
  inputKind: "intent" | "spec-path" | "plan-path",
): Stage {
  switch (inputKind) {
    case "spec-path":
      return "review-spec";
    case "plan-path":
      return "review-plan";
    case "intent":
      return "write-spec";
  }
}

/**
 * Resolve the ordered stage chain for a run (T1). Starts from the full
 * (red-team-aware) canonical order, drops everything before the auto-detected
 * (or `--from`) entry stage, then applies `--from`/`--until` slicing. The
 * result is the single source of what the run will do (stored verbatim in
 * `state.chain`).
 *
 * Throws `empty_chain` when the slice is empty (e.g. `--from` after `--until`)
 * and `stage_not_in_chain` when `--from`/`--until` names a stage absent from
 * the resolved (red-team-aware) order — e.g. `--until red-team-spec` without
 * `--red-team`.
 */
export function resolveChain(args: {
  inputKind: "intent" | "spec-path" | "plan-path";
  redTeam: boolean;
  from?: Stage;
  until?: Stage;
}): Stage[] {
  // 1. Build the canonical order, inserting red-team stages when requested.
  let full = [...DEFAULT_CHAIN];
  if (args.redTeam) {
    for (const { after, insert } of RED_TEAM_INSERTS) {
      const idx = full.indexOf(after);
      full.splice(idx + 1, 0, insert);
    }
  }

  // 2. Auto-detected entry stage (overridden by an explicit `--from`).
  const entry = args.from ?? entryStageFor(args.inputKind);

  // Validate `--from`/`--until` name stages that exist in this run's order.
  for (const [flag, stage] of [
    ["--from", args.from],
    ["--until", args.until],
  ] as const) {
    if (stage !== undefined && !full.includes(stage)) {
      throw err(
        "stage_not_in_chain",
        `${flag} names stage '${stage}', which is not part of the resolved chain ${JSON.stringify(
          full,
        )} (missing --red-team?).`,
      );
    }
  }

  const startIdx = full.indexOf(entry);
  const endIdx = args.until !== undefined ? full.indexOf(args.until) : full.length - 1;

  const sliced = startIdx <= endIdx ? full.slice(startIdx, endIdx + 1) : [];
  if (sliced.length === 0) {
    throw err(
      "empty_chain",
      `Resolved chain is empty: --from '${entry}' is after --until '${args.until}' in ${JSON.stringify(
        full,
      )}.`,
    );
  }
  return sliced;
}

// ---------------------------------------------------------------------------
// Phase 2 — Merge-point derivation (T2, issue #756)
// ---------------------------------------------------------------------------

/**
 * Derive the ordered merge points for a resolved chain (T2). PRs are owned by
 * artifact, not stage: each artifact PR is merged exactly once, after the LAST
 * stage in the chain that touches that artifact (spec §3).
 *
 * - spec merge after the last present of {review-spec, red-team-spec}
 * - plan merge after the last present of {review-plan, red-team-plan}
 * - impl merge after copilot
 * - plan-to-tasks produces issues, not a PR → no merge point
 * - a chain ending at an author stage (write-spec / spec-to-plan) yields NO
 *   merge for that artifact — an author PR is never merged without its review.
 */
export function mergePointsFor(chain: Stage[]): MergePoint[] {
  const inChain = new Set(chain);
  const points: MergePoint[] = [];

  // spec: merge only after a REVIEW stage (never a bare author-only chain).
  const specClosers: Stage[] = ["review-spec", "red-team-spec"];
  const lastSpec = lastPresent(chain, specClosers);
  if (lastSpec) points.push({ after_stage: lastSpec, artifact: "spec" });

  // plan: merge only after a plan review stage.
  const planClosers: Stage[] = ["review-plan", "red-team-plan"];
  const lastPlan = lastPresent(chain, planClosers);
  if (lastPlan) points.push({ after_stage: lastPlan, artifact: "plan" });

  // impl: one merge covering all of copilot's PRs.
  if (inChain.has("copilot")) {
    points.push({ after_stage: "copilot", artifact: "impl" });
  }

  // Order the points by their after_stage's position in the chain.
  points.sort(
    (a, b) => chain.indexOf(a.after_stage) - chain.indexOf(b.after_stage),
  );
  return points;
}

/** The candidate present in `chain` with the highest chain index, else null. */
function lastPresent(chain: Stage[], candidates: Stage[]): Stage | null {
  let best: Stage | null = null;
  let bestIdx = -1;
  for (const c of candidates) {
    const idx = chain.indexOf(c);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Phase 2 — plan-path convention (T3, issue #757): the ONE owner
// ---------------------------------------------------------------------------

/**
 * The renderable-argument grammar — the ONE definition of a value safe to emit
 * as a single bare slash-command token: parser-neutral characters only, and not
 * option-shaped (no leading `-`, which the in-session slash parser would read as
 * a flag). Every threaded artifact value (spec_path / plan_path / plan_slug) and
 * every parsed slug MUST satisfy this, so parsing and rendering agree on exactly
 * one grammar — a value the parser accepts is guaranteed renderable and vice
 * versa (findings: parse/render divergence). Whitespace, quotes, newlines, and
 * backslashes are all excluded, so an imported path or slug carrying them is
 * rejected at the same boundary the renderer would reject it.
 */
const SAFE_ARG_RE = /^[A-Za-z0-9._:=\/][A-Za-z0-9._:=\/-]*$/;

/**
 * Whether `value` is a clean bare slash-command token (the renderable-argument
 * grammar). Phase 5 `resolve` consumes this to reject a nonconforming imported
 * artifact path/slug at classification time — the same grammar the renderer
 * enforces — so an import can never be accepted only to become unrenderable
 * later. Exported as the single owner of "is this threadable as a bare arg?".
 */
export function isRenderableArg(value: string): boolean {
  return SAFE_ARG_RE.test(value);
}

/** The single canonical plan-path convention: `docs/plans/YYYY-MM-DD-<slug>-plan.md`. */
const PLAN_PATH_RE = /^docs\/plans\/(\d{4}-\d{2}-\d{2})-([^/]+)-plan\.md$/;
/**
 * The plan-slug grammar — deliberately a subset of the renderable-argument
 * grammar (`SAFE_ARG_RE`): a slug must start with an alphanumeric, `.`, or `_`
 * (NEVER `-`, which would render as an option-shaped, unthreadable token) and
 * then use only `[A-Za-z0-9._-]`. Because the first-char and body classes are
 * both subsets of `SAFE_ARG_RE`, every slug this accepts is guaranteed
 * renderable — closing the gap where `parsePlanSlug` accepted an option-shaped
 * slug (e.g. `-`, from `docs/plans/2026-07-19---plan.md`) that the renderer then
 * rejected. `parsePlanSlug` and `planPathFor` share this one grammar.
 */
const PLAN_SLUG_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/**
 * Build the canonical plan path for a slug (T3). The convention is strictly
 * `docs/plans/YYYY-MM-DD-<slug>-plan.md`. The pure lib has no clock, so the
 * date segment is HOST-SUPPLIED (spec-to-plan, the runtime owner, knows the
 * date) — passing it in as an explicit argument keeps the helper pure while
 * emitting the full dated form the convention requires. `parsePlanSlug` is the
 * exact inverse, so `parsePlanSlug(planPathFor(slug, date)) === slug`
 * round-trips. Keeping both directions here means the `docs/plans/…` pattern is
 * encoded exactly once (spec §4 import parser + Phase 6 producer conformance
 * both consume this pair). Throws on a malformed date or a slug that would
 * break the round-trip. ASSUMPTION: the renderer never calls `planPathFor` — it
 * threads spec-to-plan's REPORTED `plan_path`; this helper only exists to keep
 * the import/conformance pattern single-owned.
 */
export function planPathFor(slug: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw err("plan_path_invalid", `planPathFor: date must be YYYY-MM-DD, got '${date}'.`);
  }
  if (!PLAN_SLUG_RE.test(slug)) {
    throw err("plan_path_invalid", `planPathFor: slug '${slug}' contains characters outside [A-Za-z0-9._-].`);
  }
  return `docs/plans/${date}-${slug}-plan.md`;
}

/**
 * Parse the plan slug out of a canonical `docs/plans/YYYY-MM-DD-<slug>-plan.md`
 * path (T3) — the strict inverse of `planPathFor`. The full path is required:
 * a date-less name, a malformed date, a bare filename, an empty slug, or a file
 * outside `docs/plans/` all return null so Phase 5 rejects nonconforming
 * imports with `plan_slug_unresolved`. Returns the slug, or null when the path
 * does not match the convention exactly.
 */
export function parsePlanSlug(path: string): string | null {
  const m = path.match(PLAN_PATH_RE);
  if (!m) return null;
  const slug = m[2];
  if (slug.length === 0 || !PLAN_SLUG_RE.test(slug)) return null;
  return slug;
}

// ---------------------------------------------------------------------------
// Phase 2 — Threading + command rendering (T3, issue #757)
// ---------------------------------------------------------------------------

/**
 * Resolve a threaded artifact field from recorded state (never re-derived): the
 * producing stage's recorded `artifacts`, falling back to the run-level
 * `initial_artifacts` seeded at init for a path-based start (§4). Returns
 * undefined when neither source holds it.
 */
function resolveThreadedField(
  state: RunState,
  field: "spec_path" | "plan_path" | "plan_slug",
): string | undefined {
  const producer: Stage = field === "spec_path" ? "write-spec" : "spec-to-plan";
  const rec = state.stages.find((s) => s.stage === producer);
  const fromStage = rec?.artifacts[field];
  if (fromStage !== undefined) return fromStage;
  return state.initial_artifacts[field];
}

/**
 * The threading helper (T3): the recorded `StageArtifacts` a stage's command
 * consumes, read only from producer-reported / imported state — no path or slug
 * is ever reconstructed from a naming convention. `write-spec` consumes the
 * free-text intent (not an artifact) so it threads nothing.
 */
export function nextInputFor(state: RunState, stage: Stage): StageArtifacts {
  switch (stage) {
    case "write-spec":
      return {};
    case "review-spec":
    case "red-team-spec":
    case "spec-to-plan": {
      const spec_path = resolveThreadedField(state, "spec_path");
      return spec_path !== undefined ? { spec_path } : {};
    }
    case "review-plan":
    case "red-team-plan": {
      const plan_path = resolveThreadedField(state, "plan_path");
      return plan_path !== undefined ? { plan_path } : {};
    }
    case "plan-to-tasks": {
      const out: StageArtifacts = {};
      const plan_path = resolveThreadedField(state, "plan_path");
      const plan_slug = resolveThreadedField(state, "plan_slug");
      if (plan_path !== undefined) out.plan_path = plan_path;
      if (plan_slug !== undefined) out.plan_slug = plan_slug;
      return out;
    }
    case "copilot": {
      const plan_slug = resolveThreadedField(state, "plan_slug");
      return plan_slug !== undefined ? { plan_slug } : {};
    }
  }
}

function requireField(
  input: StageArtifacts,
  field: "spec_path" | "plan_path" | "plan_slug",
  stage: Stage,
): string {
  const v = input[field];
  if (v === undefined || v.length === 0) {
    throw err(
      "unthreaded_input",
      `Cannot render command for stage '${stage}': required input '${field}' has not been reported by its producing stage.`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Command-argument transport (T3)
//
// The consumer of a rendered command is the **in-session slash-command parser**
// (Claude reading a skill's `$ARGUMENTS` and splitting it into flags +
// positional), NOT a POSIX shell — so POSIX single-quoting is the wrong model.
// Two value classes need two different, parser-honest transports:
//
//   1. Threaded artifact values (spec_path / plan_path / plan_slug) are
//      producer-controlled and MUST already be safe bare tokens — dated
//      `docs/{specs,plans}/…` paths and kebab slugs. A threaded value that is
//      empty, option-shaped (leading `-`, which the parser would read as a
//      flag), or carries a parser-hostile metacharacter (whitespace / quote /
//      newline / backslash) is a **producer or import contract violation**, not
//      something to paper over by quoting — quoting cannot make the slash
//      parser treat `--fold` as a positional. So we validate and emit bare,
//      throwing `unsafe_threaded_arg` on a violation.
//   2. The write-spec **intent** is the one free-text field. Its transport is
//      the double-quoted-string convention the §2 table documents
//      (`/stark-write-spec "<intent>"`): wrap in double quotes and backslash-
//      escape the two characters that would otherwise break the quoting for the
//      reader — `\`→`\\` and `"`→`\"`. That is the WHOLE decode contract, and it
//      is the one documented in spec §2 ("Intent transport"). We deliberately do
//      NOT invent an escape for newlines/CR/tab: nothing on the write-spec side
//      decodes such an escape, so emitting `\n` would silently deliver a spec
//      intent containing the literal two characters `\n`. Instead the intent
//      grammar is NARROWED to a single line of printable text — a control
//      character (CR/LF/tab/other C0) throws `intent_unencodable`, refusing to
//      corrupt rather than guessing a decode the consumer never implements. A
//      double-quoted `"--fold"` is unambiguously the positional, never a flag.
// ---------------------------------------------------------------------------

/**
 * Validate a producer-threaded path/slug and return it for bare emission. A
 * value the producing stage or import should have reported as a clean token but
 * didn't (option-shaped or metacharacter-bearing) throws `unsafe_threaded_arg`
 * — the renderer refuses to emit a command whose meaning the parser could
 * misread, rather than silently quoting a broken contract.
 */
function safeThreadedArg(value: string, field: string, stage: Stage): string {
  if (!isRenderableArg(value)) {
    throw err(
      "unsafe_threaded_arg",
      `Cannot render command for stage '${stage}': threaded input '${field}' (${JSON.stringify(
        value,
      )}) is option-shaped or contains parser-hostile characters — its producing stage must report a clean token.`,
    );
  }
  return value;
}

/**
 * Encode the write-spec free-text intent as the double-quoted positional the §2
 * "Intent transport" contract defines (`/stark-write-spec "<intent>"`). The
 * decode contract is exactly: strip the surrounding double quotes, then reverse
 * `\\`→`\` and `\"`→`"`. Nothing else is escaped — in particular there is NO
 * newline/CR/tab escape, because the write-spec side implements no decode for
 * one. The intent must therefore be a single line of printable text; a control
 * character (any C0 incl. CR/LF/tab, or DEL) throws `intent_unencodable` rather
 * than being silently corrupted into a literal backslash-n on the command line.
 * Always quoted, so an option-shaped intent (`--fold`) can never be reparsed as
 * a flag. Forge's guarantee is one-sided and deliberate: it emits a well-formed,
 * single-line, double-quoted token. It defines no bespoke decoder and requires
 * no change in `stark-write-spec`, which already takes a quoted positional.
 */
export function encodeIntent(value: string): string {
  // Reject anything that is not printable single-line text. C0 controls
  // (0x00-0x1F, incl. CR/LF/tab) and DEL (0x7F) obviously split/corrupt the
  // line, but so do the C1 controls (0x80-0x9F — U+0085 NEL is a line break)
  // and the Unicode line/paragraph separators U+2028 / U+2029. Any of them can
  // terminate or corrupt the rendered command, and none has a defined escape on
  // the write-spec side. Ordinary Unicode (accents, CJK, emoji) round-trips.
  const hasControl = [...value].some((ch) => {
    const cp = ch.codePointAt(0)!;
    return (
      cp < 0x20 || // C0 controls (incl. CR/LF/tab)
      cp === 0x7f || // DEL
      (cp >= 0x80 && cp <= 0x9f) || // C1 controls (incl. U+0085 NEL)
      cp === 0x2028 || // LINE SEPARATOR
      cp === 0x2029 // PARAGRAPH SEPARATOR
    );
  });
  if (hasControl) {
    throw err(
      "intent_unencodable",
      `Cannot render write-spec command: the intent contains a control or line-separator character (e.g. a newline, tab, C1 control, or Unicode line/paragraph separator). The intent transport is a single double-quoted line — no multiline/control-character escape is defined on the write-spec side. Author the intent as one line.`,
    );
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Render a stage's exact in-session command (T3) from recorded state, per the
 * spec §2 command table. The free-text intent goes through `encodeIntent` (the
 * double-quoted transport the parser honors); threaded artifacts go through
 * `safeThreadedArg` (validated + emitted bare, since producers must report
 * clean tokens). Threaded inputs come only from `nextInputFor` (recorded
 * producer output / imported initial artifacts) — copilot's `--plan-slug` reads
 * spec-to-plan's recorded `plan_slug`, NEVER a re-derivation from the plan
 * filename; both red-team commands carry `--fold`.
 */
export function renderStageCommand(state: RunState, stage: Stage): string {
  const input = nextInputFor(state, stage);
  const arg = (field: "spec_path" | "plan_path" | "plan_slug") =>
    safeThreadedArg(requireField(input, field, stage), field, stage);
  switch (stage) {
    case "write-spec":
      return `/stark-write-spec ${encodeIntent(state.input.value)}`;
    case "review-spec":
      return `/stark-review-spec ${arg("spec_path")}`;
    case "red-team-spec":
      return `/stark-red-team-spec ${arg("spec_path")} --fold`;
    case "spec-to-plan":
      return `/stark-spec-to-plan ${arg("spec_path")}`;
    case "review-plan":
      return `/stark-review-plan ${arg("plan_path")}`;
    case "red-team-plan":
      return `/stark-red-team-plan ${arg("plan_path")} --fold`;
    case "plan-to-tasks":
      return `/stark-plan-to-tasks ${arg("plan_path")} --plan-slug ${arg("plan_slug")}`;
    case "copilot":
      return `/stark-copilot --plan-slug ${arg("plan_slug")}`;
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Slug sanitization (T2, issue #759)
// ---------------------------------------------------------------------------

/** Upper bound on a sanitized slug — long enough for a descriptive intent
 * fragment, short enough to keep the history dir name sane. Mirrors the
 * handover slug cap. */
const MAX_SLUG_LEN = 80;

/**
 * Sanitize an arbitrary intent/path into a kebab slug safe to use as a single
 * history directory-name segment (T2). Pure — no I/O. Path-traversal-safe by
 * construction: the only surviving characters are `[a-z0-9]` and `-`
 * (everything else, INCLUDING `/`, `.`, and the `..` sequence, collapses to a
 * single `-`), leading/trailing dashes are stripped, so the result can never be
 * `.`/`..`, carry a leading dot, or contain a path separator and thus cannot
 * escape the host's per-slug history directory. Mirrors
 * `stark_handover_lib.ts::sanitizeSlug`. Empty/all-punctuation input falls back
 * to `"run"` so a directory name always exists.
 */
export function sanitizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

// ---------------------------------------------------------------------------
// initializeRun — the pure run-state constructor (T7)
// ---------------------------------------------------------------------------

export function initializeRun(
  resolved: ResolvedRun,
  args: { runId: string; at: string; mode: "in-session" | "driver" },
): RunState {
  const stages: StageRecord[] = resolved.chain.map((stage) => ({
    stage,
    status: "pending",
    prs: [],
    merges: [],
    fold_prs: [],
    artifacts: {},
    gate: null,
    started_at: null,
    ended_at: null,
    attempts: [],
  }));

  return {
    slug: resolved.slug,
    run_id: args.runId,
    input: clone(resolved.input),
    initial_artifacts: clone(resolved.initial_artifacts),
    mode: args.mode,
    chain: [...resolved.chain],
    merge_points: clone(resolved.mergePoints),
    artifact_prs: {},
    repo: clone(resolved.repo),
    default_branch: resolved.default_branch,
    created_at: args.at,
    updated_at: args.at,
    abandoned_at: null,
    stages,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — Resume reconciliation + resume-target (T1–T4)
//
// PURITY: still no clock/disk/net/git — the ONLY external observation is the
// injected `readPr`. Reconciliation mutates and RETURNS the reconciled state;
// the pure lib performs NO persistence (the CLI writes it, Phase 5). Re-entry
// (`halted/failed → running`) belongs to the RESUME EXECUTOR, never here —
// `resumeTarget` always leaves the target at `done`/`halted`/`failed`.
// ---------------------------------------------------------------------------

/** Halt gate reasons that mean "the artifact can never merge in this run". */
const DEAD_END_HALT_REASONS = new Set<string>([
  "author_pr_merged_early",
  "artifact_pr_closed",
]);

/**
 * Whether a non-merge stage recorded its checkpoint: its required outputs (spec
 * §4) AND — for a PR-backed stage (`stageArtifact !== null`) — its adopted/opened
 * PR. The PR clause is load-bearing: red-team-chain `review-spec`/`review-plan`
 * are non-merge-point stages whose `requiredOutputsFor` list is EMPTY, so an
 * outputs-only check returns true vacuously — a crash before the stage records
 * its adopted PR would then reconcile it to `done` and silently skip the review.
 * plan-to-tasks (`stageArtifact === null`) stays keyed to its `issue_numbers`
 * marker only.
 */
function checkpointOutputsRecorded(rec: StageRecord): boolean {
  const outputsRecorded = requiredOutputsFor(rec.stage).every((field) =>
    isRecorded((rec.artifacts as Record<string, unknown>)[field], field),
  );
  if (!outputsRecorded) return false;
  if (stageArtifact(rec.stage) !== null) return rec.prs.length > 0;
  return true;
}

/** Whether the stage owns a merge point (spec §6 registry merge). */
function isMergePointStage(state: RunState, stage: Stage): boolean {
  return state.merge_points.some((m) => m.after_stage === stage);
}

/** Whether a stopped stage recorded its checkpoint (merge point: a PR
 * observation; non-merge: its required outputs). */
function checkpointRecorded(state: RunState, rec: StageRecord): boolean {
  return isMergePointStage(state, rec.stage)
    ? rec.prs.length > 0
    : checkpointOutputsRecorded(rec);
}

/**
 * Derive the resume action for a stage already at `halted`/`failed` (either from
 * a prior reconciliation the caller persisted, or a normal episode-end). Shared
 * by the post-reconciliation recompute AND the no-running-stage frontier scan so
 * a re-loaded halted/failed run maps to the same action without re-reconciling.
 *
 * The action is derived from merge-point membership + checkpoint presence, NOT
 * from status alone: a checkpointed merge point that failed post-checkpoint (e.g.
 * `ci_red`) has completed its review/copilot work and only needs the merge
 * retried → `merge_only`, never `reinvoke` (which would repeat that work). A
 * checkpoint-absent stopped stage never got past its work → `reinvoke`. Dead-end
 * halts (author PR merged early / registry PR closed) have no in-run
 * continuation → `abandon`.
 */
function actionForStoppedStage(
  state: RunState,
  rec: StageRecord,
  readPr: PrReader,
): ResumeAction {
  if (rec.gate && DEAD_END_HALT_REASONS.has(rec.gate.reason)) return "abandon";
  if (!checkpointRecorded(state, rec)) return "reinvoke";
  if (!isMergePointStage(state, rec.stage)) {
    // Checkpoint present on a non-merge stage. Derive the action from status,
    // NOT from a hard-coded dead-end reason list: a `halted` non-merge stage is
    // terminal — the authoring already completed (checkpoint present), so its
    // remaining path is nothing → `abandon` (re-invoking would repeat completed
    // authoring). A `failed` non-merge stage still has work to redo → reinvoke.
    return rec.status === "halted" ? "abandon" : "reinvoke";
  }
  // A merge point only has the merge left to retry — but LIVE-CHECK the registry
  // first. A merge_pending/fold_pr_open halt was persisted while its PR was open;
  // if that PR has since been CLOSED (not merged) the artifact can never merge, so
  // the dead-end recovery is `abandon`, never an endless `merge_only` retry.
  const artifact = stageArtifact(rec.stage);
  const registry = artifact === null ? [] : state.artifact_prs[artifact] ?? [];
  if (registry.some((pr) => readPr(pr) === "closed")) return "abandon";
  return "merge_only";
}

/**
 * Given a state with NO `running` stage (either never had one, or the crashed
 * stage was just reconciled), find the frontier and its action. Sequential
 * chain ⇒ the first non-`done` stage is the frontier; a `halted`/`failed` stage
 * stops the chain (T3) — the scan lands on it before any downstream `pending`,
 * so no downstream stage is ever auto-entered.
 */
function forwardTargetAndAction(
  state: RunState,
  readPr: PrReader,
): {
  target_stage: Stage;
  action: ResumeAction;
} {
  const frontier = state.stages.find((s) => s.status !== "done");
  if (!frontier) {
    // Whole sliced chain done → complete. target_stage is the last chain stage
    // (its `requires_base_sync` is still reported; `command` will be null).
    return { target_stage: state.chain[state.chain.length - 1], action: "complete" };
  }
  switch (frontier.status) {
    case "pending":
      return { target_stage: frontier.stage, action: "advance" };
    case "halted":
    case "failed":
      return { target_stage: frontier.stage, action: actionForStoppedStage(state, frontier, readPr) };
    case "running":
      // Unreachable: a running frontier is reconciled before this runs.
      throw err(
        "unreconciled_running",
        `forwardTargetAndAction reached a 'running' stage '${frontier.stage}' — it must be reconciled first.`,
      );
    default:
      throw err(
        "unexpected_status",
        `forwardTargetAndAction: unexpected status '${frontier.status}' for '${frontier.stage}'.`,
      );
  }
}

/**
 * Reconcile the one crashed (`running`) stage per spec `behavior` → Resume
 * reconciliation. Returns the reconciled state (target left at done/halted/
 * failed). Read-only on the outside world beyond `readPr`.
 */
function reconcileFrontier(
  state: RunState,
  rec: StageRecord,
  readPr: PrReader,
  at: string,
): RunState {
  const stage = rec.stage;
  const artifact = stageArtifact(stage);
  const isMergePoint = state.merge_points.some((m) => m.after_stage === stage);
  const crashedGate = (reason: string, detail: string): Gate => ({ reason, detail });

  if (isMergePoint) {
    // Checkpoint = the stage recorded its own PR observation before merging.
    if (rec.prs.length === 0) {
      return reconcileRunningStage(
        state,
        {
          stage,
          to: "failed",
          gate: crashedGate(
            "reconciled_after_crash",
            `Merge-point stage '${stage}' crashed before recording its PR checkpoint; re-invoking idempotently.`,
          ),
          at,
        },
        readPr,
      );
    }
    const registry = state.artifact_prs[artifact as "spec" | "plan" | "impl"] ?? [];
    // Snapshot every registry PR state ONCE so `done` and `halted` reconciliation
    // agree on what was observed (readPr is the sole external observation).
    const registryStates = registry.map((pr) => ({ pr, state: readPr(pr) }));
    // Every already-merged PR is persisted (merged_by_forge:false) even when the
    // merge overall stays pending — partial merges are never discarded (#16).
    const observedMerges = registryStates
      .filter((r) => r.state === "merged")
      .map((r) => ({ pr: r.pr }));
    // A registry PR CLOSED (not merged) = the artifact can never merge → dead end.
    if (registryStates.some((r) => r.state === "closed")) {
      return reconcileRunningStage(
        state,
        {
          stage,
          to: "halted",
          observedMerges,
          gate: crashedGate(
            "artifact_pr_closed",
            `A registry PR for '${artifact}' was closed without merging; the artifact can no longer merge in this run.`,
          ),
          at,
        },
        readPr,
      );
    }
    const allMerged =
      registryStates.length > 0 && registryStates.every((r) => r.state === "merged");
    const openFold = (rec.fold_prs ?? []).some((pr) => readPr(pr) === "open");
    if (allMerged && !openFold) {
      return reconcileRunningStage(
        state,
        { stage, to: "done", observedMerges, at },
        readPr,
      );
    }
    // Execution completed, only the merge remains → merge_only (never re-invoke).
    // Observed merges are recorded monotonically even while the merge is pending.
    return reconcileRunningStage(
      state,
      {
        stage,
        to: "halted",
        observedMerges,
        gate: openFold
          ? crashedGate(
              "fold_pr_open",
              `Merge-point stage '${stage}' has an open fold PR blocking the artifact merge.`,
            )
          : crashedGate(
              "merge_pending",
              `Merge-point stage '${stage}' has un-merged registry PR(s); retry the merge only.`,
            ),
        at,
      },
      readPr,
    );
  }

  // --- non-merge-point stage (author stages + plan-to-tasks marker) ---
  // Checkpoint = the stage's required outputs (spec §4) are all recorded. For
  // plan-to-tasks this IS the `issue_numbers` marker (T4). Absent → re-invoke.
  if (!checkpointOutputsRecorded(rec)) {
    return reconcileRunningStage(
      state,
      {
        stage,
        to: "failed",
        gate: crashedGate(
          "reconciled_after_crash",
          `Stage '${stage}' crashed before recording its required outputs; re-invoking idempotently.`,
        ),
        at,
      },
      readPr,
    );
  }

  // Checkpoint present. A PR-backed author stage's PR is MEANT to stay open until
  // its paired review, so both terminal PR states are dead ends:
  //   - externally MERGED before the paired review → shared-PR model broken.
  //   - CLOSED without merging → the artifact can never merge (a closed author PR
  //     cannot be adopted by the paired review).
  if (artifact !== null) {
    const registry = state.artifact_prs[artifact] ?? [];
    if (registry.some((pr) => readPr(pr) === "merged")) {
      return reconcileRunningStage(
        state,
        {
          stage,
          to: "halted",
          gate: crashedGate(
            "author_pr_merged_early",
            `The author PR for '${artifact}' was merged before its paired review stage; the shared-PR model is broken.`,
          ),
          at,
        },
        readPr,
      );
    }
    if (registry.some((pr) => readPr(pr) === "closed")) {
      return reconcileRunningStage(
        state,
        {
          stage,
          to: "halted",
          gate: crashedGate(
            "artifact_pr_closed",
            `The author PR for '${artifact}' was closed without merging; a closed author PR cannot be adopted by the paired review.`,
          ),
          at,
        },
        readPr,
      );
    }
  }

  // Healthy: execution completed, PR still open (or no PR) → done.
  return reconcileRunningStage(state, { stage, to: "done", at }, readPr);
}

/**
 * Inspect a run at resume and return the reconciled state + the action
 * descriptor (T1). If the frontier stage is `running` (crashed) it is
 * reconciled first (mutating + returning the state) and the action recomputed
 * from the reconciled chain — never an unconditional `advance`. The descriptor
 * is the sole command/routing channel: `requires_base_sync = requiresBaseSync(
 * target_stage)` and `command` = the action-appropriate rendered stage command
 * (`renderStageCommand` for `reinvoke`/`advance`; `null` for
 * `merge_only`/`complete`/`abandon`).
 *
 * PURITY: no clock. The reconciliation timestamp is derived deterministically
 * from the crashed frontier's own `started_at` (falling back to the run's
 * `updated_at`) — the last known-good moment recorded before the crash — so the
 * two-argument contract holds without a host-supplied `at`. When no
 * reconciliation happens the input state is returned verbatim.
 */
export function resumeTarget(
  state: RunState,
  readPr: PrReader,
): { state: RunState; target: ResumeTarget } {
  if (state.abandoned_at) {
    throw err(
      "run_abandoned",
      `Run '${state.run_id}' (slug '${state.slug}') is abandoned (${state.abandoned_at}); it is excluded from resume-target.`,
    );
  }

  // Locate the SEQUENTIAL FRONTIER first — the first non-`done` stage — never
  // "the first running stage anywhere in the chain". A crash reconciles ONLY the
  // frontier: if an earlier stage is `failed`/`halted` it stops the chain (T3),
  // so a later `running` stage must NOT be reconciled (no downstream mutation, no
  // PR read). Fail closed on any such downstream `running` stage — an impossible
  // state under the sequential executor, so it is an error, not a silent skip.
  const frontier = state.stages.find((s) => s.status !== "done");
  let workState = state;
  let reconciled = false;
  if (frontier) {
    // Reject a `running` stage past the frontier BEFORE any reconciliation,
    // regardless of the frontier's own status. If the frontier itself is
    // running, reconciling it (→failed/halted/done) while a downstream stage is
    // still running would violate T3 — a stopped/reconciled stage must never
    // have a live downstream episode. Checked up front so no PR read or mutation
    // happens in the two-running-stages invariant-violation case.
    const frontierIdx = state.stages.indexOf(frontier);
    const downstreamRunning = state.stages
      .slice(frontierIdx + 1)
      .find((s) => s.status === "running");
    if (downstreamRunning) {
      throw err(
        "downstream_running",
        `Stage '${downstreamRunning.stage}' is 'running' downstream of frontier '${frontier.stage}' (${frontier.status}); a stopped/reconciled stage halts the chain (T3) and its downstream must not be reconciled.`,
      );
    }
    if (frontier.status === "running") {
      // Deterministic reconciliation timestamp (no clock — `resumeTarget` is a
      // two-argument API, so there is no host-supplied `at` here). It MUST be
      // the run's last-recorded update, never the crashed stage's `started_at`:
      // a `record-output` checkpoint taken mid-stage advances `updated_at` past
      // `started_at`, so starting from `started_at` would move `updated_at`
      // backward and backdate the crashed attempt's `ended_at` to before the
      // outputs it is reconciling. `updated_at` is monotonic by construction.
      const at = state.updated_at;
      workState = reconcileFrontier(state, frontier, readPr, at);
      reconciled = true;
    }
  }

  const { target_stage, action } = forwardTargetAndAction(workState, readPr);
  const requires_base_sync = requiresBaseSync(target_stage);
  const command =
    action === "reinvoke" || action === "advance"
      ? renderStageCommand(workState, target_stage)
      : null;

  return {
    state: reconciled ? workState : state,
    target: {
      run_id: workState.run_id,
      slug: workState.slug,
      target_stage,
      action,
      reconciled,
      requires_base_sync,
      command,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — abandon semantics + resume-run selection (T2)
// ---------------------------------------------------------------------------

/**
 * Mark a run terminally abandoned (T2, issue #763): stamps run-level
 * `abandoned_at`. An abandoned run is excluded from resume selection and
 * `resumeTarget`; the host summary reports `status: abandoned`. No stage
 * transition is involved — the closed §6 stage matrix is untouched. Idempotent:
 * re-abandoning preserves the original timestamp.
 */
export function abandonRun(state: RunState, at: string): RunState {
  const next = clone(state);
  if (next.abandoned_at) return next; // already abandoned — no-op, keep original
  next.abandoned_at = at;
  next.updated_at = at;
  return next;
}

/** Whether every stage in the run's chain is `done`. */
function isFullyDone(run: RunState): boolean {
  return run.stages.length > 0 && run.stages.every((s) => s.status === "done");
}

/**
 * Select which run to resume (T2): the latest run that is neither fully `done`
 * nor abandoned. "Latest" is defined by **`created_at`** — spec `behavior`:
 * "`--resume` (no arg) selects the latest non-`done`, non-abandoned run (across
 * slugs, by `created_at`/mtime)". Deliberately NOT `updated_at`: an older run
 * that merely saw a recent checkpoint would otherwise displace a genuinely newer
 * run, and the operator's "resume what I started last" expectation is about when
 * the run began. Tie-broken by `run_id` (monotonic, host-allocated) for
 * determinism. Returns null when no resumable run remains, so a fleet of
 * done/abandoned runs never re-selects a terminal dead end.
 */
export function selectResumeRun(runs: RunState[]): RunState | null {
  const candidates = runs.filter((r) => !r.abandoned_at && !isFullyDone(r));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => {
    if (r.created_at !== best.created_at) {
      return r.created_at > best.created_at ? r : best;
    }
    return r.run_id > best.run_id ? r : best;
  });
}
