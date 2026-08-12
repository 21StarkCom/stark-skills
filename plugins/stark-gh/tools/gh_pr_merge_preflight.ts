#!/usr/bin/env node
// Stage 1 / Preflight for /stark-gh:pr-merge.
// Sequence (per design + plan-review fixes):
//   1. Parse --raw-args
//   2. Working-tree gate (--force does not bypass)
//   3. Resolve PR (--pr N or current branch)
//   4. (retired: self-modifying PR gate — see the note at lib/exit.ts's hole at 19)
//   5. Watcher-recovery / resume detection (pre-emption deferred to step 10)
//   6. Reject fork PRs BEFORE fetch
//   7. Fetch with explicit destination refspecs
//   8. PR identity (rt1) + local sync gate, then PR-state gates (gate matrix)
//   9. Pre-LLM secret scan (BEFORE rebase)
//  10. Rebase
//  11. Capture pre-edit CHANGELOG.md to durable tempfile
//  12. Resolve changelog section
//  13. Pre-plan-write base re-check
//  14. Generate runId + write plan-file
//  15. Emit STARK_GH_RESUME=<mode> if applicable, then plan-file path

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { tokenize } from "./lib/shell_quote.ts";
import { MergeExit } from "./lib/exit.ts";
import { die } from "./lib/output.ts";
import * as gitLib from "./lib/git.ts";
import * as ghLib from "./lib/gh.ts";
import { writePrMergePlan, type PrMergePlan } from "./lib/plan.ts";
import { ensureRuntimeDirs, mktempInRuntime } from "./lib/runtime.ts";
import { scanSecrets } from "./lib/secret.ts";
import { evaluateLockLiveness, lockKind, preemptCiObserver, readLock, watcherLockPath, watcherStateLatestPath } from "./lib/watcher_lock.ts";
import { appendPrMergeOverride, SECRET_TO_LLM_WARNING } from "./lib/audit.ts";
import { resolveDraftConfig } from "./lib/config.ts";
import { fetchRequiredCheckRollup, summarizeVerdict } from "./lib/checks_graphql.ts";

export interface MergeUserArgs {
  pr: number | null;                    // --pr N
  changelogSection: PrMergePlan["changelog"]["section"] | null;
  force: boolean;
  forceReason: string | null;
  noWatch: boolean;
  watchTimeoutHours: number;            // default 6
  allowSecretCommit: boolean;
  allowSecretToLlm: boolean;
  allowNoRequiredChecks: boolean;
  allowSkippedChecks: boolean;
}

const DEFAULT_WATCH_TIMEOUT_HOURS = 6;
const VALID_SECTIONS = new Set(["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"]);

export function parseRawArgs(raw: string): MergeUserArgs {
  const tokens = tokenize(raw);
  const a: MergeUserArgs = {
    pr: null,
    changelogSection: null,
    force: false,
    forceReason: null,
    noWatch: false,
    watchTimeoutHours: DEFAULT_WATCH_TIMEOUT_HOURS,
    allowSecretCommit: false,
    allowSecretToLlm: false,
    allowNoRequiredChecks: false,
    allowSkippedChecks: false,
  };
  const need = (i: number, flag: string): string => {
    if (i >= tokens.length) throw new Error(`flag ${flag} requires a value`);
    return tokens[i]!;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^-?\d+$/.test(t)) {
      if (a.pr !== null) throw new Error(`--pr already set; cannot also pass bare PR number ${t}`);
      const v = Number(t);
      if (!Number.isInteger(v) || v <= 0) throw new Error(`bare PR number must be a positive integer; got ${t}`);
      a.pr = v;
      continue;
    }
    switch (t) {
      case "--pr": {
        if (a.pr !== null) throw new Error(`--pr already set; cannot also pass --pr`);
        const v = Number(need(++i, t));
        if (!Number.isInteger(v) || v <= 0) throw new Error(`--pr must be a positive integer; got ${tokens[i]}`);
        a.pr = v;
        break;
      }
      case "--changelog-section": {
        const v = need(++i, t);
        if (!VALID_SECTIONS.has(v)) {
          throw new Error(`--changelog-section invalid: ${v}; expected Added|Changed|Fixed|Removed|Deprecated|Security`);
        }
        a.changelogSection = v as PrMergePlan["changelog"]["section"];
        break;
      }
      case "--force":
        a.force = true;
        break;
      case "--force-reason":
        a.forceReason = need(++i, t);
        break;
      case "--no-watch":
        a.noWatch = true;
        break;
      case "--watch-timeout": {
        const v = Number(need(++i, t));
        if (!(v > 0)) throw new Error(`--watch-timeout must be positive number of hours; got ${tokens[i]}`);
        a.watchTimeoutHours = v;
        break;
      }
      case "--allow-secret-commit":
        a.allowSecretCommit = true;
        break;
      case "--allow-secret-to-llm":
        a.allowSecretToLlm = true;
        break;
      case "--allow-no-required-checks":
        a.allowNoRequiredChecks = true;
        break;
      case "--allow-skipped-checks":
        a.allowSkippedChecks = true;
        break;
      default:
        throw new Error(`unknown flag: ${t}`);
    }
  }
  if (a.force && (!a.forceReason || a.forceReason.trim() === "")) {
    throw new Error("--force requires --force-reason <text>");
  }
  return a;
}

// Inferred changelog section: bug/fix label → Fixed, else a `fix(...)` /
// `revert(...)` conventional-commit title type → Fixed, else Added.
//
// Labels alone were not enough: this repo files no labels at all, so every PR
// — including deletions and bug fixes — landed its bullet under `### Added`.
// That is not cosmetic. `tools/release_changelog.ts::recommendBump` reads
// `added.length > 0` as "feature", so a patch-only cycle silently became a
// minor release. The title carries the type the labels don't.
const FIX_TYPE_TITLE = /^(fix|bugfix|revert)(\([^)]*\))?!?:/i;

export function inferSection(
  labels: { name: string }[],
  title = "",
): PrMergePlan["changelog"]["section"] {
  for (const { name } of labels) {
    const n = name.toLowerCase();
    if (n === "bug" || n === "fix" || n.startsWith("bug:") || n.startsWith("fix:")) return "Fixed";
  }
  if (FIX_TYPE_TITLE.test(title.trim())) return "Fixed";
  return "Added";
}

// Working-tree gate. Returns null if clean, else a marker name describing the
// blocker. Pure-fn variant for tests; CLI wraps with real fs/git calls.
export function workingTreeBlocker(args: {
  porcelain: string;
  gitDir: string;
  exists: (p: string) => boolean;
}): string | null {
  if (args.porcelain.trim().length > 0) return "dirty-tree";
  const op = gitLib.inProgressGitOp(args.gitDir, args.exists);
  return op;
}

// =============================================================================
// CLI orchestration. Each helper above is unit-testable; main() composes them.
// =============================================================================

async function main(argv: string[]): Promise<number> {
  // Locate --raw-args / --emit-plan-path
  let rawArgs: string | null = null;
  let emitPlanPath = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--raw-args") {
      if (i + 1 >= argv.length) {
        die(MergeExit.BAD_ARGS, "--raw-args requires a value");
      }
      rawArgs = argv[++i]!;
    } else if (t === "--emit-plan-path") {
      emitPlanPath = true;
    }
  }
  if (rawArgs === null) {
    die(MergeExit.BAD_ARGS, "--raw-args is required");
  }

  let userArgs: MergeUserArgs;
  try {
    userArgs = parseRawArgs(rawArgs);
  } catch (err) {
    die(MergeExit.BAD_ARGS, `argument parse error: ${(err as Error).message}`);
  }

  // Always-on overrides audit (write before any auditable gate per plan H15).
  const runId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const user = os.userInfo().username || "unknown";
  const hostname = os.hostname();
  if (userArgs.force) {
    appendPrMergeOverride({ timestamp: stamp, runId, pr: userArgs.pr ?? -1, flag: "--force",
      user, hostname, reason: userArgs.forceReason || "" });
  }
  if (userArgs.allowSecretCommit) {
    appendPrMergeOverride({ timestamp: stamp, runId, pr: userArgs.pr ?? -1, flag: "--allow-secret-commit",
      user, hostname, reason: userArgs.forceReason || "" });
  }
  if (userArgs.allowSecretToLlm) {
    appendPrMergeOverride({ timestamp: stamp, runId, pr: userArgs.pr ?? -1, flag: "--allow-secret-to-llm",
      user, hostname, reason: userArgs.forceReason || "" });
    process.stderr.write(SECRET_TO_LLM_WARNING + "\n");
  }

  // Step 2: working-tree gate
  if (!gitLib.isGitRepo()) {
    die(MergeExit.BAD_ARGS, "not in a git repository");
  }
  const gitDir = gitLib.git(["rev-parse", "--git-dir"]).trim();
  const wtBlocker = workingTreeBlocker({
    porcelain: gitLib.statusPorcelain(),
    gitDir,
    exists: fs.existsSync,
  });
  if (wtBlocker) {
    die(MergeExit.CONFLICT_OR_DIRTY, `working tree blocked: ${wtBlocker}`);
  }
  const startingRef = gitLib.symbolicHead();

  // Step 3: resolve PR.
  // Both gh calls throw on non-zero exit (execFileSync). Unhandled, that leaves
  // main() through the top-level catch as a generic exit 1 with a raw gh
  // message — while the very next branch promises BAD_ARGS (10) for the same
  // class of failure. Catch both so a typo'd --pr, an unauthed gh, or a
  // remote-less checkout all report the documented code.
  let repoInfo: ReturnType<typeof ghLib.repoView>;
  try {
    repoInfo = ghLib.repoView();
  } catch (err) {
    die(MergeExit.BAD_ARGS, `cannot resolve repo via gh: ${(err as Error).message}`);
  }
  let pr: ReturnType<typeof ghLib.fetchMergePrForCurrentBranch>;
  if (userArgs.pr !== null) {
    try {
      pr = ghLib.fetchMergePrByNumber(userArgs.pr, repoInfo.nameWithOwner);
    } catch (err) {
      die(MergeExit.BAD_ARGS, `cannot resolve PR #${userArgs.pr} in ${repoInfo.nameWithOwner}: ${(err as Error).message}`);
    }
  } else {
    pr = ghLib.fetchMergePrForCurrentBranch();
  }
  if (!pr) {
    die(MergeExit.BAD_ARGS, "no PR for current branch; pass --pr N");
  }

  // Step 5: watcher-recovery / resume detection
  let pendingPreempt: { pid: number; lockPath: string } | null = null;
  const dirs = ensureRuntimeDirs();
  const latestPath = watcherStateLatestPath(repoInfo.host, repoInfo.owner, repoInfo.name, pr.number, dirs.watchers);
  const lockPath = watcherLockPath(latestPath);
  const existingLock = readLock(lockPath);
  if (existingLock !== null) {
    const liveness = evaluateLockLiveness(existingLock);
    const kind = lockKind(existingLock);
    if (liveness.alive && kind === "ci-observer") {
      // A pr-open CI watcher is only REPORTING checks on the current head. We
      // are about to rebase and force-push, which makes that head — and hence
      // everything it is watching — obsolete. Blocking on it made
      // `pr-open --ready` immediately followed by `pr-merge` fail with exit 34
      // until the observer aged out on its own poll cadence. Pre-empt it.
      //
      // But NOT here. Pre-emption SIGKILLs another process and unlinks its
      // lock, and every gate between this point and the rebase can still
      // refuse the merge (fork PR, closed/merged, CHANGES_REQUESTED, failing
      // required check, secret hit). Killing first meant a refused merge left
      // the operator with no CI watcher and no notification, for a PR this run
      // never touched. Defer it to the last moment before the rebase, which is
      // still before the force-push that invalidates the watched head.
      pendingPreempt = { pid: (existingLock as { pid: number }).pid, lockPath };
    } else if (liveness.alive) {
      // A live merge-driver (or an unclassifiable lock, handled conservatively)
      // will itself mark-ready and merge — do not race it.
      process.stdout.write(`STARK_GH_RESUME=attached\n`);
      process.stdout.write(`${latestPath}\n`);
      die(MergeExit.WATCHER_RUNNING,
        `watcher already running for PR #${pr.number} (${liveness.reason}, kind=${kind}); state: ${latestPath}`);
    } else {
      // Stale lock: log and proceed (next watcher write replaces).
      process.stderr.write(`stale watcher lock taken over: ${liveness.reason}\n`);
    }
  }

  // Step 6: reject fork PRs BEFORE fetch (gate matrix v1).
  // Fetching pr.headRefName from origin would fail with a generic git error
  // for fork PRs because origin doesn't have the head ref; rejecting first
  // produces the spec-mandated FORK_OR_HEAD_MISMATCH exit code.
  if (pr.isCrossRepository) {
    die(MergeExit.FORK_OR_HEAD_MISMATCH, `cross-repository (fork) PRs unsupported in v1`);
  }

  // Step 7: fetch with explicit destination refspecs
  gitLib.fetchRefs("origin", [pr.baseRefName, pr.headRefName]);

  // Step 8: PR identity + local sync
  const remoteHeadOid = gitLib.revParse(`refs/remotes/origin/${pr.headRefName}`);
  if (remoteHeadOid !== pr.headRefOid) {
    die(MergeExit.FORK_OR_HEAD_MISMATCH,
      `origin/${pr.headRefName} (${remoteHeadOid}) != PR headRefOid (${pr.headRefOid}); rerun after fetch settles`);
  }
  // Local sync: only enforced if local head ref exists (i.e., we're working
  // on this branch).
  let localHeadOid: string | null = null;
  try {
    localHeadOid = gitLib.revParse(`refs/heads/${pr.headRefName}`);
  } catch {
    // local branch doesn't exist; we'll create it via checkout
    localHeadOid = null;
  }
  if (localHeadOid !== null && localHeadOid !== remoteHeadOid) {
    die(MergeExit.LOCAL_DIVERGED,
      `local ${pr.headRefName} (${localHeadOid}) differs from origin/${pr.headRefName} (${remoteHeadOid}); push or reset before merging`);
  }

  // Step 8: PR-state gates (gate matrix)
  if (pr.state !== "OPEN") {
    die(MergeExit.PR_GATE, `PR is ${pr.state}, not OPEN`);
  }
  if (pr.mergeable === "CONFLICTING") {
    die(MergeExit.CONFLICT_OR_DIRTY, `PR is CONFLICTING; resolve conflicts first`);
  }
  // Draft-by-default policy: a WIP PR is EXPECTED to be a draft at merge time.
  // pr-merge un-drafts it (execute marks it ready after push, which fires the
  // target-repo CI), so a draft is no longer a rejection — it's recorded in the
  // plan (pr.wasDraft, set above) and the execute step handles the transition.
  // --force-bypassable gates
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !userArgs.force) {
    die(MergeExit.PR_GATE, `PR has CHANGES_REQUESTED; pass --force --force-reason to override`);
  }

  // Gate Matrix row "Any required check failing": query the rollup against the
  // pre-rebase head OID and reject up front if any required check is in a
  // failing state. This is --force-bypassable per the gate matrix. Pending
  // checks are tolerated here (default-watch will wait; --no-watch enforces a
  // green requirement at execute time per spec section 145).
  //
  // SKIP entirely when the PR is still a draft: draft-guarded CI has not run
  // yet (and a vacuous rollup would false-trip the "no required checks" trap).
  // Execute marks the PR ready after push, which fires the CI the watcher then
  // waits on. A --no-watch merge of a draft still gets its green enforced at
  // execute time, post-mark-ready.
  if (!pr.isDraft) try {
    const preflightRollup = await fetchRequiredCheckRollup({
      owner: pr.headRepositoryOwner?.login ?? repoInfo.owner,
      repo: pr.headRepository?.name ?? repoInfo.name,
      prNumber: pr.number,
      expectedHeadOid: pr.headRefOid,
    });
    if (!preflightRollup.mismatch && preflightRollup.contexts) {
      const verdict = summarizeVerdict(preflightRollup.contexts);
      if (verdict.anyFailing && !userArgs.force) {
        die(MergeExit.CHECK_FAIL,
          `required checks failing on ${pr.headRefOid} (failing=${verdict.failing}); pass --force --force-reason to override`);
      }
      // Catch the watcher-hang trap upfront: if branch protection lists no
      // required checks for this PR's base, the rollup is vacuous and the
      // watcher's REQUIRED_GREEN gate can never advance — every merge run
      // would silently poll until the 6h timeout. Surface it now with an
      // actionable error instead of trapping the operator.
      if (verdict.vacuous && !userArgs.allowNoRequiredChecks && !userArgs.force) {
        die(MergeExit.CHECK_FAIL,
          `no required checks configured for ${pr.baseRefName} on ${repoInfo.owner}/${repoInfo.name} ` +
          `(rollup reports ${preflightRollup.contexts.length} context(s), 0 marked isRequired). ` +
          `The watcher would hang waiting for required checks that do not exist. ` +
          `Fix the configuration (add a branch protection rule / ruleset on ${pr.baseRefName} ` +
          `that requires the relevant CheckRun) or pass --allow-no-required-checks to acknowledge ` +
          `the vacuous-pass and proceed.`);
      }
    }
    // mismatch (PR head moved between gh-pr-view and the rollup query) is
    // benign here — the head-identity gate above already enforces parity, and
    // the --no-watch path re-verifies post-push.
  } catch (err) {
    // GraphQL transport / auth errors. Without --force, surface and stop —
    // silently bypassing the gate would defeat its purpose. With --force the
    // operator is overriding gate-matrix rejections anyway, so a network
    // hiccup should not block them.
    if (!userArgs.force) {
      die(MergeExit.CHECK_FAIL,
        `required-check rollup query failed: ${(err as Error).message}; rerun once GitHub API is reachable, or pass --force to bypass`);
    }
    process.stderr.write(`required-check rollup query failed (--force in effect; continuing): ${(err as Error).message}\n`);
  }

  const baseOid = gitLib.revParse(`refs/remotes/origin/${pr.baseRefName}`);

  // Step 9: pre-LLM secret scan (BEFORE rebase per H08/H32)
  // We scan against just-fetched refs so failure leaves user's branch untouched.
  // Title/body are now part of MergePrMetadata, so scanning them is a free
  // per-spec inclusion — a token pasted into the PR description is otherwise
  // sent to Codex via the Stage 2 prompt without --allow-secret-to-llm.
  const commitMessages = gitLib.logMessages(`origin/${pr.baseRefName}`, `origin/${pr.headRefName}`);
  const diff = gitLib.diffRange(`origin/${pr.baseRefName}`, `origin/${pr.headRefName}`);
  const scanInputs = [
    pr.headRefName,           // benign in practice; scan anyway for symmetry with pr-open
    pr.title,
    pr.body,
    commitMessages,
    diff,
  ].join("\n\n");
  const llmHits = scanSecrets(scanInputs);
  if (llmHits.length > 0 && !userArgs.allowSecretToLlm) {
    die(MergeExit.SECRET_LLM,
      `secrets detected pre-LLM: ${llmHits.map(h => h.category).join(", ")}; pass --allow-secret-to-llm to override`);
  }

  // Every gate that can refuse this merge has now passed, so pre-empting the
  // pr-open CI observer (detected at Step 5) can no longer orphan a watcher
  // for a merge we then decline. The rebase + force-push below is what makes
  // its watched head obsolete.
  if (pendingPreempt) {
    preemptCiObserver(pendingPreempt.pid, pendingPreempt.lockPath);
    process.stderr.write(
      `pre-empted pr-open CI watcher (pid ${pendingPreempt.pid}) for PR #${pr.number}: `
      + `its head becomes obsolete at force-push\n`);
  }

  // Step 10: rebase
  // The checkout is inside the try: a head ref held by another worktree fails
  // with `fatal: '<ref>' is already used by worktree at …`, and left unguarded
  // that escaped main() as a generic exit 1 instead of a stable MergeExit.
  let checkedOut = false;
  try {
    gitLib.checkout(pr.headRefName);
    checkedOut = true;
    gitLib.rebaseOnto(`refs/remotes/origin/${pr.baseRefName}`);
  } catch (err) {
    try { gitLib.abortRebase(); } catch { /* nothing to abort */ }
    try { gitLib.checkout(startingRef); } catch { /* best-effort */ }
    const what = checkedOut
      ? `rebase onto origin/${pr.baseRefName} failed`
      : `cannot check out ${pr.headRefName} (is it checked out in another worktree?)`;
    die(MergeExit.CONFLICT_OR_DIRTY, `${what}: ${(err as Error).message}`);
  }
  const rebasedHeadOid = gitLib.headOid();

  // Restore helper used by every post-rebase failure path. We are currently
  // checked out on pr.headRefName (Step 10), so a bare `update-ref +
  // checkout startingRef` would leave the worktree+index at the rebased
  // state when startingRef equals the PR branch (parity with the F4 fix in
  // restore_branch.ts). Use `git reset --hard` to atomically move HEAD,
  // index, and worktree, then checkout startingRef only if it differs.
  const restoreToOriginalHead = (): void => {
    gitLib.resetHard(pr.headRefOid);
    if (startingRef !== pr.headRefName) {
      try { gitLib.checkout(startingRef); } catch { /* best-effort */ }
    }
  };

  // Step 11: capture pre-edit CHANGELOG.md to durable tempfile.
  // A repo with no root CHANGELOG.md skips the changelog machinery wholesale
  // (edit, commit, restore). A CHANGELOG that exists but lacks the
  // '## [Unreleased]' section is still a hard error — that is a malformed
  // changelog, not the absence of one.
  const changelogPath = path.resolve("CHANGELOG.md");
  let preEditPath: string | null = null;
  if (fs.existsSync(changelogPath)) {
    const changelogContent = fs.readFileSync(changelogPath, "utf8");
    if (!/^## \[Unreleased\]\s*$/m.test(changelogContent)) {
      restoreToOriginalHead();
      die(MergeExit.NO_CHANGELOG, `CHANGELOG.md missing '## [Unreleased]' section`);
    }
    preEditPath = path.join(dirs.runtime, `${runId}-changelog-pre-edit.md`);
    fs.writeFileSync(preEditPath, changelogContent, { mode: 0o600 });
  } else {
    process.stderr.write(`no CHANGELOG.md at repo root; changelog step will be skipped\n`);
  }

  // Step 12: resolve section
  const section = userArgs.changelogSection ?? inferSection(pr.labels, pr.title);

  // Step 13: pre-plan-write base re-check
  gitLib.fetchRefs("origin", [pr.baseRefName]);
  const baseOidRecheck = gitLib.revParse(`refs/remotes/origin/${pr.baseRefName}`);
  if (baseOidRecheck !== baseOid) {
    restoreToOriginalHead();
    if (preEditPath !== null) fs.unlinkSync(preEditPath);
    die(MergeExit.BASE_OID_MOVED,
      `base ${pr.baseRefName} moved during preflight (${baseOid} → ${baseOidRecheck}); rerun`);
  }

  // Step 14: assemble + write plan
  const markerComment = `<!-- stark-gh:pr-merge pr=${pr.number} runId=${runId} -->`;
  const plan: PrMergePlan = {
    command: "pr-merge",
    schemaVersion: 1,
    createdAt: stamp,
    runId,
    pr: {
      number: pr.number,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      url: pr.url,
      nameWithOwner: repoInfo.nameWithOwner,
      headRepositoryOwner: pr.headRepositoryOwner?.login ?? repoInfo.owner,
      headRepositoryName: pr.headRepository?.name ?? repoInfo.name,
      isCrossRepository: pr.isCrossRepository,
      wasDraft: pr.isDraft === true,
    },
    baseOid,
    originalHeadOid: pr.headRefOid,
    rebasedHeadOid,
    changelogCommitOid: null,
    pushedHeadOid: null,
    originalChangelogPath: preEditPath,
    changelog: preEditPath === null ? null : { filePath: changelogPath, section, markerComment },
    startingRef,
    forceReason: userArgs.forceReason,
    stage2: (() => {
      // Resolve via shared draft config so pr-open and pr-merge get identical
      // model/reasoning validation (Haiku interlock, valid-effort enum, etc.).
      // Env-var overrides remain supported for backwards compat.
      const draftCfg = resolveDraftConfig({
        model: process.env.STARK_GH_MODEL,
        reasoningEffort: process.env.STARK_GH_REASONING,
      });
      return {
        skip: false,
        subjectFile: null,
        bodyFile: null,
        changelogBulletFile: null,
        model: draftCfg.model,
        reasoningEffort: draftCfg.reasoningEffort,
      };
    })(),
    execute: {
      watch: !userArgs.noWatch,
      force: userArgs.force,
      watchTimeoutHours: userArgs.watchTimeoutHours,
      secretOverrides: { commit: userArgs.allowSecretCommit, toLlm: userArgs.allowSecretToLlm },
      allowNoRequiredChecks: userArgs.allowNoRequiredChecks,
      allowSkippedChecks: userArgs.allowSkippedChecks,
    },
  };

  const planPath = mktempInRuntime(`stark-gh-pr-merge-plan-${runId}-XXXXXX.json`);
  writePrMergePlan(planPath, plan);

  if (emitPlanPath) {
    process.stdout.write(`${planPath}\n`);
  }
  return 0;
}

if (process.argv[1]?.endsWith("gh_pr_merge_preflight.ts")) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(err => {
    process.stderr.write(`preflight: ${err?.message || err}\n`);
    process.exit(1);
  });
}
