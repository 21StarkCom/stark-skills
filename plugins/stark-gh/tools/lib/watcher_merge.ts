// pr-merge watcher mode (--on-green callback). Polls the REQUIRED-check rollup,
// disambiguates GitHub's eventually-consistent merge signal against the grace
// windows in watcher_classifier.ts, and — once green is debounced — dispatches
// the merge callback. Triggered when --on-green is present.
//
// Every non-happy branch here encodes a specific incident (Atlas#73, STARK-579,
// STARK-1053 / atlas#102 #103, kotodama#861, #877). The decision math is pure in
// watcher_classifier.ts; this file is the loop that applies it and writes state.
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { atomicWriteJson } from "./watcher_paths.ts";
import * as ghLib from "./gh.ts";
import { resolveCallback } from "./watcher_callbacks.ts";
import { readPrMergePlan, type PrMergePlan } from "./plan.ts";
import { startSession } from "./watcher_session.ts";
import { writeLatestPointer } from "./watcher_state.ts";
import { pollOnce, classifyError, jitter, type BackoffState } from "./watcher_poll.ts";
import {
  type PollOutcome,
  decideHeadMovedTransition,
  decideVacuousTransition,
  decideSkippedTransition,
  decideBlockedTransition,
  decideRefireTransition,
  HEAD_MOVED_REQUIRED_RECONFIRMS,
  HEAD_MOVED_RECONFIRM_DELAY_SEC,
  MAX_REFIRE_ATTEMPTS,
} from "./watcher_classifier.ts";

export interface PrMergeWatchArgs {
  callbackName: string;
  planFile: string;
  watchTimeoutHours: number;
  pollSeconds: number;
}

export function parsePrMergeArgs(argv: string[]): PrMergeWatchArgs | null {
  const onGreenIdx = argv.indexOf("--on-green");
  if (onGreenIdx < 0) return null;
  const callbackName = argv[onGreenIdx + 1];
  if (!callbackName) throw new Error("--on-green requires a value");
  const planIdx = argv.indexOf("--plan-file");
  if (planIdx < 0) throw new Error("--on-green requires --plan-file");
  const planFile = argv[planIdx + 1];
  if (!planFile) throw new Error("--plan-file requires a value");
  const wtIdx = argv.indexOf("--watch-timeout");
  const watchTimeoutHours = wtIdx >= 0 ? Number(argv[wtIdx + 1]) : 6;
  const pollIdx = argv.indexOf("--poll-seconds");
  const pollSeconds = pollIdx >= 0 ? Number(argv[pollIdx + 1]) : 30;
  return { callbackName, planFile, watchTimeoutHours, pollSeconds };
}

function spawnCallback(callbackPath: string, planFile: string): { pid: number } {
  // Detached spawn so the watcher's exit doesn't kill the callback.
  const child = spawn("node", [callbackPath, "--plan-file", planFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? -1 };
}

export async function prMergeWatchLoop(args: PrMergeWatchArgs): Promise<number> {
  const plan = readPrMergePlan(args.planFile);
  if (!plan.pushedHeadOid) {
    process.stderr.write("watcher: plan.pushedHeadOid is null; nothing to watch\n");
    return 1;
  }
  const callbackPath = resolveCallback(args.callbackName);
  if (!callbackPath) {
    process.stderr.write(`watcher: unknown callback name '${args.callbackName}'; refused before spawn\n`);
    return 2;
  }

  const host = "github.com"; // pr-merge uses the same default
  const owner = plan.pr.headRepositoryOwner;
  const repo = plan.pr.headRepositoryName;
  const session = startSession({
    host,
    owner,
    repo,
    pr: plan.pr.number,
    headSha: plan.pushedHeadOid,
    kind: "merge-driver",
  });
  if (session === null) {
    process.stderr.write(`watcher already running for PR #${plan.pr.number} @ ${plan.pushedHeadOid}\n`);
    return 0;
  }
  const { sf, releaseAll: releaseAllMerge } = session;
  const startedAt = new Date().toISOString();

  atomicWriteJson(sf, {
    schemaVersion: 1,
    command: "stark-gh-pr-merge-watch",
    host,
    repo: plan.pr.nameWithOwner,
    pr: plan.pr.number,
    headSha: plan.pushedHeadOid,
    status: "watching",
    startedAt,
    pid: process.pid,
    hostname: os.hostname(),
    consecutiveGreen: 0,
    lastPolledAt: null,
    lastError: null,
  });

  const start = Date.now();
  const maxMs = args.watchTimeoutHours * 60 * 60 * 1000;
  const backoff: BackoffState = { consecErrors: 0, rateLimitDelaySec: 0 };
  let consecutiveGreen = 0;
  // When the CURRENT run of vacuous polls began (null = not currently vacuous).
  // Timestamped rather than counted so the grace window is wall-clock and stays
  // meaningful as the poll interval backs off under rate limiting.
  let vacuousSinceMs: number | null = null;
  // Same shape, for a rollup whose latest context on some required check is
  // SKIPPED. See decideSkippedTransition.
  let skippedSinceMs: number | null = null;
  // Same shape, for a rollup that reads green while GitHub still BLOCKS the merge
  // (a required check not yet registered, or a required review). See
  // decideBlockedTransition and mergeStateBlocksFiring.
  let blockedSinceMs: number | null = null;
  // Successful re-fires in the CURRENT blocked episode (reset whenever the blocked
  // state clears). Only the vacuous-but-BLOCKED path (refireable) consumes it;
  // caps the automatic close+reopen recovery at MAX_CHECK_REFIRES. See
  // decideRefireTransition.
  let refireCount = 0;
  // Total close+reopen ATTEMPTS this episode (success or transient-close-failure).
  // Bounds retry of a flaky `gh pr close` at MAX_REFIRE_ATTEMPTS without burning the
  // one recovery budget on the first hiccup.
  let refireAttempts = 0;
  const REQUIRED_GREEN = 2; // PR4-claude H13 debounce
  // Tolerate transient head-OID mismatch right after force-push: GitHub's
  // GraphQL `pullRequest.headRefOid` can lag the push receiver by hundreds
  // of milliseconds, so the very first poll often observes the pre-push
  // OID and would otherwise exit the watcher 500ms after spawn. Require
  // HEAD_MOVED_REQUIRED_RECONFIRMS consecutive head_moved outcomes (with
  // a short reconfirm delay between them) before declaring a terminal
  // head_moved. A real intervening force-push survives all reconfirms;
  // replication lag resolves within seconds.
  let consecutiveHeadMoved = 0;

  const writeLatest = (status: string): void =>
    writeLatestPointer(host, owner, repo, plan.pr.number, { headSha: plan.pushedHeadOid!, status });

  const writeStatus = (extras: Record<string, unknown>): void => {
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { /* keep empty */ }
    atomicWriteJson(sf, { ...cur, ...extras, lastPolledAt: new Date().toISOString() });
    // Heartbeat: touch latest.json's mtime each poll.
    try { fs.utimesSync(sf, new Date(), new Date()); } catch { /* best-effort */ }
  };

  while (true) {
    const elapsedMs = Date.now() - start;
    if (elapsedMs > maxMs) {
      writeStatus({ status: "watch_timeout", finishedAt: new Date().toISOString() });
      releaseAllMerge();
      return 0;
    }

    let outcome: PollOutcome | null = null;
    let pollErr: Error | null = null;
    try {
      outcome = await pollOnce(plan);
    } catch (err) {
      pollErr = err as Error;
    }

    if (pollErr) {
      backoff.consecErrors++;
      const cls = classifyError(pollErr);
      let delay: number;
      if (cls.rateLimit || cls.secondaryRateLimit) {
        delay = Math.min(15 * 60, args.pollSeconds * Math.pow(2, backoff.consecErrors));
      } else if (cls.transient) {
        delay = args.pollSeconds * backoff.consecErrors;
      } else {
        if (backoff.consecErrors >= 3) {
          writeStatus({ status: "auth_failed", lastError: pollErr.message, finishedAt: new Date().toISOString() });
          releaseAllMerge();
          return 1;
        }
        delay = args.pollSeconds;
      }
      writeStatus({ lastError: pollErr.message, consecErrors: backoff.consecErrors });
      await new Promise(r => setTimeout(r, jitter(delay) * 1000));
      continue;
    }
    backoff.consecErrors = 0;

    if (outcome!.kind === "head_moved") {
      consecutiveHeadMoved++;
      if (decideHeadMovedTransition(consecutiveHeadMoved) === "reconfirm") {
        // Likely GraphQL replication lag right after force-push; reconfirm
        // with a short delay before treating as terminal. Reset the green
        // debounce: a transient head_moved invalidates any in-flight green
        // streak, otherwise one ready poll before the mismatch plus one
        // after could dispatch the merge after only one post-mismatch green.
        consecutiveGreen = 0;
        writeStatus({
          status: "watching",
          consecutiveHeadMoved,
          consecutiveGreen,
          lastWarning: `head_moved (transient ${consecutiveHeadMoved}/${HEAD_MOVED_REQUIRED_RECONFIRMS}): ${outcome!.reason}`,
        });
        await new Promise(r => setTimeout(r, jitter(HEAD_MOVED_RECONFIRM_DELAY_SEC) * 1000));
        continue;
      }
      writeStatus({ status: "head_moved", finishedAt: new Date().toISOString(), reason: outcome!.reason });
      writeLatest("head_moved");
      releaseAllMerge();
      return 0;
    }
    // Any non-head_moved outcome resets the consecutive counter so a stray
    // mismatch followed by recovery doesn't accumulate toward terminal.
    consecutiveHeadMoved = 0;
    if (outcome!.kind === "fatal") {
      writeStatus({ status: "checks_failed", finishedAt: new Date().toISOString(), reason: outcome!.reason });
      releaseAllMerge();
      return 0;
    }
    if (outcome!.kind === "ready") {
      consecutiveGreen++;
      vacuousSinceMs = null;
      skippedSinceMs = null;
      blockedSinceMs = null;
      writeStatus({ consecutiveGreen, status: "watching", lastWait: null });
      if (consecutiveGreen >= REQUIRED_GREEN) {
        // Fire callback. Spawn detached so its lifetime is independent.
        const { pid } = spawnCallback(callbackPath, args.planFile);
        writeStatus({
          status: "callback_dispatched",
          callbackName: args.callbackName,
          callbackPid: pid,
          finishedAt: new Date().toISOString(),
        });
        releaseAllMerge();
        return 0;
      }
    } else {
      consecutiveGreen = 0;
      // SURFACE THE REASON. This used to write only the counter, so a watcher
      // that could never progress was indistinguishable from one waiting on a
      // check that was about to finish: `status: "watching"`, `lastError: null`
      // and nothing else. The reason is the entire diagnosis.
      writeStatus({ consecutiveGreen, status: "watching", lastWait: outcome!.reason ?? null });

      // A vacuous rollup may be transient (checks not attached yet) or permanent
      // (the base branch requires no checks at all). Bound it: past the grace
      // window, stop rather than poll to the 6h timeout with nothing to wait for.
      if (outcome!.vacuous) {
        if (vacuousSinceMs === null) vacuousSinceMs = Date.now();
        const elapsedSec = (Date.now() - vacuousSinceMs) / 1000;
        if (decideVacuousTransition(elapsedSec) === "terminal") {
          const reason =
            `no REQUIRED status checks on this PR after ${Math.round(elapsedSec)}s — the base branch has none configured, ` +
            `so this will never turn green no matter how long it is watched. Check runs on the head may all be passing and the ` +
            `PR MERGEABLE; the watcher gates on REQUIRED contexts, and there are none. Either add required checks to the base ` +
            `branch's protection, or re-run the merge with --allow-no-required-checks to accept a vacuous pass.`;
          writeStatus({ status: "no_required_checks", finishedAt: new Date().toISOString(), reason });
          writeLatest("no_required_checks");
          releaseAllMerge();
          return 0;
        }
      } else {
        vacuousSinceMs = null;
      }

      // A SKIPPED required check reads the same two ways, and gets the same
      // wall-clock separation: transient while this flow's own `gh pr ready`
      // run is still registering, permanent once it should have.
      if (outcome!.skipped) {
        if (skippedSinceMs === null) skippedSinceMs = Date.now();
        const elapsedSec = (Date.now() - skippedSinceMs) / 1000;
        if (decideSkippedTransition(elapsedSec) === "terminal") {
          const names = (outcome!.skippedNames ?? []).join(", ");
          const reason =
            `required check(s) still SKIPPED after ${Math.round(elapsedSec)}s: ${names}. The suite never ran against this ` +
            `commit, and nothing will change that on its own — re-running the workflow replays the original event payload ` +
            `(a draft-guarded job skips again) and a workflow_dispatch run does not join this PR's status rollup. GitHub ` +
            `itself counts a skipped check as satisfying the requirement, which is why the merge box looks green; it is not. ` +
            `Push a commit to re-fire CI, or re-run the merge with --allow-skipped-checks if these checks skip by design.`;
          writeStatus({ status: "checks_skipped", finishedAt: new Date().toISOString(), reason });
          writeLatest("checks_skipped");
          releaseAllMerge();
          return 0;
        }
      } else {
        skippedSinceMs = null;
      }

      // A `blocked` wait arrives in two flavors (applyMergeStateGate sets them):
      //   NON-refireable — the rollup read green but GitHub still refuses (Atlas#73:
      //     a slow required check whose context has not registered, or a missing
      //     review CI cannot supply). Passive bounded wait, then name it.
      //   refireable — the rollup carries ZERO required contexts yet GitHub blocks:
      //     the base requires a check that never attached to this SHA, the signature
      //     of a dropped `synchronize` webhook (STARK-1053 / atlas#102, #103). Wait
      //     out the registration window, then close+reopen ONCE to re-fire CI on the
      //     same SHA, then keep waiting to the overall grace before giving up.
      if (outcome!.blocked) {
        if (blockedSinceMs === null) { blockedSinceMs = Date.now(); refireCount = 0; refireAttempts = 0; }
        const elapsedSec = (Date.now() - blockedSinceMs) / 1000;
        if (outcome!.refireable) {
          const decision = decideRefireTransition(elapsedSec, refireCount);
          if (decision === "refire" && refireAttempts >= MAX_REFIRE_ATTEMPTS) {
            // The recovery window came and went spent entirely on close attempts
            // that all failed (a persistently unusable `gh pr close`). We never got
            // the PR closed, so it was never stranded — but we also cannot re-fire,
            // so stop and name it rather than retry to the 6h timeout.
            const reason =
              `could not re-fire CI on PR #${plan.pr.number}: ${refireAttempts} close attempts all failed within ` +
              `${Math.round(elapsedSec)}s while GitHub reports the merge ${outcome!.mergeState ?? "BLOCKED"} with no required ` +
              `check registered. Re-fire by hand (close+reopen), push a commit, or re-run the merge.`;
            writeStatus({ status: "checks_never_registered", finishedAt: new Date().toISOString(), reason });
            writeLatest("checks_never_registered");
            releaseAllMerge();
            return 0;
          }
          if (decision === "refire") {
            refireAttempts++;
            // Record the intent BEFORE the close: if the process dies in the ~1-2s
            // close→reopen window the state reads `refiring` (PR possibly closed),
            // not a stale `watching` that hides why the PR is closed.
            writeStatus({
              status: "refiring",
              refireAttempts,
              lastWarning: `re-firing CI on PR #${plan.pr.number} via close+reopen (attempt ${refireAttempts}/${MAX_REFIRE_ATTEMPTS})`,
            });
            try {
              ghLib.refirePrViaReopen(plan.pr.number, plan.pr.nameWithOwner);
              refireCount++;
              // Reset the clock so the re-fired CI gets a fresh registration window.
              // Without this a re-fire issued late (near the grace bound, via the
              // refire-before-terminal precedence) would go terminal on the very next
              // poll and waste the recovery. refireCount stays spent → no second re-fire.
              blockedSinceMs = Date.now();
              process.stdout.write(JSON.stringify({
                event: "ci-refired",
                prNumber: plan.pr.number,
                afterSec: Math.round(elapsedSec),
              }) + "\n");
              writeStatus({
                status: "watching",
                refireCount,
                lastWarning:
                  `no required check registered after ${Math.round(elapsedSec)}s; closed+reopened PR #${plan.pr.number} ` +
                  `on the same head to re-fire CI (dropped-webhook recovery)`,
              });
            } catch (err) {
              const msg = String((err as Error)?.message ?? err);
              if (/^LEFT_CLOSED:/.test(msg)) {
                // Close succeeded but reopen did not — the PR is CLOSED, which is
                // worse than the stuck state. Stop loudly with the manual-fix line.
                writeStatus({ status: "refire_failed", finishedAt: new Date().toISOString(), reason: msg });
                writeLatest("refire_failed");
                releaseAllMerge();
                return 1;
              }
              // Close itself failed → the PR is intact and the re-fire did not
              // happen. Do NOT burn the recovery budget (refireCount): only the
              // attempt counter advanced, so a later poll retries — bounded by
              // MAX_REFIRE_ATTEMPTS — instead of one flaky close foreclosing recovery.
              writeStatus({
                status: "watching",
                refireAttempts,
                lastWarning: `re-fire attempt ${refireAttempts} could not close PR #${plan.pr.number} (PR intact), will retry: ${msg}`,
              });
            }
          } else if (decision === "terminal") {
            const reason =
              `no required check registered a result on this commit after ${Math.round(elapsedSec)}s` +
              `${refireCount > 0 ? " (a close+reopen re-fire was attempted)" : ""}, while GitHub still reports the merge ` +
              `${outcome!.mergeState ?? "BLOCKED"}. Either a CI trigger never fired (a re-fire could not recover it), or the ` +
              `base enforces a merge requirement no check can satisfy — an unresolved conversation or a signed-commits rule. ` +
              `Check the PR's merge box: push a commit to re-fire CI, resolve/sign as needed, or re-run the merge with ` +
              `--allow-no-required-checks if the base is meant to require none.`;
            writeStatus({ status: "checks_never_registered", finishedAt: new Date().toISOString(), reason });
            writeLatest("checks_never_registered");
            releaseAllMerge();
            return 0;
          }
        } else if (decideBlockedTransition(elapsedSec) === "terminal") {
          const reason =
            `GitHub still reports the merge ${outcome!.mergeState ?? "BLOCKED"} after ${Math.round(elapsedSec)}s while every ` +
            `required check in the rollup passes. The rollup only sees contexts already attached to this commit, so a required ` +
            `check that never registered — or a required review CI cannot supply — reads green here yet stays blocked at GitHub. ` +
            `Add the missing approval, push a commit to re-fire the required check, or re-run the merge with ` +
            `--allow-no-required-checks if the base branch is meant to require none.`;
          writeStatus({ status: "merge_blocked", finishedAt: new Date().toISOString(), reason });
          writeLatest("merge_blocked");
          releaseAllMerge();
          return 0;
        }
      } else {
        blockedSinceMs = null;
        refireCount = 0;
        refireAttempts = 0;
      }
    }
    await new Promise(r => setTimeout(r, jitter(args.pollSeconds) * 1000));
  }
}
