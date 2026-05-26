#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 8 Task 4 — live-run metadata writer.
 *
 * Writes `~/.claude/code-review/observability/test/live-run.json` at the
 * moment a dispatcher starts so the destructive tests resolve
 * dispatcher_pid / writer_pid / run_id from the harness's own bookkeeping
 * rather than from `pgrep`/`tail`. The plan calls this out as the only
 * safe way to target a specific live run: `pgrep` can match an older
 * dispatcher; `tail` can land on a lexicographically-last run dir from
 * a previous test.
 *
 * Usage from a dispatcher wrapper:
 *
 *   node --experimental-strip-types tools/observability_server/test/live/live_run_metadata.ts \
 *        --run-id "$RUN_ID" \
 *        --dispatcher-pid $$ \
 *        --writer-pid "$WRITER_PID"
 *
 * `writer-pid` is read from `~/.claude/code-review/observability/runs/<run>/writer.pid`
 * once the daemon's handshake completes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Args {
  runId: string;
  dispatcherPid: number;
  writerPid: number | null;
  sentinelPid: number | null;
  outPath: string;
}

function parse(argv: string[]): Args {
  const out: Args = {
    runId: "",
    dispatcherPid: 0,
    writerPid: null,
    sentinelPid: null,
    outPath: path.join(
      os.homedir(),
      ".claude",
      "code-review",
      "observability",
      "test",
      "live-run.json",
    ),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") out.runId = argv[++i] ?? "";
    else if (a === "--dispatcher-pid") out.dispatcherPid = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a === "--writer-pid") {
      const v = argv[++i] ?? "";
      out.writerPid = v.length > 0 ? Number.parseInt(v, 10) : null;
    } else if (a === "--sentinel-pid") {
      const v = argv[++i] ?? "";
      out.sentinelPid = v.length > 0 ? Number.parseInt(v, 10) : null;
    } else if (a === "--out") out.outPath = argv[++i] ?? out.outPath;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId) throw new Error("--run-id required");
  if (out.dispatcherPid <= 0) throw new Error("--dispatcher-pid required");
  return out;
}

const USAGE = `Usage: live_run_metadata.ts --run-id ID --dispatcher-pid N
                              [--writer-pid N] [--sentinel-pid N] [--out PATH]
`;

function main(): void {
  const args = parse(process.argv.slice(2));
  fs.mkdirSync(path.dirname(args.outPath), { recursive: true, mode: 0o700 });
  const tmp = args.outPath + ".tmp";
  const body = {
    harness_started_at: new Date().toISOString(),
    run_id: args.runId,
    dispatcher_pid: args.dispatcherPid,
    writer_pid: args.writerPid,
    sentinel_pid: args.sentinelPid,
  };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, args.outPath);
  process.stdout.write(`${args.outPath}\n`);
}

const isEntry =
  import.meta.url ===
  (process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : "");
if (isEntry) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`live_run_metadata: ${(err as Error).message}\n`);
    process.exit(2);
  }
}
