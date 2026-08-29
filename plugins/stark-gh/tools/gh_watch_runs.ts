#!/usr/bin/env node
// Entrypoint for the two watcher modes. All logic lives in ./lib/watcher_*:
//   watcher_legacy.ts   — pr-open CI observer (no --on-green)
//   watcher_merge.ts    — pr-merge driver (--on-green <callback>)
//   watcher_classifier  — pure decision math (grace windows, incident scars)
//   watcher_poll        — rollup fetch + retry-error classification
//   watcher_lock        — per-SHA lock + mirror + liveness
//   watcher_session     — shared acquire/mirror/release setup
//   watcher_state       — state-file + latest.json writers
//
// This file only parses argv, picks the mode, and runs it. The re-exports below
// keep the tool's public symbol surface stable for existing importers/tests.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runLegacyWatch, parseArgs } from "./lib/watcher_legacy.ts";
import { prMergeWatchLoop, parsePrMergeArgs } from "./lib/watcher_merge.ts";

// --- Stable public surface (re-exported from the extracted modules) ---------
export {
  parseArgs,
  type CliArgs,
  runLegacyWatch,
} from "./lib/watcher_legacy.ts";
export {
  parsePrMergeArgs,
  prMergeWatchLoop,
  type PrMergeWatchArgs,
} from "./lib/watcher_merge.ts";
export {
  backoffSchedule,
  isTerminal,
  summarize,
  classifyError,
  jitter,
  pollOnce,
  type CheckRecord,
  type BackoffState,
} from "./lib/watcher_poll.ts";
export {
  type PollOutcome,
  decideHeadMovedTransition,
  HEAD_MOVED_REQUIRED_RECONFIRMS,
  HEAD_MOVED_RECONFIRM_DELAY_SEC,
  decideVacuousTransition,
  NO_REQUIRED_CHECKS_GRACE_SEC,
  decideSkippedTransition,
  SKIPPED_CHECK_GRACE_SEC,
  mergeStateBlocksFiring,
  decideBlockedTransition,
  MERGE_BLOCKED_GRACE_SEC,
  CHECK_REGISTRATION_REFIRE_SEC,
  MAX_CHECK_REFIRES,
  MAX_REFIRE_ATTEMPTS,
  decideRefireTransition,
  applyMergeStateGate,
  evaluateRollup,
} from "./lib/watcher_classifier.ts";
export {
  acquireLock,
  releaseLockIfOwner,
  mirrorLockToLatest,
  releaseMirrorLatestLock,
  type LockFileContent,
} from "./lib/watcher_lock.ts";

// Symlink-safe main-module guard. The naive `argv[1].endsWith(...)` idiom breaks
// when this file is reached through the ~/.claude plugin symlink (Node resolves
// import.meta.url to the real path while argv[1] stays the link), so both sides
// are realpath-resolved before comparing — same fix as tools/main_module_lib.ts,
// inlined here because that helper lives in a sibling package.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // Branch on --on-green: pr-merge mode vs legacy pr-open mode.
  const argv = process.argv.slice(2);
  let prMergeArgs: ReturnType<typeof parsePrMergeArgs> = null;
  try {
    prMergeArgs = parsePrMergeArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  if (prMergeArgs) {
    prMergeWatchLoop(prMergeArgs).then(c => process.exit(c)).catch(e => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
  } else {
    (async () => runLegacyWatch(parseArgs(argv)))().then(c => process.exit(c)).catch(e => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
  }
}
