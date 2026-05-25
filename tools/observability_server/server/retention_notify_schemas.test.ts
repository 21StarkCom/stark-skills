// Schema tests for the retention-notify body. These tests guard the
// plan's "Schema rejection test" in Phase 3 verification: a pre-rename
// body smuggling `new_mtime_ns`, or an update-mtime body smuggling
// `truncated[]`, MUST be rejected — those are the two confusions a
// crashed-mid-flow CLI could replay with.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  abortRewriteBodySchema,
  preRenameBodySchema,
  retentionNotifyBodySchema,
  updateMtimeBodySchema,
} from "./retention_notify_schemas.ts";

const TXN_ID = "txn-2026-05-25T10:00:00.000Z-abc";

const goodPre = {
  action: "pre-rename" as const,
  run_id: "run-abc",
  rotation_index: 0,
  file_path: "/spool/runs/run-abc/events-0000.jsonl",
  new_size_bytes: 1024,
  truncated: [
    { seq: 5, subagent_id: "run-abc:1", stream: "stdout" as const, bytes_dropped: 100 },
  ],
  rewrite_txn_id: TXN_ID,
};

const goodUpdate = {
  action: "update-mtime" as const,
  run_id: "run-abc",
  rotation_index: 0,
  file_path: "/spool/runs/run-abc/events-0000.jsonl",
  // Real mtime_ns values exceed Number.MAX_SAFE_INTEGER; the schema
  // accepts any non-negative integer Number, but tests use a small
  // value so TS doesn't flag the literal as imprecise.
  new_mtime_ns: 1_234_567_890_000,
  rewrite_txn_id: TXN_ID,
};

const goodAbort = {
  action: "abort-rewrite" as const,
  run_id: "run-abc",
  rotation_index: 0,
  rewrite_txn_id: TXN_ID,
};

test("pre-rename happy path validates", () => {
  assert.equal(preRenameBodySchema.safeParse(goodPre).success, true);
  assert.equal(retentionNotifyBodySchema.safeParse(goodPre).success, true);
});

test("pre-rename rejects new_mtime_ns smuggled at top level", () => {
  const bad = { ...goodPre, new_mtime_ns: 1 };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
  assert.equal(retentionNotifyBodySchema.safeParse(bad).success, false);
});

test("pre-rename rejects empty truncated array", () => {
  const bad = { ...goodPre, truncated: [] as { seq: number; subagent_id: string; stream: "stdout"; bytes_dropped: number }[] };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});

test("pre-rename rejects truncated entry missing bytes_dropped", () => {
  const bad = {
    ...goodPre,
    truncated: [{ seq: 5, subagent_id: "run-abc:1", stream: "stdout" as const }],
  };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});

test("pre-rename rejects bad stream value", () => {
  const bad = {
    ...goodPre,
    truncated: [
      { seq: 5, subagent_id: "run-abc:1", stream: "stdouts", bytes_dropped: 1 },
    ],
  };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});

test("pre-rename rejects file_path outside /spool/runs", () => {
  const bad = { ...goodPre, file_path: "/etc/passwd" };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});

test("update-mtime happy path validates", () => {
  assert.equal(updateMtimeBodySchema.safeParse(goodUpdate).success, true);
  assert.equal(retentionNotifyBodySchema.safeParse(goodUpdate).success, true);
});

test("update-mtime rejects truncated[] smuggled at top level", () => {
  const bad = {
    ...goodUpdate,
    truncated: [
      { seq: 5, subagent_id: "run-abc:1", stream: "stdout", bytes_dropped: 1 },
    ],
  };
  assert.equal(updateMtimeBodySchema.safeParse(bad).success, false);
  assert.equal(retentionNotifyBodySchema.safeParse(bad).success, false);
});

test("update-mtime rejects new_size_bytes smuggled at top level", () => {
  const bad = { ...goodUpdate, new_size_bytes: 1 };
  assert.equal(updateMtimeBodySchema.safeParse(bad).success, false);
});

test("update-mtime requires new_mtime_ns", () => {
  const bad: Record<string, unknown> = { ...goodUpdate };
  delete bad.new_mtime_ns;
  assert.equal(updateMtimeBodySchema.safeParse(bad).success, false);
});

test("abort-rewrite happy path validates", () => {
  assert.equal(abortRewriteBodySchema.safeParse(goodAbort).success, true);
  assert.equal(retentionNotifyBodySchema.safeParse(goodAbort).success, true);
});

test("abort-rewrite rejects extra fields", () => {
  const bad = { ...goodAbort, new_mtime_ns: 1 };
  assert.equal(abortRewriteBodySchema.safeParse(bad).success, false);
});

test("unknown action discriminator rejected by the union", () => {
  const bad = { action: "delete-everything", run_id: "x", rotation_index: 0 };
  assert.equal(retentionNotifyBodySchema.safeParse(bad).success, false);
});

// RT2: every notify POST MUST carry an opaque rewrite_txn_id so the
// server can correlate retries to the same attempt and the startup
// recovery sweep can match SQLite state against the on-disk file.
test("pre-rename requires rewrite_txn_id", () => {
  const bad: Record<string, unknown> = { ...goodPre };
  delete bad.rewrite_txn_id;
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});

test("update-mtime requires rewrite_txn_id", () => {
  const bad: Record<string, unknown> = { ...goodUpdate };
  delete bad.rewrite_txn_id;
  assert.equal(updateMtimeBodySchema.safeParse(bad).success, false);
});

test("abort-rewrite requires rewrite_txn_id", () => {
  const bad: Record<string, unknown> = { ...goodAbort };
  delete bad.rewrite_txn_id;
  assert.equal(abortRewriteBodySchema.safeParse(bad).success, false);
});

test("rewrite_txn_id with disallowed characters is rejected", () => {
  const bad = { ...goodPre, rewrite_txn_id: "txn id with spaces" };
  assert.equal(preRenameBodySchema.safeParse(bad).success, false);
});
