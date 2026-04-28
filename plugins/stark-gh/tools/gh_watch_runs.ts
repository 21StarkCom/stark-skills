#!/usr/bin/env node
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { stateFile, lockFile, latestPointer, ensurePrDir, atomicWriteJson } from "./lib/watcher_paths.ts";
import * as ghLib from "./lib/gh.ts";

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

export function* backoffSchedule(initial: number, cap: number): Generator<number> {
  for (let i = 0; i < 5; i++) yield initial;
  let cur = initial * 2;
  while (true) {
    yield cur;
    cur = Math.min(cur * 2, cap);
    if (cur === cap) break;
  }
  while (true) yield cap;
}

interface CheckSuite {
  check_runs?: { status: string; conclusion: string | null }[];
}

export function isTerminal(suites: CheckSuite[]): boolean {
  if (suites.length === 0) return false;
  const all = suites.flatMap(s => s.check_runs ?? []);
  if (all.length === 0) return false;
  return all.every(r => r.status === "completed" && r.conclusion !== null);
}

export function summarize(suites: CheckSuite[]) {
  const all = suites.flatMap(s => s.check_runs ?? []);
  const counts = { total: all.length, success: 0, failure: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const r of all) {
    if (r.conclusion === "success") counts.success++;
    else if (r.conclusion === "failure") counts.failure++;
    else if (r.conclusion === "cancelled") counts.cancelled++;
    else if (r.conclusion === "skipped") counts.skipped++;
    else if (r.conclusion === "neutral") counts.neutral++;
  }
  return counts;
}

interface CliArgs {
  host: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  maxMinutes: number;
  initialPollSeconds: number;
  maxPollSeconds: number;
  noChecksGraceMinutes: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string, def?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0) {
      if (def !== undefined) return def;
      throw new Error(`missing ${flag}`);
    }
    return argv[i + 1]!;
  };
  const repo = get("--repo");
  const [owner, repoName] = repo.split("/");
  return {
    host: get("--host"),
    owner: owner!,
    repo: repoName!,
    pr: Number(get("--pr")),
    headSha: get("--head-sha"),
    maxMinutes: Number(get("--max-minutes", "30")),
    initialPollSeconds: Number(get("--initial-poll-seconds", "15")),
    maxPollSeconds: Number(get("--max-poll-seconds", "240")),
    noChecksGraceMinutes: Number(get("--no-checks-grace-minutes", "5")),
  };
}

function notifyDone(summary: ReturnType<typeof summarize>, pr: number): void {
  try {
    const msg = `PR #${pr}: ${summary.success} success, ${summary.failure} failure, ${summary.cancelled} cancelled`;
    execFileSync("osascript", ["-e", `display notification "${msg.replace(/"/g, "")}" with title "stark-gh"`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best effort only.
  }
}

async function mainAsync(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensurePrDir(args.host, args.owner, args.repo, args.pr);

  const sf = stateFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lf = lockFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lock = acquireLock(lf, { headSha: args.headSha });
  if (lock.alreadyRunning) {
    process.stderr.write(`watcher already running for PR #${args.pr} @ ${args.headSha}\n`);
    process.exit(0);
  }
  const ownerToken = lock.ownerToken!;

  atomicWriteJson(sf, {
    schemaVersion: 1,
    command: "gh-watch-runs",
    host: args.host,
    repo: `${args.owner}/${args.repo}`,
    pr: args.pr,
    headSha: args.headSha,
    status: "watching",
    startedAt: new Date().toISOString(),
    lastPolledAt: null,
    nextPollAt: new Date().toISOString(),
    lastError: null,
    checks: [],
    summary: null,
  });

  const start = Date.now();
  const sched = backoffSchedule(args.initialPollSeconds, args.maxPollSeconds);
  let consecErrors = 0;
  let firstSeenAt: number | null = null;

  while (true) {
    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin > args.maxMinutes) {
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, { ...cur, status: "timeout", finishedAt: new Date().toISOString() });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "timeout",
        updatedAt: new Date().toISOString(),
      });
      releaseLockIfOwner(lf, ownerToken);
      process.exit(0);
    }

    let suites: unknown[] = [];
    try {
      suites = ghLib.checkSuites(args.host, args.owner, args.repo, args.headSha);
      consecErrors = 0;
    } catch (e) {
      consecErrors++;
      if (consecErrors >= 5) {
        const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
        atomicWriteJson(sf, {
          ...cur,
          status: "error",
          lastError: String((e as Error).message),
          finishedAt: new Date().toISOString(),
        });
        releaseLockIfOwner(lf, ownerToken);
        process.exit(1);
      }
    }

    if (suites.length > 0) firstSeenAt ??= Date.now();
    if (firstSeenAt === null && elapsedMin > args.noChecksGraceMinutes) {
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, { ...cur, status: "no-checks-observed", finishedAt: new Date().toISOString() });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "no-checks-observed",
        updatedAt: new Date().toISOString(),
      });
      releaseLockIfOwner(lf, ownerToken);
      process.exit(0);
    }

    if (isTerminal(suites as CheckSuite[])) {
      const sum = summarize(suites as CheckSuite[]);
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, {
        ...cur,
        status: "done",
        finishedAt: new Date().toISOString(),
        checks: suites,
        summary: sum,
      });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "done",
        updatedAt: new Date().toISOString(),
      });
      notifyDone(sum, args.pr);
      releaseLockIfOwner(lf, ownerToken);
      process.exit(0);
    }

    const sleepSec = sched.next().value as number;
    const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
    atomicWriteJson(sf, {
      ...cur,
      lastPolledAt: new Date().toISOString(),
      nextPollAt: new Date(Date.now() + sleepSec * 1000).toISOString(),
      checks: suites,
    });
    await new Promise(r => setTimeout(r, sleepSec * 1000));
  }
}

if (process.argv[1]?.endsWith("gh_watch_runs.ts")) {
  mainAsync().catch(e => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}
