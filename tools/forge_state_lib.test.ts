// Tests for `tools/forge_state_lib.ts` — the pure `/stark-forge` state machine.
// Run: node --experimental-strip-types --test tools/forge_state_lib.test.ts
//
// TDD acceptance fixtures are spec §5/§6 tables. Covers the plan's named tests:
// #4 (transition matrix), #5 (attempts archive once), #6 (done gate),
// #22 (recordOutput patch semantics + registry), the reconcile primitive, and
// initializeRun — plus the two structural guards (no I/O import; `crashed`
// produced only inside reconcileRunningStage).

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  type MergePoint,
  type PrReader,
  type ResolvedRun,
  type RunInput,
  type RunState,
  type Stage,
  type StageArtifacts,
  type StageStatus,
  LEGAL_TRANSITIONS,
  encodeIntent,
  initializeRun,
  isLegalTransition,
  isRenderableArg,
  mergePointsFor,
  nextInputFor,
  parsePlanSlug,
  planPathFor,
  recordOutput,
  reconcileRunningStage,
  renderStageCommand,
  requiredOutputsFor,
  requiresBaseSync,
  resolveChain,
  sanitizeSlug,
  stageArtifact,
  transition,
} from "./forge_state_lib.ts";

const AT = "2026-07-19T00:00:00Z";
const AT2 = "2026-07-19T01:00:00Z";
const AT3 = "2026-07-19T02:00:00Z";

const REPO = { host: "github.com", owner: "21StarkCom", name: "stark-skills" };

const allMerged: PrReader = () => "merged";
const allOpen: PrReader = () => "open";

function resolved(
  chain: Stage[],
  mergePoints: MergePoint[] = [],
  overrides: Partial<ResolvedRun> = {},
): ResolvedRun {
  return {
    chain,
    mergePoints,
    slug: "demo",
    input: { kind: "intent", value: "do a thing" },
    initial_artifacts: {},
    repo: REPO,
    default_branch: "main",
    ...overrides,
  };
}

function mkRun(
  chain: Stage[],
  mergePoints: MergePoint[] = [],
  overrides: Partial<ResolvedRun> = {},
): RunState {
  return initializeRun(resolved(chain, mergePoints, overrides), {
    runId: "run-1",
    at: AT,
    mode: "in-session",
  });
}

// ---------------------------------------------------------------------------
// T1 — static classification helpers
// ---------------------------------------------------------------------------

test("stageArtifact maps each stage to its artifact (null for plan-to-tasks)", () => {
  assert.equal(stageArtifact("write-spec"), "spec");
  assert.equal(stageArtifact("review-spec"), "spec");
  assert.equal(stageArtifact("red-team-spec"), "spec");
  assert.equal(stageArtifact("spec-to-plan"), "plan");
  assert.equal(stageArtifact("review-plan"), "plan");
  assert.equal(stageArtifact("red-team-plan"), "plan");
  assert.equal(stageArtifact("plan-to-tasks"), null);
  assert.equal(stageArtifact("copilot"), "impl");
});

test("requiresBaseSync is true EXACTLY for spec-to-plan, plan-to-tasks, copilot", () => {
  const all: Stage[] = [
    "write-spec",
    "review-spec",
    "red-team-spec",
    "spec-to-plan",
    "review-plan",
    "red-team-plan",
    "plan-to-tasks",
    "copilot",
  ];
  const truthy = all.filter(requiresBaseSync);
  assert.deepEqual(truthy.sort(), ["copilot", "plan-to-tasks", "spec-to-plan"]);
});

test("requiredOutputsFor matches spec §4 per stage", () => {
  assert.deepEqual(requiredOutputsFor("write-spec"), ["spec_path"]);
  assert.deepEqual(requiredOutputsFor("spec-to-plan"), [
    "plan_path",
    "plan_slug",
  ]);
  assert.deepEqual(requiredOutputsFor("plan-to-tasks"), ["issue_numbers"]);
  assert.deepEqual(requiredOutputsFor("review-spec"), []);
  assert.deepEqual(requiredOutputsFor("copilot"), []);
});

// ---------------------------------------------------------------------------
// Test #4 — transition matrix: every illegal transition throws with allowed set
// ---------------------------------------------------------------------------

const ALL_STATUSES: StageStatus[] = [
  "pending",
  "running",
  "halted",
  "done",
  "failed",
];

// The six legal edges of the spec §6 matrix, as "from→to" keys.
const LEGAL_EDGES = new Set<string>([
  "pending→running",
  "running→done",
  "running→halted",
  "running→failed",
  "halted→running",
  "failed→running",
]);

// Drive a single-stage (non-merge-point) `write-spec` run into any status.
function stageInStatus(status: StageStatus): RunState {
  let s = mkRun(["write-spec"]);
  if (status === "pending") return s;
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  if (status === "running") return s;
  if (status === "done") {
    s = recordOutput(s, {
      stage: "write-spec",
      artifacts: { spec_path: "docs/specs/a-spec.md" },
      at: AT,
    });
    return transition(s, { stage: "write-spec", to: "done", at: AT2 });
  }
  // halted | failed both require a gate
  return transition(s, {
    stage: "write-spec",
    to: status,
    gate: { reason: "x", detail: "y" },
    at: AT2,
  });
}

// Apply a KNOWN-legal edge with the args each target requires.
function applyLegalEdge(s: RunState, to: StageStatus): RunState {
  if (to === "running") {
    return transition(s, { stage: "write-spec", to: "running", at: AT3 });
  }
  if (to === "done") {
    s = recordOutput(s, {
      stage: "write-spec",
      artifacts: { spec_path: "docs/specs/a-spec.md" },
      at: AT3,
    });
    return transition(s, { stage: "write-spec", to: "done", at: AT3 });
  }
  return transition(s, {
    stage: "write-spec",
    to,
    gate: { reason: "x", detail: "y" },
    at: AT3,
  });
}

test("#4 all 25 status pairs: legal edges pass, same-status replays, illegal throws with source's allowed set", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const key = `${from}→${to}`;
      const isLegal = LEGAL_EDGES.has(key);

      // Pure matrix helper agrees for all 25 pairs.
      assert.equal(
        isLegalTransition(from, to),
        isLegal,
        `isLegalTransition(${key})`,
      );

      if (from === to) {
        // Same-status = no-op reprint: timestamps/attempts preserved verbatim.
        const s = stageInStatus(from);
        const before = structuredClone(s.stages[0]);
        const reprinted = transition(s, {
          stage: "write-spec",
          to,
          at: AT3,
        });
        assert.deepEqual(
          reprinted.stages[0],
          before,
          `same-status reprint ${key}`,
        );
        continue;
      }

      if (isLegal) {
        // Legal edge advances the stage to `to`.
        const s = stageInStatus(from);
        const moved = applyLegalEdge(s, to);
        assert.equal(moved.stages[0].status, to, `legal edge ${key}`);
        continue;
      }

      // Every other distinct pair throws with the SOURCE status's allowed set.
      const s = stageInStatus(from);
      const expectedAllowed = JSON.stringify([...LEGAL_TRANSITIONS[from]]);
      assert.throws(
        () => transition(s, { stage: "write-spec", to, at: AT3 }),
        (e: Error & { code?: string }) => {
          assert.equal(e.code, "illegal_transition", `code for ${key}`);
          assert.match(e.message, /Illegal transition/);
          assert.ok(
            e.message.includes(`Allowed: ${expectedAllowed}`),
            `${key} message must carry source allowed set ${expectedAllowed}, got: ${e.message}`,
          );
          return true;
        },
      );
    }
  }
});

test("#4 no-op reprint on same-status preserves timestamps & attempts", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  const before = structuredClone(s.stages[0]);
  const reprinted = transition(s, { stage: "write-spec", to: "running", at: AT3 });
  assert.deepEqual(reprinted.stages[0], before);
});

test("#4 outputs via transition land byte-identically to a direct recordOutput", () => {
  const base = mkRun(["write-spec"]);
  let started = transition(base, {
    stage: "write-spec",
    to: "running",
    at: AT,
  });
  const viaRecord = recordOutput(started, {
    stage: "write-spec",
    prs: [10],
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT,
  });
  const viaTransition = transition(started, {
    stage: "write-spec",
    expectedStatus: "running",
    to: "halted",
    prs: [10],
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    gate: { reason: "x", detail: "y" },
    at: AT,
  });
  // output-bearing fields identical between the two mutation paths
  assert.deepEqual(viaTransition.artifact_prs, viaRecord.artifact_prs);
  assert.deepEqual(
    viaTransition.stages[0].prs,
    viaRecord.stages[0].prs,
  );
  assert.deepEqual(
    viaTransition.stages[0].artifacts,
    viaRecord.stages[0].artifacts,
  );
});

// ---------------------------------------------------------------------------
// Test #5 — attempts archive exactly once, at episode end
// ---------------------------------------------------------------------------

test("#5 attempts archive exactly once per episode; re-entry appends nothing", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = transition(s, {
    stage: "write-spec",
    to: "failed",
    gate: { reason: "boom", detail: "exit 1" },
    at: AT2,
  });
  assert.equal(s.stages[0].attempts.length, 1);
  assert.deepEqual(s.stages[0].attempts[0], {
    started_at: AT,
    ended_at: AT2,
    outcome: "failed",
  });

  // failed → running re-entry appends NOTHING and clears gate/ended_at
  s = transition(s, { stage: "write-spec", to: "running", at: AT3 });
  assert.equal(s.stages[0].attempts.length, 1);
  assert.equal(s.stages[0].gate, null);
  assert.equal(s.stages[0].ended_at, null);
  assert.equal(s.stages[0].started_at, AT3);

  // running → done archives nothing
  s = recordOutput(s, {
    stage: "write-spec",
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT3,
  });
  s = transition(s, { stage: "write-spec", to: "done", at: AT3 });
  assert.equal(s.stages[0].attempts.length, 1);
});

test("#5 running→halted appends one halted attempt", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = transition(s, {
    stage: "write-spec",
    to: "halted",
    gate: { reason: "fold_pr_open", detail: "#5" },
    at: AT2,
  });
  assert.deepEqual(s.stages[0].attempts, [
    { started_at: AT, ended_at: AT2, outcome: "halted" },
  ]);
});

// ---------------------------------------------------------------------------
// Test #6 — running→done required-output + merge/marker gate
// ---------------------------------------------------------------------------

test("#6 →done fails when a required output is absent", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  assert.throws(
    () => transition(s, { stage: "write-spec", to: "done", at: AT2 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "missing_required_output");
      return true;
    },
  );
});

test("#6 merge-point →done fails when artifact_prs is empty (no vacuous pass)", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp);
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  assert.throws(
    () =>
      transition(
        s,
        { stage: "review-spec", to: "done", at: AT2 },
        allMerged,
      ),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "empty_artifact_prs");
      return true;
    },
  );
});

test("#6 merge-point →done fails when a registry PR is not merged, succeeds when all merged", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp);
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  s = recordOutput(s, { stage: "review-spec", prs: [42], at: AT });

  assert.throws(
    () =>
      transition(s, { stage: "review-spec", to: "done", at: AT2 }, allOpen),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "merge_pending");
      return true;
    },
  );

  const done = transition(
    s,
    { stage: "review-spec", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(done.stages[0].status, "done");
});

test("#6 merge-point →done requires EVERY artifact PR merged (impl multi-PR, one open blocks)", () => {
  const mp: MergePoint[] = [{ after_stage: "copilot", artifact: "impl" }];
  let s = mkRun(["copilot"], mp);
  s = transition(s, { stage: "copilot", to: "running", at: AT });
  s = recordOutput(s, { stage: "copilot", prs: [1, 2, 3], at: AT });
  assert.deepEqual(s.artifact_prs.impl, [1, 2, 3]);

  // PR #2 still open → the whole gate fails (no partial pass on multi-PR impl).
  const twoOpen: PrReader = (pr) => (pr === 2 ? "open" : "merged");
  assert.throws(
    () => transition(s, { stage: "copilot", to: "done", at: AT2 }, twoOpen),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "merge_pending");
      return true;
    },
  );

  // A different single PR open still blocks (prove it isn't just PR #2).
  const threeOpen: PrReader = (pr) => (pr === 3 ? "open" : "merged");
  assert.throws(
    () => transition(s, { stage: "copilot", to: "done", at: AT2 }, threeOpen),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "merge_pending");
      return true;
    },
  );

  // Only once ALL three are merged does →done succeed.
  const done = transition(
    s,
    { stage: "copilot", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(done.stages[0].status, "done");
});

test("#6 recorded fold PR stops blocking once the reader reports merged or closed", () => {
  const mp: MergePoint[] = [{ after_stage: "red-team-spec", artifact: "spec" }];
  let s = mkRun(["red-team-spec"], mp);
  s = transition(s, { stage: "red-team-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "red-team-spec",
    prs: [42],
    foldPrs: [99],
    at: AT,
  });

  // fold PR merged → no longer blocks (registry PR #42 also merged).
  const foldMerged = transition(
    s,
    { stage: "red-team-spec", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(foldMerged.stages[0].status, "done");

  // fold PR closed (abandoned) → also no longer blocks.
  const foldClosed: PrReader = (pr) => (pr === 99 ? "closed" : "merged");
  const closedDone = transition(
    s,
    { stage: "red-team-spec", to: "done", at: AT2 },
    foldClosed,
  );
  assert.equal(closedDone.stages[0].status, "done");
});

test("#6 merge-point →done fails while a fold PR is open", () => {
  const mp: MergePoint[] = [{ after_stage: "red-team-spec", artifact: "spec" }];
  let s = mkRun(["red-team-spec"], mp);
  s = transition(s, { stage: "red-team-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "red-team-spec",
    prs: [42],
    foldPrs: [99],
    at: AT,
  });
  const reader: PrReader = (pr) => (pr === 99 ? "open" : "merged");
  assert.throws(
    () =>
      transition(s, { stage: "red-team-spec", to: "done", at: AT2 }, reader),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "fold_pr_open");
      return true;
    },
  );
});

test("#6 plan-to-tasks →done requires non-empty issue_numbers", () => {
  let s = mkRun(["plan-to-tasks"]);
  s = transition(s, { stage: "plan-to-tasks", to: "running", at: AT });
  // absent → fails
  assert.throws(
    () => transition(s, { stage: "plan-to-tasks", to: "done", at: AT2 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "missing_required_output");
      return true;
    },
  );
  // recorded → succeeds, no PR gate (not a merge point)
  s = recordOutput(s, {
    stage: "plan-to-tasks",
    artifacts: { issue_numbers: [1, 2] },
    at: AT,
  });
  const done = transition(s, { stage: "plan-to-tasks", to: "done", at: AT2 });
  assert.equal(done.stages[0].status, "done");
  assert.deepEqual(done.stages[0].prs, []); // no PR ever
});

// ---------------------------------------------------------------------------
// Test #22 — recordOutput patch semantics + one-owner PR registry
// ---------------------------------------------------------------------------

test("#22 issue_numbers union-dedup incremental persistence", () => {
  let s = mkRun(["plan-to-tasks"]);
  s = transition(s, { stage: "plan-to-tasks", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "plan-to-tasks",
    artifacts: { issue_numbers: [1, 2] },
    at: AT,
  });
  s = recordOutput(s, {
    stage: "plan-to-tasks",
    artifacts: { issue_numbers: [2, 3] },
    at: AT2,
  });
  assert.deepEqual(s.stages[0].artifacts.issue_numbers, [1, 2, 3]);
});

test("#22 write-once scalar artifact → artifact_conflict on divergent re-report", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "write-spec",
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT,
  });
  // identical re-report = no-op
  const same = recordOutput(s, {
    stage: "write-spec",
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT2,
  });
  assert.equal(same.stages[0].artifacts.spec_path, "docs/specs/a-spec.md");
  // divergent → conflict
  assert.throws(
    () =>
      recordOutput(s, {
        stage: "write-spec",
        artifacts: { spec_path: "docs/specs/b-spec.md" },
        at: AT2,
      }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "artifact_conflict");
      return true;
    },
  );
});

test("#22 adoption_mismatch on a continuation-stage divergent PR (write-once spec)", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["write-spec", "review-spec"], mp);
  // write-spec opens PR 10 → seeds registry
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = recordOutput(s, { stage: "write-spec", prs: [10], at: AT });
  assert.deepEqual(s.artifact_prs.spec, [10]);
  // review-spec adopting the same PR = fine (no-op registry)
  s = transition(s, { stage: "review-spec", to: "running", at: AT2 });
  s = recordOutput(s, { stage: "review-spec", prs: [10], at: AT2 });
  assert.deepEqual(s.artifact_prs.spec, [10]);
  // review-spec reporting a DIFFERENT PR → mismatch
  assert.throws(
    () => recordOutput(s, { stage: "review-spec", prs: [11], at: AT3 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "adoption_mismatch");
      return true;
    },
  );
});

test("#22 impl-only incremental union across a crash (copilot PR 1 → [1,2])", () => {
  let s = mkRun(["copilot"]);
  s = transition(s, { stage: "copilot", to: "running", at: AT });
  s = recordOutput(s, { stage: "copilot", prs: [1], at: AT });
  assert.deepEqual(s.artifact_prs.impl, [1]);
  // crash + re-report with more PRs → incremental union, NO mismatch
  s = recordOutput(s, { stage: "copilot", prs: [1, 2], at: AT2 });
  assert.deepEqual(s.artifact_prs.impl, [1, 2]);
  assert.deepEqual(s.stages[0].prs, [1, 2]);
});

test("#22 spec/plan write-once even for a sliced-chain review opener", () => {
  // path-based start: review-spec is the PR opener (seeds registry)
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp, {
    input: { kind: "spec-path", value: "docs/specs/a-spec.md" },
    initial_artifacts: { spec_path: "docs/specs/a-spec.md" },
  });
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  s = recordOutput(s, { stage: "review-spec", prs: [20], at: AT });
  assert.deepEqual(s.artifact_prs.spec, [20]);
  // crash + re-entry reporting a DIFFERENT PR → adoption_mismatch (write-once)
  assert.throws(
    () => recordOutput(s, { stage: "review-spec", prs: [21], at: AT2 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "adoption_mismatch");
      return true;
    },
  );
});

test("#22 registry seeding by a review stage passes the merge gate (spec & plan paths)", () => {
  // spec-path chain
  const specMp: MergePoint[] = [
    { after_stage: "review-spec", artifact: "spec" },
  ];
  let sp = mkRun(["review-spec"], specMp);
  sp = transition(sp, { stage: "review-spec", to: "running", at: AT });
  sp = recordOutput(sp, { stage: "review-spec", prs: [30], at: AT });
  sp = transition(
    sp,
    { stage: "review-spec", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(sp.stages[0].status, "done");

  // plan-path chain
  const planMp: MergePoint[] = [
    { after_stage: "review-plan", artifact: "plan" },
  ];
  let pp = mkRun(["review-plan"], planMp);
  pp = transition(pp, { stage: "review-plan", to: "running", at: AT });
  pp = recordOutput(pp, { stage: "review-plan", prs: [40], at: AT });
  pp = transition(
    pp,
    { stage: "review-plan", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(pp.stages[0].status, "done");
});

test("#22 merges keyed by pr, monotonic: true never overwritten by false", () => {
  let s = mkRun(["copilot"]);
  s = transition(s, { stage: "copilot", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "copilot",
    merges: [{ pr: 1, merged_by_forge: true }],
    at: AT,
  });
  // attempt to demote with false → stays true
  s = recordOutput(s, {
    stage: "copilot",
    merges: [{ pr: 1, merged_by_forge: false }],
    at: AT2,
  });
  assert.deepEqual(s.stages[0].merges, [{ pr: 1, merged_by_forge: true }]);
  // false can promote to true
  s = recordOutput(s, {
    stage: "copilot",
    merges: [{ pr: 2, merged_by_forge: false }],
    at: AT2,
  });
  s = recordOutput(s, {
    stage: "copilot",
    merges: [{ pr: 2, merged_by_forge: true }],
    at: AT3,
  });
  assert.deepEqual(s.stages[0].merges, [
    { pr: 1, merged_by_forge: true },
    { pr: 2, merged_by_forge: true },
  ]);
});

test("#22 input state is never mutated (returns a new RunState)", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  const frozen = structuredClone(s);
  recordOutput(s, {
    stage: "write-spec",
    prs: [1],
    artifacts: { spec_path: "x" },
    at: AT,
  });
  assert.deepEqual(s, frozen);
});

test("#22 recordOutput is rejected unless the stage is running (no mutation)", () => {
  // pending, halted, failed, and terminal done are all rejected without mutation
  const statuses: { setup: (s: RunState) => RunState; label: string }[] = [
    { label: "pending", setup: (s) => s },
    {
      label: "halted",
      setup: (s) => {
        s = transition(s, { stage: "copilot", to: "running", at: AT });
        return transition(s, {
          stage: "copilot",
          to: "halted",
          gate: { reason: "x", detail: "y" },
          at: AT2,
        });
      },
    },
    {
      label: "failed",
      setup: (s) => {
        s = transition(s, { stage: "copilot", to: "running", at: AT });
        return transition(s, {
          stage: "copilot",
          to: "failed",
          gate: { reason: "x", detail: "y" },
          at: AT2,
        });
      },
    },
    {
      label: "done",
      setup: (s) => {
        s = transition(s, { stage: "copilot", to: "running", at: AT });
        s = recordOutput(s, { stage: "copilot", prs: [1], at: AT });
        return transition(
          s,
          { stage: "copilot", to: "done", at: AT2 },
          allMerged,
        );
      },
    },
  ];
  for (const { setup, label } of statuses) {
    const mp: MergePoint[] = [{ after_stage: "copilot", artifact: "impl" }];
    const s = setup(mkRun(["copilot"], mp));
    const frozen = structuredClone(s);
    assert.throws(
      () => recordOutput(s, { stage: "copilot", prs: [99], at: AT3 }),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "stage_not_running", `status=${label}`);
        return true;
      },
    );
    assert.deepEqual(s, frozen, `status=${label} left unmutated`);
  }
});

test("#22 spec/plan registry seed rejects multiple distinct PRs; impl allows many", () => {
  // spec seed [10, 11] → rejected (one shared PR per spec)
  let sp = mkRun(["write-spec"]);
  sp = transition(sp, { stage: "write-spec", to: "running", at: AT });
  assert.throws(
    () => recordOutput(sp, { stage: "write-spec", prs: [10, 11], at: AT }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "multiple_seed_prs");
      return true;
    },
  );

  // plan seed [10, 11] → rejected (one shared PR per plan)
  let pp = mkRun(["spec-to-plan"]);
  pp = transition(pp, { stage: "spec-to-plan", to: "running", at: AT });
  assert.throws(
    () => recordOutput(pp, { stage: "spec-to-plan", prs: [10, 11], at: AT }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "multiple_seed_prs");
      return true;
    },
  );

  // impl seed [10, 11] → accepted (copilot multi-PR)
  let ip = mkRun(["copilot"]);
  ip = transition(ip, { stage: "copilot", to: "running", at: AT });
  ip = recordOutput(ip, { stage: "copilot", prs: [10, 11], at: AT });
  assert.deepEqual(ip.artifact_prs.impl, [10, 11]);
});

test("#22 plan-to-tasks (null artifact) rejects prs via recordOutput AND transition", () => {
  let s = mkRun(["plan-to-tasks"]);
  s = transition(s, { stage: "plan-to-tasks", to: "running", at: AT });
  // direct recordOutput with prs → rejected
  assert.throws(
    () => recordOutput(s, { stage: "plan-to-tasks", prs: [5], at: AT2 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "no_pr_for_stage");
      return true;
    },
  );
  // fold_prs likewise
  assert.throws(
    () => recordOutput(s, { stage: "plan-to-tasks", foldPrs: [6], at: AT2 }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "no_pr_for_stage");
      return true;
    },
  );
  // via transition delegation → same rejection, no mutation
  const frozen = structuredClone(s);
  assert.throws(
    () =>
      transition(s, {
        stage: "plan-to-tasks",
        to: "halted",
        prs: [5],
        gate: { reason: "x", detail: "y" },
        at: AT2,
      }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "no_pr_for_stage");
      return true;
    },
  );
  assert.deepEqual(s, frozen);
  assert.deepEqual(s.stages[0].prs, []);
});

test("#22 identical re-report is a no-op that preserves updated_at", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "write-spec",
    prs: [10],
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT2,
  });
  assert.equal(s.updated_at, AT2);
  // identical re-report with a DIFFERENT `at` → full-state equality, updated_at
  // unchanged (no-op does not bump the clock).
  const same = recordOutput(s, {
    stage: "write-spec",
    prs: [10],
    artifacts: { spec_path: "docs/specs/a-spec.md" },
    at: AT3,
  });
  assert.deepEqual(same, s);
  assert.equal(same.updated_at, AT2);
});

// ---------------------------------------------------------------------------
// reconcile primitive — one crashed attempt, never double-archived
// ---------------------------------------------------------------------------

test("reconcile → failed appends exactly one crashed attempt (no failed twin)", () => {
  let s = mkRun(["write-spec"]);
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = reconcileRunningStage(
    s,
    {
      stage: "write-spec",
      to: "failed",
      gate: { reason: "reconciled_after_crash", detail: "" },
      at: AT2,
    },
    allMerged,
  );
  assert.equal(s.stages[0].status, "failed");
  // exactly one crashed attempt and NO failed twin — assert the full array.
  assert.deepEqual(s.stages[0].attempts, [
    { started_at: AT, ended_at: null, outcome: "crashed" },
  ]);
  // subsequent failed → running re-entry appends nothing
  s = transition(s, { stage: "write-spec", to: "running", at: AT3 });
  assert.deepEqual(s.stages[0].attempts, [
    { started_at: AT, ended_at: null, outcome: "crashed" },
  ]);
});

test("reconcile → halted appends one crashed attempt with a gate", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp);
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  s = reconcileRunningStage(
    s,
    {
      stage: "review-spec",
      to: "halted",
      gate: { reason: "merge_pending", detail: "#42" },
      at: AT2,
    },
    allOpen,
  );
  assert.equal(s.stages[0].status, "halted");
  assert.equal(s.stages[0].gate?.reason, "merge_pending");
  // exactly one crashed attempt and NO halted twin — assert the full array.
  assert.deepEqual(s.stages[0].attempts, [
    { started_at: AT, ended_at: null, outcome: "crashed" },
  ]);
});

test("reconcile → done enforces the merge gate and records observed merges as merged_by_forge:false", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp);
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  s = recordOutput(s, { stage: "review-spec", prs: [42], at: AT });
  s = reconcileRunningStage(
    s,
    {
      stage: "review-spec",
      to: "done",
      observedMerges: [{ pr: 42 }],
      at: AT2,
    },
    allMerged,
  );
  assert.equal(s.stages[0].status, "done");
  assert.deepEqual(s.stages[0].merges, [{ pr: 42, merged_by_forge: false }]);
  // exactly one crashed attempt and NO done-path twin — assert the full array.
  assert.deepEqual(s.stages[0].attempts, [
    { started_at: AT, ended_at: null, outcome: "crashed" },
  ]);
});

test("reconcile → done enforces required outputs (plan-to-tasks issue_numbers, with & without)", () => {
  let s = mkRun(["plan-to-tasks"]);
  s = transition(s, { stage: "plan-to-tasks", to: "running", at: AT });

  // WITHOUT issue_numbers → the T5 required-output gate blocks the crash resolve.
  const frozen = structuredClone(s);
  assert.throws(
    () =>
      reconcileRunningStage(
        s,
        { stage: "plan-to-tasks", to: "done", at: AT2 },
        allMerged,
      ),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "missing_required_output");
      return true;
    },
  );
  assert.deepEqual(s, frozen, "failed reconcile leaves state unmutated");

  // WITH issue_numbers recorded → resolves, exactly one crashed attempt, no PR gate.
  s = recordOutput(s, {
    stage: "plan-to-tasks",
    artifacts: { issue_numbers: [1, 2] },
    at: AT,
  });
  const done = reconcileRunningStage(
    s,
    { stage: "plan-to-tasks", to: "done", at: AT2 },
    allMerged,
  );
  assert.equal(done.stages[0].status, "done");
  assert.deepEqual(done.stages[0].attempts, [
    { started_at: AT, ended_at: null, outcome: "crashed" },
  ]);
  assert.deepEqual(done.stages[0].prs, []); // never a PR
});

test("reconcile → done never demotes an existing merged_by_forge:true", () => {
  const mp: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  let s = mkRun(["review-spec"], mp);
  s = transition(s, { stage: "review-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "review-spec",
    prs: [42],
    merges: [{ pr: 42, merged_by_forge: true }],
    at: AT,
  });
  s = reconcileRunningStage(
    s,
    {
      stage: "review-spec",
      to: "done",
      observedMerges: [{ pr: 42 }],
      at: AT2,
    },
    allMerged,
  );
  assert.deepEqual(s.stages[0].merges, [{ pr: 42, merged_by_forge: true }]);
});

test("reconcile requires the stage to be running", () => {
  const s = mkRun(["write-spec"]); // pending
  assert.throws(
    () =>
      reconcileRunningStage(
        s,
        {
          stage: "write-spec",
          to: "failed",
          gate: { reason: "x", detail: "" },
          at: AT,
        },
        allMerged,
      ),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "not_running");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Structural guard: `outcome: "crashed"` is produced ONLY in reconcile
// ---------------------------------------------------------------------------

test("grep guard: outcome:\"crashed\" produced only inside reconcileRunningStage", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "forge_state_lib.ts"), "utf8");
  // The only object literal producing a crashed outcome.
  const matches = [...src.matchAll(/outcome:\s*"crashed"/g)];
  assert.equal(matches.length, 1, "exactly one crashed-outcome literal");
  // and it must live inside the reconcile function body
  const reconcileStart = src.indexOf("export function reconcileRunningStage");
  const nextExport = src.indexOf("export function initializeRun");
  const idx = src.indexOf('outcome: "crashed"');
  assert.ok(
    idx > reconcileStart && idx < nextExport,
    "crashed literal is inside reconcileRunningStage",
  );
});

// ---------------------------------------------------------------------------
// Test #14 — slug sanitization: a path-traversal intent cannot escape the dir
// ---------------------------------------------------------------------------

test("slug sanitization: a path-traversal intent cannot escape the history dir", () => {
  // Traversal / separator / dot-file attempts all collapse to safe kebab.
  const attacks: [string, string][] = [
    ["../../etc/passwd", "etc-passwd"],
    ["..", "run"],
    [".", "run"],
    ["...", "run"],
    ["/absolute/path", "absolute-path"],
    [".hidden", "hidden"],
    ["a/b/c", "a-b-c"],
    ["My Cool Intent!", "my-cool-intent"],
    ["", "run"],
    ["   ", "run"],
    ["___", "run"],
    ["Foo..Bar", "foo-bar"],
  ];
  for (const [raw, want] of attacks) {
    const slug = sanitizeSlug(raw);
    assert.equal(slug, want, `sanitizeSlug(${JSON.stringify(raw)})`);
    // Structural traversal guarantees, regardless of the exact mapping:
    assert.doesNotMatch(slug, /[/\\]/, "no path separator");
    assert.doesNotMatch(slug, /^\./, "no leading dot");
    assert.ok(slug !== "." && slug !== "..", "never a dot-dir");
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, "kebab, leading alnum");
  }
  // Long input is capped and never left with a trailing dash.
  const long = sanitizeSlug("x".repeat(500));
  assert.ok(long.length <= 80);
  assert.doesNotMatch(long, /-$/);
});

test("lib imports nothing network/clock/disk", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "forge_state_lib.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']fs["']/);
  assert.doesNotMatch(src, /from\s+["']node:fs["']/);
  assert.doesNotMatch(src, /Date\.now\(/);
  assert.doesNotMatch(src, /stateRoot/);
  assert.doesNotMatch(src, /from\s+["']child_process["']/);
});

// ---------------------------------------------------------------------------
// Test #7 — chain resolver: auto-detection, red-team inserts, --from/--until
// ---------------------------------------------------------------------------

const DEFAULT_6: Stage[] = [
  "write-spec",
  "review-spec",
  "spec-to-plan",
  "review-plan",
  "plan-to-tasks",
  "copilot",
];
const FULL_8: Stage[] = [
  "write-spec",
  "review-spec",
  "red-team-spec",
  "spec-to-plan",
  "review-plan",
  "red-team-plan",
  "plan-to-tasks",
  "copilot",
];

test("#7 default chain: intent → full 6-stage chain from write-spec", () => {
  assert.deepEqual(
    resolveChain({ inputKind: "intent", redTeam: false }),
    DEFAULT_6,
  );
});

test("#7 auto-detection: spec-path starts at review-spec, plan-path at review-plan", () => {
  assert.deepEqual(resolveChain({ inputKind: "spec-path", redTeam: false }), [
    "review-spec",
    "spec-to-plan",
    "review-plan",
    "plan-to-tasks",
    "copilot",
  ]);
  assert.deepEqual(resolveChain({ inputKind: "plan-path", redTeam: false }), [
    "review-plan",
    "plan-to-tasks",
    "copilot",
  ]);
});

test("#7 --red-team inserts red-team-spec after review-spec and red-team-plan after review-plan (8 stages)", () => {
  assert.deepEqual(
    resolveChain({ inputKind: "intent", redTeam: true }),
    FULL_8,
  );
  // red-team inserts survive auto-detection from a spec path
  assert.deepEqual(resolveChain({ inputKind: "spec-path", redTeam: true }), [
    "review-spec",
    "red-team-spec",
    "spec-to-plan",
    "review-plan",
    "red-team-plan",
    "plan-to-tasks",
    "copilot",
  ]);
});

test("#7 --from/--until slice the resolved order (inclusive)", () => {
  assert.deepEqual(
    resolveChain({
      inputKind: "intent",
      redTeam: false,
      from: "spec-to-plan",
      until: "review-plan",
    }),
    ["spec-to-plan", "review-plan"],
  );
  // --from overrides auto-detection
  assert.deepEqual(
    resolveChain({
      inputKind: "spec-path",
      redTeam: false,
      from: "write-spec",
    }),
    DEFAULT_6,
  );
  // --until short of copilot on a red-team chain
  assert.deepEqual(
    resolveChain({
      inputKind: "intent",
      redTeam: true,
      until: "red-team-spec",
    }),
    ["write-spec", "review-spec", "red-team-spec"],
  );
});

test("#7 --until naming a red-team stage without --red-team throws stage_not_in_chain", () => {
  assert.throws(
    () =>
      resolveChain({
        inputKind: "intent",
        redTeam: false,
        until: "red-team-spec",
      }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "stage_not_in_chain");
      return true;
    },
  );
});

test("#7 --from after --until produces empty_chain", () => {
  assert.throws(
    () =>
      resolveChain({
        inputKind: "intent",
        redTeam: false,
        from: "copilot",
        until: "review-spec",
      }),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "empty_chain");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test #8 — mergePointsFor: one merge per artifact at the last touching stage
// ---------------------------------------------------------------------------

test("#8 default 6-stage chain: spec after review-spec, plan after review-plan, impl after copilot; none for plan-to-tasks", () => {
  assert.deepEqual(mergePointsFor(DEFAULT_6), [
    { after_stage: "review-spec", artifact: "spec" },
    { after_stage: "review-plan", artifact: "plan" },
    { after_stage: "copilot", artifact: "impl" },
  ]);
});

test("#8 red-team chain: merges move to the last present of each artifact's stages", () => {
  assert.deepEqual(mergePointsFor(FULL_8), [
    { after_stage: "red-team-spec", artifact: "spec" },
    { after_stage: "red-team-plan", artifact: "plan" },
    { after_stage: "copilot", artifact: "impl" },
  ]);
});

test("#8 chain ending at an author stage yields no merge for that artifact", () => {
  // --until write-spec: author-only spec chain → no spec merge
  assert.deepEqual(mergePointsFor(["write-spec"]), []);
  // --until spec-to-plan: spec reviewed (merge) but plan author-only (no merge)
  assert.deepEqual(
    mergePointsFor(["write-spec", "review-spec", "spec-to-plan"]),
    [{ after_stage: "review-spec", artifact: "spec" }],
  );
});

test("#8 plan-path slice: only plan + impl merges (no spec)", () => {
  assert.deepEqual(
    mergePointsFor(["review-plan", "plan-to-tasks", "copilot"]),
    [
      { after_stage: "review-plan", artifact: "plan" },
      { after_stage: "copilot", artifact: "impl" },
    ],
  );
});

// ---------------------------------------------------------------------------
// Test #10 — command renderer + threading against §4 recorded fields
// ---------------------------------------------------------------------------

// Build an 8-stage run with producer artifacts recorded, then render commands.
function fullRunWithArtifacts(): RunState {
  const chain = FULL_8;
  let s = mkRun(chain, mergePointsFor(chain), {
    input: { kind: "intent", value: "build the thing" },
  });
  // write-spec produces spec_path
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "write-spec",
    artifacts: { spec_path: "docs/specs/2026-07-19-demo-spec.md" },
    at: AT,
  });
  // spec-to-plan produces plan_path AND plan_slug. Deliberately make plan_slug
  // DIFFER from what a filename re-parse of plan_path would give, so test #10
  // proves copilot reads the recorded slug, not a re-derivation.
  s = transition(s, { stage: "spec-to-plan", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "spec-to-plan",
    artifacts: {
      plan_path: "docs/plans/2026-07-19-demo-plan.md",
      plan_slug: "custom-plan-slug",
    },
    at: AT,
  });
  return s;
}

test("#10 every stage command renders exactly per the spec §2 table", () => {
  const s = fullRunWithArtifacts();
  assert.equal(
    renderStageCommand(s, "write-spec"),
    '/stark-write-spec "build the thing"',
  );
  assert.equal(
    renderStageCommand(s, "review-spec"),
    "/stark-review-spec docs/specs/2026-07-19-demo-spec.md",
  );
  assert.equal(
    renderStageCommand(s, "red-team-spec"),
    "/stark-red-team-spec docs/specs/2026-07-19-demo-spec.md --fold",
  );
  assert.equal(
    renderStageCommand(s, "spec-to-plan"),
    "/stark-spec-to-plan docs/specs/2026-07-19-demo-spec.md",
  );
  assert.equal(
    renderStageCommand(s, "review-plan"),
    "/stark-review-plan docs/plans/2026-07-19-demo-plan.md",
  );
  assert.equal(
    renderStageCommand(s, "red-team-plan"),
    "/stark-red-team-plan docs/plans/2026-07-19-demo-plan.md --fold",
  );
  assert.equal(
    renderStageCommand(s, "plan-to-tasks"),
    "/stark-plan-to-tasks docs/plans/2026-07-19-demo-plan.md --plan-slug custom-plan-slug",
  );
  assert.equal(
    renderStageCommand(s, "copilot"),
    "/stark-copilot --plan-slug custom-plan-slug",
  );
});

test("#10 both red-team commands carry --fold", () => {
  const s = fullRunWithArtifacts();
  assert.match(renderStageCommand(s, "red-team-spec"), /--fold$/);
  assert.match(renderStageCommand(s, "red-team-plan"), /--fold$/);
});

test("#10 copilot --plan-slug reads spec-to-plan's recorded plan_slug, never a filename re-derivation", () => {
  const s = fullRunWithArtifacts();
  // plan_path parses to "demo"; the recorded slug is "custom-plan-slug".
  assert.equal(parsePlanSlug("docs/plans/2026-07-19-demo-plan.md"), "demo");
  const cmd = renderStageCommand(s, "copilot");
  assert.ok(
    cmd.includes("custom-plan-slug") && !cmd.includes("demo"),
    `copilot slug must come from artifacts.plan_slug, got: ${cmd}`,
  );
  // nextInputFor threads only the recorded slug.
  assert.deepEqual(nextInputFor(s, "copilot"), {
    plan_slug: "custom-plan-slug",
  });
});

test("#10 path-based start threads initial_artifacts (review-plan from an imported plan)", () => {
  const chain: Stage[] = ["review-plan", "plan-to-tasks", "copilot"];
  const s = mkRun(chain, mergePointsFor(chain), {
    input: { kind: "plan-path", value: "docs/plans/2026-07-19-imported-plan.md" },
    initial_artifacts: {
      plan_path: "docs/plans/2026-07-19-imported-plan.md",
      plan_slug: "imported",
    },
  });
  assert.equal(
    renderStageCommand(s, "review-plan"),
    "/stark-review-plan docs/plans/2026-07-19-imported-plan.md",
  );
  assert.equal(
    renderStageCommand(s, "copilot"),
    "/stark-copilot --plan-slug imported",
  );
});

// Table-driven coverage (spec test #10): every input kind × every stage in the
// resolved chain, threading each producer's reported path/slug and asserting the
// full rendered command matches the §2 table. Covers intent, existing spec
// path, existing plan path, AND a path-like nonexistent intent (which §1 fails
// toward write-spec). The recorded plan_slug ("custom-plan-slug") deliberately
// differs from a filename re-parse of PLAN ("demo") so no case can pass on a
// re-derivation.
const SPEC = "docs/specs/2026-07-19-demo-spec.md";
const PLAN = "docs/plans/2026-07-19-demo-plan.md";
const PLAN_SLUG = "custom-plan-slug";

// The exact §2-table command for each stage, given the fixtures above.
function expectedCommand(stage: Stage, intentValue: string): string {
  switch (stage) {
    case "write-spec":
      return `/stark-write-spec ${encodeIntent(intentValue)}`;
    case "review-spec":
      return `/stark-review-spec ${SPEC}`;
    case "red-team-spec":
      return `/stark-red-team-spec ${SPEC} --fold`;
    case "spec-to-plan":
      return `/stark-spec-to-plan ${SPEC}`;
    case "review-plan":
      return `/stark-review-plan ${PLAN}`;
    case "red-team-plan":
      return `/stark-red-team-plan ${PLAN} --fold`;
    case "plan-to-tasks":
      return `/stark-plan-to-tasks ${PLAN} --plan-slug ${PLAN_SLUG}`;
    case "copilot":
      return `/stark-copilot --plan-slug ${PLAN_SLUG}`;
  }
}

// Build a run at the state where every stage's inputs are available: producers
// present in the chain record their outputs; artifacts an earlier producer
// (absent from a sliced chain) would have owned are seeded via initial_artifacts.
function runForCase(c: {
  input: RunInput;
  chain: Stage[];
  initial_artifacts: StageArtifacts;
}): RunState {
  let s = mkRun(c.chain, mergePointsFor(c.chain), {
    input: c.input,
    initial_artifacts: c.initial_artifacts,
  });
  if (c.chain.includes("write-spec")) {
    s = transition(s, { stage: "write-spec", to: "running", at: AT });
    s = recordOutput(s, {
      stage: "write-spec",
      artifacts: { spec_path: SPEC },
      at: AT,
    });
  }
  if (c.chain.includes("spec-to-plan")) {
    s = transition(s, { stage: "spec-to-plan", to: "running", at: AT });
    s = recordOutput(s, {
      stage: "spec-to-plan",
      artifacts: { plan_path: PLAN, plan_slug: PLAN_SLUG },
      at: AT,
    });
  }
  return s;
}

test("#10 table-driven: each input kind starts at its §1 stage and every stage renders exactly", () => {
  const cases: Array<{
    name: string;
    input: RunInput;
    inputKind: "intent" | "spec-path" | "plan-path";
    redTeam: boolean;
    entry: Stage;
    initial_artifacts: StageArtifacts;
  }> = [
    {
      name: "intent (8-stage, red-team)",
      input: { kind: "intent", value: "build the thing" },
      inputKind: "intent",
      redTeam: true,
      entry: "write-spec",
      initial_artifacts: {},
    },
    {
      name: "path-like nonexistent intent → write-spec (6-stage)",
      // §1: a positional that looks like a path but does not exist is free-text intent.
      input: { kind: "intent", value: "docs/specs/2099-01-01-ghost-spec.md" },
      inputKind: "intent",
      redTeam: false,
      entry: "write-spec",
      initial_artifacts: {},
    },
    {
      name: "existing spec path → review-spec (8-stage, red-team)",
      input: { kind: "spec-path", value: SPEC },
      inputKind: "spec-path",
      redTeam: true,
      entry: "review-spec",
      initial_artifacts: { spec_path: SPEC },
    },
    {
      name: "existing plan path → review-plan (6-stage)",
      input: { kind: "plan-path", value: PLAN },
      inputKind: "plan-path",
      redTeam: false,
      entry: "review-plan",
      // Import contract (§4): a plan-path start seeds plan_path AND the imported slug.
      initial_artifacts: { plan_path: PLAN, plan_slug: PLAN_SLUG },
    },
  ];

  for (const c of cases) {
    const chain = resolveChain({ inputKind: c.inputKind, redTeam: c.redTeam });
    assert.equal(chain[0], c.entry, `${c.name}: entry stage`);
    const s = runForCase({
      input: c.input,
      chain,
      initial_artifacts: c.initial_artifacts,
    });
    for (const stage of chain) {
      assert.equal(
        renderStageCommand(s, stage),
        expectedCommand(stage, c.input.value),
        `${c.name}: stage '${stage}' command`,
      );
    }
    // The amended plan-to-tasks command carries BOTH the plan path and the slug.
    if (chain.includes("plan-to-tasks")) {
      assert.equal(
        renderStageCommand(s, "plan-to-tasks"),
        `/stark-plan-to-tasks ${PLAN} --plan-slug ${PLAN_SLUG}`,
        `${c.name}: plan-to-tasks amended command`,
      );
    }
    // copilot's slug always comes from the recorded/imported plan_slug, never
    // a filename re-derivation (PLAN parses to "demo", not "custom-plan-slug").
    if (chain.includes("copilot")) {
      assert.equal(parsePlanSlug(PLAN), "demo");
      assert.ok(
        renderStageCommand(s, "copilot").endsWith(`--plan-slug ${PLAN_SLUG}`),
        `${c.name}: copilot slug from recorded artifact`,
      );
    }
  }
});

test("#10 renderStageCommand throws when a required input has not been threaded", () => {
  const s = mkRun(DEFAULT_6, mergePointsFor(DEFAULT_6)); // no artifacts recorded
  assert.throws(
    () => renderStageCommand(s, "review-spec"),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "unthreaded_input");
      return true;
    },
  );
});

test("#10 planPathFor / parsePlanSlug round-trip the strict dated convention", () => {
  assert.equal(
    planPathFor("my-thing", "2026-07-19"),
    "docs/plans/2026-07-19-my-thing-plan.md",
  );
  assert.equal(parsePlanSlug(planPathFor("my-thing", "2026-07-19")), "my-thing");
  // real dated file (spec-to-plan's runtime output) parses to the slug
  assert.equal(parsePlanSlug("docs/plans/2026-07-19-my-thing-plan.md"), "my-thing");
});

test("#10 parsePlanSlug rejects nonconforming paths (date-less, malformed date, empty slug, wrong dir)", () => {
  // date-less
  assert.equal(parsePlanSlug("docs/plans/my-thing-plan.md"), null);
  // malformed date
  assert.equal(parsePlanSlug("docs/plans/2026-7-9-my-thing-plan.md"), null);
  assert.equal(parsePlanSlug("docs/plans/20260719-my-thing-plan.md"), null);
  // empty slug
  assert.equal(parsePlanSlug("docs/plans/2026-07-19--plan.md"), null);
  // wrong directory / bare filename
  assert.equal(parsePlanSlug("2026-07-19-alpha-plan.md"), null);
  assert.equal(parsePlanSlug("docs/specs/2026-07-19-x-spec.md"), null);
  assert.equal(parsePlanSlug("other/plans/2026-07-19-x-plan.md"), null);
  assert.equal(parsePlanSlug("random.md"), null);
});

test("#10 planPathFor rejects a malformed date or a slug that would break the round-trip", () => {
  assert.throws(() => planPathFor("ok", "2026-7-19"));
  assert.throws(() => planPathFor("ok", "not-a-date"));
  assert.throws(() => planPathFor("bad slug", "2026-07-19"));
  assert.throws(() => planPathFor("has/slash", "2026-07-19"));
});

test("#10 parsePlanSlug rejects an option-shaped slug the renderer would reject", () => {
  // Regression: `docs/plans/2026-07-19---plan.md` used to parse to "-", which
  // is option-shaped and later threw `unsafe_threaded_arg` in the renderer.
  assert.equal(parsePlanSlug("docs/plans/2026-07-19---plan.md"), null);
  assert.equal(parsePlanSlug("docs/plans/2026-07-19--x-plan.md"), null); // leading '-'
});

test("#10 parse/render agree: every non-null parsed slug is renderable as a bare arg", () => {
  const paths = [
    "docs/plans/2026-07-19-my-thing-plan.md",
    "docs/plans/2026-07-19-a-plan-plan.md", // slug 'a-plan'
    "docs/plans/2026-07-19-x_y.z-plan.md",
    "docs/plans/2026-07-19-A123-plan.md",
    "docs/plans/2026-07-19---plan.md", // parses to null → skipped
    "docs/plans/2026-07-19--plan.md", // empty slug → null → skipped
    "docs/specs/2026-07-19-x-spec.md", // wrong dir → null → skipped
  ];
  for (const p of paths) {
    const slug = parsePlanSlug(p);
    if (slug === null) continue;
    // The invariant finding #2 wants: a parsed slug is always renderable, so
    // Phase 5 never accepts an import that the renderer later rejects.
    assert.ok(
      isRenderableArg(slug),
      `parsed slug ${JSON.stringify(slug)} from ${p} must be renderable`,
    );
    // And it survives the full render path (copilot threads plan_slug bare).
    const s = mkRun(["copilot"], [], {
      input: { kind: "plan-path", value: p },
      initial_artifacts: { plan_path: p, plan_slug: slug },
    });
    assert.equal(
      renderStageCommand(s, "copilot"),
      `/stark-copilot --plan-slug ${slug}`,
    );
  }
});


test("#10 encodeIntent refuses control / line-separator intents rather than inventing an undecoded escape", () => {
  for (const intent of [
    "line1\nline2",
    "carriage\r\nreturn",
    "tab\there",
    "bell\x07",
    "nextline", // U+0085 NEL (C1)
    "c1control", // C1 control range start
    "line separator", // U+2028
    "para separator", // U+2029
  ]) {
    assert.throws(
      () => encodeIntent(intent),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "intent_unencodable");
        return true;
      },
      `a control/separator-bearing intent (${JSON.stringify(intent)}) must be refused, not silently escaped`,
    );
  }
});



test("#10 renderStageCommand rejects an option-shaped or metacharacter-bearing threaded arg", () => {
  for (const badSlug of ["--fold", "-x", "has space", "quote'd", "back\\slash", "n\newline"]) {
    const chain: Stage[] = ["copilot"];
    const s = mkRun(chain, [], {
      input: { kind: "plan-path", value: "docs/plans/2026-07-19-x-plan.md" },
      initial_artifacts: {
        plan_path: "docs/plans/2026-07-19-x-plan.md",
        plan_slug: badSlug,
      },
    });
    assert.throws(
      () => renderStageCommand(s, "copilot"),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, "unsafe_threaded_arg");
        return true;
      },
      `a producer-broken slug (${JSON.stringify(badSlug)}) must be refused, not quoted`,
    );
  }
});

// ---------------------------------------------------------------------------
// initializeRun — the pure run-state constructor (T7)
// ---------------------------------------------------------------------------

test("initializeRun builds the exact initial shape (all stages pending, empty registries)", () => {
  const chain: Stage[] = ["write-spec", "review-spec", "spec-to-plan"];
  const mps: MergePoint[] = [{ after_stage: "review-spec", artifact: "spec" }];
  const state = initializeRun(
    resolved(chain, mps, {
      slug: "my-run",
      input: { kind: "intent", value: "hi" },
    }),
    { runId: "run-abc", at: AT, mode: "in-session" },
  );
  assert.equal(state.slug, "my-run");
  assert.equal(state.run_id, "run-abc");
  assert.equal(state.mode, "in-session");
  assert.deepEqual(state.input, { kind: "intent", value: "hi" });
  assert.deepEqual(state.initial_artifacts, {});
  assert.deepEqual(state.artifact_prs, {});
  assert.deepEqual(state.chain, chain);
  assert.deepEqual(state.merge_points, mps);
  assert.deepEqual(state.repo, REPO);
  assert.equal(state.default_branch, "main");
  assert.equal(state.created_at, AT);
  assert.equal(state.updated_at, AT);
  assert.equal(state.abandoned_at, null);
  assert.equal(state.stages.length, 3);
  for (const rec of state.stages) {
    assert.equal(rec.status, "pending");
    assert.deepEqual(rec.prs, []);
    assert.deepEqual(rec.fold_prs, []);
    assert.deepEqual(rec.merges, []);
    assert.deepEqual(rec.artifacts, {});
    assert.equal(rec.gate, null);
    assert.equal(rec.started_at, null);
    assert.equal(rec.ended_at, null);
    assert.deepEqual(rec.attempts, []);
  }
  assert.ok(!state.stages.some((s) => s.status === "running"));
});

test("initializeRun: two runs of the same slug get distinct host-supplied run_ids", () => {
  const r = resolved(["write-spec"]);
  const a = initializeRun(r, { runId: "run-A", at: AT, mode: "in-session" });
  const b = initializeRun(r, { runId: "run-B", at: AT2, mode: "driver" });
  assert.equal(a.slug, b.slug);
  assert.notEqual(a.run_id, b.run_id);
  assert.equal(b.mode, "driver");
});
