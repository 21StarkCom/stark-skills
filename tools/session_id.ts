#!/usr/bin/env node
/**
 * session_id CLI — prints the resolved session ID to stdout.
 *
 * Matches the contract of the deleted `scripts/session_id.py` so
 * `SESSION_ID="${CLAUDE_SESSION_ID:-$(session_id.ts)}"` style shell
 * substitution in SKILL.md keeps working.
 */

import fs from "node:fs";
import { resolveSessionId } from "./session_id_lib.ts";

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
  process.stdout.write(`${resolveSessionId()}\n`);
}
