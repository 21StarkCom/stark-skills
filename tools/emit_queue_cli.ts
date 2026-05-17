#!/usr/bin/env node
/**
 * emit-queue CLI — TS replacement for `python3 scripts/emit_queue.py --health`
 * and the per-tick `record_context_pct` import that statusline-command.sh runs.
 *
 * Subcommands:
 *   --health                         Print queue health stats as JSON, exit 0.
 *                                    Shape matches the Python `_health()` so
 *                                    /stark-session can swap consumers freely.
 *   --init-schema                    Open the queue DB to force schema
 *                                    creation. Used by install.sh in place of
 *                                    the prior `import emit_queue` heredoc.
 *   record-context-pct <pct>         Record a context-window % reading and
 *                                    print the trend indicator (▲ / ▸ / "")
 *                                    on a single line (no trailing newline).
 *   pending-count                    Print queue pending row count, one int.
 *   dead-letter-count                Print dead_letter row count, one int.
 *
 * Both Python (`scripts/emit_queue.py`) and TS implementations write to the
 * same `~/.stark-insights/queue.db` SQLite, so a Python drain still picks up
 * rows enqueued by TS callers and vice versa.
 */

import {
  deadLetterCount,
  enqueue,
  health,
  initSchema,
  makeEvent,
  pendingCount,
  recordContextPct,
} from "./emit_queue_lib.ts";

const USAGE = `\
emit-queue CLI

  emit_queue_cli.ts --health
  emit_queue_cli.ts --init-schema
  emit_queue_cli.ts record-context-pct <pct>
  emit_queue_cli.ts pending-count
  emit_queue_cli.ts dead-letter-count
  emit_queue_cli.ts enqueue --type T --payload JSON \\
                         [--cli C] [--source S] [--session-id ID] \\
                         [--project P] [--user-id U] [--dedupe-key K]
`;

function parseFlags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new Error(`missing required flag: --${key}`);
  return v;
}

function runEnqueue(argv: string[]): number {
  let flags: Map<string, string>;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`enqueue: ${(err as Error).message}\n`);
    return 2;
  }

  let eventType: string;
  let payloadRaw: string;
  try {
    eventType = requireFlag(flags, "type");
    payloadRaw = requireFlag(flags, "payload");
  } catch (err) {
    process.stderr.write(`enqueue: ${(err as Error).message}\n`);
    return 2;
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(payloadRaw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`enqueue: --payload ${(err as Error).message}\n`);
    return 2;
  }

  const event = makeEvent({
    eventType,
    payload,
    cli: flags.get("cli"),
    source: flags.get("source"),
    sessionId: flags.get("session-id"),
    project: flags.get("project"),
    userId: flags.get("user-id"),
    dedupeKey: flags.get("dedupe-key"),
  });
  const result = enqueue(event);
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.ok ? 0 : 1;
}

export function main(argv: string[]): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = argv[0];

  if (cmd === "--health") {
    process.stdout.write(JSON.stringify(health(), null, 2) + "\n");
    return 0;
  }

  if (cmd === "--init-schema") {
    initSchema();
    return 0;
  }

  if (cmd === "record-context-pct") {
    const raw = argv[1];
    if (raw === undefined) {
      process.stderr.write("record-context-pct: missing <pct> argument\n");
      return 2;
    }
    const pct = Number(raw);
    if (!Number.isFinite(pct)) {
      process.stderr.write(`record-context-pct: <pct> must be a finite number, got: ${raw}\n`);
      return 2;
    }
    process.stdout.write(recordContextPct(pct));
    return 0;
  }

  if (cmd === "pending-count") {
    process.stdout.write(String(pendingCount()) + "\n");
    return 0;
  }

  if (cmd === "dead-letter-count") {
    process.stdout.write(String(deadLetterCount()) + "\n");
    return 0;
  }

  if (cmd === "enqueue") {
    return runEnqueue(argv.slice(1));
  }

  process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
