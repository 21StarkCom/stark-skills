import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildTaskMarker,
  hasTaskMarker,
  computePlanToTasksDedup,
  mergeIssueNumbers,
  type ExistingIssueRecord,
  type PlannedTaskInput,
} from "./plan_to_tasks_dedup_lib.ts";

// --- buildTaskMarker / hasTaskMarker ---------------------------------------

describe("buildTaskMarker / hasTaskMarker", () => {
  test("marker is a plan_slug/task_id-scoped HTML comment", () => {
    assert.equal(buildTaskMarker("demo-plan", "task-1-1-foo"), "<!-- stark-task: demo-plan/task-1-1-foo -->");
  });

  test("hasTaskMarker matches exact marker inside a larger body", () => {
    const body = "## What\nSome text.\n\n<!-- stark-task: demo-plan/task-1-1-foo -->\n";
    assert.equal(hasTaskMarker(body, "demo-plan", "task-1-1-foo"), true);
  });

  test("hasTaskMarker is false for null/undefined/empty body", () => {
    assert.equal(hasTaskMarker(null, "demo-plan", "task-1-1-foo"), false);
    assert.equal(hasTaskMarker(undefined, "demo-plan", "task-1-1-foo"), false);
    assert.equal(hasTaskMarker("", "demo-plan", "task-1-1-foo"), false);
  });

  test("hasTaskMarker does not match a different plan_slug or task_id", () => {
    const body = "<!-- stark-task: other-plan/task-1-1-foo -->";
    assert.equal(hasTaskMarker(body, "demo-plan", "task-1-1-foo"), false);
    const body2 = "<!-- stark-task: demo-plan/task-1-1-bar -->";
    assert.equal(hasTaskMarker(body2, "demo-plan", "task-1-1-foo"), false);
  });
});

// --- computePlanToTasksDedup: required gate tests --------------------------

describe("computePlanToTasksDedup — the BLOCKING BUILD GATE", () => {
  test("plan-to-tasks re-run after marker-absent crash creates no duplicate issues", () => {
    const planSlug = "demo-plan";

    // Simulate a run that crashed AFTER creating issues #101-#103 (each
    // stamped with its task marker) but before the run finished — the
    // "run manifest" that was never actually written/consulted no longer
    // matters; the marker on the issue itself is the sole source of truth.
    const existingIssues: ExistingIssueRecord[] = [
      { number: 101, title: "Add user entity", body: "## What\n...\n<!-- stark-task: demo-plan/task-1-1-user-entity -->" },
      { number: 102, title: "Add auth middleware", body: "## What\n...\n<!-- stark-task: demo-plan/task-1-2-auth-middleware -->" },
      { number: 103, title: "Wire up login route", body: "## What\n...\n<!-- stark-task: demo-plan/task-1-3-login-route -->" },
    ];

    const plannedTasks: PlannedTaskInput[] = [
      { task_id: "task-1-1-user-entity", title: "Add user entity", phase_id: "phase-1" },
      { task_id: "task-1-2-auth-middleware", title: "Add auth middleware", phase_id: "phase-1" },
      { task_id: "task-1-3-login-route", title: "Wire up login route", phase_id: "phase-1" },
    ];

    const result = computePlanToTasksDedup(planSlug, plannedTasks, existingIssues);

    assert.deepEqual(result.toCreate, [], "re-run must create zero new issues for tasks already marked");
    assert.equal(result.toSkip.length, 3);
    assert.deepEqual(
      result.toSkip.map((s) => s.issue_number).sort(),
      [101, 102, 103],
    );
    assert.deepEqual(result.issueNumbers.sort(), [101, 102, 103]);
  });

  test("a same-titled task belonging to a DIFFERENT plan is still created (no repo-wide title match)", () => {
    const planSlug = "demo-plan";

    // An issue exists with an identical TITLE, but its marker belongs to a
    // different plan ("other-plan"). A repo-wide title match would wrongly
    // suppress this task; exact plan-scoped marker match must not.
    const existingIssues: ExistingIssueRecord[] = [
      { number: 55, title: "Add integration tests", body: "## What\n...\n<!-- stark-task: other-plan/task-9-9-integration-tests -->" },
    ];

    const plannedTasks: PlannedTaskInput[] = [
      { task_id: "task-2-1-integration-tests", title: "Add integration tests", phase_id: "phase-2" },
    ];

    const result = computePlanToTasksDedup(planSlug, plannedTasks, existingIssues);

    assert.equal(result.toCreate.length, 1, "different-plan same-title task must be created, not skipped");
    assert.equal(result.toCreate[0].task_id, "task-2-1-integration-tests");
    assert.deepEqual(result.toSkip, []);
    assert.deepEqual(result.issueNumbers, []);
  });
});

// --- mergeIssueNumbers ------------------------------------------------------

describe("mergeIssueNumbers", () => {
  test("combines pre-existing (dedup-skipped) and newly-created numbers, de-duplicated", () => {
    assert.deepEqual(mergeIssueNumbers([101, 102], [104, 105]), [101, 102, 104, 105]);
  });

  test("de-dupes overlap defensively", () => {
    assert.deepEqual(mergeIssueNumbers([101, 102], [102, 103]), [101, 102, 103]);
  });

  test("handles empty inputs", () => {
    assert.deepEqual(mergeIssueNumbers([], []), []);
    assert.deepEqual(mergeIssueNumbers([101], []), [101]);
    assert.deepEqual(mergeIssueNumbers([], [101]), [101]);
  });
});
