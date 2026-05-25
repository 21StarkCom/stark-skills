// Unit + integration tests for `observability_hostinfo.ts`.
//
// Pure parsers (parseBootTime, formatBootId, parsePidList) drive a tight
// unit suite; the full `collect()` path runs against injected fakes; an
// end-to-end test forces a real `--once` invocation against a tmp HOME
// and verifies the on-disk file shape.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  collect,
  formatBootId,
  hostInfoFilePath,
  parseBootTime,
  parseIntervalArg,
  parsePidList,
  writeAtomic,
  type HostInfo,
} from "./observability_hostinfo.ts";

const SAMPLE_BOOTTIME =
  "{ sec = 1779692400, usec = 123456 } Wed May 25 09:00:00 2026\n";

test("parseBootTime parses sec + usec into fractional seconds", () => {
  assert.equal(parseBootTime(SAMPLE_BOOTTIME), 1779692400 + 123456 / 1e6);
});

test("parseBootTime throws on malformed input", () => {
  assert.throws(() => parseBootTime("garbage"));
  assert.throws(() => parseBootTime("{ sec = x, usec = y }"));
});

test("formatBootId returns <sec>.<usec> verbatim", () => {
  assert.equal(formatBootId(SAMPLE_BOOTTIME), "1779692400.123456");
});

test("parsePidList drops blanks, dedupes, sorts ascending", () => {
  const raw = " 84367 \n84412\n84367\n\n  84415  \nnot-an-int\n0\n";
  // pid=0 is filtered (kernel-only, never user-owned), duplicates collapse,
  // result is sorted ascending.
  assert.deepEqual(parsePidList(raw), [84367, 84412, 84415]);
});

test("parsePidList tolerates an empty capture", () => {
  assert.deepEqual(parsePidList(""), []);
});

test("collect() composes every field from the injected env", () => {
  const fixedNow = 1779692400_500; // 0.5s after boot
  const info: HostInfo = collect({
    sysctl: () => SAMPLE_BOOTTIME,
    ps: () => "100\n200\n",
    statfs: () => ({ bavail: 1_000_000, bsize: 4096 }),
    now: () => fixedNow,
    spoolDir: "/tmp/whatever",
  });
  assert.equal(info.host_boot_id, "1779692400.123456");
  assert.equal(info.boot_time_seconds, 1779692400 + 123456 / 1e6);
  // 0.5s - 123456us is positive
  assert.ok(info.uptime_seconds > 0 && info.uptime_seconds < 1);
  assert.equal(info.free_disk_bytes, 1_000_000 * 4096);
  assert.equal(info.wall_clock, new Date(fixedNow).toISOString());
  assert.deepEqual(info.live_pids, [100, 200]);
});

test("collect() clamps uptime_seconds at 0 if clock skew makes it negative", () => {
  // Pretend the wall clock is BEFORE boot — should never happen, but the
  // guard is documented and worth pinning.
  const info = collect({
    sysctl: () => SAMPLE_BOOTTIME,
    ps: () => "1\n",
    statfs: () => ({ bavail: 1, bsize: 1 }),
    now: () => 0,
  });
  assert.equal(info.uptime_seconds, 0);
});

test("parseIntervalArg handles ms / s / m suffixes + default", () => {
  assert.equal(parseIntervalArg(undefined), 5000);
  assert.equal(parseIntervalArg("250"), 250);
  assert.equal(parseIntervalArg("250ms"), 250);
  assert.equal(parseIntervalArg("3s"), 3000);
  assert.equal(parseIntervalArg("2m"), 120_000);
  assert.throws(() => parseIntervalArg("forever"));
});

test("writeAtomic produces a 0600 file with the expected JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostinfo-test-"));
  try {
    const target = path.join(dir, "host.json");
    const info: HostInfo = {
      host_boot_id: "1.2",
      boot_time_seconds: 1,
      uptime_seconds: 2,
      free_disk_bytes: 3,
      wall_clock: "2026-05-25T00:00:00.000Z",
      live_pids: [1, 2, 3],
    };
    writeAtomic(target, info);
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(parsed, info);
    // tmp sidecar got cleaned up by rename.
    assert.equal(fs.existsSync(path.join(dir, ".host.json.tmp")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAtomic survives a torn-write stress test (1000 writes vs 1000 reads)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostinfo-torn-"));
  try {
    const target = path.join(dir, "host.json");
    let stopWriter = false;
    let writes = 0;
    const writer = (async () => {
      while (!stopWriter && writes < 1000) {
        writeAtomic(target, {
          host_boot_id: "1.2",
          boot_time_seconds: 1,
          uptime_seconds: writes,
          free_disk_bytes: writes * 1024,
          wall_clock: new Date().toISOString(),
          live_pids: [1, 2, writes],
        });
        writes++;
      }
    })();
    // Spin up readers; each one must produce a parseable JSON object.
    let parseFailures = 0;
    let reads = 0;
    const reader = (async () => {
      while (!stopWriter && reads < 1000) {
        try {
          const text = fs.readFileSync(target, "utf8");
          JSON.parse(text);
        } catch (err) {
          // ENOENT for the first read (writer hasn't ticked yet) is fine.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") parseFailures++;
        }
        reads++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    await writer;
    stopWriter = true;
    await reader;
    assert.equal(parseFailures, 0, `torn reads: ${parseFailures}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end --once writes a parseable host.json under HOME", async () => {
  // Skip on platforms where sysctl/ps aren't available — the helpers
  // throw on non-darwin.
  if (process.platform !== "darwin") return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hostinfo-e2e-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(import.meta.dirname, "observability_hostinfo.ts"),
        "--once",
      ],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home } },
    );
    assert.equal(
      r.status,
      0,
      `ticker --once failed:\nstdout=${r.stdout}\nstderr=${r.stderr}`,
    );
    const target = path.join(
      home,
      ".claude/code-review/observability/hostinfo/host.json",
    );
    const info = JSON.parse(fs.readFileSync(target, "utf8")) as HostInfo;
    assert.ok(info.uptime_seconds > 0);
    assert.match(info.host_boot_id, /^\d+\.\d+$/);
    assert.ok(Array.isArray(info.live_pids));
    assert.ok(info.live_pids.length > 0);
    assert.match(info.wall_clock, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hostInfoFilePath returns the canonical hostinfo path", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hostinfo-path-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Re-import to pick up the new HOME.
    const url = new URL("./observability_hostinfo.ts", import.meta.url);
    const mod = (await import(
      `${url.href}?t=${Date.now()}-${Math.random()}`
    )) as typeof import("./observability_hostinfo.ts");
    const p = mod.hostInfoFilePath();
    assert.ok(
      p.endsWith("observability/hostinfo/host.json"),
      `path was ${p}`,
    );
    // macOS resolves $HOME under /private/tmp via a symlink; os.homedir()
    // honors HOME literally. Match the basename chain instead of the prefix.
    assert.match(p, /\.claude\/code-review\/observability\/hostinfo\/host\.json$/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Reference the imported symbol so the import block stays stable.
void hostInfoFilePath;
