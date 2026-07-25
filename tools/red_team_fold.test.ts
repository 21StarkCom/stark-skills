// tools/red_team_fold.test.ts
//
// Regression test for the pr_number-discard bug: openOrEditFoldPr resolves
// { pr_url, pr_number } but the CLI used to capture only pr_url, and the
// Envelope type had no pr_number field — so --json could never expose the
// fold PR's number. buildEnvelope is the pure extraction point; this test
// pins pr_number surviving into the envelope end to end.

import test from "node:test";
import assert from "node:assert/strict";

import { buildEnvelope, type Envelope } from "./red_team_fold.ts";
import type { FoldResult } from "./red_team_fold_lib.ts";

const BASE_RESULT: FoldResult = {
  fold_run_id: "fold-1",
  source_run_id: "run-1",
  decider_model: "claude-opus-4-8",
  dispositions: [],
  applied_count: 1,
  modified_count: 0,
  rejected_count: 0,
  apply_failed_count: 0,
  cost_usd: 0.01,
  duration_s: 1.2,
  revised_doc: "revised text",
  status: "ok",
  pr_url: null,
};

test("buildEnvelope surfaces pr_number from the opened/edited fold PR", () => {
  const env: Envelope = buildEnvelope(BASE_RESULT, "/repo/docs/spec.md", "red-team-fold/spec-20260725-000000", {
    pr_url: "https://github.com/21StarkCom/repo/pull/901",
    pr_number: 901,
  });

  assert.equal(env.pr_url, "https://github.com/21StarkCom/repo/pull/901");
  assert.equal(env.pr_number, 901);
});

test("buildEnvelope reports pr_number null when no PR was opened (all-rejected/no-diff fold)", () => {
  const env: Envelope = buildEnvelope(BASE_RESULT, "/repo/docs/spec.md", null, {
    pr_url: null,
    pr_number: null,
  });

  assert.equal(env.pr_url, null);
  assert.equal(env.pr_number, null);
});
