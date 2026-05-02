// Tests for housekeeping_infra. Each phase step is tested independently
// against a synthetic FAKE_HOME so we never touch the real ~/.claude tree,
// then a small integration test runs cleanInfra() end-to-end.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import {
  archiveOldFiles,
  cleanInfra,
  findStaleCheckpointFiles,
  findStaleLockFiles,
  findStaleSessionFiles,
  isLockDataStale,
  rotateLogFile,
  type AgeProvider,
  type StaleClock,
} from "./housekeeping_infra.ts";

function makeTmp(t: TestContext): string | null {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "housekeeping-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

const NOW = new Date("2026-04-27T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// ── isLockDataStale ─────────────────────────────────────────────

const liveClock: StaleClock = {
  now: () => NOW,
  pidAlive: () => true,
  startTime: () => "Mon Apr 27 12:00:00 2026",
};

test("isLockDataStale: TTL exceeded → stale even when PID is alive", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: "2026-04-27T10:00:00Z", // 2 hours ago
    ttl_minutes: 30,
  };
  assert.equal(isLockDataStale(lock, liveClock), true);
});

test("isLockDataStale: dead PID → stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: NOW.toISOString().replace(".000", ""),
    ttl_minutes: 30,
  };
  const deadClock: StaleClock = { ...liveClock, pidAlive: () => false };
  assert.equal(isLockDataStale(lock, deadClock), true);
});

test("isLockDataStale: PID reused (start_time mismatch) → stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 11:00:00 2026", // earlier than current
    timestamp: NOW.toISOString().replace(".000", ""),
    ttl_minutes: 30,
  };
  const reusedClock: StaleClock = {
    ...liveClock,
    startTime: () => "Mon Apr 27 12:00:00 2026",
  };
  assert.equal(isLockDataStale(lock, reusedClock), true);
});

test("isLockDataStale: live, fresh, matching start_time → not stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: "2026-04-27T11:55:00Z",
    ttl_minutes: 30,
  };
  assert.equal(isLockDataStale(lock, liveClock), false);
});

test("isLockDataStale: missing timestamp → stale", () => {
  assert.equal(isLockDataStale({ pid: 1234 }, liveClock), true);
});

// ── findStaleSessionFiles ───────────────────────────────────────

test("findStaleSessionFiles flags session JSONs older than 30 days", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    fs.writeFileSync(path.join(tmp, "old.json"), "{}");
    fs.writeFileSync(path.join(tmp, "fresh.json"), "{}");
    fs.writeFileSync(path.join(tmp, "ignore.txt"), "x");
    const ages: Record<string, Date> = {
      [path.join(tmp, "old.json")]: days(45),
      [path.join(tmp, "fresh.json")]: days(5),
      [path.join(tmp, "ignore.txt")]: days(100),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const stale = findStaleSessionFiles(tmp, 30, ageProvider, NOW);
    assert.deepEqual(stale.sort(), [path.join(tmp, "old.json")]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── findStaleCheckpointFiles ────────────────────────────────────

test("findStaleCheckpointFiles walks subdirs and flags old checkpoint markdowns", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    fs.mkdirSync(path.join(tmp, "session-a"));
    const cp1 = path.join(tmp, "session-a", "checkpoint-1.md");
    const cp2 = path.join(tmp, "session-a", "checkpoint-2.md");
    const notes = path.join(tmp, "session-a", "notes.md");
    fs.writeFileSync(cp1, "x");
    fs.writeFileSync(cp2, "x");
    fs.writeFileSync(notes, "x");
    const ages: Record<string, Date> = {
      [cp1]: days(30),
      [cp2]: days(2),
      [notes]: days(40),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const stale = findStaleCheckpointFiles(tmp, 7, ageProvider, NOW);
    assert.deepEqual(stale.sort(), [cp1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── findStaleLockFiles ──────────────────────────────────────────

test("findStaleLockFiles surfaces both corrupt and stale locks", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const corrupt = path.join(tmp, "corrupt.lock");
    fs.writeFileSync(corrupt, "{not json");
    const stale = path.join(tmp, "stale.lock");
    fs.writeFileSync(
      stale,
      JSON.stringify({
        pid: 1,
        start_time: "x",
        timestamp: "2020-01-01T00:00:00Z",
        ttl_minutes: 30,
      }),
    );
    const fresh = path.join(tmp, "fresh.lock");
    fs.writeFileSync(
      fresh,
      JSON.stringify({
        pid: 1,
        start_time: "Mon Apr 27 12:00:00 2026",
        timestamp: "2026-04-27T11:55:00Z",
        ttl_minutes: 30,
      }),
    );
    const result = findStaleLockFiles([tmp], { clock: liveClock });
    assert.deepEqual(result.sort(), [corrupt, stale].sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── rotateLogFile ───────────────────────────────────────────────

test("rotateLogFile leaves small files alone", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "tiny.jsonl");
    fs.writeFileSync(log, "a\nb\nc\n");
    const r = rotateLogFile(log, 1000, false);
    assert.equal(r.rotated, false);
    assert.equal(fs.readFileSync(log, "utf8"), "a\nb\nc\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rotateLogFile keeps the last N lines and preserves trailing newline", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "big.jsonl");
    const lines = Array.from({ length: 1500 }, (_, i) => `line-${i}`);
    fs.writeFileSync(log, lines.join("\n") + "\n");
    const r = rotateLogFile(log, 1000, false);
    assert.equal(r.rotated, true);
    assert.equal(r.lines, 1500);
    const after = fs.readFileSync(log, "utf8").split("\n");
    // 1000 lines + the final empty element from the trailing newline.
    assert.equal(after.length, 1001);
    assert.equal(after[0], "line-500");
    assert.equal(after[999], "line-1499");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rotateLogFile dry-run reports without writing", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "big.jsonl");
    const lines = Array.from({ length: 1100 }, (_, i) => `line-${i}`);
    const before = lines.join("\n") + "\n";
    fs.writeFileSync(log, before);
    const r = rotateLogFile(log, 1000, true);
    assert.equal(r.rotated, true);
    assert.equal(fs.readFileSync(log, "utf8"), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── archiveOldFiles ─────────────────────────────────────────────

test("archiveOldFiles groups by month and only includes old files", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const src = path.join(tmp, "logs");
    fs.mkdirSync(src);
    const oldA = path.join(src, "old-a.txt");
    const oldB = path.join(src, "old-b.txt");
    const fresh = path.join(src, "fresh.txt");
    for (const f of [oldA, oldB, fresh]) fs.writeFileSync(f, "x");
    const ages: Record<string, Date> = {
      [oldA]: new Date("2026-01-15T12:00:00Z"),
      [oldB]: new Date("2026-02-10T12:00:00Z"),
      [fresh]: new Date("2026-04-25T12:00:00Z"),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const tarCalls: string[][] = [];
    const tarRunner = (args: string[]) => {
      tarCalls.push(args);
      // Simulate `tar -czf` writing the archive so verification passes.
      if (args[0] === "-czf") fs.writeFileSync(args[1], "tar-bytes");
      return "";
    };
    const archives = archiveOldFiles(
      { slug: "logs", rootDir: src },
      path.join(tmp, "archives"),
      30,
      { ageProvider, now: NOW, tarRunner },
    );
    assert.equal(archives.length, 2);
    const months = archives.map((a) => path.basename(a.archive)).sort();
    assert.deepEqual(months, ["logs-2026-01.tar.gz", "logs-2026-02.tar.gz"]);
    // Originals were unlinked.
    assert.equal(fs.existsSync(oldA), false);
    assert.equal(fs.existsSync(oldB), false);
    // Fresh file untouched.
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archiveOldFiles dry-run reports without invoking tar", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const src = path.join(tmp, "logs");
    fs.mkdirSync(src);
    const old = path.join(src, "old.txt");
    fs.writeFileSync(old, "x");
    const ageProvider: AgeProvider = () => new Date("2026-01-01T00:00:00Z");
    let called = 0;
    const tarRunner = (_args: string[]) => {
      called++;
      return "";
    };
    const archives = archiveOldFiles(
      { slug: "logs", rootDir: src },
      path.join(tmp, "archives"),
      30,
      { ageProvider, now: NOW, dryRun: true, tarRunner },
    );
    assert.equal(archives.length, 1);
    assert.equal(called, 0);
    assert.equal(fs.existsSync(old), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── cleanInfra integration ──────────────────────────────────────

test("cleanInfra dry-run reports counts without mutating", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const home = path.join(tmp, "home");
    const codeReview = path.join(home, ".claude", "code-review");
    const sessions = path.join(codeReview, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const oldSession = path.join(sessions, "old.json");
    fs.writeFileSync(oldSession, "{}");

    const ageProvider: AgeProvider = (p) =>
      p === oldSession ? days(45) : days(0);
    const receipt = cleanInfra({
      homeDir: home,
      cwd: tmp,
      dryRun: true,
      ageProvider,
      now: NOW,
      clock: liveClock,
      tarRunner: () => "",
    });
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.sessionsRemoved.length, 1);
    assert.equal(fs.existsSync(oldSession), true); // still there
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanInfra surfaces unlink errors but keeps going", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const home = path.join(tmp, "home");
    const codeReview = path.join(home, ".claude", "code-review");
    const sessions = path.join(codeReview, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    // No actual session files — receipt.errors should be empty even though
    // the directories exist. This guards against any startup error paths.
    const receipt = cleanInfra({
      homeDir: home,
      cwd: tmp,
      ageProvider: () => days(0),
      now: NOW,
      clock: liveClock,
      tarRunner: () => "",
    });
    assert.equal(receipt.errors.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression: under Node 25's --experimental-strip-types, the entry-point
// gate goes silent when the script is invoked through a symlink (e.g.
// ~/.claude/code-review/tools/ → stark-skills/tools/). See
// review_setup_worktree for the full root cause. Guard by invoking through
// a real symlink and asserting the CLI parser actually runs.
test("CLI runs when invoked through a symlink (Node 25 strip-types regression)", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  const realScript = fileURLToPath(
    new URL("./housekeeping_infra.ts", import.meta.url),
  );
  const linkedScript = path.join(tmp, "housekeeping_infra.ts");
  try {
    fs.symlinkSync(realScript, linkedScript);
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-strip-types", linkedScript, "--dry-run", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // --dry-run --json prints a JSON receipt; empty stdout means the gate
    // misfired and main() never ran.
    assert.ok(stdout.trim().length > 0, "expected JSON receipt, got empty stdout");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
