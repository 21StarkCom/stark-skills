import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stark_review_doc.ts",
);

function runTool(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", ["--experimental-strip-types", TOOL, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: e.status ?? 1,
      stdout: typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "",
    };
  }
}

// ─── CLI arg parsing ───────────────────────────────────────────────────

describe("stark_review_doc CLI", () => {
  test("--help exits 0 and prints usage", () => {
    const r = runTool(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: stark_review_doc.ts/);
  });

  test("--doc and --prompts-dir are required", () => {
    const r = runTool(["--prompts-dir", "design-review"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--doc is required/);
  });

  test("--prompts-dir validates allowed values", () => {
    const r = runTool(["--doc", "x.md", "--prompts-dir", "nope-review"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /must be one of/);
  });

  test("--rounds rejects out-of-range values", () => {
    const r = runTool([
      "--doc", "x.md", "--prompts-dir", "design-review",
      "--rounds", "999",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--rounds must be 1..10/);
  });

  test("--codex-concurrent rejects 0", () => {
    const r = runTool([
      "--doc", "x.md", "--prompts-dir", "design-review",
      "--codex-concurrent", "0",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--codex-concurrent must be >= 1/);
  });
});

// ─── Receipt shape — early failures ────────────────────────────────────

describe("stark_review_doc early errors → receipt JSON", () => {
  test("missing doc surfaces error code in receipt", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-rev-"));
    try {
      // Build a minimal valid prompts tree so dispatch advances past the
      // prompts_dir_missing check and reaches doc_not_found.
      const promptsBase = path.join(tmp, "prompts");
      mkdirSync(path.join(promptsBase, "design-review", "codex"), { recursive: true });
      writeFileSync(
        path.join(promptsBase, "design-review", "codex", "01-completeness.md"),
        "domain content",
      );
      writeFileSync(
        path.join(promptsBase, "design-review", "codex", "agent.md"),
        "agent prelude",
      );

      const r = runTool([
        "--doc", "does-not-exist.md",
        "--prompts-dir", "design-review",
        "--prompts-base", promptsBase,
        "--repo-dir", tmp,
        "--dry-run",
      ]);
      assert.notEqual(r.code, 0);
      const receipt = JSON.parse(r.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "doc_not_found");
      assert.equal(receipt.doc, "does-not-exist.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing prompts dir surfaces prompts_dir_missing", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-rev-"));
    try {
      writeFileSync(path.join(tmp, "doc.md"), "# doc");
      const r = runTool([
        "--doc", "doc.md",
        "--prompts-dir", "design-review",
        "--prompts-base", path.join(tmp, "no-such-prompts"),
        "--repo-dir", tmp,
        "--dry-run",
      ]);
      assert.notEqual(r.code, 0);
      const receipt = JSON.parse(r.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "prompts_dir_missing");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dirty doc without --force is rejected (when in a git repo)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-rev-"));
    try {
      // Initialize a real git repo so `git status --porcelain` works.
      execFileSync("git", ["init", "-q", tmp], { stdio: "ignore" });
      execFileSync("git", ["-C", tmp, "config", "user.email", "t@example.com"], { stdio: "ignore" });
      execFileSync("git", ["-C", tmp, "config", "user.name", "test"], { stdio: "ignore" });
      writeFileSync(path.join(tmp, "doc.md"), "# v1");
      execFileSync("git", ["-C", tmp, "add", "doc.md"], { stdio: "ignore" });
      execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "init"], { stdio: "ignore" });
      // Make it dirty.
      writeFileSync(path.join(tmp, "doc.md"), "# v2 dirty");

      const promptsBase = path.join(tmp, "prompts");
      mkdirSync(path.join(promptsBase, "design-review", "codex"), { recursive: true });
      writeFileSync(
        path.join(promptsBase, "design-review", "codex", "01-completeness.md"),
        "domain content",
      );

      const r = runTool([
        "--doc", "doc.md",
        "--prompts-dir", "design-review",
        "--prompts-base", promptsBase,
        "--repo-dir", tmp,
      ]);
      assert.notEqual(r.code, 0);
      const receipt = JSON.parse(r.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "doc_dirty");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
