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
  abandonRun,
  encodeIntent,
  initializeRun,
  resumeTarget,
  selectResumeRun,
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

// ---------------------------------------------------------------------------
// Phase 4 — resumeTarget / abandon / selectResumeRun (T1–T4)
// ---------------------------------------------------------------------------

const AT4 = "2026-07-19T03:00:00Z";

/** PR-state reader from a fixed map (default "open" for unknown PRs). */
function prMap(m: Record<number, "open" | "merged" | "closed">): PrReader {
  return (pr) => m[pr] ?? "open";
}

/** Put stage[0] of `chain` into `running`, optionally recording a checkpoint. */
function crashRunning(
  chain: Stage[],
  overrides: Partial<Parameters<typeof resolved>[2]> = {},
  checkpoint?: {
    prs?: number[];
    foldPrs?: number[];
    artifacts?: Partial<StageArtifacts>;
  },
): RunState {
  const mps = mergePointsFor(chain);
  let s = mkRun(chain, mps, overrides as any);
  const stage = chain[0];
  s = transition(s, { stage, to: "running", at: AT });
  if (checkpoint) {
    s = recordOutput(s, {
      stage,
      prs: checkpoint.prs,
      foldPrs: checkpoint.foldPrs,
      artifacts: checkpoint.artifacts,
      at: AT2,
    });
  }
  return s;
}

// --- #1: merged merge-point → done → advance/complete; author early-merge → abandon
test("#1 merge-point all merged → done + recompute (advance to next pending)", () => {
  // write-spec (author) done already, review-spec (merge point) crashed after
  // recording its adopted PR; the spec PR is merged → reconcile done → advance.
  const chain: Stage[] = ["review-spec", "spec-to-plan"];
  let s = crashRunning(
    chain,
    { initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" } },
    { prs: [10] },
  );
  const { state, target } = resumeTarget(s, prMap({ 10: "merged" }));
  assert.equal(target.reconciled, true);
  assert.equal(target.action, "advance");
  assert.equal(target.target_stage, "spec-to-plan");
  // reconciled state carries the mutation: review-spec is done with a crashed attempt
  const rs = state.stages.find((x) => x.stage === "review-spec")!;
  assert.equal(rs.status, "done");
  assert.equal(rs.attempts.filter((a) => a.outcome === "crashed").length, 1);
  // advance → command rendered, requires_base_sync from the target (spec-to-plan)
  assert.equal(target.requires_base_sync, true);
  assert.equal(target.command, "/stark-spec-to-plan docs/specs/2026-07-19-x-spec.md");
});

test("#1 non-merge author stage with an externally-merged PR → abandon", () => {
  const chain: Stage[] = ["write-spec", "review-spec"];
  const s = crashRunning(chain, {}, {
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { state, target } = resumeTarget(s, prMap({ 10: "merged" }));
  assert.equal(target.action, "abandon");
  assert.equal(target.target_stage, "write-spec");
  assert.equal(target.command, null);
  assert.equal(target.requires_base_sync, false);
  const ws = state.stages.find((x) => x.stage === "write-spec")!;
  assert.equal(ws.status, "halted");
  assert.equal(ws.gate?.reason, "author_pr_merged_early");
  assert.equal(ws.attempts.filter((a) => a.outcome === "crashed").length, 1);
});

// --- #2: checkpoint present vs absent decides done/merge_only vs reinvoke
test("#2 merge-point checkpoint present but merge pending → halted merge_pending + merge_only", () => {
  const chain: Stage[] = ["copilot"];
  const s = crashRunning(chain, {}, { prs: [1, 2] });
  const { state, target } = resumeTarget(s, prMap({ 1: "merged", 2: "open" }));
  assert.equal(target.action, "merge_only");
  assert.equal(target.target_stage, "copilot");
  assert.equal(target.command, null);
  assert.equal(target.requires_base_sync, true);
  const cp = state.stages.find((x) => x.stage === "copilot")!;
  assert.equal(cp.status, "halted");
  assert.equal(cp.gate?.reason, "merge_pending");
});

test("#2 merge-point checkpoint absent → failed reconciled_after_crash + reinvoke", () => {
  const chain: Stage[] = ["review-spec", "spec-to-plan"];
  const s = crashRunning(chain, {
    initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "reinvoke");
  assert.equal(target.target_stage, "review-spec");
  assert.equal(target.command, "/stark-review-spec docs/specs/2026-07-19-x-spec.md");
  assert.equal(target.requires_base_sync, false);
  const rs = state.stages.find((x) => x.stage === "review-spec")!;
  assert.equal(rs.status, "failed");
  assert.equal(rs.gate?.reason, "reconciled_after_crash");
});

// --- #3: plan-to-tasks issue_numbers marker
test("#3 plan-to-tasks marker present → done + advance, no re-run", () => {
  const chain: Stage[] = ["plan-to-tasks", "copilot"];
  const s = crashRunning(
    chain,
    {
      initial_artifacts: {
        plan_path: "docs/plans/2026-07-19-x-plan.md",
        plan_slug: "x",
      },
    },
    { artifacts: { issue_numbers: [11, 12] } },
  );
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "advance");
  assert.equal(target.target_stage, "copilot");
  assert.equal(target.command, "/stark-copilot --plan-slug x");
  assert.equal(target.requires_base_sync, true);
  assert.equal(state.stages.find((x) => x.stage === "plan-to-tasks")!.status, "done");
});

test("#3 plan-to-tasks marker absent → failed + reinvoke with --plan-slug", () => {
  const chain: Stage[] = ["plan-to-tasks", "copilot"];
  const s = crashRunning(chain, {
    initial_artifacts: {
      plan_path: "docs/plans/2026-07-19-x-plan.md",
      plan_slug: "x",
    },
  });
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "reinvoke");
  assert.equal(target.target_stage, "plan-to-tasks");
  assert.equal(
    target.command,
    "/stark-plan-to-tasks docs/plans/2026-07-19-x-plan.md --plan-slug x",
  );
  assert.equal(target.requires_base_sync, true);
  assert.equal(state.stages.find((x) => x.stage === "plan-to-tasks")!.status, "failed");
});

// --- terminal-slice --until crash → done + complete
test("terminal --until write-spec crash-after-output → done + complete", () => {
  const s = crashRunning(["write-spec"], {}, {
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { state, target } = resumeTarget(s, prMap({ 10: "open" }));
  assert.equal(target.action, "complete");
  assert.equal(target.target_stage, "write-spec");
  assert.equal(target.command, null);
  assert.equal(target.requires_base_sync, false);
  assert.equal(state.stages[0].status, "done");
});

test("terminal --until spec-to-plan crash-after-output → done + complete (requires_base_sync true, command null)", () => {
  const s = crashRunning(
    ["spec-to-plan"],
    { initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" } },
    {
      prs: [20],
      artifacts: {
        plan_path: "docs/plans/2026-07-19-x-plan.md",
        plan_slug: "x",
      },
    },
  );
  const { target } = resumeTarget(s, prMap({ 20: "open" }));
  assert.equal(target.action, "complete");
  assert.equal(target.target_stage, "spec-to-plan");
  assert.equal(target.command, null);
  assert.equal(target.requires_base_sync, true);
});

// --- pending target → advance (resume right after init)
test("pending target → advance into the first pending stage (no reconciliation)", () => {
  const chain: Stage[] = ["write-spec", "review-spec"];
  const s = mkRun(chain, mergePointsFor(chain));
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.reconciled, false);
  assert.equal(state, s); // input returned unchanged
  assert.equal(target.action, "advance");
  assert.equal(target.target_stage, "write-spec");
  assert.equal(target.command, '/stark-write-spec "do a thing"');
  assert.equal(target.requires_base_sync, false);
});

// --- #20: crash-before-output every input kind → failed + reinvoke
test("#20 crash-before-output intent/spec-path/plan-path → reinvoke with the entry command", () => {
  // intent → write-spec
  {
    const s = crashRunning(["write-spec", "review-spec"]);
    const { target } = resumeTarget(s, allOpen);
    assert.equal(target.action, "reinvoke");
    assert.equal(target.target_stage, "write-spec");
    assert.equal(target.command, '/stark-write-spec "do a thing"');
    assert.equal(target.requires_base_sync, false);
  }
  // spec-path → review-spec
  {
    const s = crashRunning(["review-spec", "spec-to-plan"], {
      initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
    });
    const { target } = resumeTarget(s, allOpen);
    assert.equal(target.action, "reinvoke");
    assert.equal(target.command, "/stark-review-spec docs/specs/2026-07-19-x-spec.md");
  }
  // plan-path → review-plan
  {
    const s = crashRunning(["review-plan", "plan-to-tasks"], {
      initial_artifacts: { plan_path: "docs/plans/2026-07-19-x-plan.md" },
    });
    const { target } = resumeTarget(s, allOpen);
    assert.equal(target.action, "reinvoke");
    assert.equal(target.command, "/stark-review-plan docs/plans/2026-07-19-x-plan.md");
  }
});

// --- #16: multi-impl-PR merge_only + partial merges recorded monotonically
test("#16 copilot multi-PR, one merged one open → merge_only", () => {
  const s = crashRunning(["copilot"], {}, { prs: [1, 2, 3] });
  const { state, target } = resumeTarget(
    s,
    prMap({ 1: "merged", 2: "merged", 3: "open" }),
  );
  assert.equal(target.action, "merge_only");
  assert.equal(target.command, null);
  // The already-merged PRs are recorded merged_by_forge:false even while the
  // merge overall stays pending (partial merges are never discarded, #16). PR 3
  // (still open) is NOT recorded as merged.
  const cp = state.stages.find((x) => x.stage === "copilot")!;
  assert.equal(cp.status, "halted");
  assert.equal(cp.gate?.reason, "merge_pending");
  assert.deepEqual(cp.merges, [
    { pr: 1, merged_by_forge: false },
    { pr: 2, merged_by_forge: false },
  ]);
});

// --- #17: fold PR blocks then unblocks
test("#17 open fold PR blocks the merge → fold_pr_open + merge_only", () => {
  const s = crashRunning(["copilot"], {}, { prs: [1], foldPrs: [5] });
  const { state, target } = resumeTarget(s, prMap({ 1: "merged", 5: "open" }));
  assert.equal(target.action, "merge_only");
  assert.equal(state.stages[0].gate?.reason, "fold_pr_open");
});

test("#17 fold PR merged + registry merged → done + complete", () => {
  const s = crashRunning(["copilot"], {}, { prs: [1], foldPrs: [5] });
  const { state, target } = resumeTarget(s, prMap({ 1: "merged", 5: "merged" }));
  assert.equal(target.action, "complete");
  assert.equal(state.stages[0].status, "done");
});

// --- closed registry PR → dead end
test("registry PR reported closed → halted artifact_pr_closed + abandon", () => {
  const s = crashRunning(["copilot"], {}, { prs: [1, 2] });
  const { state, target } = resumeTarget(s, prMap({ 1: "merged", 2: "closed" }));
  assert.equal(target.action, "abandon");
  assert.equal(target.command, null);
  assert.equal(state.stages[0].status, "halted");
  assert.equal(state.stages[0].gate?.reason, "artifact_pr_closed");
});

// --- actionForStoppedStage keys off merge-point membership + checkpoint, not status
test("persisted failed merge-point WITH checkpoint (ci_red) → merge_only, not reinvoke", () => {
  // copilot (merge point) recorded its PR, then CI went red post-checkpoint — a
  // real episode-end failure, not a crash. The review/copilot work is done; only
  // the merge needs retrying → merge_only (reinvoke would repeat completed work).
  let s = crashRunning(["copilot"], {}, { prs: [1] });
  s = transition(s, {
    stage: "copilot",
    to: "failed",
    gate: { reason: "ci_red", detail: "CI failed on the impl PR" },
    at: AT3,
  });
  const { state, target } = resumeTarget(s, prMap({ 1: "open" }));
  assert.equal(target.reconciled, false); // no running stage
  assert.equal(state, s);
  assert.equal(target.action, "merge_only");
  assert.equal(target.command, null);
  assert.equal(target.target_stage, "copilot");
});

test("persisted halted merge-point WITHOUT checkpoint → reinvoke, not merge_only", () => {
  // A halted merge point that never recorded its PR observation has no completed
  // merge to retry — its work must be re-invoked.
  let s = crashRunning(["copilot"], {
    initial_artifacts: { plan_slug: "x" },
  });
  s = transition(s, {
    stage: "copilot",
    to: "halted",
    gate: { reason: "merge_pending", detail: "no PR recorded" },
    at: AT3,
  });
  const { target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "reinvoke");
  assert.equal(target.command, "/stark-copilot --plan-slug x");
  assert.equal(target.target_stage, "copilot");
});

// --- closed author PR (non-merge author stage) → dead end
test("checkpointed non-merge author stage, PR closed without merge → halted artifact_pr_closed + abandon", () => {
  // write-spec recorded its spec + author PR, crashed, and that PR was then
  // closed without merging. A closed author PR can't be adopted by the paired
  // review → dead end (abandon), never a fall-through to done + advance.
  const chain: Stage[] = ["write-spec", "review-spec"];
  const s = crashRunning(chain, {}, {
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { state, target } = resumeTarget(s, prMap({ 10: "closed" }));
  assert.equal(target.action, "abandon");
  assert.equal(target.target_stage, "write-spec");
  assert.equal(target.command, null);
  const ws = state.stages.find((x) => x.stage === "write-spec")!;
  assert.equal(ws.status, "halted");
  assert.equal(ws.gate?.reason, "artifact_pr_closed");
  // review-spec is never entered
  assert.equal(state.stages.find((x) => x.stage === "review-spec")!.status, "pending");
});

// --- #18: failed/halted stage stops the chain, never auto-skipped
test("#18 a failed stage stops the chain — target is that stage, no downstream entry", () => {
  const chain: Stage[] = ["write-spec", "review-spec", "spec-to-plan"];
  let s = mkRun(chain, mergePointsFor(chain));
  // write-spec → done
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = recordOutput(s, {
    stage: "write-spec",
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
    at: AT,
  });
  s = transition(s, { stage: "write-spec", to: "done", at: AT2 });
  // review-spec → running → failed (a real episode-end, not a crash)
  s = transition(s, { stage: "review-spec", to: "running", at: AT2 });
  s = transition(s, {
    stage: "review-spec",
    to: "failed",
    gate: { reason: "domain_error", detail: "x" },
    at: AT3,
  });
  const { state, target } = resumeTarget(s, prMap({ 10: "open" }));
  assert.equal(target.reconciled, false); // no running stage → no reconciliation
  assert.equal(state, s);
  assert.equal(target.target_stage, "review-spec");
  assert.equal(target.action, "reinvoke");
  assert.equal(target.command, "/stark-review-spec docs/specs/2026-07-19-x-spec.md");
  // downstream spec-to-plan is still pending and never selected
  assert.equal(state.stages.find((x) => x.stage === "spec-to-plan")!.status, "pending");
});

test("#18 an already-persisted halted merge-point stage → merge_only without reconciliation", () => {
  let s = crashRunning(["copilot"], {}, { prs: [1] });
  // Persist a prior reconciliation: halt merge_pending, then re-load (no running).
  const first = resumeTarget(s, prMap({ 1: "open" }));
  assert.equal(first.target.action, "merge_only");
  // Feed the reconciled state back in — no running stage now.
  const second = resumeTarget(first.state, prMap({ 1: "open" }));
  assert.equal(second.target.reconciled, false);
  assert.equal(second.target.action, "merge_only");
  assert.equal(second.target.target_stage, "copilot");
});

// --- red-team-chain review stages are non-merge-point + PR-backed (finding #1):
// their requiredOutputsFor list is EMPTY, so the checkpoint gate must key off the
// adopted PR — a crash before the PR is recorded must NOT reconcile to done.
test("red-team chain: review-spec crash BEFORE recording adopted PR → reinvoke, not done-skip", () => {
  // ["review-spec", "red-team-spec"] → red-team-spec is the spec merge point,
  // review-spec is non-merge + PR-backed. review-spec crashes with no PR recorded.
  const chain: Stage[] = ["review-spec", "red-team-spec"];
  const s = crashRunning(chain, {
    initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "reinvoke");
  assert.equal(target.target_stage, "review-spec");
  assert.equal(target.command, "/stark-review-spec docs/specs/2026-07-19-x-spec.md");
  const rs = state.stages.find((x) => x.stage === "review-spec")!;
  assert.equal(rs.status, "failed");
  assert.equal(rs.gate?.reason, "reconciled_after_crash");
  // red-team-spec is never entered (review not silently skipped)
  assert.equal(state.stages.find((x) => x.stage === "red-team-spec")!.status, "pending");
});

test("red-team chain: review-spec crash AFTER recording adopted PR → done + advance", () => {
  const chain: Stage[] = ["review-spec", "red-team-spec"];
  const s = crashRunning(
    chain,
    { initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" } },
    { prs: [10] },
  );
  const { state, target } = resumeTarget(s, prMap({ 10: "open" }));
  assert.equal(target.action, "advance");
  assert.equal(target.target_stage, "red-team-spec");
  assert.equal(state.stages.find((x) => x.stage === "review-spec")!.status, "done");
});

test("red-team chain: review-plan crash BEFORE recording adopted PR → reinvoke, not done-skip", () => {
  const chain: Stage[] = ["review-plan", "red-team-plan"];
  const s = crashRunning(chain, {
    initial_artifacts: { plan_path: "docs/plans/2026-07-19-x-plan.md" },
  });
  const { state, target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "reinvoke");
  assert.equal(target.target_stage, "review-plan");
  assert.equal(target.command, "/stark-review-plan docs/plans/2026-07-19-x-plan.md");
  const rp = state.stages.find((x) => x.stage === "review-plan")!;
  assert.equal(rp.status, "failed");
  assert.equal(rp.gate?.reason, "reconciled_after_crash");
  assert.equal(state.stages.find((x) => x.stage === "red-team-plan")!.status, "pending");
});

test("red-team chain: review-plan crash AFTER recording adopted PR → done + advance", () => {
  const chain: Stage[] = ["review-plan", "red-team-plan"];
  const s = crashRunning(
    chain,
    { initial_artifacts: { plan_path: "docs/plans/2026-07-19-x-plan.md" } },
    { prs: [20] },
  );
  const { state, target } = resumeTarget(s, prMap({ 20: "open" }));
  assert.equal(target.action, "advance");
  assert.equal(target.target_stage, "red-team-plan");
  assert.equal(state.stages.find((x) => x.stage === "review-plan")!.status, "done");
});

// --- persisted merge_pending re-routed to abandon once its PR is closed (finding
// #2): a checkpointed stopped merge point must live-check the registry, never
// retry merge_only forever against a PR that can no longer merge.
test("persisted merge_pending then PR closed on re-resume → abandon, not endless merge_only", () => {
  const s = crashRunning(["copilot"], {}, { prs: [1] });
  // First resume: PR open → merge_pending halt → merge_only.
  const first = resumeTarget(s, prMap({ 1: "open" }));
  assert.equal(first.target.action, "merge_only");
  const cp = first.state.stages.find((x) => x.stage === "copilot")!;
  assert.equal(cp.status, "halted");
  assert.equal(cp.gate?.reason, "merge_pending");
  // Second resume on the persisted state: the registry PR is now closed → abandon.
  const second = resumeTarget(first.state, prMap({ 1: "closed" }));
  assert.equal(second.target.reconciled, false); // no running stage
  assert.equal(second.target.action, "abandon");
  assert.equal(second.target.target_stage, "copilot");
  assert.equal(second.target.command, null);
});

// --- T2: abandonRun + selectResumeRun
test("#13 selectResumeRun picks latest non-done non-abandoned; abandonRun excludes", () => {
  const doneRun = (() => {
    let s = crashRunning(["write-spec"], {}, {
      prs: [10],
      artifacts: { spec_path: "docs/specs/2026-07-19-a-spec.md" },
    });
    s = transition(s, { stage: "write-spec", to: "done", at: AT2 });
    s.run_id = "run-done";
    s.updated_at = "2026-07-19T09:00:00Z";
    return s;
  })();
  let abandoned = crashRunning(["copilot"], {}, { prs: [1] });
  abandoned = resumeTarget(abandoned, prMap({ 1: "closed" })).state;
  abandoned = abandonRun(abandoned, "2026-07-19T10:00:00Z");
  abandoned.run_id = "run-abandoned";
  assert.equal(abandoned.abandoned_at, "2026-07-19T10:00:00Z");

  const halted = (() => {
    let s = crashRunning(["copilot"], {}, { prs: [1] });
    s = resumeTarget(s, prMap({ 1: "open" })).state; // halted merge_pending
    s.run_id = "run-halted";
    s.updated_at = "2026-07-19T08:00:00Z";
    return s;
  })();

  const pick = selectResumeRun([doneRun, abandoned, halted]);
  assert.ok(pick);
  assert.equal(pick!.run_id, "run-halted");

  // abandoned + done runs excluded from resumeTarget selection entirely
  assert.equal(selectResumeRun([doneRun, abandoned]), null);
});

test("abandonRun is idempotent and resumeTarget refuses an abandoned run", () => {
  let s = crashRunning(["copilot"], {}, { prs: [1] });
  s = abandonRun(s, "2026-07-19T10:00:00Z");
  const again = abandonRun(s, "2026-07-19T11:00:00Z");
  assert.equal(again.abandoned_at, "2026-07-19T10:00:00Z"); // original preserved
  assert.throws(() => resumeTarget(s, allOpen), /abandoned/);
});

// --- descriptor identity fields
test("resumeTarget descriptor carries run_id + slug", () => {
  const s = crashRunning(["write-spec"], {}, {
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  const { target } = resumeTarget(s, prMap({ 10: "open" }));
  assert.equal(target.run_id, s.run_id);
  assert.equal(target.slug, s.slug);
});

// --- finding 1: frontier-first reconciliation (T3 stop invariant)
// A stopped (failed/halted) earlier stage halts the chain; a later `running`
// stage must NOT be reconciled — no downstream mutation, no PR read.
test("failed frontier with a downstream running stage → fail closed, no downstream mutation or PR read", () => {
  const chain: Stage[] = ["write-spec", "review-spec", "spec-to-plan"];
  let s = mkRun(chain, mergePointsFor(chain), {
    initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  s = transition(s, {
    stage: "write-spec",
    to: "failed",
    gate: { reason: "domain_error", detail: "x" },
    at: AT2,
  });
  // Force an impossible downstream running episode (invariant violation).
  s = transition(s, { stage: "review-spec", to: "running", at: AT2 });
  const before = JSON.stringify(s);
  let prRead = false;
  const spyReader: PrReader = (pr) => {
    prRead = true;
    return "open";
  };
  assert.throws(() => resumeTarget(s, spyReader), /downstream/);
  assert.equal(prRead, false, "no PR read when failing closed on downstream running");
  assert.equal(JSON.stringify(s), before, "input state not mutated");
});

test("running frontier with a downstream running stage → fail closed BEFORE reconciling the frontier (no PR read or mutation)", () => {
  // Two running stages: the frontier is itself running AND a later stage is
  // running. Reconciling the frontier (→failed/halted/done) while the downstream
  // episode is still live would violate T3 — so the check must run BEFORE any
  // reconciliation, regardless of the frontier's own status.
  const chain: Stage[] = ["write-spec", "review-spec", "spec-to-plan"];
  let s = mkRun(chain, mergePointsFor(chain), {
    initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  s = transition(s, { stage: "write-spec", to: "running", at: AT });
  // Force an impossible second live episode downstream of the running frontier.
  s = transition(s, { stage: "review-spec", to: "running", at: AT2 });
  const before = JSON.stringify(s);
  let prRead = false;
  const spyReader: PrReader = () => {
    prRead = true;
    return "open";
  };
  assert.throws(() => resumeTarget(s, spyReader), /downstream/);
  assert.equal(prRead, false, "no PR read when the frontier is running too");
  assert.equal(JSON.stringify(s), before, "input state not mutated");
});

test("two-argument reconciliation never moves updated_at backward or backdates ended_at", () => {
  // `resumeTarget` is a two-argument API, so reconciliation derives its own
  // timestamp with no clock. It must use the run's last-recorded `updated_at`,
  // NOT the crashed stage's `started_at`: a mid-stage `record-output` checkpoint
  // advances `updated_at` past `started_at`, so keying off `started_at` would
  // rewind the run's clock and stamp the crashed attempt's `ended_at` *before*
  // the very outputs it is reconciling.
  const chain: Stage[] = ["review-spec", "spec-to-plan"];
  const s = crashRunning(
    chain,
    { initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" } },
    { prs: [10] },
  );
  const rec = s.stages.find((x) => x.stage === "review-spec")!;
  const startedAt = rec.started_at!;
  assert.ok(startedAt, "precondition: the crashed frontier recorded a started_at");
  // Simulate the checkpoint that advances the run clock past the stage start.
  const later = "2026-07-19T23:59:59Z";
  assert.ok(later > startedAt, "precondition: checkpoint is after the stage start");
  s.updated_at = later;

  const { state, target } = resumeTarget(s, prMap({ 10: "merged" }));
  assert.equal(target.reconciled, true);
  const rs = state.stages.find((x) => x.stage === "review-spec")!;
  assert.equal(rs.status, "done");
  // Monotonic: the run clock never decreases.
  assert.ok(
    state.updated_at >= later,
    `updated_at must not move backward: ${state.updated_at} < ${later}`,
  );
  // And the crashed attempt is not backdated before the outputs it reconciles.
  const crashed = rs.attempts.filter((a) => a.outcome === "crashed");
  assert.equal(crashed.length, 1, "exactly one crashed attempt");
  assert.ok(
    rs.ended_at! >= startedAt,
    `ended_at must not predate the stage start: ${rs.ended_at} < ${startedAt}`,
  );
});

test("selectResumeRun picks the newest run by created_at, not most-recently-updated", () => {
  // Spec `behavior`: no-arg `--resume` selects the latest non-done,
  // non-abandoned run "across slugs, by created_at/mtime". An OLDER run that
  // merely saw a recent checkpoint must not displace a genuinely NEWER run.
  const older = crashRunning(["write-spec"], {}, {});
  older.slug = "older";
  older.run_id = "20260719-000000-aaa";
  older.created_at = "2026-07-19T00:00:00Z";
  older.updated_at = "2026-07-19T23:00:00Z"; // updated most recently

  const newer = crashRunning(["write-spec"], {}, {});
  newer.slug = "newer";
  newer.run_id = "20260719-120000-bbb";
  newer.created_at = "2026-07-19T12:00:00Z"; // created later
  newer.updated_at = "2026-07-19T12:30:00Z"; // but updated earlier

  const picked = selectResumeRun([older, newer]);
  assert.equal(picked?.slug, "newer", "created_at wins over updated_at");
  // Order of the input array must not matter.
  assert.equal(selectResumeRun([newer, older])?.slug, "newer");
});

// --- finding 2: a checkpointed HALTED non-merge author stage → abandon, not
// reinvoke (re-invoking would repeat already-completed authoring). Derived from
// checkpoint + status, NOT from a hard-coded dead-end gate reason.
test("checkpointed halted write-spec with a non-special gate reason → abandon, not reinvoke", () => {
  const chain: Stage[] = ["write-spec", "review-spec"];
  let s = crashRunning(chain, {}, {
    prs: [10],
    artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  // Normal episode-end halt with a non-dead-end reason (not merged-early/closed).
  s = transition(s, {
    stage: "write-spec",
    to: "halted",
    gate: { reason: "operator_halt", detail: "stopped by hand" },
    at: AT3,
  });
  const { target } = resumeTarget(s, prMap({ 10: "open" }));
  assert.equal(target.reconciled, false); // no running stage
  assert.equal(target.action, "abandon");
  assert.equal(target.target_stage, "write-spec");
  assert.equal(target.command, null);
});

test("checkpointed halted spec-to-plan with a non-special gate reason → abandon", () => {
  const chain: Stage[] = ["spec-to-plan", "plan-to-tasks"];
  let s = crashRunning(chain, {}, {
    prs: [10],
    artifacts: { plan_path: "docs/plans/2026-07-19-x-plan.md", plan_slug: "x" },
  });
  s = transition(s, {
    stage: "spec-to-plan",
    to: "halted",
    gate: { reason: "operator_halt", detail: "stopped by hand" },
    at: AT3,
  });
  const { target } = resumeTarget(s, allOpen);
  assert.equal(target.action, "abandon");
  assert.equal(target.target_stage, "spec-to-plan");
  assert.equal(target.command, null);
});

// --- finding 3: abandonment is terminal — every mutating entry point rejects an
// abandoned run (pending AND running), while abandonRun stays idempotent.
test("abandoned run rejects recordOutput/transition/reconcileRunningStage; abandonRun idempotent", () => {
  // running abandoned state
  let running = crashRunning(["copilot"], {}, { prs: [1] });
  running = abandonRun(running, "2026-07-19T10:00:00Z");
  assert.throws(
    () => recordOutput(running, { stage: "copilot", prs: [2], at: AT4 }),
    /abandoned/,
  );
  assert.throws(
    () =>
      transition(running, {
        stage: "copilot",
        to: "halted",
        gate: { reason: "x", detail: "y" },
        at: AT4,
      }),
    /abandoned/,
  );
  assert.throws(
    () =>
      reconcileRunningStage(
        running,
        { stage: "copilot", to: "failed", gate: { reason: "x", detail: "y" }, at: AT4 },
        allOpen,
      ),
    /abandoned/,
  );

  // pending abandoned state — still rejects mutation
  let pending = mkRun(["write-spec"], mergePointsFor(["write-spec"]), {
    initial_artifacts: { spec_path: "docs/specs/2026-07-19-x-spec.md" },
  });
  pending = abandonRun(pending, "2026-07-19T10:00:00Z");
  assert.throws(
    () => transition(pending, { stage: "write-spec", to: "running", at: AT4 }),
    /abandoned/,
  );

  // abandonRun itself remains reachable + idempotent on an abandoned run
  const again = abandonRun(running, "2026-07-19T12:00:00Z");
  assert.equal(again.abandoned_at, "2026-07-19T10:00:00Z");
});
