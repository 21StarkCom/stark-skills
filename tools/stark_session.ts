#!/usr/bin/env node
/**
 * stark-session data collector. Returns structured JSON the /stark-session
 * SKILL.md feeds to Claude for rendering — no ANSI, no box-drawing.
 *
 * Subcommands:
 *   start [--session-id ID] [--start-head SHA] [--started-at ISO]
 *     Gather start-of-session state (git, gh, board, alerts, health, queue,
 *     persona, skills, etc.) and print as JSON.
 *
 *   end   [--session-id ID] [--start-head SHA] [--started-at ISO] [--name N]
 *     Gather end-of-session state (session row, diff vs start_head, branch
 *     state) and print as JSON. The receipt (tests, build, merges, push,
 *     telemetry) is tracked by the SKILL through end-mode dialogue and
 *     rendered by Claude — not collected here.
 *
 * Exit codes:
 *   0  success
 *   1  unrecoverable error (bad flag, fatal exception)
 *
 * Per-subprocess timeout: 15s. Wall-clock budget for `start` is implicit —
 * collectors run in parallel so the slowest single child caps total time.
 */

import { pathToFileURL } from "node:url";

import {
  collectEnd,
  collectStart,
  realDeps,
  type Deps,
} from "./stark_session_lib.ts";

const USAGE = `\
stark-session CLI

  stark_session.ts start [--session-id ID] [--start-head SHA] [--started-at ISO]
  stark_session.ts end   [--session-id ID] [--start-head SHA] [--started-at ISO]
                         [--name NAME]
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

export async function runStart(rest: string[], deps?: Deps): Promise<number> {
  const flags = parseFlags(rest);
  const result = await collectStart(deps ?? realDeps(), {
    session_id: flags.get("session-id") ?? "",
    start_head: flags.get("start-head") ?? null,
    started_at: flags.get("started-at") ?? "",
  });
  process.stdout.write(JSON.stringify(result, null, 2));
  return 0;
}

export async function runEnd(rest: string[], deps?: Deps): Promise<number> {
  const flags = parseFlags(rest);
  const result = await collectEnd(deps ?? realDeps(), {
    session_id: flags.get("session-id") ?? "",
    start_head: flags.get("start-head") ?? null,
    started_at: flags.get("started-at") ?? "",
    name: flags.get("name") ?? null,
  });
  process.stdout.write(JSON.stringify(result, null, 2));
  return 0;
}

export async function main(argv: string[], deps?: Deps): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  try {
    if (sub === "start") return await runStart(rest, deps);
    if (sub === "end") return await runEnd(rest, deps);
    process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
    return 1;
  } catch (e) {
    process.stderr.write(`stark_session: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
