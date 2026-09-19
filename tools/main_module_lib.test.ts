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

// ── STARK-489: a path containing a SPACE ────────────────────────────────────
//
// The second way this guard silently no-ops. Fifteen entrypoints hand-rolled
//   fs.realpathSync(new URL(import.meta.url).pathname)
// and `URL.pathname` is percent-ENCODED: a space arrives as `%20`, realpathSync
// throws ENOENT on a path that does not exist, the catch returns false, main()
// never runs and the CLI exits 0 having done nothing. Not an edge case either:
// Claude installs plugins under `~/Library/Application Support/`.

const SPACED = "Application Support";

test("returns true when the probe lives under a path containing a SPACE", () => {
  withTempDir((dir) => {
    const spaced = path.join(dir, SPACED);
    fs.mkdirSync(spaced);
    const probe = path.join(spaced, "probe.ts");
    fs.writeFileSync(probe, probeSource());
    const r = run(probe);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "MAIN:true");
  });
});

test("returns true through a SYMLINK whose target path contains a SPACE", () => {
  withTempDir((dir) => {
    const spaced = path.join(dir, SPACED);
    fs.mkdirSync(spaced);
    const probe = path.join(spaced, "probe.ts");
    fs.writeFileSync(probe, probeSource());
    const link = path.join(dir, "probe-link.ts");
    fs.symlinkSync(probe, link);
    const r = run(link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "MAIN:true");
  });
});

// Every entrypoint that carried the broken hand-rolled guard. Listed, not
// discovered: discovering them by "imports isMainModule" would pass vacuously
// against the very build this exists to fail on.
const FORMERLY_HAND_ROLLED = [
  "alert_delivery.ts",
  "approach_contract.ts",
  "context_compactor.ts",
  "failure_classifier.ts",
  "github_projects.ts",
  "healer_canary.ts",
  "optimize_skill_description.ts",
  "preflight.ts",
  "self_healer.ts",
  "session_id.ts",
  "session_state.ts",
  "skill_router.ts",
  "stark_handover.ts",
  "statusline_setup.ts",
  "validation_gate.ts",
];

/** Copy the non-test tool sources into `dest` — they import only siblings. */
function copyToolSources(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
}

test("every formerly hand-rolled CLI still runs main() from a path containing a SPACE", () => {
  // End-to-end on the REAL tools. `--help` is the side-effect-free probe: a
  // guard that returned false prints nothing at all and exits 0, so "any
  // output" is exactly the distinction between ran and silently skipped.
  withTempDir((dir) => {
    const spacedTools = path.join(dir, SPACED, "tools");
    copyToolSources(HERE, spacedTools);
    const silent: string[] = [];
    for (const name of FORMERLY_HAND_ROLLED) {
      const r = run(path.join(spacedTools, name), ["--help"]);
      if ((r.stdout + r.stderr).trim() === "") silent.push(name);
    }
    assert.deepEqual(silent, []);
  });
});

test("the codex self_healer overlay runs main() from a path containing a SPACE", () => {
  // Bifrost overlays `runtime-overrides/codex/tools/` onto the canonical tree,
  // so the mirror is exercised the way it ships: canonical first, overlay on top.
  withTempDir((dir) => {
    const spacedTools = path.join(dir, SPACED, "tools");
    copyToolSources(HERE, spacedTools);
    copyToolSources(path.join(REPO_ROOT, "runtime-overrides", "codex", "tools"), spacedTools);
    const r = run(path.join(spacedTools, "self_healer.ts"), ["--help"]);
    assert.notEqual((r.stdout + r.stderr).trim(), "", "silent no-op from a spaced path");
  });
});

test("no tool hand-rolls its run-as-main guard", () => {
  // `process.argv[1]` has exactly one legitimate reader — the helper. Any other
  // mention in a tool source is a private guard, and every private guard so far
  // has mishandled a symlink, a space, or both.
  const offenders: string[] = [];
  for (const dir of [HERE, path.join(REPO_ROOT, "runtime-overrides", "codex", "tools")]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      if (name === "main_module_lib.ts") continue;
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      if (text.includes("process.argv[1]") || text.includes("new URL(import.meta.url).pathname")) {
        offenders.push(path.relative(REPO_ROOT, path.join(dir, name)));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
