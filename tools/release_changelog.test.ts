// Unit tests for the pure parsers in release_changelog.ts. Integration with
// real `git` is exercised manually — these tests focus on the parsing /
// categorization rules that used to live inline in stark-release SKILL.md.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  categorizeCommit,
  gatherChanges,
  parseChangelogUnreleased,
  parseGitLogRecords,
  recommendBump,
} from "./release_changelog.ts";

const RS = "\x1e"; // ASCII Record Separator used by `--format='%s%n%b%x1e'`

// ── parseGitLogRecords ──────────────────────────────────────────

test("parseGitLogRecords splits on the record separator", () => {
  const input = `feat(api): add endpoint${RS}\nfix: typo${RS}\n`;
  const records = parseGitLogRecords(input);
  assert.equal(records.length, 2);
  assert.equal(records[0].subject, "feat(api): add endpoint");
  assert.equal(records[1].subject, "fix: typo");
});

test("parseGitLogRecords keeps multi-line bodies intact", () => {
  const input =
    `feat: add X\n\nlong body line 1\nlong body line 2\nBREAKING CHANGE: removes Y${RS}\n`;
  const records = parseGitLogRecords(input);
  assert.equal(records.length, 1);
  assert.match(records[0].body, /BREAKING CHANGE: removes Y/);
});

test("parseGitLogRecords returns [] for empty input", () => {
  assert.deepEqual(parseGitLogRecords(""), []);
  assert.deepEqual(parseGitLogRecords("   \n   "), []);
});

// ── categorizeCommit ────────────────────────────────────────────

test("categorizeCommit routes feat → Added with scope prefix", () => {
  const result = categorizeCommit({
    subject: "feat(calendar): read vacations from personAbsences (#341) (#348)",
    body: "",
  });
  assert.equal(result.category, "added");
  assert.equal(result.breaking, false);
  // Scope is preserved as a `scope: subject` prefix; trailing PR refs stay.
  assert.equal(result.entry, "calendar: read vacations from personAbsences (#341) (#348)");
});

test("categorizeCommit routes fix: → Fixed", () => {
  const result = categorizeCommit({ subject: "fix: handle null user", body: "" });
  assert.equal(result.category, "fixed");
  assert.equal(result.entry, "handle null user");
});

test("categorizeCommit detects bang-suffix breaking changes and routes to Changed", () => {
  const result = categorizeCommit({
    subject: "feat(api)!: drop legacy endpoint",
    body: "",
  });
  assert.equal(result.category, "changed");
  assert.equal(result.breaking, true);
  assert.equal(result.entry, "**BREAKING:** api: drop legacy endpoint");
});

test("categorizeCommit detects body-encoded BREAKING CHANGE", () => {
  const result = categorizeCommit({
    subject: "refactor(auth): rework session store",
    body: "BREAKING CHANGE: cookies now require Secure flag",
  });
  assert.equal(result.category, "changed");
  assert.equal(result.breaking, true);
  assert.match(result.entry, /^\*\*BREAKING:\*\*/);
});

test("categorizeCommit treats refactor/chore/docs as Changed", () => {
  for (const type of ["refactor", "chore", "docs", "perf", "ci"]) {
    const result = categorizeCommit({ subject: `${type}: tweak`, body: "" });
    assert.equal(result.category, "changed", `expected changed for ${type}`);
  }
});

test("categorizeCommit falls back to Changed when prefix is missing", () => {
  const result = categorizeCommit({ subject: "Something raw without a prefix", body: "" });
  assert.equal(result.category, "changed");
  assert.equal(result.entry, "Something raw without a prefix");
});

// ── parseChangelogUnreleased ────────────────────────────────────

test("parseChangelogUnreleased extracts entries by sub-section", () => {
  const md = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "- shiny new thing",
    "",
    "### Fixed",
    "- bug A",
    "- bug B",
    "",
    "## [v1.0.0] - 2026-01-01",
    "### Fixed",
    "- old fix",
    "",
  ].join("\n");
  const section = parseChangelogUnreleased(md);
  assert.equal(section.isEmpty, false);
  assert.deepEqual(section.added, ["shiny new thing"]);
  assert.deepEqual(section.fixed, ["bug A", "bug B"]);
  assert.deepEqual(section.changed, []);
});

test("parseChangelogUnreleased flags an empty section", () => {
  const md = ["## [Unreleased]", "", "## [v0.1.0] - 2026-01-01", "### Added", "- x"].join(
    "\n",
  );
  const section = parseChangelogUnreleased(md);
  assert.equal(section.isEmpty, true);
});

test("parseChangelogUnreleased returns empty when section is missing", () => {
  const section = parseChangelogUnreleased("# Just the heading\n\n## [v0.1.0]\n- thing\n");
  assert.equal(section.isEmpty, true);
});

// ── gatherChanges ───────────────────────────────────────────────

test("gatherChanges prefers a populated CHANGELOG over git log", () => {
  const md = [
    "## [Unreleased]",
    "### Added",
    "- thing from changelog",
    "",
  ].join("\n");
  const gitLog = `feat: thing from git${RS}\n`;
  const result = gatherChanges({
    changelogContent: md,
    gitLogOutput: gitLog,
    lastTag: "v0.1.0",
  });
  assert.equal(result.source, "changelog");
  assert.deepEqual(result.added, ["thing from changelog"]);
});

test("gatherChanges falls back to git log when [Unreleased] is empty", () => {
  const md = "## [Unreleased]\n\n## [v0.1.0]\n";
  const gitLog =
    `feat(api): add endpoint${RS}\nfix: typo${RS}\nrefactor: cleanup${RS}\n`;
  const result = gatherChanges({
    changelogContent: md,
    gitLogOutput: gitLog,
    lastTag: "v0.1.0",
  });
  assert.equal(result.source, "git-log");
  assert.deepEqual(result.added, ["api: add endpoint"]);
  assert.deepEqual(result.fixed, ["typo"]);
  assert.deepEqual(result.changed, ["cleanup"]);
});

test("gatherChanges returns source=empty when both inputs are empty", () => {
  const result = gatherChanges({
    changelogContent: "## [Unreleased]\n",
    gitLogOutput: "",
    lastTag: null,
  });
  assert.equal(result.source, "empty");
  assert.equal(result.recommendedBump, null);
});

// ── recommendBump ────────────────────────────────────────────────

test("recommendBump: only fixes → patch", () => {
  assert.equal(recommendBump([], ["fix1"], [], false), "patch");
});

test("recommendBump: any added → minor", () => {
  assert.equal(recommendBump(["new feature"], ["fix1"], [], false), "minor");
});

test("recommendBump: breaking change → major", () => {
  assert.equal(recommendBump(["new feature"], [], ["**BREAKING:** drop X"], true), "major");
});

test("recommendBump: empty → null", () => {
  assert.equal(recommendBump([], [], [], false), null);
});
