// tools/red_team_fold_lib.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, resolveFixPlanForFold } from "./red_team_fold_lib.ts";

const PLAN = JSON.stringify({ summary: "s", moves: [], model: "gpt-5.5-pro",
  unaddressed_finding_ids: [], orphan_finding_ids: [], notes: "", input_truncated: false,
  input_omitted_finding_ids: [], warnings: [], raw_output: "", duration_s: 0, cost_usd: 0,
  input_tokens: 0, output_tokens: 0, reasoning_effort: "xhigh", error: null });

test("resolve: sidecar chosen when artifact_hash matches", () => {
  const art = "ARTIFACT BODY";
  const h = sha256Hex(art);
  const r = resolveFixPlanForFold({ artifactText: art,
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: h },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "ok");
  assert.equal(r.source?.sourceRunId, "run-1");
});

test("resolve: sidecar hash mismatch → stale_fix_plan unless forceStale", () => {
  const r = resolveFixPlanForFold({ artifactText: "EDITED",
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: sha256Hex("OLD") },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "stale_fix_plan");
  const forced = resolveFixPlanForFold({ artifactText: "EDITED",
    sidecar: { fixPlanJson: PLAN, runId: "run-1", artifactHash: sha256Hex("OLD") },
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: true });
  assert.equal(forced.status, "ok");
});

test("resolve: DB fallback requires --source-run-id", () => {
  const art = "A"; const h = sha256Hex(art);
  const noId = resolveFixPlanForFold({ artifactText: art, sidecar: null,
    explicitFixPlanJson: null, dbLatest: { fixPlanJson: PLAN, runId: "run-9", artifactHash: h },
    sourceRunId: null, forceStale: false });
  assert.equal(noId.status, "source_run_id_required");
  const withId = resolveFixPlanForFold({ artifactText: art, sidecar: null,
    explicitFixPlanJson: null, dbLatest: { fixPlanJson: PLAN, runId: "run-9", artifactHash: h },
    sourceRunId: "run-9", forceStale: false });
  assert.equal(withId.status, "ok");
});

test("resolve: nothing available → no_fix_plan_found", () => {
  const r = resolveFixPlanForFold({ artifactText: "A", sidecar: null,
    explicitFixPlanJson: null, dbLatest: null, sourceRunId: null, forceStale: false });
  assert.equal(r.status, "no_fix_plan_found");
});
