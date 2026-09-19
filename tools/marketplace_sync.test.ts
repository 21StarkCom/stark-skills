import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/marketplace-sync.yml", import.meta.url), "utf8");

// The publisher's review predicate USED to live in this workflow and be exercised
// here. STARK-6208 moved publication to bifrost's `publish-sync-pr` workflow, so
// the predicate — and the suite that pins it — moved with it:
// `bifrost/engine/cmd/stark/publish_sync_pr_test.go`. Every case that ran here
// runs there, against the same jq program, plus the cases the new event shape
// adds. Testing it from this repo is not possible: the text no longer exists in
// any file this repo checks out, and a copy would pin a copy.
//
// What remains below is this workflow's OWN remaining logic: the release-notes
// generator, which did not move.

// ─── The release-notes generator ────────────────────────────────────────────
// Exercise the awk program the workflow actually runs, extracted from the
// workflow file rather than restated here. This generator has shipped the same defect twice — a tag
// whose notes never mention the `[Unreleased]` bullets it absorbed — and the second
// time was a regression of a hand repair. Nothing but a test stops the third.
const notesAwk = workflow.match(/awk -v version=[^\n]*\n([\s\S]*?)\n\s*' CHANGELOG\.md > CHANGELOG\.md\.next/)?.[1];
assert.ok(notesAwk, "exercise the actual release-notes generator");
const REFRESH = "- Refresh marketplace packages from [stark-skills@deadbee](https://github.com/21StarkCom/stark-skills/commit/deadbeef).";

function generate(changelog: string): string {
  const result = spawnSync("awk", ["-v", "version=1.2.3", "-v", "source=deadbeef", "-v", "short=deadbee",
    "-v", "date=2026-01-02", notesAwk!], { input: changelog, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("release notes absorb the [Unreleased] body instead of stranding it above the tag", () => {
  const out = generate(["# Changelog", "", "## [Unreleased]", "", "### Changed", "- carried change", "",
    "### Fixed", "- carried fix", "", "## [1.2.2] - 2026-01-01", "", "### Changed", "- older", ""].join("\n"));
  // The new section sits directly under [Unreleased], which is left as a bare heading.
  assert.match(out, /## \[Unreleased\]\n\n## \[1\.2\.3\] - 2026-01-02\n/);
  // Every carried bullet is INSIDE the released section, above the previous release.
  const released = out.slice(out.indexOf("## [1.2.3]"), out.indexOf("## [1.2.2]"));
  for (const carried of ["- carried change", "- carried fix", "### Fixed"]) assert.ok(released.includes(carried), carried);
  assert.ok(!out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [1.2.3]")).includes("- carried"), "nothing stranded");
  // The Refresh bullet joins the existing "### Changed" rather than opening a second one.
  assert.equal(released.split("### Changed").length - 1, 1);
  assert.equal(released.split(REFRESH).length - 1, 1);
  assert.match(released, /### Changed\n- Refresh marketplace packages/);
});

test("release notes handle every CHANGELOG shape, exactly once each", () => {
  const body = (out: string) => out.slice(out.indexOf("## [1.2.3]"));
  // A body with no "### Changed" gets one, carrying its other sections through.
  const added = generate(["# Changelog", "", "## [Unreleased]", "", "### Added", "- new thing", "",
    "## [1.2.2] - 2026-01-01", ""].join("\n"));
  assert.match(body(added), /### Added\n- new thing\n\n### Changed\n- Refresh marketplace packages/);
  assert.equal(added.split(REFRESH).length - 1, 1);
  // An empty [Unreleased] section, and no [Unreleased] section at all.
  for (const source of [["# Changelog", "", "## [Unreleased]", "", "## [1.2.2] - 2026-01-01", ""],
    ["# Changelog", "", "## [1.2.2] - 2026-01-01", "", "### Changed", "- older", ""]]) {
    const out = generate(source.join("\n"));
    assert.match(out, /## \[1\.2\.3\] - 2026-01-02\n\n### Changed\n/);
    assert.equal(out.split(REFRESH).length - 1, 1);
    assert.ok(out.indexOf("## [1.2.3]") < out.indexOf("## [1.2.2]"), "newest release first");
  }
  // A CHANGELOG with no release headings at all still gets its first section appended.
  const bare = generate(["# Changelog", "", "prose only", ""].join("\n"));
  assert.match(bare, /prose only\n\n## \[1\.2\.3\] - 2026-01-02\n\n### Changed\n/);
  assert.equal(bare.split(REFRESH).length - 1, 1);
  // A first release: [Unreleased] with a body and no numbered heading to flush at, so the
  // absorb happens at EOF. The heading already supplied the blank line under it.
  const first = generate(["# Changelog", "", "## [Unreleased]", "", "### Changed", "- the first thing", ""].join("\n"));
  assert.match(first, /## \[Unreleased\]\n\n## \[1\.2\.3\] - 2026-01-02\n\n### Changed\n/);
  assert.ok(first.includes("- the first thing"), "the body is absorbed, not dropped");
  assert.equal(first.split(REFRESH).length - 1, 1);
});

test("release notes emit exactly one version section, whatever the heading order", () => {
  // Two "### Changed" headings under [Unreleased] must not each take a Refresh bullet.
  const twice = generate(["## [Unreleased]", "", "### Changed", "- one", "", "### Changed", "- two", "",
    "## [1.2.2] - 2026-01-01", ""].join("\n"));
  assert.equal(twice.split(REFRESH).length - 1, 1);
  for (const carried of ["- one", "- two"]) assert.ok(twice.includes(carried), carried);
  // A malformed file whose numbered heading precedes [Unreleased]: one section, and the
  // Unreleased body replayed verbatim rather than duplicated into a second 1.2.3 section
  // or swallowed by the buffer that never gets flushed.
  // The trailing heading matters: it is the line that fires the [Unreleased] flush, so
  // without it an unguarded flush rule has nothing to duplicate the section at.
  const misordered = generate(["# Changelog", "", "## [1.2.2] - 2026-01-01", "", "### Changed", "- older", "",
    "## [Unreleased]", "", "### Added", "- stray", "", "## [1.2.1] - 2025-12-31", ""].join("\n"));
  assert.equal(misordered.split("## [1.2.3]").length - 1, 1);
  assert.equal(misordered.split(REFRESH).length - 1, 1);
  assert.ok(misordered.includes("- stray"), "the Unreleased body survives");
});

test("release notes keep Keep a Changelog section order, which the file's own header declares", () => {
  // The generated "### Changed" used to be appended after everything, so a body carrying
  // "### Fixed" produced Added -> Fixed -> Changed — against the order the CHANGELOG header
  // says it follows, on every publish, in the generator's own output.
  const rank = (out: string) => ["### Added", "### Changed", "### Fixed"]
    .map(h => out.indexOf(h)).filter(i => i >= 0);
  const ordered = (out: string) => rank(out).every((v, i, a) => i === 0 || a[i - 1] < v);

  const afterFixed = generate(["# C", "", "## [Unreleased]", "", "### Added", "- a", "",
    "### Fixed", "- f", "", "## [1.2.2] - 2026-01-01", ""].join("\n"));
  const released = afterFixed.slice(afterFixed.indexOf("## [1.2.3]"), afterFixed.indexOf("## [1.2.2]"));
  assert.ok(ordered(released), `sections out of order:\n${released}`);
  assert.match(released, /### Added[\s\S]*### Changed[\s\S]*### Fixed/);
  assert.equal(released.split(REFRESH).length - 1, 1);

  // An existing "### Changed" still absorbs the bullet in place rather than gaining a sibling.
  const existing = generate(["# C", "", "## [Unreleased]", "", "### Changed", "- c", "",
    "### Fixed", "- f", "", "## [1.2.2] - 2026-01-01", ""].join("\n"));
  const inPlace = existing.slice(existing.indexOf("## [1.2.3]"), existing.indexOf("## [1.2.2]"));
  assert.equal(inPlace.split("### Changed").length - 1, 1);
  assert.ok(ordered(inPlace), `sections out of order:\n${inPlace}`);

  // A body with only earlier-ranked sections appends, which is also in order.
  const onlyAdded = generate(["# C", "", "## [Unreleased]", "", "### Added", "- a", "",
    "## [1.2.2] - 2026-01-01", ""].join("\n"));
  const appended = onlyAdded.slice(onlyAdded.indexOf("## [1.2.3]"), onlyAdded.indexOf("## [1.2.2]"));
  assert.match(appended, /### Added[\s\S]*### Changed/);
  assert.equal(appended.split(REFRESH).length - 1, 1);
});

test("an out-of-order body keeps ONE '### Changed', the one it already had", () => {
  // Placing the generated heading at the first later-ranked section is only correct when the
  // body has no "### Changed" of its own. A body that puts "### Fixed" (or "### Removed")
  // BEFORE its own "### Changed" otherwise gets one inserted at that boundary and keeps its
  // own too — two "### Changed" sections in one release, with the Refresh bullet orphaned
  // under the first. Ordering someone else's out-of-order sections is not this job.
  for (const before of ["### Deprecated", "### Removed", "### Fixed", "### Security"]) {
    const out = generate(["# C", "", "## [Unreleased]", "", before, "- x", "",
      "### Changed", "- c", "", "## [1.2.2] - 2026-01-01", ""].join("\n"));
    const released = out.slice(out.indexOf("## [1.2.3]"), out.indexOf("## [1.2.2]"));
    assert.equal(released.split("### Changed").length - 1, 1, `two '### Changed' after ${before}:\n${released}`);
    assert.equal(released.split(REFRESH).length - 1, 1);
    // The bullet joined the body's own section, beside the bullet already there.
    assert.match(released, /### Changed\n- Refresh marketplace packages[^\n]*\n- c/);
  }

  // The repository's OWN CHANGELOG is this shape today: its [Unreleased] body opens with
  // "### Removed" and carries "### Changed" further down. This is not a hypothetical input.
  const real = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const generated = generate(real);
  const section = generated.slice(generated.indexOf("## [1.2.3]"),
    generated.indexOf("## [", generated.indexOf("## [1.2.3]") + 1));
  assert.equal(section.split("\n").filter(l => l === "### Changed").length, 1,
    "the real CHANGELOG must publish exactly one '### Changed'");
  assert.equal(section.split(REFRESH).length - 1, 1);
});

test("section rank and the '### Changed' test read a heading the same way", () => {
  // Two disagreeing readings of "is this a section heading" strand the generated section:
  // "### Changed since 1.2.2" matched a prefix-only rank (so it never triggered the ordered
  // insertion) but not the exact heading test (so it never absorbed the bullet either), and
  // the generated "### Changed" fell to the end, after everything.
  const out = generate(["# C", "", "## [Unreleased]", "", "### Changed since 1.2.2", "- c", "",
    "### Fixed", "- f", "", "## [1.2.2] - 2026-01-01", ""].join("\n"));
  const released = out.slice(out.indexOf("## [1.2.3]"), out.indexOf("## [1.2.2]"));
  assert.equal(released.split(REFRESH).length - 1, 1);
  // Not a heading, so it is body text: the real "### Changed" is placed before "### Fixed".
  assert.match(released, /### Changed\n- Refresh marketplace packages[\s\S]*### Fixed/);
  assert.ok(released.includes("### Changed since 1.2.2"), "the body line survives verbatim");
});
