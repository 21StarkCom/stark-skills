// Integration tests for skill_audit CLI. Covers the exit-code contract of
// --validate and --json: non-zero when any discovered bundle has missing
// refs, zero when everything resolves. Depends on a writable os.tmpdir();
// a sandboxed run exits early if mkdtempSync refuses.

import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "skill_audit.ts");

function makeRepo(t: TestContext): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-audit-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    return tmp;
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

function runCli(repo: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

function writeSkill(repo: string, slug: string, body: string): void {
  const dir = path.join(repo, "skill", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

test("--validate exits 0 when every ref resolves", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nNo external refs.\n");
    const res = runCli(repo, ["--validate"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /All local markdown references resolve/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--validate exits non-zero when a bundle has a missing ref", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(
      repo,
      "alpha",
      "# alpha\n\n[missing](./does-not-exist.md)\n",
    );
    const res = runCli(repo, ["--validate"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /skill\/alpha\/SKILL\.md/);
    assert.match(res.stdout, /does-not-exist\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--json exits non-zero when any bundle has missing refs", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(
      repo,
      "alpha",
      "# alpha\n\n[missing](./gone.md)\n",
    );
    const res = runCli(repo, ["--json"]);
    assert.notEqual(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.brokenRefCount, 1);
    assert.ok(Array.isArray(parsed.skills));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("skill_audit refuses to run outside a git repo", (t) => {
  // Build a repo whose cwd has no .git/ anywhere above it. mkdtempSync
  // alone guarantees the fresh directory has no ancestor .git/ unless the
  // system tmpdir happens to be nested inside a repo.
  let tmp: string | null = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-audit-noroot-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return;
  }
  try {
    const tmpReal = fs.realpathSync(tmp);
    let dir = tmpReal;
    while (true) {
      if (fs.existsSync(path.join(dir, ".git"))) {
        t.skip(`tmpdir ${tmpReal} is nested inside an existing repo at ${dir}`);
        return;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const res = runCli(tmp, ["--validate"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must run from inside a git repository/);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
});
