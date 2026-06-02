// Unit tests for the per-ecosystem rewriters and the integration test that
// drives bumpAll() against a synthetic repo.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  bumpAll,
  bumpCargoToml,
  bumpPackageJson,
  bumpPyproject,
  bumpPythonInit,
  bumpVersionFile,
  isValidSemver,
} from "./release_version_bump.ts";

function makeRepo(t: TestContext): string | null {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "release-bump-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

// ── isValidSemver ───────────────────────────────────────────────

test("isValidSemver accepts plain semver and pre-release/build suffixes", () => {
  for (const ok of ["0.1.0", "1.2.3", "10.20.30", "1.0.0-rc.1", "1.0.0+build.5"]) {
    assert.equal(isValidSemver(ok), true, `should accept ${ok}`);
  }
  for (const bad of ["1.2", "v1.0.0", "1.0.0.0", "abc", ""]) {
    assert.equal(isValidSemver(bad), false, `should reject ${bad}`);
  }
});

// ── Python __init__.py ──────────────────────────────────────────

test("bumpPythonInit rewrites the __version__ string", () => {
  const before = '__version__ = "0.1.2"\n\nfrom .api import *\n';
  const result = bumpPythonInit(before, "0.2.0");
  assert.equal(result.previous, "0.1.2");
  assert.match(result.content, /__version__ = "0\.2\.0"/);
});

test("bumpPythonInit returns previous=null when no marker is present", () => {
  const result = bumpPythonInit("# Just a regular module\n", "1.0.0");
  assert.equal(result.previous, null);
});

// ── pyproject.toml ──────────────────────────────────────────────

test("bumpPyproject rewrites a [project] version", () => {
  const before = '[project]\nname = "demo"\nversion = "0.1.0"\n';
  const result = bumpPyproject(before, "0.2.0");
  assert.equal(result.previous, "0.1.0");
  assert.match(result.content, /version = "0\.2\.0"/);
});

test("bumpPyproject is a no-op when [tool.setuptools-scm] is present", () => {
  const before =
    '[project]\nname = "demo"\nversion = "0.0.0"\n\n[tool.setuptools-scm]\n';
  const result = bumpPyproject(before, "0.2.0");
  assert.equal(result.previous, null);
  assert.equal(result.reason, "uses setuptools-scm");
  assert.equal(result.content, before);
});

// ── package.json ────────────────────────────────────────────────

test("bumpPackageJson preserves indentation and key ordering", () => {
  const before =
    '{\n  "name": "demo",\n  "version": "0.1.0",\n  "private": true\n}\n';
  const result = bumpPackageJson(before, "0.2.0");
  assert.equal(result.previous, "0.1.0");
  assert.equal(
    result.content,
    '{\n  "name": "demo",\n  "version": "0.2.0",\n  "private": true\n}\n',
  );
});

// ── Cargo.toml ──────────────────────────────────────────────────

test("bumpCargoToml rewrites the [package] version, not dependency versions", () => {
  // The trailing dependency block exists specifically to make sure the
  // anchor `^version =` doesn't match the inline dep version table.
  const before =
    '[package]\nname = "demo"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0.0" }\n';
  const result = bumpCargoToml(before, "0.2.0");
  assert.equal(result.previous, "0.1.0");
  // Top-level version updated.
  assert.match(result.content, /^version = "0\.2\.0"/m);
  // Dependency version untouched.
  assert.match(result.content, /serde = \{ version = "1\.0\.0" \}/);
});

// ── plain VERSION file ──────────────────────────────────────────

test("bumpVersionFile rewrites a bare version and preserves the trailing newline", () => {
  const result = bumpVersionFile("0.13.6\n", "0.13.9");
  assert.equal(result.previous, "0.13.6");
  assert.equal(result.content, "0.13.9\n");
});

test("bumpVersionFile preserves a leading v prefix and a no-newline file", () => {
  const pref = bumpVersionFile("v1.2.3\n", "1.2.4");
  assert.equal(pref.previous, "1.2.3");
  assert.equal(pref.content, "v1.2.4\n");

  const noNewline = bumpVersionFile("0.1.0", "0.2.0");
  assert.equal(noNewline.previous, "0.1.0");
  assert.equal(noNewline.content, "0.2.0");
});

test("bumpVersionFile returns previous=null for a non-semver VERSION file", () => {
  const result = bumpVersionFile("stable\n", "9.9.9");
  assert.equal(result.previous, null);
  assert.equal(result.content, "stable\n");
});

// ── bumpAll integration ─────────────────────────────────────────

test("bumpAll updates every supported file in a synthetic repo", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    fs.writeFileSync(path.join(repo, "package.json"), '{"version": "0.0.1"}\n');
    fs.writeFileSync(path.join(repo, "Cargo.toml"), '[package]\nversion = "0.0.1"\n');
    fs.writeFileSync(
      path.join(repo, "pyproject.toml"),
      '[project]\nversion = "0.0.1"\n',
    );
    fs.mkdirSync(path.join(repo, "src", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "demo", "__init__.py"),
      '__version__ = "0.0.1"\n',
    );
    fs.writeFileSync(path.join(repo, "VERSION"), "0.0.1\n");

    const result = bumpAll(repo, "1.0.0");
    assert.equal(result.version, "1.0.0");
    assert.equal(result.dryRun, false);
    const updatedPaths = result.filesUpdated.map((f) => f.path).sort();
    assert.deepEqual(updatedPaths, [
      "Cargo.toml",
      "VERSION",
      "package.json",
      "pyproject.toml",
      path.join("src", "demo", "__init__.py"),
    ]);
    assert.equal(
      fs.readFileSync(path.join(repo, "package.json"), "utf8"),
      '{"version": "1.0.0"}\n',
    );
    assert.match(
      fs.readFileSync(path.join(repo, "Cargo.toml"), "utf8"),
      /version = "1\.0\.0"/,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "VERSION"), "utf8"),
      "1.0.0\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("bumpAll skips pyproject.toml when setuptools-scm is in use", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    fs.writeFileSync(
      path.join(repo, "pyproject.toml"),
      '[project]\nname = "demo"\nversion = "0.0.0"\n\n[tool.setuptools-scm]\n',
    );
    const result = bumpAll(repo, "1.0.0");
    assert.equal(result.filesUpdated.length, 0);
    assert.equal(result.filesSkipped.length, 1);
    assert.equal(result.filesSkipped[0].reason, "uses setuptools-scm");
    // Confirm the file content is byte-identical after the run.
    assert.match(
      fs.readFileSync(path.join(repo, "pyproject.toml"), "utf8"),
      /version = "0\.0\.0"/,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("bumpAll dry-run reports updates without writing", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    fs.writeFileSync(path.join(repo, "package.json"), '{"version": "0.0.1"}\n');
    const result = bumpAll(repo, "1.0.0", { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.filesUpdated.length, 1);
    // File on disk untouched.
    assert.equal(
      fs.readFileSync(path.join(repo, "package.json"), "utf8"),
      '{"version": "0.0.1"}\n',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("bumpAll throws on invalid semver", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    assert.throws(() => bumpAll(repo, "not-a-version"), /Invalid semver/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("bumpAll skips a file already at the target version", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    fs.writeFileSync(path.join(repo, "package.json"), '{"version": "1.0.0"}\n');
    const result = bumpAll(repo, "1.0.0");
    assert.equal(result.filesUpdated.length, 0);
    assert.equal(result.filesSkipped.length, 1);
    assert.equal(result.filesSkipped[0].reason, "already at target version");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
