// Permission/idempotency tests for `observability_paths_lib.ts`. Phase 1
// Task 1 acceptance: every directory is 0700, every file written via the
// helpers is 0600, ensureRoot() is a no-op the second time.
//
// Tests redirect $HOME to a tmpdir so we never touch the user's real
// ~/.claude tree. The module reads $HOME at import time via os.homedir(),
// so we re-import dynamically inside each test after rewriting HOME.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-paths-test-"));
}

async function freshImport() {
  // Bust the module cache for a clean HOME read per test.
  const url = new URL("./observability_paths_lib.ts", import.meta.url);
  return (await import(`${url.href}?t=${Date.now()}-${Math.random()}`)) as
    typeof import("./observability_paths_lib.ts");
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

test("ensureRoot creates the full tree at 0700 (dirs)", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    mod.ensureRoot();
    const dirs = [
      mod.OBSERVABILITY_ROOT,
      mod.runsDir(),
      mod.hostinfoDir(),
      mod.trashDir(),
      mod.auditDir(),
      mod.sessionsDir(),
    ];
    for (const d of dirs) {
      assert.equal(fs.statSync(d).isDirectory(), true, `${d} not dir`);
      assert.equal(modeOf(d), 0o700, `${d} mode=${modeOf(d).toString(8)}`);
    }
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRoot is a no-op on the second call", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    mod.ensureRoot();
    const stat1 = fs.statSync(mod.OBSERVABILITY_ROOT);
    const btime1 = stat1.birthtimeMs;
    mod.ensureRoot();
    const stat2 = fs.statSync(mod.OBSERVABILITY_ROOT);
    // inode + birthtime should match — re-creating would change both.
    // ctime is allowed to drift because chmod on an already-0700 dir still
    // bumps it on some filesystems; that's idempotent in effect.
    assert.equal(stat1.ino, stat2.ino);
    assert.equal(btime1, stat2.birthtimeMs);
    assert.equal(stat2.mode & 0o777, 0o700);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensurePrivateDir converges an existing wider-mode dir to 0700", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    const target = path.join(home, "preexisting");
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755); // ensure 0755 even with umask
    assert.equal(modeOf(target), 0o755);
    mod.ensurePrivateDir(target);
    assert.equal(modeOf(target), 0o700);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("openPrivate writes files at 0600 even with a wide umask", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  const prevUmask = process.umask(0o022); // simulate macOS default
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    mod.ensureRoot();
    // Every path helper that produces a file we own:
    const runId = "run-123";
    mod.ensurePrivateDir(mod.runDir(runId));
    const targets = [
      mod.metaPath(runId),
      mod.currentSpoolFile(runId, 0),
      mod.writerSocketPath(runId), // we treat the sock pid-file slot as a file
      mod.sessionCookiePath(),
      path.join(mod.auditDir(), "audit.jsonl"),
    ];
    for (const t of targets) {
      // Some targets nest under runDir(runId) which already exists; others
      // live at OBSERVABILITY_ROOT or auditDir() which ensureRoot() created.
      const fd = mod.openPrivate(t, fs.constants.O_WRONLY | fs.constants.O_CREAT);
      fs.writeSync(fd, "x");
      fs.closeSync(fd);
      assert.equal(
        modeOf(t),
        0o600,
        `${t} mode=${modeOf(t).toString(8)} (umask leak?)`,
      );
    }
  } finally {
    process.umask(prevUmask);
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ensurePrivateDir respects 0700 even with a wide umask", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  const prevUmask = process.umask(0o022);
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    mod.ensureRoot();
    for (const d of [
      mod.OBSERVABILITY_ROOT,
      mod.runsDir(),
      mod.hostinfoDir(),
      mod.trashDir(),
      mod.auditDir(),
    ]) {
      assert.equal(modeOf(d), 0o700, `umask leak on ${d}`);
    }
  } finally {
    process.umask(prevUmask);
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sanitizeId refuses path traversal", async () => {
  const mod = await freshImport();
  assert.throws(() => mod.__test.sanitizeId(".."));
  assert.throws(() => mod.__test.sanitizeId("../escape"));
  assert.throws(() => mod.__test.sanitizeId("a/b"));
  assert.throws(() => mod.__test.sanitizeId("a\\b"));
  assert.throws(() => mod.__test.sanitizeId(""));
  assert.equal(mod.__test.sanitizeId("run-abcd"), "run-abcd");
});

test("currentSpoolFile pads rotation index to 4 digits", async () => {
  const mod = await freshImport();
  assert.match(mod.currentSpoolFile("r1", 0), /\/events-0000\.jsonl$/);
  assert.match(mod.currentSpoolFile("r1", 42), /\/events-0042\.jsonl$/);
  assert.match(mod.currentSpoolFile("r1", 9999), /\/events-9999\.jsonl$/);
});

test("audit dir is writable after ensureRoot (E9)", async () => {
  const home = tmpHome();
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await freshImport();
    mod.ensureRoot();
    const marker = path.join(mod.auditDir(), ".writable-check");
    fs.writeFileSync(marker, "ok", { mode: 0o600 });
    assert.equal(fs.readFileSync(marker, "utf8"), "ok");
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

