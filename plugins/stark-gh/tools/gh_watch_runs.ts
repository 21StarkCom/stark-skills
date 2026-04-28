#!/usr/bin/env node
import * as fs from "node:fs";
import * as crypto from "node:crypto";

export interface LockFileContent {
  pid: number;
  startedAt: string;
  headSha: string;
  command: "gh-watch-runs";
  ownerToken: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(
  filepath: string,
  args: { headSha: string },
): { acquired: boolean; alreadyRunning?: boolean; ownerToken?: string } {
  if (fs.existsSync(filepath)) {
    try {
      const c: LockFileContent = JSON.parse(fs.readFileSync(filepath, "utf8"));
      if (c.command === "gh-watch-runs" && c.headSha === args.headSha && pidAlive(c.pid)) {
        return { acquired: false, alreadyRunning: true };
      }
    } catch {
      // Malformed lock is stale.
    }
    fs.unlinkSync(filepath);
  }
  const ownerToken = crypto.randomUUID();
  const content: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    headSha: args.headSha,
    command: "gh-watch-runs",
    ownerToken,
  };
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
  fs.renameSync(tmp, filepath);
  return { acquired: true, ownerToken };
}

export function releaseLockIfOwner(filepath: string, ownerToken: string): void {
  if (!fs.existsSync(filepath)) return;
  try {
    const c: LockFileContent = JSON.parse(fs.readFileSync(filepath, "utf8"));
    if (c.ownerToken === ownerToken) fs.unlinkSync(filepath);
  } catch {
    // Leave malformed lock for the next acquisition path.
  }
}
