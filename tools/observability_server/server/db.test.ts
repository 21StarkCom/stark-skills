// Pure-loader tests for `db.ts`. The runMigrations function itself
// requires better-sqlite3 (a native module). Validating it runtime-wise
// happens via `docker compose up` on a fresh volume — see plan §1
// verification commands. Here we only pin the file-discovery behavior so
// the runner picks up files in the expected order with the expected
// versions.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMigrations } from "./migrations_loader.ts";

function withTmpDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-db-test-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadMigrations returns [] for a missing dir", () => {
  assert.deepEqual(loadMigrations("/nonexistent/path/abcxyz"), []);
});

test("loadMigrations returns [] for an empty dir", () => {
  withTmpDir((dir) => {
    assert.deepEqual(loadMigrations(dir), []);
  });
});

test("loadMigrations parses NNN_name.sql and sorts lexicographically", () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, "002_alpha.sql"), "-- two");
    fs.writeFileSync(path.join(dir, "001_init.sql"), "-- one");
    fs.writeFileSync(path.join(dir, "010_z.sql"), "-- ten");
    const got = loadMigrations(dir);
    assert.deepEqual(
      got.map((m) => m.fileName),
      ["001_init.sql", "002_alpha.sql", "010_z.sql"],
    );
    assert.deepEqual(
      got.map((m) => m.version),
      [1, 2, 10],
    );
    assert.deepEqual(
      got.map((m) => m.sql),
      ["-- one", "-- two", "-- ten"],
    );
  });
});

test("loadMigrations skips files that don't match NNN_name.sql", () => {
  withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, "001_init.sql"), "-- one");
    // Garbage that should NOT be picked up.
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    fs.writeFileSync(path.join(dir, "abc.sql"), "x");
    fs.writeFileSync(path.join(dir, "1_short.sql"), "x"); // <— short on purpose
    fs.writeFileSync(path.join(dir, "001-dashed.sql"), "x");
    const got = loadMigrations(dir);
    assert.deepEqual(
      got.map((m) => m.fileName),
      ["001_init.sql", "1_short.sql"],
    );
  });
});

test("the real 001_init.sql is discoverable from the project tree", () => {
  // import.meta.dirname → tools/observability_server/server
  const migrationsDir = path.resolve(import.meta.dirname, "..", "migrations");
  const got = loadMigrations(migrationsDir);
  assert.ok(got.length >= 1, "expected at least one migration");
  assert.equal(got[0].fileName, "001_init.sql");
  assert.equal(got[0].version, 1);
  // Spot-check the schema mentions the post-amendment tables (RT3 + RT2)
  // so a future edit can't accidentally regress the columns.
  assert.match(got[0].sql, /CREATE TABLE IF NOT EXISTS synthetic_events/);
  assert.match(got[0].sql, /rewrite_txn_id/);
  assert.match(got[0].sql, /writer_daemon_pid/);
  assert.match(got[0].sql, /event_offsets/);
  assert.match(got[0].sql, /chunk_truncations/);
});
