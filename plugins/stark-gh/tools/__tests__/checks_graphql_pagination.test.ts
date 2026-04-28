import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchRequiredCheckRollup,
  isCheckPassing,
  isCheckFailing,
  summarizeVerdict,
  type Context,
} from "../lib/checks_graphql.ts";

// Build a synthetic GraphQL response for one page of contexts.
function makePage(
  headRefOid: string,
  nodes: any[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          commits: {
            nodes: [{
              commit: {
                statusCheckRollup: {
                  contexts: { pageInfo: { hasNextPage, endCursor }, nodes },
                },
              },
            }],
          },
        },
      },
    },
  };
}

// Raw GraphQL node (uses __typename) — for fetchRequiredCheckRollup tests.
function rawCheckRun(name: string, conclusion: string | null, isRequired: boolean): any {
  return { __typename: "CheckRun", name, conclusion, status: "COMPLETED", isRequired };
}
function rawStatus(context: string, state: string, isRequired: boolean): any {
  return { __typename: "StatusContext", context, state, isRequired };
}
// Normalized Context (uses kind) — for predicate tests.
function makeCheckRun(name: string, conclusion: any, isRequired: boolean): Context {
  return { kind: "CheckRun", name, conclusion, status: "COMPLETED", isRequired };
}
function makeStatus(context: string, state: any, isRequired: boolean): Context {
  return { kind: "StatusContext", context, state, isRequired };
}

test("fetchRequiredCheckRollup aggregates a single page", async () => {
  const apiGraphql = async () => makePage("sha1", [
    rawCheckRun("ci", "SUCCESS", true),
    rawCheckRun("lint", "SUCCESS", false),
  ], false, null);
  const r = await fetchRequiredCheckRollup(
    { owner: "o", repo: "r", prNumber: 1, expectedHeadOid: "sha1" },
    { apiGraphql: apiGraphql as any },
  );
  assert.equal(r.mismatch, false);
  assert.equal(r.headRefOid, "sha1");
  assert.equal(r.contexts!.length, 2);
});

test("fetchRequiredCheckRollup paginates through 3 pages", async () => {
  let call = 0;
  const apiGraphql = async (_q: string, vars: any) => {
    call++;
    if (call === 1) {
      assert.equal(vars.after, null);
      return makePage("sha1", [rawCheckRun("c1", "SUCCESS", true)], true, "cursor1");
    }
    if (call === 2) {
      assert.equal(vars.after, "cursor1");
      return makePage("sha1", [rawCheckRun("c2", "SUCCESS", true)], true, "cursor2");
    }
    if (call === 3) {
      assert.equal(vars.after, "cursor2");
      return makePage("sha1", [rawCheckRun("c3", "SUCCESS", true)], false, null);
    }
    throw new Error("unexpected page");
  };
  const r = await fetchRequiredCheckRollup(
    { owner: "o", repo: "r", prNumber: 1, expectedHeadOid: "sha1" },
    { apiGraphql: apiGraphql as any },
  );
  assert.equal(call, 3);
  assert.equal(r.contexts!.length, 3);
  assert.deepEqual(r.contexts!.map(c => (c as any).name), ["c1", "c2", "c3"]);
});

test("fetchRequiredCheckRollup returns mismatch when expectedHeadOid differs", async () => {
  const apiGraphql = async () => makePage("actual-sha", [
    rawCheckRun("ci", "SUCCESS", true),
  ], false, null);
  const r = await fetchRequiredCheckRollup(
    { owner: "o", repo: "r", prNumber: 1, expectedHeadOid: "expected-sha" },
    { apiGraphql: apiGraphql as any },
  );
  assert.equal(r.mismatch, true);
  assert.equal(r.contexts, null);
  assert.equal(r.headRefOid, "actual-sha");
});

test("fetchRequiredCheckRollup handles empty rollup (zero contexts)", async () => {
  const apiGraphql = async () => makePage("sha1", [], false, null);
  const r = await fetchRequiredCheckRollup(
    { owner: "o", repo: "r", prNumber: 1, expectedHeadOid: "sha1" },
    { apiGraphql: apiGraphql as any },
  );
  assert.equal(r.mismatch, false);
  assert.deepEqual(r.contexts, []);
});

test("fetchRequiredCheckRollup throws on missing pullRequest payload", async () => {
  const apiGraphql = async () => ({ data: { repository: null } });
  await assert.rejects(() => fetchRequiredCheckRollup(
    { owner: "o", repo: "r", prNumber: 1, expectedHeadOid: "sha1" },
    { apiGraphql: apiGraphql as any },
  ), /pullRequest payload missing/);
});

test("isCheckPassing: CheckRun SUCCESS/NEUTRAL/SKIPPED count as passing", () => {
  assert.equal(isCheckPassing(makeCheckRun("c", "SUCCESS", true)), true);
  assert.equal(isCheckPassing(makeCheckRun("c", "NEUTRAL", true)), true);
  assert.equal(isCheckPassing(makeCheckRun("c", "SKIPPED", true)), true);
  assert.equal(isCheckPassing(makeCheckRun("c", "FAILURE", true)), false);
  assert.equal(isCheckPassing(makeCheckRun("c", null, true)), false);  // pending
  assert.equal(isCheckPassing(makeCheckRun("c", "SUCCESS", false)), false);  // not required
});

test("isCheckPassing: StatusContext SUCCESS only", () => {
  assert.equal(isCheckPassing(makeStatus("c", "SUCCESS", true)), true);
  assert.equal(isCheckPassing(makeStatus("c", "PENDING", true)), false);
  assert.equal(isCheckPassing(makeStatus("c", "FAILURE", true)), false);
});

test("isCheckFailing: explicit failing conclusions", () => {
  for (const v of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) {
    assert.equal(isCheckFailing(makeCheckRun("c", v, true)), true, v);
  }
  assert.equal(isCheckFailing(makeCheckRun("c", "SUCCESS", true)), false);
  assert.equal(isCheckFailing(makeCheckRun("c", null, true)), false);  // pending != failing
});

test("summarizeVerdict: vacuous pass when zero required", () => {
  const v = summarizeVerdict([
    makeCheckRun("c", "FAILURE", false),  // not required, doesn't count
  ] as Context[]);
  assert.equal(v.required, 0);
  assert.equal(v.vacuous, true);
  assert.equal(v.allPassing, true);
});

test("summarizeVerdict: all required passing", () => {
  const v = summarizeVerdict([
    makeCheckRun("a", "SUCCESS", true),
    makeCheckRun("b", "NEUTRAL", true),
  ] as Context[]);
  assert.equal(v.required, 2);
  assert.equal(v.passing, 2);
  assert.equal(v.allPassing, true);
  assert.equal(v.anyFailing, false);
});

test("summarizeVerdict: any failing", () => {
  const v = summarizeVerdict([
    makeCheckRun("a", "SUCCESS", true),
    makeCheckRun("b", "FAILURE", true),
  ] as Context[]);
  assert.equal(v.required, 2);
  assert.equal(v.passing, 1);
  assert.equal(v.failing, 1);
  assert.equal(v.allPassing, false);
  assert.equal(v.anyFailing, true);
});

test("summarizeVerdict: pending counted separately", () => {
  const v = summarizeVerdict([
    makeCheckRun("a", "SUCCESS", true),
    makeCheckRun("b", null, true),     // pending
  ] as Context[]);
  assert.equal(v.required, 2);
  assert.equal(v.passing, 1);
  assert.equal(v.failing, 0);
  assert.equal(v.pending, 1);
  assert.equal(v.allPassing, false);
});
