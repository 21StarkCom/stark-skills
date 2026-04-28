import { test } from "node:test";
import assert from "node:assert/strict";
import { updateUnreleasedChangelog } from "../lib/changelog.ts";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID_2 = "22222222-2222-2222-2222-222222222222";

test("first-run insert creates section + marker + bullet under [Unreleased]", () => {
  const before = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [v0.1.0] - 2026-01-01",
    "",
    "### Added",
    "- existing entry",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 42,
    runId: RUN_ID,
    section: "Added",
    bullet: "- new feature",
  });
  assert.equal(r.changed, true);
  assert.match(r.content, /## \[Unreleased\]\n\n### Added\n<!-- stark-gh:pr-merge pr=42 runId=11111111-1111-1111-1111-111111111111 -->\n- new feature\n/);
  // Existing v0.1.0 entry untouched
  assert.match(r.content, /## \[v0\.1\.0\] - 2026-01-01\n\n### Added\n- existing entry/);
});

test("rerun with same bullet text leaves file byte-identical (no runId update)", () => {
  const before = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "<!-- stark-gh:pr-merge pr=42 runId=" + RUN_ID + " -->",
    "- a feature",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 42,
    runId: RUN_ID_2,           // different runId
    section: "Added",
    bullet: "- a feature",     // identical bullet
  });
  assert.equal(r.changed, false);
  assert.equal(r.content, before);
  // markerLine returned is the existing one — runId NOT bumped on no-op.
  assert.match(r.markerLine, new RegExp(`runId=${RUN_ID}`));
});

test("rerun with changed bullet replaces line and bumps runId", () => {
  const before = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "<!-- stark-gh:pr-merge pr=42 runId=" + RUN_ID + " -->",
    "- old text",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 42,
    runId: RUN_ID_2,
    section: "Added",
    bullet: "- new text",
  });
  assert.equal(r.changed, true);
  // Marker line replaced with new runId, bullet replaced.
  assert.match(r.content, new RegExp(`<!-- stark-gh:pr-merge pr=42 runId=${RUN_ID_2} -->`));
  assert.match(r.content, /\n- new text\n/);
  // No duplicate bullet.
  assert.equal((r.content.match(/- old text/g) || []).length, 0);
  assert.equal((r.content.match(/- new text/g) || []).length, 1);
});

test("matches by PR number even when runId differs (deterministic across runs)", () => {
  const before = [
    "## [Unreleased]",
    "",
    "### Fixed",
    "<!-- stark-gh:pr-merge pr=99 runId=zzz -->",
    "- old fix",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 99,
    runId: "fresh",
    section: "Fixed",
    bullet: "- updated fix",
  });
  assert.equal(r.changed, true);
  assert.match(r.content, /<!-- stark-gh:pr-merge pr=99 runId=fresh -->/);
});

test("inserts section if [Unreleased] has no matching subsection", () => {
  const before = [
    "## [Unreleased]",
    "",
    "### Fixed",
    "- a fix",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 1,
    runId: RUN_ID,
    section: "Added",                 // section absent
    bullet: "- a brand new section",
  });
  assert.equal(r.changed, true);
  assert.match(r.content, /## \[Unreleased\]\n\n### Added\n<!-- stark-gh:pr-merge pr=1 runId=11111111-1111-1111-1111-111111111111 -->\n- a brand new section\n/);
  // Existing ### Fixed preserved
  assert.match(r.content, /### Fixed\n- a fix/);
});

test("inserts at top of subsection when other entries exist", () => {
  const before = [
    "## [Unreleased]",
    "",
    "### Added",
    "- existing entry 1",
    "- existing entry 2",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 7,
    runId: RUN_ID,
    section: "Added",
    bullet: "- new entry on top",
  });
  assert.equal(r.changed, true);
  // The marker + new bullet should appear BEFORE the two existing entries.
  const lines = r.content.split("\n");
  const markerIdx = lines.findIndex(l => l.includes("pr=7"));
  const newBulletIdx = markerIdx + 1;
  const existing1Idx = lines.findIndex(l => l === "- existing entry 1");
  assert.ok(newBulletIdx < existing1Idx, "new bullet should be above existing entries");
});

test("rejects non-positive PR number", () => {
  assert.throws(() => updateUnreleasedChangelog({
    content: "## [Unreleased]\n\n",
    pr: 0,
    runId: RUN_ID,
    section: "Added",
    bullet: "- x",
  }), /pr must be a positive integer/);
});

test("rejects bullet without leading dash-space", () => {
  assert.throws(() => updateUnreleasedChangelog({
    content: "## [Unreleased]\n\n",
    pr: 1,
    runId: RUN_ID,
    section: "Added",
    bullet: "no dash",
  }), /bullet must match/);
});

test("rejects bullet with embedded newline", () => {
  assert.throws(() => updateUnreleasedChangelog({
    content: "## [Unreleased]\n\n",
    pr: 1,
    runId: RUN_ID,
    section: "Added",
    bullet: "- multi\nline",
  }), /bullet must match/);
});

test("rejects bullet over 200 chars", () => {
  assert.throws(() => updateUnreleasedChangelog({
    content: "## [Unreleased]\n\n",
    pr: 1,
    runId: RUN_ID,
    section: "Added",
    bullet: "- " + "x".repeat(199),    // 201 chars total
  }), /bullet must match/);
});

test("rejects missing [Unreleased] section", () => {
  assert.throws(() => updateUnreleasedChangelog({
    content: "# Changelog\n\n## [v0.1] - 2025-01-01\n",
    pr: 1,
    runId: RUN_ID,
    section: "Added",
    bullet: "- x",
  }), /\[Unreleased\] section not found/);
});

test("does not corrupt content under prior version subsection", () => {
  const before = [
    "## [Unreleased]",
    "",
    "## [v0.6.2] - 2026-04-24",
    "",
    "### Added",
    "- forge feature",
    "",
    "### Fixed",
    "- another fix",
    "",
  ].join("\n");
  const r = updateUnreleasedChangelog({
    content: before,
    pr: 5,
    runId: RUN_ID,
    section: "Added",
    bullet: "- under unreleased only",
  });
  assert.equal(r.changed, true);
  // v0.6.2 section's Added/Fixed must remain intact.
  assert.match(r.content, /## \[v0\.6\.2\] - 2026-04-24\n\n### Added\n- forge feature\n\n### Fixed\n- another fix/);
});
