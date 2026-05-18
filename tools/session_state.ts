#!/usr/bin/env node
/**
 * session_state CLI — TypeScript port of `scripts/session_state.py`.
 *
 * Surface:
 *
 *   session_state.ts [--session-id ID] [--json]
 *     Show the current (or named) session. JSON shape is
 *     byte-compatible with the Python `asdict(SessionState)` output:
 *     `session_id`, `started_at`, `branch`, `repo`, `tasks_completed`,
 *     `last_checkpoint`, `context`, `name`, `start_head`. Consumed by
 *     `tools/stark_session_lib.ts:collectSessionState`.
 *
 *   session_state.ts set --field <name|start_head|last_checkpoint> \
 *                        --value VAL [--session-id ID]
 *     Replaces the SKILL.md `python3 -c "from session_state import …"`
 *     inline snippets. Creates a fresh state file (seeded from git) if
 *     none exists for the resolved session id.
 */

import fs from "node:fs";
import {
  type SessionState,
  defaultSessionsDir,
  getCurrent,
  loadState,
  setField,
  type SetFieldName,
} from "./session_state_lib.ts";

// ---------------------------------------------------------------------------
// Tiny argv parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function renderText(ss: SessionState): string {
  const lines: string[] = [];
  lines.push(`Session ID:      ${ss.session_id}`);
  lines.push(`Started at:      ${ss.started_at}`);
  lines.push(`Branch:          ${ss.branch}`);
  lines.push(`Repo:            ${ss.repo}`);
  lines.push(`Tasks completed: ${ss.tasks_completed.length}`);
  for (const t of ss.tasks_completed) lines.push(`  - ${t}`);
  lines.push(`Last checkpoint: ${ss.last_checkpoint ?? "(none)"}`);
  const ctxKeys = Object.keys(ss.context);
  if (ctxKeys.length > 0) {
    lines.push("Context:");
    for (const k of ctxKeys) lines.push(`  ${k}: ${String(ss.context[k])}`);
  }
  return lines.join("\n");
}

function cmdShow(args: ParsedArgs): number {
  const sessionId = flagString(args, "session-id");
  const asJson = flagBool(args, "json");

  let ss: SessionState | null;
  if (sessionId) {
    ss = loadState(sessionId);
    if (ss === null) {
      process.stderr.write(`Session not found: ${sessionId}\n`);
      return 1;
    }
  } else {
    ss = getCurrent();
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(ss, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(ss)}\n`);
  }
  return 0;
}

const VALID_SET_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "start_head",
  "last_checkpoint",
]);

function cmdSet(args: ParsedArgs): number {
  const field = flagString(args, "field");
  const value = flagString(args, "value");
  const sessionId = flagString(args, "session-id");
  if (!field || !value) {
    process.stderr.write("Error: --field and --value are required\n");
    return 2;
  }
  if (!VALID_SET_FIELDS.has(field)) {
    process.stderr.write(
      `Error: --field must be one of: ${[...VALID_SET_FIELDS].join(", ")}\n`,
    );
    return 2;
  }
  const sid = sessionId ?? getCurrent().session_id;
  setField({ sessionId: sid, field: field as SetFieldName, value });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  // Subcommand form: `session_state.ts set --field … --value …`
  if (argv[0] === "set") {
    return cmdSet(parseArgs(argv.slice(1)));
  }
  // Default form (no subcommand): same surface as Python.
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(
      "usage: session_state.ts [--session-id ID] [--json]\n" +
        "       session_state.ts set --field <name|start_head|last_checkpoint> --value VAL [--session-id ID]\n",
    );
    return 0;
  }
  return cmdShow(parseArgs(argv));
}

void defaultSessionsDir;

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const realArgv = fs.realpathSync(argv1);
    const realModule = fs.realpathSync(new URL(import.meta.url).pathname);
    return realArgv === realModule;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`session_state: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
