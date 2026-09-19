#!/usr/bin/env node
/**
 * session_id CLI — prints the resolved session ID to stdout.
 *
 * Matches the contract of the deleted `scripts/session_id.py` so
 * `SESSION_ID="${CLAUDE_SESSION_ID:-$(session_id.ts)}"` style shell
 * substitution in SKILL.md keeps working.
 */

import { resolveSessionId } from "./session_id_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${resolveSessionId()}\n`);
}
