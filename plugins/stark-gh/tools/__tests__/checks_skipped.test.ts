// A skipped required check must never read as green, and same-named contexts
// must be collapsed to the latest before the verdict is computed.
//
// Both rules come from one measured incident: 21StarkCom/stark-skills#877
// merged while the only `test` context on its head sha was SKIPPED (the
// draft-guarded job), and that same rollup carried `sync` twice — SKIPPED at
// 10:32:08Z and SUCCESS at 10:35:15Z. Counting rows instead of checks inflated
// `required`, and counting SKIPPED as passing made the whole thing green.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCheckPassing,
  isCheckSkipped,
  latestPerName,
  summarizeVerdict,
  contextName,
  type Context,
} from "../lib/checks_graphql.ts";
import { evaluateRollup } from "../gh_watch_runs.ts";

function run(
  name: string,
  conclusion: any,
  isRequired = true,
  startedAt: string | null = null,
  completedAt: string | null = null,
): Context {
  return { kind: "CheckRun", name, conclusion, isRequired, status: "COMPLETED", startedAt, completedAt };
}

function status(context: string, state: any, isRequired = true, createdAt: string | null = null): Context {
  return { kind: "StatusContext", context, state, isRequired, createdAt };
}

test("isCheckPassing: SKIPPED is not passing", () => {
  assert.equal(isCheckPassing(run("test", "SUCCESS")), true);
  assert.equal(isCheckPassing(run("test", "NEUTRAL")), true);
  assert.equal(isCheckPassing(run("test", "SKIPPED")), false);
});

test("isCheckSkipped: only a REQUIRED skipped CheckRun", () => {
  assert.equal(isCheckSkipped(run("test", "SKIPPED")), true);
  assert.equal(isCheckSkipped(run("test", "SKIPPED", false)), false);
  assert.equal(isCheckSkipped(run("test", "SUCCESS")), false);
  assert.equal(isCheckSkipped(status("ctx", "SUCCESS")), false);
});

test("a skipped required check is neither passing nor failing, and blocks allPassing", () => {
  const v = summarizeVerdict([run("test", "SKIPPED"), run("lint", "SUCCESS")]);
  assert.equal(v.required, 2);
  assert.equal(v.passing, 1);
  assert.equal(v.failing, 0);
  assert.equal(v.skipped, 1);
  assert.equal(v.pending, 0, "a skip must not masquerade as a pending check the watcher waits on");
  assert.equal(v.allPassing, false);
  assert.equal(v.anyFailing, false);
  assert.equal(v.anySkipped, true);
  assert.deepEqual(v.skippedNames, ["test"]);
});

test("#877 rollup shape: skipped `test` alone keeps the verdict red", () => {
  const v = summarizeVerdict([
    run("sync", "SKIPPED", false, "2026-08-11T10:32:08Z", "2026-08-11T10:32:08Z"),
    run("test", "SKIPPED", true, "2026-08-11T10:32:17Z", "2026-08-11T10:32:08Z"),
    run("Analyze (go)", "SUCCESS", true, "2026-08-11T10:32:09Z", "2026-08-11T10:32:56Z"),
    run("sync", "SUCCESS", false, "2026-08-11T10:35:15Z", "2026-08-11T10:35:19Z"),
    run("Analyze (javascript-typescript)", "SUCCESS", true, "2026-08-11T10:32:09Z", "2026-08-11T10:33:14Z"),
    run("typecheck", "SKIPPED", false, "2026-08-11T10:32:08Z", "2026-08-11T10:32:08Z"),
  ]);
  assert.equal(v.required, 3);
  assert.equal(v.passing, 2);
  assert.equal(v.allPassing, false);
  assert.deepEqual(v.skippedNames, ["test"]);
});

test("latestPerName keeps the newest of same-named contexts", () => {
  const kept = latestPerName([
    run("sync", "SKIPPED", true, "2026-08-11T10:32:08Z", "2026-08-11T10:32:08Z"),
    run("sync", "SUCCESS", true, "2026-08-11T10:35:15Z", "2026-08-11T10:35:19Z"),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(isCheckPassing(kept[0]!), true);
});

test("a later FAILURE beats an earlier SUCCESS — no stale green", () => {
  const v = summarizeVerdict([
    run("test", "SUCCESS", true, "2026-08-11T10:00:00Z", "2026-08-11T10:01:00Z"),
    run("test", "FAILURE", true, "2026-08-11T11:00:00Z", "2026-08-11T11:01:00Z"),
  ]);
  assert.equal(v.required, 1, "two rows for one check name count once");
  assert.equal(v.anyFailing, true);
  assert.equal(v.allPassing, false);
});

test("recency uses max(startedAt, completedAt) — GitHub emits completedAt before startedAt", () => {
  // Verbatim from #877: the skipped `test` reported completedAt nine seconds
  // BEFORE its startedAt. Keying on completedAt alone would rank it older than
  // a genuinely earlier run and let that stale entry win.
  const kept = latestPerName([
    run("test", "SUCCESS", true, "2026-08-11T10:32:10Z", "2026-08-11T10:32:12Z"),
    run("test", "SKIPPED", true, "2026-08-11T10:32:17Z", "2026-08-11T10:32:08Z"),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(isCheckSkipped(kept[0]!), true);
});

test("indistinguishable timestamps resolve fail-closed", () => {
  for (const order of [0, 1]) {
    const pair: Context[] = [
      run("test", "SUCCESS", true, null, null),
      run("test", "SKIPPED", true, null, null),
    ];
    const kept = latestPerName(order === 0 ? pair : [pair[1]!, pair[0]!]);
    assert.equal(kept.length, 1);
    assert.equal(isCheckPassing(kept[0]!), false, "an ambiguous pair must never resolve to green");
  }
});

test("non-required contexts never enter the verdict", () => {
  const v = summarizeVerdict([run("test", "SKIPPED", false), run("lint", "FAILURE", false)]);
  assert.equal(v.required, 0);
  assert.equal(v.vacuous, true);
  assert.equal(v.anySkipped, false);
  assert.equal(v.allPassing, true, "vacuous still passes here; the callers refuse it separately");
});

test("evaluateRollup: a skipped required check is FATAL, not a wait", () => {
  // Terminal because nothing repairs it in place: a re-run replays the
  // original event payload, and a workflow_dispatch run never joins the
  // rollup. Waiting would burn the full 6h watch timeout.
  const ctx = [run("test", "SKIPPED"), run("lint", "SUCCESS")];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "fatal");
  assert.match(r.reason!, /skipped/);
  assert.match(r.reason!, /test/);
});

test("evaluateRollup: --allow-skipped-checks lets a by-design skip through", () => {
  const ctx = [run("test", "SKIPPED"), run("lint", "SUCCESS")];
  const r = evaluateRollup(
    { mismatch: false, contexts: ctx, headRefOid: "sha" },
    { allowNoRequiredChecks: false, allowSkippedChecks: true },
  );
  assert.equal(r.kind, "ready");
});

test("evaluateRollup: a real failure still outranks a skip in the message", () => {
  const ctx = [run("test", "SKIPPED"), run("lint", "FAILURE")];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "fatal");
  assert.match(r.reason!, /failing checks/);
});

test("StatusContext dedupes by its own name field", () => {
  const kept = latestPerName([
    status("ci/legacy", "FAILURE", true, "2026-08-11T10:00:00Z"),
    status("ci/legacy", "SUCCESS", true, "2026-08-11T11:00:00Z"),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(contextName(kept[0]!), "ci/legacy");
  assert.equal(isCheckPassing(kept[0]!), true);
});
