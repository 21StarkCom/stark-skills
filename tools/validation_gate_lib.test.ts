// Tests for `tools/validation_gate_lib.ts` — the lint/typecheck/test
// runner ported from `scripts/validation_gate.py`. HOME is redirected to
// a temp dir so config reads, the stderr log, and telemetry stay isolated.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test,
  formatTable,
  runValidationGate,
  type ValidationResult,
} from "./validation_gate_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vgate-test-"));
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

// ---------------------------------------------------------------------------
// discoverCommands
// ---------------------------------------------------------------------------

test("discoverCommands: package.json → npm test", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    assert.equal(__test.discoverCommands(dir).test_cmd, "npm test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCommands: Makefile → make test", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "Makefile"), "");
    assert.equal(__test.discoverCommands(dir).test_cmd, "make test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCommands: pyproject.toml → pytest", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "");
    assert.equal(__test.discoverCommands(dir).test_cmd, "pytest");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCommands: package.json wins over Makefile (priority order)", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "Makefile"), "");
    assert.equal(__test.discoverCommands(dir).test_cmd, "npm test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCommands: empty repo → no command", () => {
  const dir = tmp();
  try {
    assert.equal(__test.discoverCommands(dir).test_cmd, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// getRepoName
// ---------------------------------------------------------------------------

test("getRepoName: derives name from git remote, strips .git suffix", () => {
  const dir = tmp();
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/widgets.git"],
      { cwd: dir },
    );
    assert.equal(__test.getRepoName(dir), "widgets");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getRepoName: no git remote → _default", () => {
  const dir = tmp();
  try {
    assert.equal(__test.getRepoName(dir), "_default");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

test("runCheck: null command → TEST_COMMAND_MISSING", () => {
  const r = __test.runCheck("test", null, os.tmpdir(), 10);
  assert.equal(r.passed, false);
  assert.equal(r.failure_pattern, "TEST_COMMAND_MISSING");
});

test("runCheck: succeeding command → passed, no failure pattern", () => {
  const r = __test.runCheck("test", "exit 0", os.tmpdir(), 10);
  assert.equal(r.passed, true);
  assert.equal(r.failure_pattern, null);
});

test("runCheck: failing lint/typecheck/test → name-specific pattern", () => {
  assert.equal(__test.runCheck("lint", "exit 1", os.tmpdir(), 10).failure_pattern, "LINT_ERROR");
  assert.equal(
    __test.runCheck("typecheck", "exit 1", os.tmpdir(), 10).failure_pattern,
    "TYPE_ERROR",
  );
  assert.equal(__test.runCheck("test", "exit 1", os.tmpdir(), 10).failure_pattern, "TEST_FAILURE");
});

test("runCheck: command exceeding timeout → TIMEOUT pattern", () => {
  const r = __test.runCheck("test", "sleep 5", os.tmpdir(), 1);
  assert.equal(r.passed, false);
  assert.equal(r.failure_pattern, "TIMEOUT");
});

// ---------------------------------------------------------------------------
// runValidationGate (integration — HOME redirected)
// ---------------------------------------------------------------------------

test("runValidationGate: discovery mode, passing test command → overall pass", () => {
  const home = tmp();
  const repo = tmp();
  try {
    // A package.json whose `npm test` is forced to a trivial success so
    // discovery picks "npm test" but the run is fast + deterministic.
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "exit 0" } }),
    );
    const result = withHome(home, () => runValidationGate(repo, 60));
    assert.equal(result.overall, "pass");
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].name, "test");
    assert.equal(result.checks[0].passed, true);
    assert.ok(fs.existsSync(result.stderr_path), "stderr log written");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runValidationGate: empty repo → no checks, overall pass", () => {
  const home = tmp();
  const repo = tmp();
  try {
    const result = withHome(home, () => runValidationGate(repo, 60));
    assert.equal(result.overall, "pass");
    assert.equal(result.checks.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("runValidationGate: failing test command → overall fail", () => {
  const home = tmp();
  const repo = tmp();
  try {
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
    );
    const result = withHome(home, () => runValidationGate(repo, 60));
    assert.equal(result.overall, "fail");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

test("formatTable: no checks → renders the empty-state line", () => {
  const result: ValidationResult = {
    repo: "demo",
    checks: [],
    overall: "pass",
    stderr_path: "/tmp/x.stderr",
  };
  const out = formatTable(result);
  assert.match(out, /Overall: PASS/);
  assert.match(out, /No checks ran/);
});

test("formatTable: renders a check row with status + pattern", () => {
  const result: ValidationResult = {
    repo: "demo",
    checks: [
      {
        name: "test",
        command: "npm test",
        passed: false,
        duration_s: 1.234,
        failure_pattern: "TEST_FAILURE",
        // duration shown to 2dp
      },
    ],
    overall: "fail",
    stderr_path: "/tmp/x.stderr",
  };
  const out = formatTable(result);
  assert.match(out, /Overall: FAIL/);
  assert.match(out, /npm test/);
  assert.match(out, /TEST_FAILURE/);
});
