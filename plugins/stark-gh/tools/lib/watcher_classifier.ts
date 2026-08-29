// Pure classification for the pr-merge watcher: given a required-check rollup
// (and, for two ambiguous readings, GitHub's own mergeStateStatus), decide what
// the poll loop should do next. Every function here is pure and unit-tested by
// __tests__/watcher_poll.test.ts, __tests__/watcher_on_green.test.ts and
// __tests__/checks_skipped.test.ts.
//
// Each grace-window constant + its decide* function encodes a specific
// production incident where GitHub's merge signal was ambiguous or eventually
// consistent. The comments name the incident; do not "simplify" a window away
// without re-reading the case it exists for.
import { summarizeVerdict, isGreen, type Context } from "./checks_graphql.ts";

export interface PollOutcome {
  kind: "wait" | "ready" | "head_moved" | "fatal";
  reason?: string;
  // Set only on a `wait` produced by a rollup with ZERO required contexts. See
  // decideVacuousTransition for why that case is time-bounded rather than
  // waited on indefinitely.
  vacuous?: boolean;
  // Set only on a `wait` produced by a rollup whose latest context for some
  // REQUIRED check is SKIPPED. Same shape as `vacuous`: transient right after
  // the draft-time push, permanent once the real run has had time to register.
  skipped?: boolean;
  skippedNames?: string[];
  // Set only on a `wait` produced when the required-check ROLLUP reads green but
  // GitHub still reports the merge BLOCKED/UNKNOWN — a required check GitHub knows
  // about (from branch config) has not registered a context on this SHA yet, or a
  // required review is missing. Same time-bounded shape as `vacuous`/`skipped`.
  blocked?: boolean;
  // Set on a `blocked` wait that is safe to recover by re-firing CI (close+reopen
  // on the same SHA): the rollup carries ZERO required contexts yet GitHub blocks
  // the merge, so the base DOES require a check that never attached to this SHA —
  // the signature of a dropped `synchronize` webhook. NOT set on a green-but-BLOCKED
  // wait (STARK-579), where the suite demonstrably ran and re-firing the whole set
  // would be wasteful and, if the block is a missing review, useless.
  refireable?: boolean;
  // GitHub's mergeStateStatus captured when the rollup reached green, for the
  // operator-facing message (present on a `ready` or a `blocked` outcome).
  mergeState?: string;
}

// Constants exported for the unit-test of decideHeadMovedTransition.
export const HEAD_MOVED_REQUIRED_RECONFIRMS = 3;
export const HEAD_MOVED_RECONFIRM_DELAY_SEC = 5;

// Pure: given the running head_moved counter, decide whether to reconfirm
// (transient — likely GraphQL replication lag right after force-push) or
// declare the head_moved terminal. consecutiveCount is the post-increment
// value, so the very first head_moved seen passes 1.
export function decideHeadMovedTransition(
  consecutiveCount: number,
  required: number = HEAD_MOVED_REQUIRED_RECONFIRMS,
): "reconfirm" | "terminal" {
  return consecutiveCount < required ? "reconfirm" : "terminal";
}

// How long a VACUOUS rollup (zero REQUIRED contexts) may persist before the
// watcher gives up instead of polling to its 6h timeout.
export const NO_REQUIRED_CHECKS_GRACE_SEC = 300;

// Pure: a vacuous rollup is ambiguous, and the two readings need opposite
// handling.
//
//   TRANSIENT — the push just landed and GitHub has not attached the check
//     runs yet, so nothing is required *yet*. Waiting fixes it, usually within
//     seconds.
//   PERMANENT — the base branch has no required status checks at all
//     (unprotected branch, or protection without required contexts). Waiting
//     can NEVER fix this: `required` is 0 because of branch configuration, and
//     no amount of polling changes branch configuration.
//
// They are indistinguishable in a single sample, so time separates them: past
// the grace window, treat it as configuration and stop.
//
// This is the bug that motivated the helper. A PR into an UNPROTECTED base
// branch left the watcher polling happily for its full 6h timeout —
// `status: "watching"`, `consecutiveGreen: 0`, `lastError: null` — while every
// check run on the head was green and the PR was MERGEABLE/CLEAN. Nothing ever
// merged and nothing said why, because `evaluateRollup`'s wait reason was
// computed and then dropped (see writeStatus at the call site, now fixed too).
// Observed on 21StarkCom/kotodama#861, whose base `build/gke-api-auth-boundary`
// carried no branch protection; `main` requires one context, so every prior run
// had exercised only the non-vacuous path.
export function decideVacuousTransition(
  vacuousElapsedSec: number,
  graceSec: number = NO_REQUIRED_CHECKS_GRACE_SEC,
): "wait" | "terminal" {
  return vacuousElapsedSec < graceSec ? "wait" : "terminal";
}

// How long a SKIPPED required check may persist before the watcher stops.
//
// Same two readings as the vacuous case, so the same treatment. TRANSIENT: the
// merge flow force-pushed while the PR was still a draft, so a draft-guarded
// required check reported SKIPPED, and the `ready_for_review` run that replaces
// it has not registered yet. PERMANENT: the check skips by configuration (or
// its real run was lost), and nothing but a new commit will ever change it.
// Shorter than the vacuous window because the replacement run is fired by this
// tool's own `gh pr ready` moments earlier — it is late by seconds, not minutes.
export const SKIPPED_CHECK_GRACE_SEC = 120;

export function decideSkippedTransition(
  skippedElapsedSec: number,
  graceSec: number = SKIPPED_CHECK_GRACE_SEC,
): "wait" | "terminal" {
  return skippedElapsedSec < graceSec ? "wait" : "terminal";
}

// GitHub `mergeStateStatus` values under which firing the merge is pointless
// because branch protection would reject it, no matter what the required-check
// ROLLUP says.
//
// The rollup is built ONLY from the check contexts currently attached to the head
// SHA (see checks_graphql.ts). A slow REQUIRED check — a ubuntu build that takes
// minutes just to spin up — has no context yet, so it is ABSENT from the rollup,
// not pending: `summarizeVerdict` counts `required` over the contexts that exist,
// `passing === required` holds over that incomplete set, and `isGreen` returns
// true before the required set is even complete. GitHub, which knows the full
// required set from the base branch's protection config, still reports BLOCKED.
// Firing then is a guaranteed "the base branch policy prohibits the merge" — the
// exact way the watcher for 21StarkCom/Atlas#73 fired at consecutiveGreen=2 only
// 31s in and dead-ended on merge_failed while build-test (5m21s) had not started.
//
// UNKNOWN is grouped in: an un-computed mergeability is not a green light either
// (a `gh pr view` triggers the computation, so the next poll usually resolves it).
// Everything else — CLEAN, and notably UNSTABLE (mergeable, only NON-required
// checks outstanding) and HAS_HOOKS — is left to fire, preserving the design's
// refusal to wait on non-required checks.
export function mergeStateBlocksFiring(mergeStateStatus: string): boolean {
  return mergeStateStatus === "BLOCKED" || mergeStateStatus === "UNKNOWN";
}

// How long a rollup-green-but-GitHub-BLOCKED reading may persist before the
// watcher stops. Generous relative to the vacuous/skipped windows: the whole
// point is to outlast a slow required check's REGISTRATION latency (the context
// appearing at all), after which the rollup itself shows `pending` and the normal
// wait path — bounded only by the 6h watch timeout — takes over. If BLOCKED still
// stands past this window WITH the rollup green, the cause is not a late check but
// a required review CI can never supply, and stopping with that message is right.
export const MERGE_BLOCKED_GRACE_SEC = 600;

export function decideBlockedTransition(
  blockedElapsedSec: number,
  graceSec: number = MERGE_BLOCKED_GRACE_SEC,
): "wait" | "terminal" {
  return blockedElapsedSec < graceSec ? "wait" : "terminal";
}

// How long a vacuous-but-BLOCKED reading (zero required contexts on the SHA, yet
// GitHub blocks the merge) may persist before the watcher stops passively waiting
// and actively re-fires CI. Short: GitHub attaches a check-run when a workflow is
// QUEUED, which happens seconds after the triggering event — so a required gate
// with no context after two minutes is the signature of an event that never
// arrived (the swallowed `synchronize` on 21StarkCom/atlas#103 left #103 BLOCKED
// with zero checks for 20 minutes), not a runner that is merely slow to start.
export const CHECK_REGISTRATION_REFIRE_SEC = 120;

// At most one SUCCESSFUL close+reopen recovery per blocked episode. A second one
// that still yields nothing is not a transient webhook drop but a real
// misconfiguration (a required context no workflow produces), which another
// re-fire cannot cure — so we stop and name it instead of thrashing the PR.
export const MAX_CHECK_REFIRES = 1;

// A cap on close+reopen ATTEMPTS (as opposed to successful recoveries). A transient
// `gh pr close` failure must NOT permanently burn the one recovery — the loop
// retries on the next poll — but a persistently failing close cannot retry forever,
// so it is bounded. Distinct from MAX_CHECK_REFIRES: the recovery budget counts
// successes; this counts tries, so one flaky close does not foreclose the recovery
// the whole feature exists for.
export const MAX_REFIRE_ATTEMPTS = 3;

// Pure: drives the vacuous-but-BLOCKED recovery. `blockedElapsedSec` is the age of
// the current blocked episode; `refireCount` how many re-fires it has already had.
//   wait     — inside the registration window, still expecting the context.
//   refire   — window elapsed and the re-fire budget is unspent: close+reopen once.
//   terminal — past the overall grace (MERGE_BLOCKED_GRACE_SEC); give up and name it.
// `refire` is tested BEFORE `terminal` so a state that jumped straight past both
// bounds (a long poll gap under rate limiting) still gets its one cure attempt
// before the watcher abandons it.
export function decideRefireTransition(
  blockedElapsedSec: number,
  refireCount: number,
  opts: { refireAfterSec?: number; maxRefires?: number; terminalAfterSec?: number } = {},
): "wait" | "refire" | "terminal" {
  const refireAfter = opts.refireAfterSec ?? CHECK_REGISTRATION_REFIRE_SEC;
  const maxRefires = opts.maxRefires ?? MAX_CHECK_REFIRES;
  const terminalAfter = opts.terminalAfterSec ?? MERGE_BLOCKED_GRACE_SEC;
  if (refireCount < maxRefires && blockedElapsedSec >= refireAfter) return "refire";
  if (blockedElapsedSec >= terminalAfter) return "terminal";
  return "wait";
}

// Pure gate applied AFTER the rollup verdict, using GitHub's own mergeability to
// disambiguate the two cases a single rollup sample cannot tell apart:
//
//   READY rollup + BLOCKED/UNKNOWN → the rollup read green over a required set
//     that has not fully registered (STARK-579). Downgrade to a bounded `blocked`
//     wait; it is NOT re-fireable — the suite demonstrably ran.
//
//   VACUOUS rollup (zero required contexts) + BLOCKED/UNKNOWN → GitHub enforces a
//     merge requirement that is unmet, and the rollup carries no context to explain
//     it. This is NOT a vacuous pass: treating it as "no required checks → give up
//     at the 300s grace" is the exact STARK-1053 bug (atlas#102 sat green+CLEAN for
//     ~90 min, unmerged). Reclassify OUT of the vacuous terminal into a bounded
//     `blocked` wait. Whether it is ALSO re-fireable depends on reviewDecision:
//       - a required REVIEW is outstanding (REVIEW_REQUIRED / CHANGES_REQUESTED) →
//         a close+reopen cannot supply it, so NOT refireable — same carve-out the
//         ready+BLOCKED path already makes. Routes to the merge_blocked terminal,
//         whose message names the missing approval.
//       - otherwise → the block is most consistent with a required check that has
//         not attached to this SHA (pre-registration / dropped webhook), which a
//         close+reopen CAN cure → refireable.
//
//   VACUOUS rollup + non-blocking mergeState (CLEAN/UNSTABLE/…) → the base
//     genuinely requires no checks (kotodama#861). Leave it vacuous; the existing
//     300s terminal names `--allow-no-required-checks`.
//
// Any other outcome (a non-vacuous pending wait, fatal, head_moved) passes through
// untouched — the rollup already decided and GitHub's mergeability adds nothing.
//
// reviewDecision is only meaningful for the vacuous case, so it is optional; the
// ready path never reads it (a green rollup that GitHub still blocks is never
// re-fired regardless of why).
export function applyMergeStateGate(
  outcome: PollOutcome,
  mergeStateStatus: string,
  opts: { reviewDecision?: string } = {},
): PollOutcome {
  if (outcome.kind === "ready") {
    if (mergeStateBlocksFiring(mergeStateStatus)) {
      return {
        kind: "wait",
        reason:
          `every required check in the rollup passes, but GitHub still reports the merge ${mergeStateStatus} — ` +
          `a required check has not registered a result on this commit yet, or a required review is missing`,
        blocked: true,
        mergeState: mergeStateStatus,
      };
    }
    return { ...outcome, mergeState: mergeStateStatus };
  }
  if (outcome.kind === "wait" && outcome.vacuous) {
    if (mergeStateBlocksFiring(mergeStateStatus)) {
      const reviewBlocked =
        opts.reviewDecision === "REVIEW_REQUIRED" || opts.reviewDecision === "CHANGES_REQUESTED";
      if (reviewBlocked) {
        return {
          kind: "wait",
          reason:
            `no required check has reported on this commit, and GitHub reports the merge ${mergeStateStatus} because a ` +
            `required review is outstanding (reviewDecision=${opts.reviewDecision}) — a re-fire cannot supply a review`,
          blocked: true,
          mergeState: mergeStateStatus,
        };
      }
      return {
        kind: "wait",
        reason:
          `no required check has reported on this commit yet, but GitHub reports the merge ${mergeStateStatus} — ` +
          `the base branch requires a check that has not registered a context on this SHA (pre-registration window, or a dropped CI trigger)`,
        blocked: true,
        refireable: true,
        mergeState: mergeStateStatus,
      };
    }
    return { ...outcome, mergeState: mergeStateStatus };
  }
  return outcome;
}

// Pure function: maps a rollup result (mismatch | contexts) + plan policy
// into a PollOutcome. Easy to unit-test.
export function evaluateRollup(
  rollup: { mismatch: boolean; contexts: Context[] | null; headRefOid: string },
  policy: { allowNoRequiredChecks: boolean; allowSkippedChecks?: boolean },
): PollOutcome {
  if (rollup.mismatch) return { kind: "head_moved", reason: `headRefOid=${rollup.headRefOid}` };
  const v = summarizeVerdict(rollup.contexts!);
  if (v.vacuous) {
    if (policy.allowNoRequiredChecks) return { kind: "ready", reason: "vacuous-allowed" };
    // `vacuous: true` is carried on the outcome so the caller can time-bound it
    // (decideVacuousTransition) instead of waiting on a condition that may be
    // permanent. The reason string is not a marker — callers must not parse it.
    return { kind: "wait", reason: "no required checks observed yet", vacuous: true };
  }
  if (v.anyFailing) return { kind: "fatal", reason: `failing checks: ${v.failing}` };
  // A skipped required check will not resolve itself: re-running the workflow
  // replays the original event payload (so a draft-guarded job skips again), and
  // a `workflow_dispatch` run does not join the PR's status rollup at all —
  // measured on #877, where the dispatch produced `test: SUCCESS` on the head
  // sha that the rollup never carried. Only a new commit clears it.
  //
  // But it is NOT terminal on sight, for the same reason a vacuous rollup is
  // not: this flow manufactures a transient skip. `pr-merge` force-pushes while
  // the PR is still a draft (creating a SKIPPED run in any target repo that
  // still draft-guards that check) and only then marks it ready, which fires the
  // real run. A first poll landing in that gap would abort seconds before the
  // genuine run registers, telling the operator to push a commit they do not
  // need. Time separates the two readings, exactly as with vacuous — the caller
  // bounds it via decideSkippedTransition.
  if (v.anySkipped && !policy.allowSkippedChecks) {
    return {
      kind: "wait",
      reason: `required check(s) skipped, so the suite has not run on this commit: ${v.skippedNames.join(", ")}`,
      skipped: true,
      skippedNames: v.skippedNames,
    };
  }
  if (isGreen(v, { allowSkippedChecks: policy.allowSkippedChecks })) {
    return { kind: "ready", reason: "all required passing" };
  }
  return { kind: "wait", reason: `pending: ${v.pending}` };
}
