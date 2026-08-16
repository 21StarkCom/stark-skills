// Tests for `tools/main_module_lib.ts` — the symlink-safe entrypoint guard.
//
// Run: node --test tools/main_module_lib.test.ts
//
// The bug this locks down: the naive guard
//   `import.meta.url === pathToFileURL(process.argv[1]).href`
// silently no-ops when a tool is invoked through a **symlink** (Node resolves
// `import.meta.url` to the real path but `process.argv[1]` stays the symlink),
// so `main()` never runs and the CLI exits 0 having done nothing. These tools
// are *designed* to be reached through the `~/.claude/code-review` symlink on
// direct/cron runs (see `asset_root_lib.ts`), so that path is the common case,
// not an edge case.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LIB = path.join(HERE, "main_module_lib.ts");
const REPO_ROOT = path.resolve(HERE, "..");

function run(script: string, args: string[] = []) {
  const r = spawnSync(
    process.execPath,
    [script, ...args],
    { encoding: "utf8", cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A throwaway temp dir, torn down after `fn`. */
function withTempDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-module-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A probe that imports the REAL lib by absolute file URL and prints the verdict.
function probeSource(): string {
  const libUrl = pathToFileURL(LIB).href;
  return [
    `import { isMainModule } from ${JSON.stringify(libUrl)};`,
    `process.stdout.write("MAIN:" + isMainModule(import.meta.url));`,
    ``,
  ].join("\n");
}

test("returns true when the probe is invoked directly", () => {
  withTempDir((dir) => {
    const probe = path.join(dir, "probe.ts");
    fs.writeFileSync(probe, probeSource());
    const r = run(probe);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "MAIN:true");
  });
});

test("returns true when the probe is invoked through a SYMLINK (the bug)", () => {
  withTempDir((dir) => {
    const probe = path.join(dir, "probe.ts");
    fs.writeFileSync(probe, probeSource());
    const link = path.join(dir, "probe-link.ts");
    fs.symlinkSync(probe, link);
    const r = run(link);
    assert.equal(r.status, 0, r.stderr);
    // The naive `=== pathToFileURL(argv1).href` guard prints "MAIN:false" here.
    assert.equal(r.stdout.trim(), "MAIN:true");
  });
});

test("returns false for a module that is imported, not the entrypoint", () => {
  withTempDir((dir) => {
    // The entrypoint imports a SECOND module which asks isMainModule about
    // ITSELF — it is not the process entry, so the answer must be false.
    const imported = path.join(dir, "imported.ts");
    const libUrl = pathToFileURL(LIB).href;
    fs.writeFileSync(
      imported,
      [
        `import { isMainModule } from ${JSON.stringify(libUrl)};`,
        `export const verdict = isMainModule(import.meta.url);`,
        ``,
      ].join("\n"),
    );
    const entry = path.join(dir, "entry.ts");
    fs.writeFileSync(
      entry,
      [
        `import { verdict } from ${JSON.stringify(pathToFileURL(imported).href)};`,
        `process.stdout.write("IMPORTED:" + verdict);`,
        ``,
      ].join("\n"),
    );
    const r = run(entry);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "IMPORTED:false");
  });
});

test("copilot_land.ts runs its command when reached through a symlink", () => {
  // End-to-end proof on a REAL tool: the exact class the report hit. A symlink
  // to the CLI must still produce the branch name, not a silent no-op.
  withTempDir((dir) => {
    const link = path.join(dir, "copilot_land-link.ts");
    fs.symlinkSync(path.join(HERE, "copilot_land.ts"), link);
    const r = run(link, [
      "branch-name",
      "--plan-slug",
      "example",
      "--fallback-slug",
      "fallback",
      "--json",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.branch, "copilot/example");
  });
});
