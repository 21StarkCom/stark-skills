import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Regression cover for the entry-point guard. This bug class cannot be caught by
// observing a failing run: a false guard skips main(), writes nothing to stdout
// or stderr, and exits 0. It is indistinguishable from a successful no-op run,
// which is why every prior break went unnoticed for months.

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "main_module.ts");

// A throwaway entrypoint that prints a marker iff its guard fires.
const PROBE = `import { isMainModule } from ${JSON.stringify(LIB)};
if (isMainModule(import.meta.url)) console.log("MAIN_RAN");
`;

function runProbe(entry: string): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", entry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function withTempDir<T>(fn: (dir: string) => T): T {
  // realpath: macOS resolves $TMPDIR through /var -> /private/var, and the whole
  // point of these cases is to control which side of the comparison is symlinked.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-mainmod-")));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("guard fires for a plain entrypoint", () => {
  withTempDir((dir) => {
    const entry = path.join(dir, "probe.ts");
    fs.writeFileSync(entry, PROBE);
    assert.equal(runProbe(entry), "MAIN_RAN");
  });
});

test("guard fires when the path contains a space", () => {
  // `file://${process.argv[1]}` never matched here: import.meta.url encodes the
  // space as %20 and the template literal does not.
  withTempDir((dir) => {
    const nested = path.join(dir, "Application Support");
    fs.mkdirSync(nested);
    const entry = path.join(nested, "probe.ts");
    fs.writeFileSync(entry, PROBE);
    assert.equal(runProbe(entry), "MAIN_RAN");
  });
});

test("guard fires when the entrypoint is reached through a symlink", () => {
  // A plain `pathToFileURL(process.argv[1]).href` comparison fails here: Node
  // resolves import.meta.url to the real path while argv[1] stays as invoked.
  // housekeeping_infra.ts::ASSET_SYMLINKS keeps ~/.claude/plugins/stark-gh
  // pointed into the source checkout, so this is a live invocation shape.
  withTempDir((dir) => {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "probe.ts"), PROBE);
    fs.symlinkSync(real, path.join(dir, "link"));
    assert.equal(runProbe(path.join(dir, "link", "probe.ts")), "MAIN_RAN");
  });
});

test("guard stays false when the module is imported as a library", () => {
  withTempDir((dir) => {
    const lib = path.join(dir, "lib.ts");
    fs.writeFileSync(lib, PROBE);
    const entry = path.join(dir, "entry.ts");
    fs.writeFileSync(entry, `import ${JSON.stringify(lib)};\nconsole.log("IMPORTED");\n`);
    assert.equal(runProbe(entry), "IMPORTED");
  });
});
