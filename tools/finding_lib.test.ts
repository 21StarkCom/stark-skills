// Tests for `tools/finding_lib.ts`.
//
// Ported from the buried `stark_review_lib.phase2.test.ts` (STARK-6098). The
// dispatcher those tests surrounded is gone; the finding model is not — it is
// what `findings_review_post.ts` and the three `agent_*.ts` ports build, so its
// two determinism contracts keep their tests here:
//
//   - `findingId` is stable across runs and across cosmetic title edits, which
//     is what lets a finding be recognised as the same finding twice.
//   - the severity ladder is total and ordered, which is what
//     `partitionInlineVsBody`'s threshold test and the posted review's ordering
//     both rest on.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildMarker,
  compareSeverityDesc,
  findingId,
  severityMeetsThreshold,
} from "./finding_lib.ts";

test("findingId is deterministic across runs", () => {
  const a = findingId("security", "codex", "Unvalidated input");
  const b = findingId("security", "codex", "Unvalidated input");
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("findingId normalizes whitespace and punctuation", () => {
  const a = findingId("security", "codex", "Foo  bar.");
  const b = findingId("security", "codex", "foo bar");
  assert.equal(a, b);
});

test("findingId differs across domain/agent/title", () => {
  const base = findingId("security", "codex", "X");
  assert.notEqual(base, findingId("architecture", "codex", "X"));
  assert.notEqual(base, findingId("security", "claude", "X"));
  assert.notEqual(base, findingId("security", "codex", "Y"));
});

test("severityMeetsThreshold ordering", () => {
  assert.equal(severityMeetsThreshold("critical", "low"), true);
  assert.equal(severityMeetsThreshold("critical", "critical"), true);
  assert.equal(severityMeetsThreshold("high", "critical"), false);
  assert.equal(severityMeetsThreshold("medium", "high"), false);
  assert.equal(severityMeetsThreshold("low", "low"), true);
  assert.equal(severityMeetsThreshold("low", "medium"), false);
});

test("compareSeverityDesc orders critical → high → medium → low, ties by domain/file/line", () => {
  const items = [
    { severity: "low" as const,      domain: "a", file: "z.ts", line: 1 },
    { severity: "critical" as const, domain: "a", file: "z.ts", line: 1 },
    { severity: "medium" as const,   domain: "a", file: "z.ts", line: 1 },
    { severity: "high" as const,     domain: "a", file: "z.ts", line: 1 },
  ];
  const sorted = [...items].sort(compareSeverityDesc);
  assert.deepEqual(sorted.map((i) => i.severity), ["critical", "high", "medium", "low"]);
  // Ties broken by (domain, file, line)
  const ties = [
    { severity: "high" as const, domain: "b", file: "a.ts", line: 9 },
    { severity: "high" as const, domain: "a", file: "z.ts", line: 1 },
    { severity: "high" as const, domain: "a", file: "a.ts", line: 9 },
    { severity: "high" as const, domain: "a", file: "a.ts", line: 1 },
  ].sort(compareSeverityDesc);
  assert.deepEqual(
    ties.map((t) => `${t.domain}/${t.file}:${t.line}`),
    ["a/a.ts:1", "a/a.ts:9", "a/z.ts:1", "b/a.ts:9"],
  );
});

test("buildMarker is the single source of truth for the POST body and the GET check", () => {
  // The poster writes this string and then greps for the same string; a format
  // that differed between the two would double-post on every retry.
  assert.equal(
    buildMarker(3, "gemini", "deadbeef"),
    "<!-- stark-review:round=3:agent=gemini:run=deadbeef -->",
  );
});
