// Legacy pr-open watcher mode: a CI OBSERVER. Polls `gh pr checks`, reports the
// rollup to the state file, notifies on terminal, and exits. It does NOT drive a
// merge — pr-merge preflight pre-empts it (kind "ci-observer"). Triggered when
// --on-green is absent.
import { atomicWriteJson } from "./watcher_paths.ts";
import * as ghLib from "./gh.ts";
import { startSession } from "./watcher_session.ts";
import { updateState, writeLatestPointer } from "./watcher_state.ts";
import {
  backoffSchedule,
  isTerminal,
  summarize,
  type CheckRecord,
} from "./watcher_poll.ts";
import { notifyDone } from "./watcher_notify.ts";

export interface CliArgs {
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

export function parseArgs(argv: string[]): CliArgs {
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

// Runs the observer loop to completion. Returns the process exit code.
export async function runLegacyWatch(args: CliArgs): Promise<number> {
  const session = startSession({
    host: args.host,
    owner: args.owner,
    repo: args.repo,
    pr: args.pr,
    headSha: args.headSha,
    kind: "ci-observer",
  });
  if (session === null) {
    process.stderr.write(`watcher already running for PR #${args.pr} @ ${args.headSha}\n`);
    return 0;
  }
  const { sf, releaseAll } = session;

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
      updateState(sf, { status: "timeout", finishedAt: new Date().toISOString() });
      writeLatestPointer(args.host, args.owner, args.repo, args.pr, { headSha: args.headSha, status: "timeout" });
      releaseAll();
      return 0;
    }

    let checks: CheckRecord[] = [];
    let pollError: Error | null = null;
    try {
      const currentHead = ghLib.prHeadOid(args.pr, args.owner, args.repo);
      if (currentHead !== args.headSha) {
        updateState(sf, {
          status: "superseded",
          supersededBy: currentHead,
          finishedAt: new Date().toISOString(),
        });
        // Do not touch latest.json: the newer watcher (or its caller) owns
        // that pointer for currentHead. Overwriting from here would clobber
        // a fresher status with our terminal "superseded" record.
        releaseAll();
        return 0;
      }
      const raw = ghLib.prChecks(args.pr, args.owner, args.repo) as CheckRecord[];
      checks = raw;
      consecErrors = 0;
    } catch (e) {
      pollError = e as Error;
    }
    if (pollError !== null) {
      consecErrors++;
      if (consecErrors >= 5) {
        updateState(sf, {
          status: "error",
          lastError: String(pollError.message),
          finishedAt: new Date().toISOString(),
        });
        releaseAll();
        return 1;
      }
    }

    if (checks.length > 0) firstSeenAt ??= Date.now();
    if (firstSeenAt === null && elapsedMin > args.noChecksGraceMinutes) {
      updateState(sf, { status: "no-checks-observed", finishedAt: new Date().toISOString() });
      writeLatestPointer(args.host, args.owner, args.repo, args.pr, { headSha: args.headSha, status: "no-checks-observed" });
      releaseAll();
      return 0;
    }

    if (isTerminal(checks)) {
      const sum = summarize(checks);
      updateState(sf, {
        status: "done",
        finishedAt: new Date().toISOString(),
        checks,
        summary: sum,
      });
      writeLatestPointer(args.host, args.owner, args.repo, args.pr, { headSha: args.headSha, status: "done" });
      notifyDone(sum, args.pr);
      releaseAll();
      return 0;
    }

    const sleepSec = sched.next().value as number;
    updateState(sf, {
      lastPolledAt: new Date().toISOString(),
      nextPollAt: new Date(Date.now() + sleepSec * 1000).toISOString(),
      checks,
    });
    await new Promise(r => setTimeout(r, sleepSec * 1000));
  }
}
