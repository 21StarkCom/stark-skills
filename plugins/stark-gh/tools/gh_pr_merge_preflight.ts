#!/usr/bin/env node
// Stage 1 / Preflight for /stark-gh:pr-merge.
// Sequence (per design + plan-review fixes):
//   1. Parse --raw-args
//   2. Working-tree gate (--force does not bypass)
//   3. Resolve PR (--pr N or current branch)
//   4. Self-modifying PR gate
//   5. Watcher-recovery / resume detection
//   6. Fetch with explicit destination refspecs
//   7. PR identity (rt1) + local sync gate
//   8. PR-state gates (gate matrix)
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
import { evaluateLockLiveness, readLock, watcherLockPath, watcherStateLatestPath } from "./lib/watcher_lock.ts";
import { appendPrMergeOverride, SECRET_TO_LLM_WARNING } from "./lib/audit.ts";

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
}

const DEFAULT_WATCH_TIMEOUT_HOURS = 6;
const VALID_SECTIONS = new Set(["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"]);

// Guarded path prefixes (PR4-claude H06). v1 conservatively guards every dir
// install.sh symlinks. If install.sh changes, this list must be updated.
const GUARDED_PREFIXES = [
  "plugins/stark-gh/",
  "scripts/",
  "tools/",
  "global/",
  "skill/",
  "standards/",
];

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
  };
  const need = (i: number, flag: string): string => {
    if (i >= tokens.length) throw new Error(`flag ${flag} requires a value`);
    return tokens[i]!;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "--pr": {
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
      default:
        throw new Error(`unknown flag: ${t}`);
    }
  }
  if (a.force && (!a.forceReason || a.forceReason.trim() === "")) {
    throw new Error("--force requires --force-reason <text>");
  }
  return a;
}

// Label-inferred section: bug/fix → Fixed; else Added.
export function inferSection(labels: { name: string }[]): PrMergePlan["changelog"]["section"] {
  for (const { name } of labels) {
    const n = name.toLowerCase();
    if (n === "bug" || n === "fix" || n.startsWith("bug:") || n.startsWith("fix:")) return "Fixed";
  }
  return "Added";
}

// Self-modifying PR gate (PR4-claude H06). Refuses if any changed file path
// matches a guarded prefix.
export function isSelfModifying(files: { path: string }[]): { offending: string | null } {
  for (const f of files) {
    for (const prefix of GUARDED_PREFIXES) {
      if (f.path.startsWith(prefix)) return { offending: f.path };
    }
  }
  return { offending: null };
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

  // Step 3: resolve PR
  const repoInfo = ghLib.repoView();
  const pr = userArgs.pr !== null
    ? ghLib.fetchMergePrByNumber(userArgs.pr, repoInfo.nameWithOwner)
    : ghLib.fetchMergePrForCurrentBranch();
  if (!pr) {
    die(MergeExit.BAD_ARGS, "no PR for current branch; pass --pr N");
  }

  // Step 4: self-modifying gate
  const sm = isSelfModifying(pr.files);
  if (sm.offending) {
    die(MergeExit.SELF_MODIFYING_PR,
      `PR modifies stark-skills runtime files (${sm.offending}); refuse to self-execute. Merge via plain 'gh pr merge' after manual review.`);
  }

  // Step 5: watcher-recovery / resume detection
  const dirs = ensureRuntimeDirs();
  const latestPath = watcherStateLatestPath(repoInfo.host, repoInfo.owner, repoInfo.name, pr.number, dirs.watchers);
  const lockPath = watcherLockPath(latestPath);
  const existingLock = readLock(lockPath);
  if (existingLock !== null) {
    const liveness = evaluateLockLiveness(existingLock);
    if (liveness.alive) {
      // Live watcher exists — print resume hint, exit 34.
      process.stdout.write(`STARK_GH_RESUME=attached\n`);
      process.stdout.write(`${latestPath}\n`);
      die(MergeExit.WATCHER_RUNNING,
        `watcher already running for PR #${pr.number} (${liveness.reason}); state: ${latestPath}`);
    }
    // Stale lock: log and proceed (next watcher write replaces).
    process.stderr.write(`stale watcher lock taken over: ${liveness.reason}\n`);
  }

  // Step 6: fetch with explicit destination refspecs
  gitLib.fetchRefs("origin", [pr.baseRefName, pr.headRefName]);

  // Step 7: PR identity + local sync
  const remoteHeadOid = gitLib.revParse(`refs/remotes/origin/${pr.headRefName}`);
  if (pr.isCrossRepository) {
    die(MergeExit.FORK_OR_HEAD_MISMATCH, `cross-repository (fork) PRs unsupported in v1`);
  }
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
  // --force-bypassable gates
  if (pr.isDraft && !userArgs.force) {
    die(MergeExit.PR_GATE, `PR is draft; pass --force --force-reason '<text>' to merge a draft`);
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !userArgs.force) {
    die(MergeExit.PR_GATE, `PR has CHANGES_REQUESTED; pass --force --force-reason to override`);
  }

  const baseOid = gitLib.revParse(`refs/remotes/origin/${pr.baseRefName}`);

  // Step 9: pre-LLM secret scan (BEFORE rebase per H08/H32)
  // We scan against just-fetched refs so failure leaves user's branch untouched.
  const commitMessages = gitLib.logMessages(`origin/${pr.baseRefName}`, `origin/${pr.headRefName}`);
  const diff = gitLib.diffRange(`origin/${pr.baseRefName}`, `origin/${pr.headRefName}`);
  const scanInputs = [
    pr.headRefName,           // benign in practice; scan anyway for symmetry with pr-open
    commitMessages,
    diff,
    // PR title/body would require additional gh fetches; skip for v1 — scanner
    // will catch the same secrets in the diff/messages it almost always also
    // appears in.
  ].join("\n\n");
  const llmHits = scanSecrets(scanInputs);
  if (llmHits.length > 0 && !userArgs.allowSecretToLlm) {
    die(MergeExit.SECRET_LLM,
      `secrets detected pre-LLM: ${llmHits.map(h => h.category).join(", ")}; pass --allow-secret-to-llm to override`);
  }

  // Step 10: rebase
  gitLib.checkout(pr.headRefName);
  try {
    gitLib.rebaseOnto(`refs/remotes/origin/${pr.baseRefName}`);
  } catch (err) {
    try { gitLib.abortRebase(); } catch { /* nothing to abort */ }
    try { gitLib.checkout(startingRef); } catch { /* best-effort */ }
    die(MergeExit.CONFLICT_OR_DIRTY, `rebase onto origin/${pr.baseRefName} failed: ${(err as Error).message}`);
  }
  const rebasedHeadOid = gitLib.headOid();

  // Step 11: capture pre-edit CHANGELOG.md to durable tempfile
  const changelogPath = path.resolve("CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    // Restore branch on failure
    gitLib.updateRef(`refs/heads/${pr.headRefName}`, pr.headRefOid);
    gitLib.checkout(startingRef);
    die(MergeExit.NO_CHANGELOG, `CHANGELOG.md not found at repo root`);
  }
  const changelogContent = fs.readFileSync(changelogPath, "utf8");
  if (!/^## \[Unreleased\]\s*$/m.test(changelogContent)) {
    gitLib.updateRef(`refs/heads/${pr.headRefName}`, pr.headRefOid);
    gitLib.checkout(startingRef);
    die(MergeExit.NO_CHANGELOG, `CHANGELOG.md missing '## [Unreleased]' section`);
  }
  const preEditPath = path.join(dirs.runtime, `${runId}-changelog-pre-edit.md`);
  fs.writeFileSync(preEditPath, changelogContent, { mode: 0o600 });

  // Step 12: resolve section
  const section = userArgs.changelogSection ?? inferSection(pr.labels);

  // Step 13: pre-plan-write base re-check
  gitLib.fetchRefs("origin", [pr.baseRefName]);
  const baseOidRecheck = gitLib.revParse(`refs/remotes/origin/${pr.baseRefName}`);
  if (baseOidRecheck !== baseOid) {
    gitLib.updateRef(`refs/heads/${pr.headRefName}`, pr.headRefOid);
    gitLib.checkout(startingRef);
    fs.unlinkSync(preEditPath);
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
    },
    baseOid,
    originalHeadOid: pr.headRefOid,
    rebasedHeadOid,
    changelogCommitOid: null,
    pushedHeadOid: null,
    originalChangelogPath: preEditPath,
    changelog: { filePath: changelogPath, section, markerComment },
    startingRef,
    forceReason: userArgs.forceReason,
    stage2: {
      skip: false,
      subjectFile: null,
      bodyFile: null,
      changelogBulletFile: null,
      model: process.env.STARK_GH_MODEL || "gpt-5.5",
      reasoningEffort: (process.env.STARK_GH_REASONING || "medium") as "low" | "medium" | "high",
    },
    execute: {
      watch: !userArgs.noWatch,
      force: userArgs.force,
      watchTimeoutHours: userArgs.watchTimeoutHours,
      secretOverrides: { commit: userArgs.allowSecretCommit, toLlm: userArgs.allowSecretToLlm },
      allowNoRequiredChecks: userArgs.allowNoRequiredChecks,
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
