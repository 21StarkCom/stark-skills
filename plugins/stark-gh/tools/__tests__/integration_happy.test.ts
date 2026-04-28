import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

function makeGhShim(dir: string) {
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"evinced/stark","defaultBranchRef":{"name":"main"},"url":"https://github.com/evinced/stark"}' ;;
  "pr list") echo '[]' ;;
  "issue view") exit 0 ;;
  "auth status") exit 0 ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  return ghPath;
}

test("preflight emits a plan-file for a basic feature branch", () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-int-"));
  const tmpOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-origin-"));
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-shim-"));
  try {
    makeGhShim(ghDir);
    const env = { ...process.env, PATH: `${ghDir}:${process.env.PATH}` };
    execFileSync("git", ["init", "--bare"], { cwd: tmpOrigin });
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpRepo });
    execFileSync("git", ["remote", "add", "origin", tmpOrigin], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpRepo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "x");
    execFileSync("git", ["add", "."], { cwd: tmpRepo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo });
    execFileSync("git", ["push", "origin", "main"], { cwd: tmpRepo });
    execFileSync("git", ["checkout", "-b", "feat/123-foo"], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, "x.ts"), "// add\n");
    execFileSync("git", ["add", "x.ts"], { cwd: tmpRepo });

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
    const preflight = path.join(repoRoot, "plugins/stark-gh/tools/gh_pr_open_preflight.ts");
    const r = spawnSync("node", ["--experimental-strip-types", preflight, "--raw-args", "", "--emit-plan-path"], {
      cwd: tmpRepo,
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `preflight failed: ${r.stderr}`);
    const planPath = r.stdout.trim();
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(plan.branch, "feat/123-foo");
    assert.equal(plan.tree.dirty, true);
    assert.deepEqual(plan.refsLines.preflight, ["Refs #123"]);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpOrigin, { recursive: true, force: true });
    fs.rmSync(ghDir, { recursive: true, force: true });
  }
});
