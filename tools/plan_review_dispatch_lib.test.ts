// Tests for `tools/plan_review_dispatch_lib.ts` — the pure logic of the
// plan/spec document review orchestrator ported from
// `scripts/plan_review_dispatch.py`. Subprocess dispatch is verified live.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PLAN_REVIEW_CONFIG,
  loadPlanReviewConfig,
  parsePlanFindings,
  safeRepoRelative,
} from "./plan_review_dispatch_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-test-"));
}

// ---------------------------------------------------------------------------
// parsePlanFindings
// ---------------------------------------------------------------------------

test("parsePlanFindings: plain JSON array", () => {
  const raw = JSON.stringify([
    { severity: "high", section: "Goals", title: "T", description: "D", suggestion: "S" },
  ]);
  const got = parsePlanFindings("claude", "completeness", raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].agent, "claude");
  assert.equal(got[0].domain, "completeness");
  assert.equal(got[0].section, "Goals");
});

test("parsePlanFindings: empty array", () => {
  assert.deepEqual(parsePlanFindings("codex", "x", "[]"), []);
});

test("parsePlanFindings: strips markdown code fences", () => {
  const raw = '```json\n[{"severity":"low","section":"S","title":"t","description":"d","suggestion":""}]\n```';
  assert.equal(parsePlanFindings("claude", "x", raw).length, 1);
});

test("parsePlanFindings: extracts array embedded in prose (outermost brackets)", () => {
  const raw = 'Findings:\n[{"severity":"medium","section":"S","title":"t","description":"d","suggestion":""}]\nend';
  const got = parsePlanFindings("claude", "x", raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, "medium");
});

test("parsePlanFindings: unparseable input → empty list (no throw)", () => {
  assert.deepEqual(parsePlanFindings("claude", "x", "no json here"), []);
  assert.deepEqual(parsePlanFindings("claude", "x", "[broken"), []);
});

test("parsePlanFindings: missing fields default to empty strings", () => {
  const got = parsePlanFindings("claude", "x", JSON.stringify([{}]));
  assert.equal(got[0].severity, "medium");
  assert.equal(got[0].section, "");
  assert.equal(got[0].title, "");
});

// ---------------------------------------------------------------------------
// safeRepoRelative
// ---------------------------------------------------------------------------

test("safeRepoRelative: makes a path repo-relative", () => {
  assert.equal(safeRepoRelative("/repo/docs/spec.md", "/repo"), "docs/spec.md");
});

test("safeRepoRelative: strips leading slash + parent traversal when no repoDir", () => {
  assert.equal(safeRepoRelative("/abs/path/spec.md"), "abs/path/spec.md");
  assert.equal(safeRepoRelative("../../etc/passwd"), "etc/passwd");
});

test("safeRepoRelative: empty input passes through", () => {
  assert.equal(safeRepoRelative(""), "");
});

// ---------------------------------------------------------------------------
// loadPlanReviewConfig
// ---------------------------------------------------------------------------

test("loadPlanReviewConfig: no config files → defaults", () => {
  const dir = tmp();
  try {
    const cfg = loadPlanReviewConfig(null, dir, "plan_review");
    assert.deepEqual(cfg, DEFAULT_PLAN_REVIEW_CONFIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanReviewConfig: global section merges over defaults", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ plan_review: { agents: ["claude"], max_rounds: 5 } }),
    );
    const cfg = loadPlanReviewConfig(null, dir, "plan_review");
    assert.deepEqual(cfg.agents, ["claude"]);
    assert.equal(cfg.max_rounds, 5);
    assert.equal(cfg.fix_threshold, "medium"); // default survives
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanReviewConfig: repo section overrides global", () => {
  const globalDir = tmp();
  const repoDir = tmp();
  try {
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({ plan_review: { max_rounds: 2 } }),
    );
    fs.mkdirSync(path.join(repoDir, ".code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ plan_review: { max_rounds: 9 } }),
    );
    const cfg = loadPlanReviewConfig(repoDir, globalDir, "plan_review");
    assert.equal(cfg.max_rounds, 9);
  } finally {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("loadPlanReviewConfig: custom config section (design_review)", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ design_review: { agents: ["codex", "gemini"] } }),
    );
    const cfg = loadPlanReviewConfig(null, dir, "design_review");
    assert.deepEqual(cfg.agents, ["codex", "gemini"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
