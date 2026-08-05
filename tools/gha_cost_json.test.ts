import assert from "node:assert/strict";
import test from "node:test";

import {
  renderBilling,
  summarizeJobs,
} from "../skill/stark-gha-cost/scripts/gha-cost-json.ts";

test("GHA jobs are rounded per job and weighted by runner OS", () => {
  const summary = summarizeJobs([{ jobs: [
    { started_at: "2026-08-05T00:00:00Z", completed_at: "2026-08-05T00:00:09Z", labels: ["ubuntu-latest"] },
    { started_at: "2026-08-05T00:00:00Z", completed_at: "2026-08-05T00:01:01Z", labels: ["windows-latest"] },
    { started_at: "2026-08-05T00:00:00Z", completed_at: "2026-08-05T00:00:03Z", labels: ["macos-15"] },
  ] }]);
  assert.equal(summary.jobs, 3);
  assert.equal(summary.roundedMinutes, 4); // 1 + 2 + 1
  assert.equal(summary.linuxEquivalentMinutes, 15); // 1 + (2*2) + (1*10)
  assert.deepEqual(summary.byRunner, { linux: 1, windows: 1, macos: 1 });
});

test("GHA billing summary ranks products and Actions repositories", () => {
  const out = renderBilling({ usageItems: [
    { product: "actions", sku: "linux", repositoryName: "org/high", netAmount: 12 },
    { product: "actions", sku: "linux", repositoryName: "org/low", netAmount: 2 },
    { product: "code-security", sku: "seat", netAmount: 30 },
  ] });
  assert.match(out, /TOTAL net \$44\.00/);
  assert.ok(out.indexOf("org/high") < out.indexOf("org/low"));
});
