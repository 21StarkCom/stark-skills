// Smoke tests for `tools/emit_queue_cli.ts`. Each test runs the CLI in a
// subprocess against a fresh STARK_QUEUE_DIR so the wire shape (stdout,
// exit code) stays in lockstep with the Python `--health` consumer
// (`/stark-session`) and the statusline-command.sh consumer.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "emit_queue_cli.ts");

function freshQueueDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "emit-queue-cli-"));
}

function runCli(args: string[], queueDir: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", CLI, ...args],
    {
      env: { ...process.env, STARK_QUEUE_DIR: queueDir },
      encoding: "utf8",
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

test("--help prints usage on stdout and exits 0", () => {
  const r = runCli(["--help"], freshQueueDir());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /emit-queue CLI/);
  assert.match(r.stdout, /--health/);
  assert.match(r.stdout, /record-context-pct/);
});

test("--health on a fresh DB prints {pending_count:0, max_created_at:null}", () => {
  const r = runCli(["--health"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.pending_count, 0);
  assert.equal(parsed.max_created_at, null);
});

test("--init-schema creates the queue.db file", () => {
  const dir = freshQueueDir();
  const r = runCli(["--init-schema"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, "queue.db")), true);
});

test("pending-count on fresh DB prints 0", () => {
  const r = runCli(["pending-count"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0");
});

test("dead-letter-count on fresh DB prints 0", () => {
  const r = runCli(["dead-letter-count"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0");
});

test("record-context-pct: first reading prints empty string trend", () => {
  const r = runCli(["record-context-pct", "12.5"], freshQueueDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, ""); // no trailing newline by design
});

test("record-context-pct: ≥5pp jump prints ▲", () => {
  const dir = freshQueueDir();
  runCli(["record-context-pct", "10"], dir);
  const r = runCli(["record-context-pct", "20"], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "▲");
});

test("record-context-pct: missing argument exits 2 with usage hint", () => {
  const r = runCli(["record-context-pct"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing <pct>/);
});

test("record-context-pct: non-numeric argument exits 2 with usage hint", () => {
  const r = runCli(["record-context-pct", "abc"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be a finite number/);
});

test("unknown command exits 2 and prints usage", () => {
  const r = runCli(["nope"], freshQueueDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
  assert.match(r.stderr, /--health/);
});

// ---------------------------------------------------------------------------
// enqueue (used by Python consumers in Phase 3)
// ---------------------------------------------------------------------------

test("enqueue: minimum flags persists an event and prints JSON result", () => {
  const dir = freshQueueDir();
  const r = runCli(
    ["enqueue", "--type", "skill_invocation", "--payload", '{"skill":"x"}'],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.ok(result.event_id);
  assert.ok(result.dedupe_key);
});

test("enqueue: duplicate dedupe_key returns ok:true, duplicate:true", () => {
  const dir = freshQueueDir();
  const args = [
    "enqueue",
    "--type", "skill_invocation",
    "--payload", '{"skill":"x"}',
    "--dedupe-key", "the-same",
  ];
  runCli(args, dir);
  const r = runCli(args, dir);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.duplicate, true);
});

test("enqueue: missing --type exits 2 with a clear error", () => {
  const r = runCli(
    ["enqueue", "--payload", '{"x":1}'],
    freshQueueDir(),
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing required flag: --type/);
});

test("enqueue: --payload that isn't valid JSON exits 2", () => {
  const r = runCli(
    ["enqueue", "--type", "skill_invocation", "--payload", "not json"],
    freshQueueDir(),
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--payload/);
});

test("enqueue: --payload that's a JSON array (not object) exits 2", () => {
  const r = runCli(
    ["enqueue", "--type", "skill_invocation", "--payload", "[1,2,3]"],
    freshQueueDir(),
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /JSON object/);
});

test("enqueue: invalid event type exits 1 with ok:false in JSON", () => {
  const r = runCli(
    ["enqueue", "--type", "bogus", "--payload", "{}"],
    freshQueueDir(),
  );
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid type/);
});

test("enqueue: ADR-0014 skill dedupe formula matches Python", () => {
  // python> make_event("skill_invocation", {"skill":"s", "start_timestamp":1700000000},
  //                    session_id="sid", source="skill")["dedupe_key"]
  // == "s:sid:1700000000"
  const dir = freshQueueDir();
  const r = runCli(
    [
      "enqueue",
      "--type", "skill_invocation",
      "--payload", JSON.stringify({ skill: "s", start_timestamp: 1700000000 }),
      "--session-id", "sid",
      "--source", "skill",
    ],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dedupe_key, "s:sid:1700000000");
});
