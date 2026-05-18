// Tests for `tools/alert_delivery_lib.ts` — port of
// `scripts/alert_delivery.py`. Covers JSONL append, the
// critical-creates-marker rule, the same-second collision counter,
// `acknowledgeAlert` removal, and `checkAlerts` discovery.
//
// Cross-language interop note: the Python `scripts/alert_delivery.py`
// stays in place — `self_healer.py` and `healer_canary.py` still
// import it. Both implementations target the same on-disk marker dir,
// so a critical emitted by either side is visible to both.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acknowledgeAlert,
  alertsPath,
  checkAlerts,
  emitAlert,
  markersDir,
} from "./alert_delivery_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alert-delivery-test-"));
}

// ---------------------------------------------------------------------------
// emitAlert
// ---------------------------------------------------------------------------

test("emitAlert: appends a single JSONL entry with level/source/message/timestamp", () => {
  const base = tmp();
  emitAlert({
    level: "info",
    source: "test-source",
    message: "hello world",
    baseDir: base,
  });
  const text = fs.readFileSync(alertsPath(base), "utf8").trim();
  const entry = JSON.parse(text) as Record<string, unknown>;
  assert.equal(entry.level, "info");
  assert.equal(entry.source, "test-source");
  assert.equal(entry.message, "hello world");
  assert.equal(typeof entry.timestamp, "string");
});

test("emitAlert: critical level creates a marker file", () => {
  const base = tmp();
  emitAlert({
    level: "critical",
    source: "cost_controls",
    message: "hard stop exceeded",
    baseDir: base,
  });
  const markers = fs
    .readdirSync(markersDir(base))
    .filter((n) => n.startsWith("alert-") && n.endsWith(".marker"));
  assert.equal(markers.length, 1);
});

test("emitAlert: warning level does NOT create a marker file", () => {
  const base = tmp();
  emitAlert({
    level: "warning",
    source: "cost_controls",
    message: "approaching budget",
    baseDir: base,
  });
  const markers = fs
    .readdirSync(markersDir(base))
    .filter((n) => n.startsWith("alert-"));
  assert.equal(markers.length, 0);
});

test("emitAlert: info level does NOT create a marker file", () => {
  const base = tmp();
  emitAlert({
    level: "info",
    source: "preflight",
    message: "all checks passed",
    baseDir: base,
  });
  const markers = fs
    .readdirSync(markersDir(base))
    .filter((n) => n.startsWith("alert-"));
  assert.equal(markers.length, 0);
});

test("emitAlert: multiple criticals each get their own marker", () => {
  const base = tmp();
  emitAlert({ level: "critical", source: "src1", message: "msg1", baseDir: base });
  emitAlert({ level: "critical", source: "src2", message: "msg2", baseDir: base });
  const markers = fs
    .readdirSync(markersDir(base))
    .filter((n) => n.startsWith("alert-") && n.endsWith(".marker"));
  assert.equal(markers.length, 2);
});

test("emitAlert: same-second collision uses counter suffix (Python parity)", () => {
  const base = tmp();
  // Pin the clock so both criticals collide on the same unix-second.
  const fixed = 1700000000;
  emitAlert({
    level: "critical",
    source: "src1",
    message: "first",
    baseDir: base,
    now: () => fixed,
  });
  emitAlert({
    level: "critical",
    source: "src2",
    message: "second",
    baseDir: base,
    now: () => fixed,
  });
  const names = new Set(
    fs.readdirSync(markersDir(base)).filter((n) => n.startsWith("alert-")),
  );
  assert.equal(names.size, 2);
  assert.ok(names.has(`alert-${fixed}.marker`));
  assert.ok(names.has(`alert-${fixed}-1.marker`));
});

test("emitAlert: creates the base dir (and JSONL parent) when missing", () => {
  const base = path.join(tmp(), "nested", "deep");
  emitAlert({
    level: "critical",
    source: "src",
    message: "msg",
    baseDir: base,
  });
  assert.ok(fs.existsSync(alertsPath(base)));
  const markers = fs
    .readdirSync(markersDir(base))
    .filter((n) => n.startsWith("alert-"));
  assert.equal(markers.length, 1);
});

test("emitAlert: timestamp is the canonical Z-suffixed ISO 8601 (no millis)", () => {
  const base = tmp();
  emitAlert({
    level: "info",
    source: "x",
    message: "y",
    baseDir: base,
    nowDate: () => new Date("2026-05-18T09:30:15.123Z"),
  });
  const entry = JSON.parse(fs.readFileSync(alertsPath(base), "utf8").trim());
  assert.equal(entry.timestamp, "2026-05-18T09:30:15Z");
});

test("emitAlert: appends — multiple calls all land in one alerts.jsonl", () => {
  const base = tmp();
  emitAlert({ level: "info", source: "a", message: "1", baseDir: base });
  emitAlert({ level: "info", source: "b", message: "2", baseDir: base });
  emitAlert({ level: "info", source: "c", message: "3", baseDir: base });
  const lines = fs
    .readFileSync(alertsPath(base), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).source, "a");
  assert.equal(JSON.parse(lines[1]).source, "b");
  assert.equal(JSON.parse(lines[2]).source, "c");
});

// ---------------------------------------------------------------------------
// checkAlerts
// ---------------------------------------------------------------------------

test("checkAlerts: returns empty unacknowledged list when dir doesn't exist", () => {
  const base = path.join(tmp(), "absent");
  assert.deepEqual(checkAlerts({ baseDir: base }), { unacknowledged: [] });
});

test("checkAlerts: lists existing alert-*.marker files in sorted order", () => {
  const base = tmp();
  fs.mkdirSync(markersDir(base), { recursive: true });
  fs.writeFileSync(path.join(markersDir(base), "alert-100.marker"), "");
  fs.writeFileSync(path.join(markersDir(base), "alert-200.marker"), "");
  fs.writeFileSync(path.join(markersDir(base), "alert-150-1.marker"), "");
  // Decoy: unrelated file in the same dir must not appear.
  fs.writeFileSync(path.join(markersDir(base), "something-else.txt"), "");
  const { unacknowledged } = checkAlerts({ baseDir: base });
  assert.equal(unacknowledged.length, 3);
  const names = unacknowledged.map((u) => path.basename(u.path));
  // Python uses `sorted(glob(...))` — lexicographic.
  assert.deepEqual(names, [
    "alert-100.marker",
    "alert-150-1.marker",
    "alert-200.marker",
  ]);
});

test("checkAlerts: paths returned are absolute (joined with markersDir)", () => {
  const base = tmp();
  fs.mkdirSync(markersDir(base), { recursive: true });
  fs.writeFileSync(path.join(markersDir(base), "alert-1.marker"), "");
  const { unacknowledged } = checkAlerts({ baseDir: base });
  assert.equal(unacknowledged.length, 1);
  assert.ok(path.isAbsolute(unacknowledged[0].path));
  assert.equal(
    unacknowledged[0].path,
    path.join(markersDir(base), "alert-1.marker"),
  );
});

// ---------------------------------------------------------------------------
// acknowledgeAlert
// ---------------------------------------------------------------------------

test("acknowledgeAlert: removes an existing marker file", () => {
  const base = tmp();
  fs.mkdirSync(markersDir(base), { recursive: true });
  const marker = path.join(markersDir(base), "alert-1.marker");
  fs.writeFileSync(marker, "");
  acknowledgeAlert(marker);
  assert.ok(!fs.existsSync(marker));
});

test("acknowledgeAlert: no-op when file is missing (does not throw)", () => {
  const base = tmp();
  // Must not throw — Python uses `if p.exists(): p.unlink()`.
  acknowledgeAlert(path.join(markersDir(base), "alert-does-not-exist.marker"));
});
