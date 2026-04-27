// Tests for the design review Phase 4 renderer. Each renderXxx function is
// exercised directly so we can verify the markdown shape without spawning the
// CLI for every case. The CLI integration test confirms the JSON envelope.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import {
  isDispatchFailure,
  renderChangesMade,
  renderDispatchFailure,
  renderFindingsTable,
  renderFixedGrouped,
  renderHeadlineCounts,
  renderNoiseAndFp,
  renderRecurring,
  renderSummary,
  renderUnresolved,
  type Finding,
  type RoundData,
  type SummaryInput,
} from "./design_review_summary.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "design_review_summary.ts");

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "high",
    section: "Auth",
    title: "Missing timeout",
    agent: "claude",
    domain: "general",
    classification: "fix",
    ...overrides,
  };
}

function round(num: number, findings: Finding[], failed = 0): RoundData {
  return {
    round: num,
    agents: ["claude", "codex"],
    summary: {
      total_sub_agents: 2,
      succeeded: 2 - failed,
      failed,
      total_findings: findings.length,
    },
    findings,
  };
}

// ── isDispatchFailure ───────────────────────────────────────────

test("isDispatchFailure detects rounds where every sub-agent failed", () => {
  const input: SummaryInput = {
    designPath: "x.md",
    rounds: [
      {
        round: 1,
        agents: [],
        summary: { total_sub_agents: 4, succeeded: 0, failed: 4, total_findings: 0 },
        findings: [],
      },
    ],
  };
  assert.equal(isDispatchFailure(input), true);
});

test("isDispatchFailure ignores rounds with at least one success", () => {
  const input: SummaryInput = {
    designPath: "x.md",
    rounds: [round(1, [finding()], 1)],
  };
  assert.equal(isDispatchFailure(input), false);
});

// ── renderHeadlineCounts ────────────────────────────────────────

test("renderHeadlineCounts splits issues, noise, and ignored", () => {
  const findings = [
    finding({ classification: "fix" }),
    finding({ classification: "fix" }),
    finding({ classification: "recurring" }),
    finding({ classification: "noise" }),
    finding({ classification: "false_positive" }),
    finding({ classification: "ignored" }),
  ];
  const out = renderHeadlineCounts(findings);
  assert.match(out, /\*\*Issues found:\*\* 3/);
  assert.match(out, /\*\*Noise:\*\* 2/);
  assert.match(out, /\*\*Ignored:\*\* 1/);
  // 3 / (3 + 2) = 60%
  assert.match(out, /\*\*Signal-to-noise:\*\* 60%/);
});

test("renderHeadlineCounts reports 100% when there's no noise", () => {
  const out = renderHeadlineCounts([finding({ classification: "fix" })]);
  assert.match(out, /\*\*Signal-to-noise:\*\* 100%/);
});

// ── renderFindingsTable ─────────────────────────────────────────

test("renderFindingsTable sorts by round then severity", () => {
  const r1 = round(1, [
    finding({ severity: "low", title: "low-r1" }),
    finding({ severity: "critical", title: "crit-r1" }),
  ]);
  const r2 = round(2, [finding({ severity: "high", title: "high-r2" })]);
  const out = renderFindingsTable([r1, r2]);
  const titles = ["crit-r1", "low-r1", "high-r2"];
  let lastIdx = -1;
  for (const t of titles) {
    const idx = out.indexOf(t);
    assert.ok(idx > lastIdx, `expected ${t} after position ${lastIdx}, got ${idx}`);
    lastIdx = idx;
  }
});

test("renderFindingsTable escapes pipe characters in section/title", () => {
  const out = renderFindingsTable([
    round(1, [finding({ section: "A | B", title: "T1" })]),
  ]);
  assert.match(out, /A &#124; B/);
});

// ── renderFixedGrouped ──────────────────────────────────────────

test("renderFixedGrouped groups by round and skips empty rounds", () => {
  const r1 = round(1, [finding({ classification: "fix", title: "fixA" })]);
  const r2 = round(2, [finding({ classification: "noise", title: "noiseA" })]);
  const r3 = round(3, [finding({ classification: "fix", title: "fixB" })]);
  const out = renderFixedGrouped([r1, r2, r3]);
  assert.match(out, /Round 1 — 1 fixed/);
  assert.match(out, /fixA/);
  assert.equal(out.includes("Round 2"), false);
  assert.match(out, /Round 3 — 1 fixed/);
});

test("renderFixedGrouped reports None when no rounds had fixes", () => {
  const r = round(1, [finding({ classification: "noise" })]);
  const out = renderFixedGrouped([r]);
  assert.match(out, /_None\._/);
});

// ── renderRecurring ─────────────────────────────────────────────

test("renderRecurring buckets by section+domain across rounds", () => {
  const f = (r: number, section: string) =>
    finding({ classification: "recurring", section, title: `t-r${r}` });
  const out = renderRecurring([
    round(1, [f(1, "Auth")]),
    round(2, [f(2, "Auth")]),
    round(3, [f(3, "Auth")]),
  ]);
  assert.match(out, /\*\*`Auth`\*\* \[general\]/);
  assert.match(out, /r1, r2, r3/);
});

// ── renderUnresolved ────────────────────────────────────────────

test("renderUnresolved reads only the final round and only fix/recurring", () => {
  const final = round(2, [
    finding({ classification: "fix", title: "still-broken" }),
    finding({ classification: "noise", title: "ignored" }),
  ]);
  const out = renderUnresolved([round(1, []), final]);
  assert.match(out, /still-broken/);
  assert.equal(out.includes("ignored"), false);
});

test("renderUnresolved is empty when final round produced no actionable findings", () => {
  // Only a noise finding in the final round → nothing actionable remains.
  const out = renderUnresolved([
    round(1, [finding({ classification: "noise", title: "subjective" })]),
  ]);
  assert.match(out, /final round produced zero actionable findings/);
});

// ── renderNoiseAndFp ────────────────────────────────────────────

test("renderNoiseAndFp surfaces classification reasons", () => {
  const out = renderNoiseAndFp([
    round(1, [
      finding({
        classification: "noise",
        title: "Bikeshed",
        classification_reason: "Style choice",
      }),
      finding({
        classification: "false_positive",
        title: "Already covered",
        classification_reason: "See section X",
      }),
    ]),
  ]);
  assert.match(out, /\[noise\].*Bikeshed: Style choice/);
  assert.match(out, /\[false-positive\].*Already covered: See section X/);
});

// ── renderChangesMade ───────────────────────────────────────────

test("renderChangesMade fences the diff in a ```diff block", () => {
  const out = renderChangesMade("--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-foo\n+bar\n");
  assert.match(out, /^### Changes Made$/m);
  assert.match(out, /```diff/);
  assert.match(out, /```\s*$/);
});

test("renderChangesMade reports no-op when diff is empty", () => {
  const out = renderChangesMade("");
  assert.match(out, /design file is identical/);
});

// ── renderDispatchFailure ───────────────────────────────────────

test("renderDispatchFailure includes the per-agent error rows", () => {
  const input: SummaryInput = {
    designPath: "docs/specs/x.md",
    rounds: [
      {
        round: 1,
        agents: ["claude", "codex"],
        summary: { total_sub_agents: 2, succeeded: 0, failed: 2, total_findings: 0 },
        findings: [],
        results: [
          { agent: "claude", domain: "general", error: "auth" },
          { agent: "codex", domain: "security", error: "timeout" },
        ],
      },
    ],
    cliAvailability: { claude: true, codex: false, gemini: false },
  };
  const out = renderDispatchFailure(input);
  assert.match(out, /Dispatch Failure/);
  assert.match(out, /\| claude \| general \| auth/);
  assert.match(out, /\| codex \| security \| timeout/);
  assert.match(out, /claude=yes, codex=no, gemini=no/);
});

// ── renderSummary integration ───────────────────────────────────

test("renderSummary emits all sections in order for a healthy run", () => {
  const r1 = round(1, [
    finding({ classification: "fix", title: "fix1" }),
    finding({ classification: "noise", title: "noise1", classification_reason: "subjective" }),
  ]);
  const r2 = round(2, [finding({ classification: "ignored", title: "ignored1" })]);
  const out = renderSummary({
    designPath: "docs/specs/x.md",
    rounds: [r1, r2],
    designDiff: "diff content here",
  });
  // Section ordering — each must appear after the previous one.
  const order = [
    "### Headline",
    "### All findings",
    "### Fixed",
    "### Recurring",
    "### Unresolved",
    "### Noise & False Positives",
    "### Misalignment Analysis",
    "### Changes Made",
    "### Prompt Improvement Assessment",
  ];
  let last = -1;
  for (const heading of order) {
    const idx = out.indexOf(heading);
    assert.ok(idx > last, `expected ${heading} after ${last}, got ${idx}`);
    last = idx;
  }
});

test("renderSummary swaps in the dispatch-failure template when warranted", () => {
  const input: SummaryInput = {
    designPath: "docs/specs/x.md",
    rounds: [
      {
        round: 1,
        agents: [],
        summary: { total_sub_agents: 4, succeeded: 0, failed: 4, total_findings: 0 },
        findings: [],
      },
    ],
  };
  const out = renderSummary(input);
  assert.match(out, /Dispatch Failure/);
  assert.equal(out.includes("### Headline"), false);
});

// ── CLI smoke test ──────────────────────────────────────────────

function makeTmp(t: TestContext): string | null {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "design-summary-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

test("CLI --json wraps the markdown payload", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const inputPath = path.join(tmp, "input.json");
    const payload: SummaryInput = {
      designPath: "docs/specs/x.md",
      rounds: [round(1, [finding({ classification: "fix" })])],
    };
    fs.writeFileSync(inputPath, JSON.stringify(payload));
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "--input", inputPath, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.match(parsed.markdown, /### Headline/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
