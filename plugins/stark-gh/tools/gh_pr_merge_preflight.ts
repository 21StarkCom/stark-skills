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
// matches a guarded prefix — but only in the stark-skills repo itself. The
// guarded prefixes are generic dir names (tools/, scripts/, …) that exist in
// unrelated repos too, and the gate exists to stop the tool rewriting its own
// runtime mid-run, not to police other repos' merges. Matched by repo NAME
// (not owner/name) so an org migration doesn't silently disable the guard.
const SELF_REPO_NAME = "stark-skills";

export function isSelfModifying(
  files: { path: string }[],
  repoNameWithOwner: string,
): { offending: string | null } {
  const repoName = repoNameWithOwner.split("/").pop() ?? "";
  if (repoName !== SELF_REPO_NAME) return { offending: null };
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
  const sm = isSelfModifying(pr.files, repoInfo.nameWithOwner);
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

  // Step 11: capture pre-edit CHANGELOG.md to durable tempfile
  const changelogPath = path.resolve("CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    restoreToOriginalHead();
    die(MergeExit.NO_CHANGELOG, `CHANGELOG.md not found at repo root`);
  }
  const changelogContent = fs.readFileSync(changelogPath, "utf8");
  if (!/^## \[Unreleased\]\s*$/m.test(changelogContent)) {
    restoreToOriginalHead();
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
    restoreToOriginalHead();
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
      wasDraft: pr.isDraft === true,
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
