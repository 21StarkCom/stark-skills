import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/marketplace-sync.yml", import.meta.url), "utf8");
const filter = workflow.match(/review_filter='([^']+)'/)?.[1];
assert.ok(filter, "exercise the actual publisher review predicate");
const head = "a".repeat(40);
const completed = () => ({ id: 1, user: { login: "aryeh-stark" }, commit_id: head,
  state: "COMMENTED", submitted_at: "2026-09-15T12:00:00Z",
  body: "<!-- stark-code-review:complete -->\n/code-review xhigh --fix completed; findings fixed or answered." });

function accepted(pages: unknown[][], expected: boolean): void {
  const result = spawnSync("jq", ["-e", "--arg", "head", head, filter!], {
    input: JSON.stringify(pages), encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected ? 0 : 1, result.stderr || result.stdout);
}

test("publisher requires the operator's explicit completed review on the current head", () => {
  accepted([[completed()]], true);
  accepted([[{ ...completed(), state: "APPROVED" }]], true);
  accepted([[]], false);
  for (const change of [
    { user: { login: "stark-meridian-ci[bot]" } },
    { commit_id: "b".repeat(40) },
    { submitted_at: null },
    { state: "PENDING" },
    { state: "CHANGES_REQUESTED" },
    { state: "DISMISSED" },
    { body: "/code-review xhigh --fix is still running." },
    { body: "Example marker:\n" + completed().body },
    { body: "<!-- stark-code-review:complete -->\nAn unrelated review passed." },
    { body: null },
  ]) accepted([[{ ...completed(), ...change }]], false);
});

test("publisher accepts the CRLF body GitHub's web UI actually submits", () => {
  // GitHub returns web-UI-authored review bodies with \r\n line endings (over
  // half of any sampled comment page carries them). Matching the raw text would
  // reject the attestation an operator types by hand and report it as "no
  // completed head review", pointing the blame at the human, not the parser.
  const crlf = completed().body.replace(/\n/g, "\r\n");
  accepted([[{ ...completed(), body: crlf }]], true);
  accepted([[{ ...completed(), body: crlf.replace("/code-review xhigh --fix", "/code-review high") }]], false);
  // The marker must still own the whole first line, CRLF or not.
  accepted([[{ ...completed(), body: "Example marker:\r\n" + crlf }]], false);
  accepted([[{ ...completed(), body: "<!-- stark-code-review:complete --> /code-review xhigh --fix" }]], false);
  // A review with no author record must not read as the operator's.
  accepted([[{ ...completed(), user: null }]], false);
});

test("publisher keeps all review pages and honors the latest operator verdict", () => {
  const later = { ...completed(), id: 2, submitted_at: "2026-09-15T12:01:00Z" };
  accepted([[completed()], [{ ...later, state: "CHANGES_REQUESTED" }]], false);
  accepted([[completed()], [{ ...later, state: "DISMISSED" }]], false);
  accepted([[{ ...completed(), state: "CHANGES_REQUESTED" }], [later]], true);
  accepted([[completed()], [{ ...later, commit_id: "b".repeat(40), state: "CHANGES_REQUESTED" }]], true);
  accepted([[completed()], [{ ...later, user: { login: "unrelated-bot" }, state: "COMMENTED", body: "FYI" }]], true);
  // Equal timestamps use monotonically increasing review ids, not page order.
  accepted([[{ ...completed(), id: 2, state: "DISMISSED" }], [completed()]], false);
});

// ─── The release-notes generator ────────────────────────────────────────────
// Exercise the awk program the workflow actually runs, extracted the same way as
// `review_filter` above. This generator has shipped the same defect twice — a tag
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
