// Tests for `tools/github_projects_lib.ts` — pure logic only (state
// machine, spec-completeness gate, fieldValues parser, client-side
// filter, file IO). The GraphQL-backed paths (findProject, addIssue,
// getFieldIds, setField, getItemFields, getItems pagination,
// findItemForIssue, getIssueNodeId) are covered by live CLI exercise
// against a real GetEvinced project.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFieldValuePayload,
  graphql,
  checkSpecCompleteness,
  isLegalTransition,
  itemMatchesFilters,
  LEGAL_TRANSITIONS,
  loadProjectConfig,
  parseFieldValues,
  type FieldInfo,
  type ProjectItem,
} from "./github_projects_lib.ts";

test("GraphQL retries opted-in reads once, preserves errors, and never replays default mutations", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphql-transport-"));
  const count = path.join(dir, "count");
  const mode = path.join(dir, "mode");
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const count = ${JSON.stringify(count)}, mode = ${JSON.stringify(mode)};
const n = Number(fs.readFileSync(count, "utf8")) + 1;
fs.writeFileSync(count, String(n));
const behavior = fs.readFileSync(mode, "utf8");
if (behavior === "stdout") { console.log(JSON.stringify({errors:[{message:"Resource not accessible"}]})); process.exit(1); }
if (n === 1 || behavior === "always") { console.error("ECONNRESET"); process.exit(1); }
console.log(JSON.stringify({data:{ok:true}}));
`, { mode: 0o700 });
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
  const reset = (behavior: string) => { fs.writeFileSync(count, "0"); fs.writeFileSync(mode, behavior); };
  reset("once");
  assert.deepEqual(await graphql("query { viewer { login } }", { retryRead: true }), { data: { ok: true } });
  assert.equal(fs.readFileSync(count, "utf8"), "2");
  reset("once");
  await assert.rejects(graphql("mutation { change }"), /ECONNRESET/);
  assert.equal(fs.readFileSync(count, "utf8"), "1");
  reset("always");
  await assert.rejects(graphql("query { viewer { login } }", { retryRead: true }), /ECONNRESET/);
  assert.equal(fs.readFileSync(count, "utf8"), "2");
  reset("stdout");
  await assert.rejects(graphql("query { viewer { login } }", { retryRead: true }), /Resource not accessible/);
  assert.equal(fs.readFileSync(count, "utf8"), "1");
});

// ---------------------------------------------------------------------------
// isLegalTransition / state machine
// ---------------------------------------------------------------------------

test("isLegalTransition: Backlog → Needs Spec is the only forward edge", () => {
  assert.equal(isLegalTransition("Backlog", "Needs Spec"), true);
  assert.equal(isLegalTransition("Backlog", "Ready for Agent"), false);
  assert.equal(isLegalTransition("Backlog", "Done"), false);
});

test("isLegalTransition: Needs Spec branches to Ready for Agent / Human Working / Blocked", () => {
  assert.equal(isLegalTransition("Needs Spec", "Ready for Agent"), true);
  assert.equal(isLegalTransition("Needs Spec", "Human Working"), true);
  assert.equal(isLegalTransition("Needs Spec", "Blocked"), true);
  assert.equal(isLegalTransition("Needs Spec", "Done"), false);
});

test("isLegalTransition: Agent Working escalates only via Human Review / Needs Clarification / Blocked", () => {
  assert.equal(isLegalTransition("Agent Working", "Human Review"), true);
  assert.equal(isLegalTransition("Agent Working", "Needs Clarification"), true);
  assert.equal(isLegalTransition("Agent Working", "Blocked"), true);
  // Agents must not bypass review.
  assert.equal(isLegalTransition("Agent Working", "Ready to Merge"), false);
  assert.equal(isLegalTransition("Agent Working", "Done"), false);
});

test("isLegalTransition: Human Review can send back to Agent Working", () => {
  assert.equal(isLegalTransition("Human Review", "Agent Working"), true);
  assert.equal(isLegalTransition("Human Review", "Ready to Merge"), true);
  assert.equal(isLegalTransition("Human Review", "Done"), false);
});

test("isLegalTransition: Ready to Release → Done is the only path to Done", () => {
  assert.equal(isLegalTransition("Ready to Release", "Done"), true);
  // Every other from-state must NOT transition to Done.
  for (const from of Object.keys(LEGAL_TRANSITIONS)) {
    if (from === "Ready to Release") continue;
    assert.equal(
      isLegalTransition(from, "Done"),
      false,
      `unexpected ${from} → Done`,
    );
  }
});

test("isLegalTransition: every active state has a Blocked escape hatch", () => {
  // Active states (post-triage, pre-terminal) must be able to → Blocked.
  // Backlog and Blocked itself are excluded: an un-triaged item isn't
  // "blocked" yet, and Blocked → Blocked would be a no-op self-loop the
  // graph deliberately omits to surface idempotent transitions as
  // explicit no-ops at the caller.
  const activeStates = Object.keys(LEGAL_TRANSITIONS).filter(
    (k) => k !== "Backlog" && k !== "Blocked",
  );
  for (const from of activeStates) {
    assert.equal(
      isLegalTransition(from, "Blocked"),
      true,
      `${from} should be able to → Blocked`,
    );
  }
  // Negative cases — confirm the two exclusions.
  assert.equal(isLegalTransition("Backlog", "Blocked"), false);
  assert.equal(isLegalTransition("Blocked", "Blocked"), false);
  // Blocked itself cannot escape to Done — must route through a review state.
  assert.equal(LEGAL_TRANSITIONS["Blocked"]!.has("Done"), false);
});

test("isLegalTransition: unknown from-status returns false (not throws)", () => {
  assert.equal(isLegalTransition("Bogus", "Done"), false);
  assert.equal(isLegalTransition("", "Done"), false);
});

// ---------------------------------------------------------------------------
// checkSpecCompleteness
// ---------------------------------------------------------------------------

test("checkSpecCompleteness: missing both required fields → both reasons", () => {
  const result = checkSpecCompleteness({});
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing.sort(), [
    "AI Suitability field is not set",
    "Risk field is not set",
  ]);
});

test("checkSpecCompleteness: low-risk + AI Suitability set → complete", () => {
  const result = checkSpecCompleteness({
    Risk: "Low",
    "AI Suitability": "Autonomous",
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
});

test("checkSpecCompleteness: high-risk without Spec Approval → incomplete", () => {
  const result = checkSpecCompleteness({
    Risk: "High",
    "AI Suitability": "Assisted",
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, [
    "Spec Approval required for high-risk items",
  ]);
});

test("checkSpecCompleteness: high-risk with Spec Approval=Approved → complete", () => {
  const result = checkSpecCompleteness({
    Risk: "High",
    "AI Suitability": "Assisted",
    "Spec Approval": "Approved",
  });
  assert.equal(result.complete, true);
});

test("checkSpecCompleteness: Risk='HIGH' (case-insensitive) still triggers spec approval gate", () => {
  // Defensive: the Python lowercases via str.lower() — match that behavior
  // so an upper-case field value doesn't silently bypass the gate.
  const result = checkSpecCompleteness({
    Risk: "HIGH",
    "AI Suitability": "Autonomous",
  });
  assert.equal(result.complete, false);
  assert.equal(
    result.missing.includes("Spec Approval required for high-risk items"),
    true,
  );
});

// ---------------------------------------------------------------------------
// parseFieldValues
// ---------------------------------------------------------------------------

test("parseFieldValues: flattens text/number/single-select/iteration/date", () => {
  const result = parseFieldValues([
    { text: "spec content", field: { name: "Spec" } },
    { number: 5, field: { name: "Story Points" } },
    { name: "Ready for Agent", field: { name: "Status" } },
    { title: "Sprint 7", field: { name: "Iteration" } },
    { date: "2026-05-18", field: { name: "Due" } },
  ]);
  assert.deepEqual(result, {
    Spec: "spec content",
    "Story Points": 5,
    Status: "Ready for Agent",
    Iteration: "Sprint 7",
    Due: "2026-05-18",
  });
});

test("parseFieldValues: skips nodes without a field.name pointer", () => {
  const result = parseFieldValues([
    { text: "orphan" },
    { name: "kept", field: { name: "Status" } },
    { number: 1, field: {} },
  ]);
  assert.deepEqual(result, { Status: "kept" });
});

test("parseFieldValues: empty input → empty object", () => {
  assert.deepEqual(parseFieldValues([]), {});
});

// ---------------------------------------------------------------------------
// itemMatchesFilters (client-side filter for getItems)
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    item_id: "I_1",
    issue_number: 42,
    title: "Hello",
    repo: "21-Stark-AI/stark-skills",
    state: "OPEN",
    fields: {
      Status: "Ready for Agent",
      "AI Suitability": "Autonomous",
      Risk: "Low",
    },
    ...overrides,
  };
}

test("itemMatchesFilters: top-level key match", () => {
  assert.equal(
    itemMatchesFilters(makeItem(), { issue_number: 42, state: "OPEN" }),
    true,
  );
  assert.equal(
    itemMatchesFilters(makeItem(), { issue_number: 99 }),
    false,
  );
});

test("itemMatchesFilters: field-bag key match", () => {
  assert.equal(
    itemMatchesFilters(makeItem(), { Status: "Ready for Agent" }),
    true,
  );
  assert.equal(
    itemMatchesFilters(makeItem(), { Status: "Done" }),
    false,
  );
});

test("itemMatchesFilters: unknown key → no match (fail-closed)", () => {
  assert.equal(
    itemMatchesFilters(makeItem(), { NoSuchField: "x" }),
    false,
  );
});

test("itemMatchesFilters: empty filter set → match (vacuous truth)", () => {
  assert.equal(itemMatchesFilters(makeItem(), {}), true);
});

test("itemMatchesFilters: top-level key wins over same-named field-bag key", () => {
  // The Python's first-match semantics: top-level keys shadow field-bag
  // entries when a name collision exists.
  const item = makeItem({ fields: { title: "field-bag title" } });
  // top-level title is "Hello" — filter for "Hello" matches.
  assert.equal(itemMatchesFilters(item, { title: "Hello" }), true);
  // filter for the field-bag value does NOT match because top-level wins.
  assert.equal(itemMatchesFilters(item, { title: "field-bag title" }), false);
});

// ---------------------------------------------------------------------------
// buildFieldValuePayload (set-field payload builder)
// ---------------------------------------------------------------------------

test("buildFieldValuePayload: SINGLE_SELECT resolves option name → id", () => {
  const field: FieldInfo = {
    id: "F1",
    type: "SINGLE_SELECT",
    options: { "Ready for Agent": "OPT_ready", "Done": "OPT_done" },
  };
  assert.deepEqual(buildFieldValuePayload(field, "Status", "Done"), {
    singleSelectOptionId: "OPT_done",
  });
});

test("buildFieldValuePayload: SINGLE_SELECT unknown option throws with available list", () => {
  const field: FieldInfo = {
    id: "F1",
    type: "SINGLE_SELECT",
    options: { Foo: "OPT_foo", Bar: "OPT_bar" },
  };
  assert.throws(
    () => buildFieldValuePayload(field, "Status", "Bogus"),
    (err: Error) => {
      assert.match(err.message, /Option 'Bogus' not found/);
      assert.match(err.message, /Foo/);
      assert.match(err.message, /Bar/);
      return true;
    },
  );
});

test("buildFieldValuePayload: NUMBER coerces string to float", () => {
  const field: FieldInfo = { id: "F2", type: "NUMBER", options: {} };
  assert.deepEqual(buildFieldValuePayload(field, "Story Points", "3"), {
    number: 3,
  });
  assert.deepEqual(buildFieldValuePayload(field, "Story Points", 2.5), {
    number: 2.5,
  });
});

test("buildFieldValuePayload: TEXT stringifies arbitrary values", () => {
  const field: FieldInfo = { id: "F3", type: "TEXT", options: {} };
  assert.deepEqual(buildFieldValuePayload(field, "Notes", 42), {
    text: "42",
  });
});

test("buildFieldValuePayload: ITERATION resolves iteration name → id", () => {
  const field: FieldInfo = {
    id: "F4",
    type: "ITERATION",
    options: { "Sprint 7": "ITER_7" },
  };
  assert.deepEqual(buildFieldValuePayload(field, "Iteration", "Sprint 7"), {
    iterationId: "ITER_7",
  });
});

test("buildFieldValuePayload: unknown field type throws", () => {
  const field: FieldInfo = { id: "F5", type: "BOGUS", options: {} };
  assert.throws(
    () => buildFieldValuePayload(field, "X", "v"),
    /Unsupported field type 'BOGUS'/,
  );
});

// ---------------------------------------------------------------------------
// loadProjectConfig
// ---------------------------------------------------------------------------

test("loadProjectConfig: returns null when .github/project-config.json missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-projects-test-"));
  try {
    assert.equal(loadProjectConfig(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadProjectConfig: parses the JSON when file exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-projects-test-"));
  try {
    const ghDir = path.join(tmp, ".github");
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghDir, "project-config.json"),
      JSON.stringify({ project_id: "PVT_123", board: "main" }),
    );
    const cfg = loadProjectConfig(tmp);
    assert.deepEqual(cfg, { project_id: "PVT_123", board: "main" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
