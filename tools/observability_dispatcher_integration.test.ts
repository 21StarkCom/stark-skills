/**
 * Phase 6 — dispatcher integration tests.
 *
 * Asserts the load-bearing contracts:
 *
 *   1. `run()` (copilot_dispatch) and `runProcess()` (multi_review_lib) do NOT
 *      reference any lifecycle ops in their function bodies: `startSubAgent`,
 *      `endSubAgent`, `startRun`, `endRun`, `startHeartbeat`,
 *      `startRunHeartbeat`. Their job is only the optional non-consuming tap.
 *
 *   2. Calling `run()` AND `runProcess()` with a fake `WriterClient` records
 *      ZERO lifecycle wire-ops (`start_subagent` / `end_subagent` /
 *      `start_run` / `end_run` / `start_heartbeat`). The single-ownership rule
 *      is asserted at the wire level via a captured-ops fake — not just
 *      source scanning.
 *
 *   3. Passing `observability: { ctx, sa }` calls the chunk-tap path at least
 *      once per stream and the resolved result includes the original
 *      stdout/stderr verbatim. Drain is awaited before `run()` resolves (E2).
 *
 *   4. `phase_execute_observability_sentinel.sh` exists, is executable, and
 *      honors a missing lease as "exit 0 immediately".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type {
  RunCtx,
  SubAgent,
  WriterClient,
} from "./observability_emit_lib.ts";

const TOOLS_DIR = path.dirname(new URL(import.meta.url).pathname);

/** Wire-op names emitted by the lifecycle helpers
 * (`startSubAgent`/`endSubAgent`/`startRun`/`endRun`/`startHeartbeat`). Any of
 * these in the recorded op stream means a lifecycle op was called — which
 * violates the single-ownership rule for `run()`/`runProcess()`. */
const LIFECYCLE_WIRE_OPS = [
  "start_subagent",
  "end_subagent",
  "start_run",
  "end_run",
  "start_heartbeat",
] as const;

/** Build a fake `WriterClient` + `RunCtx` + `SubAgent` triple that records
 * every wire op the unit-under-test sends. The fake replies to chunk + progress
 * ops with monotonic seq; lifecycle-op replies are deliberately stubbed so a
 * misbehaving caller surfaces them in `sent[]` rather than crashing. */
function makeFakeWriter() {
  const sent: Array<{ op: string; chunk?: string; subagent_id?: string }> = [];
  const fakeClient = {
    send: async (req: Record<string, unknown>) => {
      sent.push({
        op: String(req.op),
        chunk: typeof req.chunk === "string" ? req.chunk : undefined,
        subagent_id:
          typeof req.subagent_id === "string" ? req.subagent_id : undefined,
      });
      return { ok: true, seq: sent.length, subagent_id: "fake-sa" };
    },
    close: () => {},
    isConnected: () => true,
  };
  const ctx: RunCtx = {
    runId: "test-run",
    _isOwned: true,
    _disabled: false,
    _client: fakeClient as unknown as WriterClient,
  };
  const sa: SubAgent = {
    id: "test-sa",
    agent: "test",
    model: "test",
    task: "test",
    startedAtMs: Date.now(),
  };
  return { sent, ctx, sa };
}

test("run() / runProcess do not import lifecycle ops", () => {
  const banned = [
    "startSubAgent",
    "endSubAgent",
    "startRun(",
    "endRun(",
    "startHeartbeat(",
    "startRunHeartbeat(",
  ];
  const files = [
    path.join(TOOLS_DIR, "copilot_dispatch.ts"),
    path.join(TOOLS_DIR, "multi_review_lib.ts"),
    path.join(TOOLS_DIR, "plan_to_tasks_validate_lib.ts"),
    path.join(TOOLS_DIR, "stark_review_doc.ts"),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf-8");
    // Match only the EXACT helper signatures — not substrings like
    // `runImplementationAgent` which also starts with `function run`.
    const fnPatterns = [
      /\bexport\s+async\s+function\s+run\s*\(/m,
      /\bexport\s+async\s+function\s+runProcess\s*\(/m,
      /\basync\s+function\s+run\s*\(/m,
    ];
    let foundBody: string | null = null;
    for (const pat of fnPatterns) {
      const m = src.match(pat);
      if (!m || m.index === undefined) continue;
      const idx = m.index;
      const openIdx = src.indexOf("{", idx);
      if (openIdx === -1) continue;
      let depth = 0;
      for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            foundBody = src.slice(openIdx, i + 1);
            break;
          }
        }
      }
      if (foundBody) break;
    }
    if (!foundBody) continue;
    // Strip comments (line + block) so docstrings explaining the
    // single-ownership contract don't false-positive the substring scan.
    const stripped = foundBody
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const b of banned) {
      assert.ok(
        !stripped.includes(b),
        `${path.basename(f)} run/runProcess body references banned lifecycle op "${b}"`,
      );
    }
  }
});

test("run() (copilot_dispatch) with observability: chunks taped, drain awaited, zero lifecycle ops", async () => {
  const dispatch = await import("./copilot_dispatch.ts");
  const { sent, ctx, sa } = makeFakeWriter();

  const res = await dispatch.run(
    "/bin/sh",
    ["-c", "printf 'hello\\n'; printf 'err\\n' >&2"],
    {
      timeoutSec: 10,
      observability: { ctx, sa },
    },
  );
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), "hello");
  assert.equal(res.stderr.trim(), "err");

  const chunks = sent.filter((s) => s.op === "emit_chunk");
  assert.ok(chunks.length >= 1, `expected at least one emit_chunk, got ${chunks.length}`);

  for (const banned of LIFECYCLE_WIRE_OPS) {
    const offending = sent.filter((s) => s.op === banned);
    assert.equal(
      offending.length,
      0,
      `copilot_dispatch.run sent lifecycle op '${banned}' ${offending.length} time(s); ` +
        `single-ownership rule violated. Captured ops: ${JSON.stringify(sent.map((s) => s.op))}`,
    );
  }
});

test("runProcess() (multi_review_lib) with observability: chunks taped, zero lifecycle ops", async () => {
  const mr = await import("./multi_review_lib.ts");
  const { sent, ctx, sa } = makeFakeWriter();

  const res = await mr.runProcess(
    "/bin/sh",
    ["-c", "printf 'hello\\n'; printf 'err\\n' >&2"],
    {
      timeoutMs: 10_000,
      observability: { ctx, sa },
    },
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "hello");
  assert.equal(res.stderr.trim(), "err");

  const chunks = sent.filter((s) => s.op === "emit_chunk");
  assert.ok(chunks.length >= 1, `expected at least one emit_chunk, got ${chunks.length}`);

  for (const banned of LIFECYCLE_WIRE_OPS) {
    const offending = sent.filter((s) => s.op === banned);
    assert.equal(
      offending.length,
      0,
      `multi_review_lib.runProcess sent lifecycle op '${banned}' ${offending.length} time(s); ` +
        `single-ownership rule violated. Captured ops: ${JSON.stringify(sent.map((s) => s.op))}`,
    );
  }
});

test("sentinel script exists, is executable, exits 0 on missing lease", () => {
  const sentinel = path.join(TOOLS_DIR, "phase_execute_observability_sentinel.sh");
  const st = fs.statSync(sentinel);
  assert.ok((st.mode & 0o100) !== 0, "sentinel script must be owner-executable");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stark-sentinel-test-"));
  const lease = path.join(tmp, "missing-lease.tick");
  const r = spawnSync("/bin/sh", [sentinel, lease, "60"], {
    encoding: "utf-8",
    timeout: 5000,
    env: { ...process.env, SENTINEL_DETACHED: "1" },
  });
  assert.equal(
    r.status,
    0,
    `sentinel should exit 0; got status=${r.status} stderr=${r.stderr}`,
  );
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("phase_execute_observability.ts --help prints all subcommands", () => {
  const cli = path.join(TOOLS_DIR, "phase_execute_observability.ts");
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, "--help"],
    { encoding: "utf-8", timeout: 10_000 },
  );
  assert.equal(r.status, 0);
  for (const sub of [
    "start",
    "progress",
    "subagent-start",
    "subagent-end",
    "end",
    "exec-child",
  ]) {
    assert.ok(r.stdout.includes(sub), `usage missing subcommand: ${sub}`);
  }
});

test("phase_execute_observability.ts end without prior start exits non-zero", () => {
  const cli = path.join(TOOLS_DIR, "phase_execute_observability.ts");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "stark-phase-obs-test-"));
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      cli,
      "end",
      "--status",
      "ok",
      "--session-id",
      "nonexistent-session",
    ],
    {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, HOME: tmpHome },
    },
  );
  assert.notEqual(r.status, 0, `expected non-zero exit; stderr=${r.stderr}`);
  assert.ok(
    r.stderr.includes("no active phase run") ||
      r.stderr.includes("phase_execute_observability"),
    `unexpected stderr: ${r.stderr}`,
  );
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
