import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { appendPrMergeOverride, prMergeAuditPath, SECRET_TO_LLM_WARNING } from "../lib/audit.ts";

// All tests force CODEX_SANDBOX so audit writes go under /tmp/stark-gh/audit/.

function withSandbox<T>(fn: () => T): T {
  const prev = process.env.CODEX_SANDBOX;
  process.env.CODEX_SANDBOX = "1";
  // Clean state per-test to keep assertions deterministic.
  const fp = prMergeAuditPath();
  try { fs.unlinkSync(fp); } catch { /* ok */ }
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_SANDBOX;
    else process.env.CODEX_SANDBOX = prev;
  }
}

test("appendPrMergeOverride writes JSONL line to expected path", () => {
  withSandbox(() => {
    appendPrMergeOverride({
      timestamp: "2026-04-28T12:00:00Z",
      runId: "run-1",
      pr: 42,
      flag: "--allow-secret-commit",
      user: "alice",
      hostname: "host",
      reason: "intentional secret in fixture",
    });
    const fp = prMergeAuditPath();
    assert.ok(fs.existsSync(fp), `audit file should exist at ${fp}`);
    const lines = fs.readFileSync(fp, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.runId, "run-1");
    assert.equal(parsed.pr, 42);
    assert.equal(parsed.flag, "--allow-secret-commit");
  });
});

test("appendPrMergeOverride file mode is 0600", () => {
  withSandbox(() => {
    appendPrMergeOverride({
      timestamp: "2026-04-28T12:00:01Z",
      runId: "run-mode",
      pr: 1,
      flag: "--allow-secret-to-llm",
      user: "u",
      hostname: "h",
      reason: "",
    });
    const fp = prMergeAuditPath();
    const st = fs.statSync(fp);
    // chmod to 0600 — strip the file-type bits.
    assert.equal(st.mode & 0o777, 0o600);
  });
});

test("appendPrMergeOverride --force requires non-empty reason", () => {
  withSandbox(() => {
    assert.throws(
      () => appendPrMergeOverride({
        timestamp: "2026-04-28T12:00:02Z",
        runId: "run-noforce",
        pr: 99,
        flag: "--force",
        user: "u",
        hostname: "h",
        reason: "",
      }),
      /--force requires a non-empty reason/,
    );
    assert.throws(
      () => appendPrMergeOverride({
        timestamp: "2026-04-28T12:00:03Z",
        runId: "run-spaces",
        pr: 99,
        flag: "--force",
        user: "u",
        hostname: "h",
        reason: "   ",
      }),
      /--force requires a non-empty reason/,
    );

    // Non-empty reason succeeds.
    appendPrMergeOverride({
      timestamp: "2026-04-28T12:00:04Z",
      runId: "run-ok",
      pr: 99,
      flag: "--force",
      user: "u",
      hostname: "h",
      reason: "release-train rolling forward",
    });
  });
});

test("appendPrMergeOverride append-mode creates separate JSONL records", () => {
  withSandbox(() => {
    appendPrMergeOverride({
      timestamp: "t1", runId: "r-multi", pr: 1, flag: "--force",
      user: "u", hostname: "h", reason: "first",
    });
    appendPrMergeOverride({
      timestamp: "t2", runId: "r-multi", pr: 1, flag: "--allow-secret-commit",
      user: "u", hostname: "h", reason: "",
    });
    const lines = fs.readFileSync(prMergeAuditPath(), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).flag, "--force");
    assert.equal(JSON.parse(lines[1]).flag, "--allow-secret-commit");
  });
});

test("SECRET_TO_LLM_WARNING text is stable", () => {
  // Operators may grep for this string; lock the wording.
  assert.match(SECRET_TO_LLM_WARNING, /WARNING.*secret material.*external LLM provider/);
});
