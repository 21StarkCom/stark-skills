import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrMergeArgs,
  classifyError,
  jitter,
  evaluateRollup,
  decideHeadMovedTransition,
  decideVacuousTransition,
  HEAD_MOVED_REQUIRED_RECONFIRMS,
  NO_REQUIRED_CHECKS_GRACE_SEC,
  mergeStateBlocksFiring,
  decideBlockedTransition,
  applyMergeStateGate,
  MERGE_BLOCKED_GRACE_SEC,
  decideRefireTransition,
  CHECK_REGISTRATION_REFIRE_SEC,
  MAX_CHECK_REFIRES,
  MAX_REFIRE_ATTEMPTS,
} from "../gh_watch_runs.ts";
import { refirePrViaReopen, reopenPr } from "../lib/gh.ts";

test("parsePrMergeArgs: returns null when --on-green absent", () => {
  assert.equal(parsePrMergeArgs([]), null);
  assert.equal(parsePrMergeArgs(["--repo", "o/r", "--pr", "1"]), null);
});

test("parsePrMergeArgs: extracts callback + plan-file + watch-timeout + poll-seconds", () => {
  const r = parsePrMergeArgs(["--on-green", "pr-merge-complete", "--plan-file", "/tmp/p.json", "--watch-timeout", "12", "--poll-seconds", "45"]);
  assert.deepEqual(r, {
    callbackName: "pr-merge-complete",
    planFile: "/tmp/p.json",
    watchTimeoutHours: 12,
    pollSeconds: 45,
  });
});

test("parsePrMergeArgs: defaults watch-timeout=6, poll=30", () => {
  const r = parsePrMergeArgs(["--on-green", "pr-merge-complete", "--plan-file", "/p"]);
  assert.equal(r!.watchTimeoutHours, 6);
  assert.equal(r!.pollSeconds, 30);
});

test("parsePrMergeArgs: --on-green requires --plan-file", () => {
  assert.throws(() => parsePrMergeArgs(["--on-green", "x"]), /requires --plan-file/);
});

test("parsePrMergeArgs: --on-green requires a value", () => {
  assert.throws(() => parsePrMergeArgs(["--on-green"]), /--on-green requires a value/);
});

test("classifyError: 429 → rateLimit", () => {
  const r = classifyError(new Error("HTTP 429: rate limit"));
  assert.equal(r.rateLimit, true);
});

test("classifyError: X-RateLimit-Remaining: 0 → rateLimit", () => {
  const r = classifyError(new Error("got X-RateLimit-Remaining: 0 from gh"));
  assert.equal(r.rateLimit, true);
});

test("classifyError: secondary rate limit", () => {
  const r = classifyError(new Error("you have triggered a secondary rate limit"));
  assert.equal(r.secondaryRateLimit, true);
});

test("classifyError: 5xx transient", () => {
  for (const code of [500, 502, 503, 504]) {
    const r = classifyError(new Error(`HTTP ${code} server error`));
    assert.equal(r.transient, true, `${code} should be transient`);
  }
});

test("classifyError: unknown / 401 → not classified", () => {
  const r = classifyError(new Error("401 unauthorized"));
  assert.equal(r.rateLimit, false);
  assert.equal(r.secondaryRateLimit, false);
  assert.equal(r.transient, false);
});

test("jitter: stays within ±20% by default", () => {
  for (let i = 0; i < 100; i++) {
    const r = jitter(30);
    assert.ok(r >= 24, `${r} >= 24`);
    assert.ok(r <= 36, `${r} <= 36`);
  }
});

test("jitter: clamps to >= 1", () => {
  // Even if base * (1 - pct) would be 0 or negative, output is at least 1.
  const r = jitter(0.1);
  assert.ok(r >= 1);
});

test("evaluateRollup: head_moved on mismatch", () => {
  const r = evaluateRollup({ mismatch: true, contexts: null, headRefOid: "actual-sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "head_moved");
});

test("evaluateRollup: vacuous wait when not allowed", () => {
  const r = evaluateRollup({ mismatch: false, contexts: [], headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
  assert.match(r.reason!, /no required/);
});

test("evaluateRollup: vacuous ready when allowNoRequiredChecks", () => {
  const r = evaluateRollup({ mismatch: false, contexts: [], headRefOid: "sha" }, { allowNoRequiredChecks: true });
  assert.equal(r.kind, "ready");
});

// A vacuous wait must be MARKED as vacuous, so the loop can time-bound it. Without
// the flag the caller cannot tell "no required checks configured — never resolves"
// from "a required check is still running", and polls the full watch timeout.
test("evaluateRollup: vacuous wait carries the vacuous flag", () => {
  const r = evaluateRollup({ mismatch: false, contexts: [], headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
  assert.equal(r.vacuous, true);
});

// ...and a NON-vacuous wait must not, or a PR legitimately waiting on a slow
// required check would be abandoned after the grace window.
test("evaluateRollup: pending required check is a wait that is NOT vacuous", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: null, status: "IN_PROGRESS" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
  assert.ok(!r.vacuous);
});

// The regression this exists for: 21StarkCom/kotodama#861 targeted an UNPROTECTED
// base branch, so the rollup was permanently vacuous. The watcher polled for its
// full 6h timeout with consecutiveGreen stuck at 0 and lastError null, while every
// check run was green and the PR was MERGEABLE/CLEAN. Waiting cannot fix branch
// configuration, so past the grace window the watcher must stop.
test("decideVacuousTransition: waits inside the grace window, terminal past it", () => {
  assert.equal(decideVacuousTransition(0), "wait");
  assert.equal(decideVacuousTransition(NO_REQUIRED_CHECKS_GRACE_SEC - 1), "wait");
  assert.equal(decideVacuousTransition(NO_REQUIRED_CHECKS_GRACE_SEC), "terminal");
  assert.equal(decideVacuousTransition(NO_REQUIRED_CHECKS_GRACE_SEC + 600), "terminal");
});

// The grace window exists because the SAME vacuous reading is legitimately
// transient right after a push, before GitHub attaches the check runs.
test("decideVacuousTransition: grace window is configurable", () => {
  assert.equal(decideVacuousTransition(10, 60), "wait");
  assert.equal(decideVacuousTransition(60, 60), "terminal");
});

test("evaluateRollup: all-passing → ready", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "CheckRun", name: "lint", isRequired: true, conclusion: "NEUTRAL", status: "COMPLETED" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "ready");
});

test("evaluateRollup: any failing → fatal", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "CheckRun", name: "lint", isRequired: true, conclusion: "FAILURE", status: "COMPLETED" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "fatal");
});

test("evaluateRollup: pending → wait", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: null, status: "IN_PROGRESS" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
});

test("decideHeadMovedTransition: first observation is reconfirm (transient)", () => {
  // Tolerates GraphQL replication lag right after force-push: very first
  // poll often observes the pre-push OID and must NOT exit the watcher.
  assert.equal(decideHeadMovedTransition(1), "reconfirm");
});

test("decideHeadMovedTransition: below required threshold is reconfirm", () => {
  for (let n = 1; n < HEAD_MOVED_REQUIRED_RECONFIRMS; n++) {
    assert.equal(decideHeadMovedTransition(n), "reconfirm", `n=${n}`);
  }
});

test("decideHeadMovedTransition: at-or-above threshold is terminal", () => {
  assert.equal(decideHeadMovedTransition(HEAD_MOVED_REQUIRED_RECONFIRMS), "terminal");
  assert.equal(decideHeadMovedTransition(HEAD_MOVED_REQUIRED_RECONFIRMS + 1), "terminal");
});

test("decideHeadMovedTransition: required defaults to 3 so single observation is never terminal", () => {
  // The whole point of the debounce — one stale GraphQL response from
  // post-push replication lag must never end the watcher. Pinned to the
  // literal 3 so weakening the configured debounce (e.g. dropping to 2)
  // is caught here instead of silently passing.
  assert.equal(HEAD_MOVED_REQUIRED_RECONFIRMS, 3);
});

test("evaluateRollup: not-required contexts ignored", () => {
  const ctx = [
    { kind: "CheckRun", name: "optional", isRequired: false, conclusion: "FAILURE", status: "COMPLETED" },
  ];
  // No required contexts → vacuous pass behavior.
  const r1 = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r1.kind, "wait");        // vacuous → wait without override
  const r2 = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: true });
  assert.equal(r2.kind, "ready");
});

// =============================================================================
// STARK-579 — GitHub-mergeability gate. The required-check ROLLUP is assembled
// only from the contexts already attached to the head SHA, so a slow REQUIRED
// check that has not registered a context yet is ABSENT — the rollup reads green
// over an incomplete required set and the watcher fired at consecutiveGreen=2,
// only for GitHub's branch protection to reject the merge (Atlas#73). The gate
// defers to GitHub's own verdict before letting the callback fire.
// =============================================================================

test("mergeStateBlocksFiring: BLOCKED and UNKNOWN block; mergeable states do not", () => {
  assert.equal(mergeStateBlocksFiring("BLOCKED"), true);
  assert.equal(mergeStateBlocksFiring("UNKNOWN"), true);
  assert.equal(mergeStateBlocksFiring("CLEAN"), false);
  // UNSTABLE = mergeable, only NON-required checks outstanding — must fire, or the
  // design's deliberate refusal to wait on non-required checks would regress.
  assert.equal(mergeStateBlocksFiring("UNSTABLE"), false);
  assert.equal(mergeStateBlocksFiring("HAS_HOOKS"), false);
  assert.equal(mergeStateBlocksFiring("BEHIND"), false);
});

test("decideBlockedTransition: waits inside the grace window, terminal past it", () => {
  assert.equal(decideBlockedTransition(0), "wait");
  assert.equal(decideBlockedTransition(MERGE_BLOCKED_GRACE_SEC - 1), "wait");
  assert.equal(decideBlockedTransition(MERGE_BLOCKED_GRACE_SEC), "terminal");
  assert.equal(decideBlockedTransition(MERGE_BLOCKED_GRACE_SEC + 600), "terminal");
});

test("decideBlockedTransition: grace window is configurable", () => {
  assert.equal(decideBlockedTransition(10, 60), "wait");
  assert.equal(decideBlockedTransition(60, 60), "terminal");
});

// The core of the fix: a rollup that reads green must NOT fire while GitHub still
// blocks the merge. The downgrade is marked `blocked` so the loop can time-bound
// it (decideBlockedTransition) exactly as it does vacuous/skipped.
test("applyMergeStateGate: ready + BLOCKED downgrades to a blocked wait", () => {
  const r = applyMergeStateGate({ kind: "ready", reason: "all required passing" }, "BLOCKED");
  assert.equal(r.kind, "wait");
  assert.equal(r.blocked, true);
  assert.equal(r.mergeState, "BLOCKED");
});

test("applyMergeStateGate: ready + UNKNOWN downgrades to a blocked wait", () => {
  const r = applyMergeStateGate({ kind: "ready", reason: "all required passing" }, "UNKNOWN");
  assert.equal(r.kind, "wait");
  assert.equal(r.blocked, true);
  assert.equal(r.mergeState, "UNKNOWN");
});

// Non-vacuity: the gate must let a genuinely mergeable PR through, or the watcher
// would never merge anything. CLEAN and UNSTABLE both fire, mergeState stamped.
test("applyMergeStateGate: ready + CLEAN stays ready and stamps mergeState", () => {
  const r = applyMergeStateGate({ kind: "ready", reason: "all required passing" }, "CLEAN");
  assert.equal(r.kind, "ready");
  assert.ok(!r.blocked);
  assert.equal(r.mergeState, "CLEAN");
});

test("applyMergeStateGate: ready + UNSTABLE stays ready", () => {
  const r = applyMergeStateGate({ kind: "ready", reason: "all required passing" }, "UNSTABLE");
  assert.equal(r.kind, "ready");
  assert.ok(!r.blocked);
});

// A non-ready outcome is never rewritten: a failing or pending rollup already
// decided, and the mergeability gate must not touch it even under BLOCKED.
test("applyMergeStateGate: non-ready outcomes pass through untouched", () => {
  const failing = applyMergeStateGate({ kind: "fatal", reason: "failing checks: 1" }, "BLOCKED");
  assert.equal(failing.kind, "fatal");
  const waiting = applyMergeStateGate({ kind: "wait", reason: "pending: 1" }, "BLOCKED");
  assert.equal(waiting.kind, "wait");
  assert.ok(!waiting.blocked);
});

// =============================================================================
// STARK-1053 — the watcher must not treat a vacuous rollup as terminal during the
// post-force-push pre-registration window. atlas#102 force-pushed, the rollup read
// zero required contexts before atlas-gate attached, and the watcher gave up at
// the 300s vacuous grace; #102 then sat green+CLEAN+MERGEABLE for ~90 min, unmerged.
// The fix: GitHub's own mergeStateStatus disambiguates a pre-registration vacuous
// (BLOCKED → wait/re-fire) from a genuinely-unprotected base (CLEAN → the existing
// vacuous terminal).
// =============================================================================

test("applyMergeStateGate: vacuous + BLOCKED becomes a re-fireable blocked wait", () => {
  const r = applyMergeStateGate(
    { kind: "wait", reason: "no required checks observed yet", vacuous: true },
    "BLOCKED",
  );
  assert.equal(r.kind, "wait");
  assert.equal(r.blocked, true);
  assert.equal(r.refireable, true);
  assert.equal(r.mergeState, "BLOCKED");
  // Dropping the vacuous flag is load-bearing: it routes the loop AWAY from the
  // 300s no_required_checks terminal and INTO the bounded blocked/re-fire path.
  assert.ok(!r.vacuous, "must drop the vacuous flag");
});

test("applyMergeStateGate: vacuous + UNKNOWN becomes a re-fireable blocked wait", () => {
  const r = applyMergeStateGate({ kind: "wait", vacuous: true }, "UNKNOWN");
  assert.equal(r.blocked, true);
  assert.equal(r.refireable, true);
  assert.ok(!r.vacuous);
});

// The genuinely-unprotected base (kotodama#861): a vacuous rollup GitHub does NOT
// block is a real vacuous pass. It must STAY vacuous so the existing 300s terminal
// names --allow-no-required-checks — never reclassified as blocked/refireable.
test("applyMergeStateGate: vacuous + CLEAN stays vacuous, not blocked", () => {
  const r = applyMergeStateGate({ kind: "wait", vacuous: true }, "CLEAN");
  assert.equal(r.kind, "wait");
  assert.equal(r.vacuous, true);
  assert.ok(!r.blocked);
  assert.ok(!r.refireable);
  assert.equal(r.mergeState, "CLEAN");
});

test("applyMergeStateGate: vacuous + UNSTABLE stays vacuous", () => {
  const r = applyMergeStateGate({ kind: "wait", vacuous: true }, "UNSTABLE");
  assert.equal(r.vacuous, true);
  assert.ok(!r.blocked);
});

// A green-but-BLOCKED wait (STARK-579) stays NON-refireable: the suite demonstrably
// ran, so close+reopen would re-run the whole set and, for a missing review, do
// nothing. Only the ZERO-required-contexts case is a dropped-webhook signature.
test("applyMergeStateGate: ready + BLOCKED is blocked but NOT refireable", () => {
  const r = applyMergeStateGate({ kind: "ready", reason: "all required passing" }, "BLOCKED");
  assert.equal(r.blocked, true);
  assert.ok(!r.refireable);
});

test("decideRefireTransition: waits inside the registration window", () => {
  assert.equal(decideRefireTransition(0, 0), "wait");
  assert.equal(decideRefireTransition(CHECK_REGISTRATION_REFIRE_SEC - 1, 0), "wait");
});

test("decideRefireTransition: re-fires once the window elapses with budget unspent", () => {
  assert.equal(decideRefireTransition(CHECK_REGISTRATION_REFIRE_SEC, 0), "refire");
});

test("decideRefireTransition: budget spent → waits inside grace, terminal past it", () => {
  assert.equal(decideRefireTransition(CHECK_REGISTRATION_REFIRE_SEC, MAX_CHECK_REFIRES), "wait");
  assert.equal(decideRefireTransition(MERGE_BLOCKED_GRACE_SEC, MAX_CHECK_REFIRES), "terminal");
});

// Re-fire is tested BEFORE terminal: a state that jumped past both bounds (a long
// poll gap under rate limiting) still gets its one cure attempt before we abandon it.
test("decideRefireTransition: re-fire takes precedence over terminal when never fired", () => {
  assert.equal(decideRefireTransition(MERGE_BLOCKED_GRACE_SEC + 100, 0), "refire");
});

test("decideRefireTransition: windows are configurable", () => {
  const o = { refireAfterSec: 10, maxRefires: 1, terminalAfterSec: 30 };
  assert.equal(decideRefireTransition(5, 0, o), "wait");
  assert.equal(decideRefireTransition(10, 0, o), "refire");
  assert.equal(decideRefireTransition(30, 1, o), "terminal");
});

test("MAX_CHECK_REFIRES is 1 — one automatic close+reopen per blocked episode", () => {
  assert.equal(MAX_CHECK_REFIRES, 1);
});

// refirePrViaReopen: close THEN reopen (order-sensitive), reopen retried, and a
// reopen that never lands surfaces LEFT_CLOSED so the watcher stops loudly rather
// than strand the PR closed. A close that itself fails leaves the PR intact.
test("refirePrViaReopen: closes then reopens in order on the happy path", () => {
  const calls: string[] = [];
  const exec = (_cmd: string, args: string[]) => {
    calls.push(args.slice(0, 2).join(" "));
    return Buffer.from("");
  };
  refirePrViaReopen(42, "o/r", { exec: exec as never });
  assert.deepEqual(calls, ["pr close", "pr reopen"]);
});

test("refirePrViaReopen: retries a failing reopen and succeeds within budget", () => {
  const closes: number[] = [];
  let reopenTries = 0;
  const exec = (_cmd: string, args: string[]) => {
    const verb = args.slice(0, 2).join(" ");
    if (verb === "pr close") closes.push(1);
    if (verb === "pr reopen") {
      reopenTries++;
      if (reopenTries < 3) throw new Error("502 server error");
    }
    return Buffer.from("");
  };
  refirePrViaReopen(42, "o/r", { exec: exec as never, reopenAttempts: 5 });
  assert.equal(reopenTries, 3);
  assert.equal(closes.length, 1, "close is issued exactly once");
});

test("refirePrViaReopen: LEFT_CLOSED when close succeeds but every reopen fails", () => {
  const exec = (_cmd: string, args: string[]) => {
    if (args.slice(0, 2).join(" ") === "pr reopen") throw new Error("reopen boom");
    return Buffer.from("");
  };
  assert.throws(
    () => refirePrViaReopen(42, "o/r", { exec: exec as never, reopenAttempts: 3 }),
    /LEFT_CLOSED/,
  );
});

test("refirePrViaReopen: a failing close throws plain (no LEFT_CLOSED), PR intact", () => {
  const exec = (_cmd: string, args: string[]) => {
    if (args.slice(0, 2).join(" ") === "pr close") throw new Error("close denied");
    return Buffer.from("");
  };
  assert.throws(
    () => refirePrViaReopen(42, "o/r", { exec: exec as never }),
    (err: Error) => /close denied/.test(err.message) && !/LEFT_CLOSED/.test(err.message),
  );
});

// =============================================================================
// STARK-1053 review round 2 — a vacuous+BLOCKED reading is only re-fireable when
// the block is NOT a required review. mergeStateStatus alone cannot tell a
// missing check from a missing review; reviewDecision does. A close+reopen cannot
// supply a review, so a review-blocked PR must route to merge_blocked, never get
// churned — the same carve-out the ready+BLOCKED path already makes.
// =============================================================================

test("applyMergeStateGate: vacuous + BLOCKED + REVIEW_REQUIRED is blocked but NOT refireable", () => {
  const r = applyMergeStateGate(
    { kind: "wait", vacuous: true }, "BLOCKED", { reviewDecision: "REVIEW_REQUIRED" },
  );
  assert.equal(r.blocked, true);
  assert.ok(!r.refireable, "a required review cannot be cured by close+reopen");
  assert.match(r.reason!, /review/i);
});

test("applyMergeStateGate: vacuous + BLOCKED + CHANGES_REQUESTED is blocked but NOT refireable", () => {
  const r = applyMergeStateGate(
    { kind: "wait", vacuous: true }, "BLOCKED", { reviewDecision: "CHANGES_REQUESTED" },
  );
  assert.equal(r.blocked, true);
  assert.ok(!r.refireable);
});

test("applyMergeStateGate: vacuous + BLOCKED + APPROVED stays refireable (block is not the review)", () => {
  const r = applyMergeStateGate(
    { kind: "wait", vacuous: true }, "BLOCKED", { reviewDecision: "APPROVED" },
  );
  assert.equal(r.blocked, true);
  assert.equal(r.refireable, true);
});

test("applyMergeStateGate: vacuous + BLOCKED + no review gate stays refireable", () => {
  const r = applyMergeStateGate({ kind: "wait", vacuous: true }, "BLOCKED", { reviewDecision: "" });
  assert.equal(r.refireable, true);
});

test("MAX_REFIRE_ATTEMPTS bounds transient-close retries above the single-recovery cap", () => {
  assert.ok(MAX_REFIRE_ATTEMPTS >= 1);
  assert.ok(MAX_REFIRE_ATTEMPTS >= MAX_CHECK_REFIRES);
});

// reopenPr is idempotent (like markPrReady): an "already open" reopen is a no-op
// success, so refirePrViaReopen's retry after a silently-applied reopen cannot
// manufacture a false LEFT_CLOSED. A genuine failure still throws.
test("reopenPr: swallows an 'already open' error as success", () => {
  const exec = () => { throw new Error("! Pull request #42 is already open"); };
  assert.doesNotThrow(() => reopenPr(42, "o/r", { exec: exec as never }));
});

test("reopenPr: rethrows a non-idempotent failure (e.g. cannot be reopened / auth)", () => {
  const exec = () => { throw new Error("Pull request #42 cannot be reopened because it was merged"); };
  assert.throws(() => reopenPr(42, "o/r", { exec: exec as never }), /cannot be reopened/);
});
