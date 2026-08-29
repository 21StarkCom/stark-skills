// Shared watcher setup/teardown, identical for both modes: acquire the per-SHA
// lock, mirror it to the per-PR pointer so pr-merge preflight can find us, and
// hand back a combined release closure. The only per-mode differences are the
// head SHA, the watcher kind, and the initial state object (which each loop
// writes itself, since their state shapes differ).
import { ensurePrDir, stateFile, lockFile, latestPointer } from "./watcher_paths.ts";
import {
  acquireLock,
  mirrorLockToLatest,
  releaseLockIfOwner,
  releaseMirrorLatestLock,
  type WatcherKind,
} from "./watcher_lock.ts";

export interface WatchSession {
  sf: string;
  ownerToken: string;
  // Release the per-SHA lock and the mirror pointer together. Call at every
  // exit point.
  releaseAll(): void;
}

// Returns the session, or null if a live watcher already holds this head's
// lock (the caller should log and stop).
export function startSession(args: {
  host: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  kind: Exclude<WatcherKind, "unknown">;
}): WatchSession | null {
  ensurePrDir(args.host, args.owner, args.repo, args.pr);
  const sf = stateFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lf = lockFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lock = acquireLock(lf, { headSha: args.headSha });
  if (lock.alreadyRunning) return null;
  const ownerToken = lock.ownerToken!;
  const latestLock = latestPointer(args.host, args.owner, args.repo, args.pr) + ".lock";
  mirrorLockToLatest(
    latestLock,
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      headSha: args.headSha,
      command: "gh-watch-runs",
      ownerToken,
    },
    args.kind,
  );
  const releaseAll = (): void => {
    releaseLockIfOwner(lf, ownerToken);
    releaseMirrorLatestLock(latestLock, ownerToken);
  };
  return { sf, ownerToken, releaseAll };
}
