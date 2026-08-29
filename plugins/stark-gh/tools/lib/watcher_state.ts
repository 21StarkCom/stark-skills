// Watcher state-file I/O. Both loops write their per-poll status the same way —
// read the current JSON, merge new fields, atomically rewrite — plus the
// terminal `latest.json` pointer that pr-merge preflight and the operator read.
// This module is the single owner of that read→spread→write dance, which was
// hand-inlined ~15× across the two loops.
import * as fs from "node:fs";
import { atomicWriteJson, latestPointer } from "./watcher_paths.ts";

// Read the current state JSON, tolerating an absent or malformed file (returns
// {} so a merge write still succeeds — a torn write on a prior poll must not
// wedge the watcher).
export function readState(sf: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(sf, "utf8"));
  } catch {
    return {};
  }
}

// Merge `extras` over the current state and rewrite atomically.
export function updateState(sf: string, extras: Record<string, unknown>): void {
  atomicWriteJson(sf, { ...readState(sf), ...extras });
}

// Write the SHA-independent `latest.json` pointer that survives after the
// per-SHA state file (the operator- and preflight-facing terminal status).
export function writeLatestPointer(
  host: string,
  owner: string,
  repo: string,
  pr: number,
  fields: { headSha: string; status: string },
): void {
  atomicWriteJson(latestPointer(host, owner, repo, pr), {
    headSha: fields.headSha,
    status: fields.status,
    updatedAt: new Date().toISOString(),
  });
}
