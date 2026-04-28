import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffSchedule, isTerminal } from "../gh_watch_runs.ts";

test("backoffSchedule yields 15s x 5 then doubles to cap", () => {
  const cap = 240;
  const seq: number[] = [];
  const it = backoffSchedule(15, cap);
  for (let i = 0; i < 12; i++) seq.push(it.next().value as number);
  assert.deepEqual(seq.slice(0, 5), [15, 15, 15, 15, 15]);
  assert.equal(seq[5], 30);
  assert.equal(seq[6], 60);
  assert.equal(seq[7], 120);
  assert.equal(seq[8], 240);
  assert.equal(seq[9], 240);
});

test("isTerminal true when all check-runs completed", () => {
  const suites = [{ check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] }];
  assert.equal(isTerminal(suites), true);
});

test("isTerminal false when any still in_progress", () => {
  const suites = [{ check_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }] }];
  assert.equal(isTerminal(suites), false);
});
