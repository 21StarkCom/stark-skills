// Tests for the launchd plist generator. We mostly care that:
//   - the PATH env carries both /opt/homebrew/bin (Apple Silicon) and
//     /usr/local/bin (Intel Homebrew / manual installs), satisfying the
//     Phase 1 Task 5 portability acceptance,
//   - ProgramArguments uses `/usr/bin/env node` so PATH resolution
//     actually fires,
//   - XML escaping doesn't break on `&` / `<` characters that may show
//     up in tmp paths,
//   - the helper writes both plists when --service=all.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test,
  buildHostinfoSpec,
  buildPruneSpec,
  install,
  renderPlist,
} from "./observability_install_launchd.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "launchd-test-"));
}

test("PATH includes both /opt/homebrew/bin and /usr/local/bin", () => {
  assert.ok(__test.PORTABLE_PATH.includes("/opt/homebrew/bin"));
  assert.ok(__test.PORTABLE_PATH.includes("/usr/local/bin"));
  assert.ok(__test.PORTABLE_PATH.includes("/usr/bin"));
});

test("buildHostinfoSpec uses /usr/bin/env node with --loop --interval 5s", () => {
  const spec = buildHostinfoSpec({
    repoRoot: "/repo",
    outDir: "/out",
    logDir: "/logs",
    service: "hostinfo",
  });
  assert.equal(spec.label, "com.aryeh.observability.hostinfo");
  assert.deepEqual(spec.programArguments.slice(0, 3), [
    "/usr/bin/env",
    "node",
    "--experimental-strip-types",
  ]);
  assert.equal(
    spec.programArguments[3],
    "/repo/tools/observability_hostinfo.ts",
  );
  assert.deepEqual(spec.programArguments.slice(4), [
    "--loop",
    "--interval",
    "5s",
  ]);
  assert.equal(spec.keepAlive, true);
  assert.equal(spec.runAtLoad, true);
});

test("buildPruneSpec carries a StartInterval (cron-like)", () => {
  const spec = buildPruneSpec({
    repoRoot: "/repo",
    outDir: "/out",
    logDir: "/logs",
    service: "prune",
  });
  assert.equal(spec.label, "com.aryeh.observability.prune");
  assert.equal(spec.intervalSeconds, 3600);
});

test("renderPlist escapes XML metacharacters in values", () => {
  const xml = renderPlist({
    label: "com.aryeh.observability.hostinfo",
    workingDir: "/path/with/ampers&and/and<lt>",
    logDir: "/logs",
    programArguments: ["/usr/bin/env", "node", `"quoted"`],
  });
  assert.match(xml, /ampers&amp;and/);
  assert.match(xml, /and&lt;lt&gt;/);
  assert.match(xml, /&quot;quoted&quot;/);
  // PATH dict is present.
  assert.match(xml, /<key>PATH<\/key>/);
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
});

test("install --service all writes both plists with sane modes", () => {
  const root = tmp();
  try {
    const outDir = path.join(root, "out");
    const logDir = path.join(root, "logs");
    const written = install({
      repoRoot: root,
      outDir,
      logDir,
      service: "all",
    });
    assert.equal(written.length, 2);
    for (const p of written) {
      assert.ok(fs.existsSync(p));
      const xml = fs.readFileSync(p, "utf8");
      assert.match(xml, /<plist version="1.0">/);
      assert.match(xml, /<key>Label<\/key>/);
    }
    // logDir is 0700 (the prune helper writes audit-adjacent logs here).
    const logStat = fs.statSync(logDir);
    assert.equal(logStat.mode & 0o777, 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--repo-root retargets repoRoot AND the default outDir", () => {
  const args = __test.parseArgs(["--repo-root", "/elsewhere/checkout"]);
  assert.equal(args.repoRoot, "/elsewhere/checkout");
  assert.equal(
    args.outDir,
    "/elsewhere/checkout/tools/observability_server/launchd",
  );
});

test("--repo-root + explicit --out-dir keeps the explicit outDir", () => {
  const args = __test.parseArgs([
    "--repo-root",
    "/elsewhere",
    "--out-dir",
    "/custom/out",
  ]);
  assert.equal(args.repoRoot, "/elsewhere");
  assert.equal(args.outDir, "/custom/out");
});

test("--out-dir before --repo-root also honors the explicit outDir", () => {
  const args = __test.parseArgs([
    "--out-dir",
    "/custom/out",
    "--repo-root",
    "/elsewhere",
  ]);
  assert.equal(args.repoRoot, "/elsewhere");
  assert.equal(args.outDir, "/custom/out");
});

test("install --service hostinfo writes only one plist", () => {
  const root = tmp();
  try {
    const written = install({
      repoRoot: root,
      outDir: path.join(root, "out"),
      logDir: path.join(root, "logs"),
      service: "hostinfo",
    });
    assert.equal(written.length, 1);
    assert.match(written[0], /com\.aryeh\.observability\.hostinfo\.plist$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
