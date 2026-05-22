#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { tokenize } from "./lib/shell_quote.ts";
import { printJson, die } from "./lib/output.ts";
import { watcherDir, prDir } from "./lib/watcher_paths.ts";
import { git, tryGit } from "./lib/git.ts";
import { ghRaw, tryGh } from "./lib/gh.ts";

// Stable exit codes. Distinct numeric range from pr-open / pr-merge namespaces.
export const CleanupExit = {
  OK: 0,
  GENERIC: 1,
  NOT_GIT_REPO: 10,
  GH_NOT_AUTHED: 11,
  DIRTY_WORKTREE: 12,
  UNRECOGNIZED_FLAG: 13,
  PR_NOT_DONE: 15,
  PROTECTED_BRANCH: 16,
  CROSS_REPO_PR: 17,
} as const;

// =============================================================================
// Args
// =============================================================================

export interface CleanupArgs {
  pr: number | null;
  dryRun: boolean;
  keepBranches: string[];
  noRebase: boolean;
  noWatcherCleanup: boolean;
  noConfig: boolean;
  noGc: boolean;
  dropStaleStashes: boolean;
  force: boolean;
  json: boolean;
}

export function parseRawArgs(raw: string): CleanupArgs {
  const tokens = tokenize(raw);
  const a: CleanupArgs = {
    pr: null,
    dryRun: false,
    keepBranches: [],
    noRebase: false,
    noWatcherCleanup: false,
    noConfig: false,
    noGc: false,
    dropStaleStashes: false,
    force: false,
    json: false,
  };
  const need = (i: number, flag: string): string => {
    if (i >= tokens.length) throw new Error(`flag ${flag} requires a value`);
    return tokens[i]!;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--pr") {
      const v = need(++i, "--pr");
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--pr must be a positive integer, got '${v}'`);
      a.pr = n;
    } else if (t === "--dry-run") {
      a.dryRun = true;
    } else if (t === "--keep-branch") {
      a.keepBranches.push(need(++i, "--keep-branch"));
    } else if (t === "--no-rebase") {
      a.noRebase = true;
    } else if (t === "--no-watcher-cleanup") {
      a.noWatcherCleanup = true;
    } else if (t === "--no-config") {
      a.noConfig = true;
    } else if (t === "--no-gc") {
      a.noGc = true;
    } else if (t === "--drop-stale-stashes") {
      a.dropStaleStashes = true;
    } else if (t === "--force") {
      a.force = true;
    } else if (t === "--json") {
      a.json = true;
    } else if (t.startsWith("-")) {
      throw new Error(`unrecognized flag '${t}'`);
    } else {
      throw new Error(`unexpected positional argument '${t}'`);
    }
  }
  return a;
}

// =============================================================================
// Repo discovery
// =============================================================================

export interface RepoCtx {
  host: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  defaultBranch: string;
  currentBranch: string;
}

export function discoverRepo(): RepoCtx {
  const out = ghRaw(["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"]);
  const j = JSON.parse(out);
  const [owner, name] = String(j.nameWithOwner).split("/");
  const url = new URL(j.url);
  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return {
    host: url.host,
    owner: owner!,
    name: name!,
    nameWithOwner: j.nameWithOwner,
    defaultBranch: j.defaultBranchRef.name,
    currentBranch,
  };
}

// =============================================================================
// Plan model
// =============================================================================

export interface LocalBranchPlan {
  name: string;
  reason: "merged-pr" | "gone-upstream" | "reachable-from-default";
  prNumber?: number;
  upstream?: string | null;
  safeDelete: boolean;
}

export interface RemoteBranchPlan {
  name: string;
  reason: "merged-pr";
  prNumber: number;
}

export interface WorktreePlan {
  path: string;
  branch: string | null;
  // "review-merged" — a detached-HEAD review worktree (review-*-prN-*) whose
  // PR is MERGED/CLOSED and whose tree is clean. The skill's branch-pinned
  // sweep never catches these because they have no branch ref.
  reason: "broken" | "branch-deleted" | "review-merged";
  prNumber?: number;
}

export interface WatcherDirPlan {
  path: string;
  prNumber: number;
  state: "MERGED" | "CLOSED";
}

// A stash whose base branch no longer exists locally. Surfaced in the plan but
// NEVER dropped unless --drop-stale-stashes is passed — a stale stash can be
// the only copy of unrecovered work.
export interface StashPlan {
  ref: string;          // stash@{N}
  baseBranch: string;   // branch the stash was taken on
  message: string;      // full `git stash list` subject
}

export interface CleanupPlan {
  repo: RepoCtx;
  protectedBranches: string[];
  fetchPruned: boolean;
  rebase: { skipped: boolean; reason?: string };
  configChanges: { key: string; value: string }[];
  localBranches: LocalBranchPlan[];
  remoteBranches: RemoteBranchPlan[];
  worktrees: WorktreePlan[];
  watcherDirs: WatcherDirPlan[];
  staleStashes: StashPlan[];
  gc: { willRun: boolean; looseObjects: number };
  notes: string[];
}

// =============================================================================
// Discovery helpers
// =============================================================================

function listLocalBranches(): { name: string; upstream: string; gone: boolean }[] {
  const out = git([
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
    "refs/heads/",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const [name, upstream, track] = line.split("\t");
      return { name: name!, upstream: upstream ?? "", gone: (track ?? "").includes("gone") };
    });
}

function listRemoteBranches(remote = "origin"): string[] {
  const out = git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`]);
  const prefix = remote + "/";
  return out
    .split("\n")
    .filter(Boolean)
    .map(s => (s.startsWith(prefix) ? s.slice(prefix.length) : s))
    .filter(s => s && s !== "HEAD");
}

function isAncestor(refA: string, refB: string): boolean {
  return tryGit(["merge-base", "--is-ancestor", refA, refB]).ok;
}

interface PrLite {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  isCrossRepository: boolean;
}

function listAllPrs(repoSlug: string): PrLite[] {
  const out = ghRaw([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--state",
    "all",
    "--limit",
    "200",
    "--json",
    "number,state,headRefName,isCrossRepository",
  ]);
  return JSON.parse(out) as PrLite[];
}

function listWorktrees(): { path: string; branch: string | null; broken: boolean }[] {
  const out = git(["worktree", "list", "--porcelain"]);
  const entries: { path: string; branch: string | null; broken: boolean }[] = [];
  let cur: { path: string; branch: string | null; broken: boolean } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, broken: false };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached" && cur) {
      cur.branch = null;
    }
  }
  if (cur) entries.push(cur);
  for (const e of entries) {
    if (!fs.existsSync(e.path)) e.broken = true;
  }
  return entries;
}

function discoverWatcherDirs(repo: RepoCtx): WatcherDirPlan[] {
  const root = path.join(watcherDir(), repo.host, repo.owner, repo.name);
  if (!fs.existsSync(root)) return [];
  const found: WatcherDirPlan[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pr-")) continue;
    const n = Number(entry.name.slice("pr-".length));
    if (!Number.isInteger(n) || n <= 0) continue;
    const r = tryGh(["pr", "view", String(n), "--repo", repo.nameWithOwner, "--json", "state"]);
    if (!r.ok) continue;
    try {
      const j = JSON.parse(r.stdout);
      if (j.state === "MERGED" || j.state === "CLOSED") {
        found.push({ path: path.join(root, entry.name), prNumber: n, state: j.state });
      }
    } catch {
      // ignore parse error; try next run
    }
  }
  return found;
}

// A review worktree path looks like `review-<repo-slug>-pr<N>-<mode>`. The
// `/stark-review` skill provisions these detached (no branch ref), so the
// branch-pinned sweep misses them once their PR merges.
function reviewWorktreePrNumber(wtPath: string): number | null {
  const base = path.basename(wtPath);
  const m = /^review-.*-pr(\d+)-/.exec(base);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function worktreeIsClean(wtPath: string): boolean {
  const r = tryGit(["-C", wtPath, "status", "--porcelain"]);
  return r.ok && r.stdout.trim() === "";
}

// Detached-HEAD review worktrees whose PR is done. Dirty ones are reported as a
// note and skipped (never force-removed without --force).
function discoverReviewWorktrees(repo: RepoCtx, args: CleanupArgs, notes: string[]): WorktreePlan[] {
  const found: WorktreePlan[] = [];
  for (const w of listWorktrees()) {
    if (w.broken || w.branch !== null) continue; // branch-pinned ones handled elsewhere
    const prNumber = reviewWorktreePrNumber(w.path);
    if (prNumber === null) continue;
    if (args.pr !== null && prNumber !== args.pr) continue;
    const r = tryGh(["pr", "view", String(prNumber), "--repo", repo.nameWithOwner, "--json", "state"]);
    if (!r.ok) continue;
    let state: string;
    try {
      state = JSON.parse(r.stdout).state;
    } catch {
      continue;
    }
    if (state !== "MERGED" && state !== "CLOSED") continue;
    if (!worktreeIsClean(w.path) && !args.force) {
      notes.push(`review worktree ${w.path} (PR #${prNumber} ${state}) has uncommitted changes; skipped. Pass --force to remove.`);
      continue;
    }
    found.push({ path: w.path, branch: null, reason: "review-merged", prNumber });
  }
  return found;
}

// Stashes whose base branch no longer exists locally. The base branch is parsed
// from the `git stash list` subject ("WIP on <branch>:" / "On <branch>:").
function discoverStaleStashes(): StashPlan[] {
  const out = git(["stash", "list", "--format=%gd%x09%gs"]);
  const stale: StashPlan[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, subject] = line.split("\t");
    if (!ref || !subject) continue;
    const m = /^(?:WIP on|On) ([^:]+):/.exec(subject);
    if (!m) continue;
    const baseBranch = m[1]!;
    const exists = tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${baseBranch}`]).ok;
    if (!exists) stale.push({ ref, baseBranch, message: subject });
  }
  return stale;
}

// Loose-object count from `git count-objects -v`. A non-trivial count means a
// `git gc` would tighten the object store.
function looseObjectCount(): number {
  const r = tryGit(["count-objects", "-v"]);
  if (!r.ok) return 0;
  const m = /^count:\s*(\d+)/m.exec(r.stdout);
  return m ? Number(m[1]) : 0;
}

const GC_LOOSE_OBJECT_THRESHOLD = 50;

// =============================================================================
// Plan builder — full sweep
// =============================================================================

export function buildPlanFullSweep(args: CleanupArgs): CleanupPlan {
  const repo = discoverRepo();
  const protectedBranches = Array.from(
    new Set([repo.defaultBranch, repo.currentBranch, "main", "master", ...args.keepBranches]),
  );

  // Fetch + prune (best-effort; surface in notes if it fails).
  const fetched = tryGit(["fetch", "--all", "--prune", "--prune-tags"]);
  const notes: string[] = [];
  if (!fetched.ok) notes.push(`fetch --all --prune failed: ${fetched.stderr.split("\n")[0]}`);

  // Local config (linear-tree defaults). Only record changes that differ.
  const configChanges: { key: string; value: string }[] = [];
  if (!args.noConfig) {
    const wanted: [string, string][] = [
      ["pull.rebase", "true"],
      ["rebase.autoStash", "true"],
      ["branch.autoSetupRebase", "always"],
      ["rerere.enabled", "true"],
      ["fetch.prune", "true"],
      ["fetch.pruneTags", "true"],
    ];
    for (const [k, v] of wanted) {
      const cur = tryGit(["config", "--get", k]);
      if (!cur.ok || cur.stdout.trim() !== v) configChanges.push({ key: k, value: v });
    }
  }

  // Rebase decision
  let rebase: CleanupPlan["rebase"];
  if (args.noRebase) {
    rebase = { skipped: true, reason: "--no-rebase" };
  } else if (repo.currentBranch === repo.defaultBranch) {
    rebase = { skipped: true, reason: "on-default-branch (fast-forward only)" };
  } else {
    const upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    rebase = upstream.ok ? { skipped: false } : { skipped: true, reason: "no upstream tracking branch" };
  }

  // PRs index
  const prs = listAllPrs(repo.nameWithOwner);
  const mergedByHead = new Map<string, PrLite>();
  for (const p of prs) {
    if (p.state === "MERGED" && !p.isCrossRepository) mergedByHead.set(p.headRefName, p);
  }

  // Local branch candidates
  const allLocal = listLocalBranches();
  const localBranches: LocalBranchPlan[] = [];
  const defaultRef = `origin/${repo.defaultBranch}`;
  for (const b of allLocal) {
    if (protectedBranches.includes(b.name)) continue;
    const mergedPr = mergedByHead.get(b.name);
    if (mergedPr) {
      localBranches.push({
        name: b.name,
        reason: "merged-pr",
        prNumber: mergedPr.number,
        upstream: b.upstream || null,
        safeDelete: isAncestor(b.name, "HEAD") || isAncestor(b.name, defaultRef),
      });
      continue;
    }
    if (b.gone) {
      localBranches.push({
        name: b.name,
        reason: "gone-upstream",
        upstream: b.upstream || null,
        safeDelete: isAncestor(b.name, "HEAD") || isAncestor(b.name, defaultRef),
      });
      continue;
    }
    if (isAncestor(b.name, defaultRef)) {
      localBranches.push({
        name: b.name,
        reason: "reachable-from-default",
        upstream: b.upstream || null,
        safeDelete: true,
      });
    }
  }

  // Remote branch candidates
  const allRemote = listRemoteBranches("origin");
  const remoteBranches: RemoteBranchPlan[] = [];
  for (const name of allRemote) {
    if (protectedBranches.includes(name)) continue;
    const mergedPr = mergedByHead.get(name);
    if (mergedPr) remoteBranches.push({ name, reason: "merged-pr", prNumber: mergedPr.number });
  }

  // Worktrees — broken entries always, plus any whose branch is in the deletion set.
  const willDelete = new Set(
    localBranches
      .filter(b => b.safeDelete || b.reason === "merged-pr" || args.force)
      .map(b => b.name),
  );
  const worktrees: WorktreePlan[] = [];
  for (const w of listWorktrees()) {
    if (w.broken) {
      worktrees.push({ path: w.path, branch: w.branch, reason: "broken" });
    } else if (w.branch && willDelete.has(w.branch)) {
      worktrees.push({ path: w.path, branch: w.branch, reason: "branch-deleted" });
    }
  }
  // Detached-HEAD review worktrees for done PRs — the branch-pinned scan above
  // can't see them.
  worktrees.push(...discoverReviewWorktrees(repo, args, notes));

  // Watcher state
  const watcherDirs = args.noWatcherCleanup ? [] : discoverWatcherDirs(repo);

  // Stale stashes (surfaced; only dropped with --drop-stale-stashes).
  const staleStashes = discoverStaleStashes();

  // git gc decision.
  const looseObjects = looseObjectCount();
  const gc = { willRun: !args.noGc && looseObjects >= GC_LOOSE_OBJECT_THRESHOLD, looseObjects };

  const unsafe = localBranches.filter(
    b => !b.safeDelete && b.reason !== "merged-pr" && !args.force,
  );
  if (unsafe.length > 0) {
    notes.push(
      `${unsafe.length} local branch(es) have unmerged commits; skipping. Pass --force to delete with 'git branch -D'.`,
    );
  }

  return {
    repo,
    protectedBranches,
    fetchPruned: fetched.ok,
    rebase,
    configChanges,
    localBranches,
    remoteBranches,
    worktrees,
    watcherDirs,
    staleStashes,
    gc,
    notes,
  };
}

// =============================================================================
// Plan builder — single PR
// =============================================================================

export function buildPlanSinglePr(prNumber: number, args: CleanupArgs): CleanupPlan {
  const repo = discoverRepo();
  const protectedBranches = Array.from(
    new Set([repo.defaultBranch, repo.currentBranch, "main", "master", ...args.keepBranches]),
  );

  const view = ghRaw([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo.nameWithOwner,
    "--json",
    "number,state,headRefName,isCrossRepository",
  ]);
  const pr = JSON.parse(view) as PrLite;

  if (pr.state !== "MERGED" && pr.state !== "CLOSED") {
    die(CleanupExit.PR_NOT_DONE, `PR #${pr.number} is ${pr.state}; refusing to delete its head branch.`);
  }
  if (pr.headRefName === repo.defaultBranch) {
    die(CleanupExit.PROTECTED_BRANCH, `PR #${pr.number}'s head ref is the default branch; refusing.`);
  }
  if (pr.isCrossRepository) {
    die(CleanupExit.CROSS_REPO_PR, `PR #${pr.number} is from a fork; can't delete cross-repo branches.`);
  }

  const localExists = tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${pr.headRefName}`]).ok;
  const remoteExists = tryGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${pr.headRefName}`]).ok;

  const localBranches: LocalBranchPlan[] = [];
  if (localExists && !protectedBranches.includes(pr.headRefName)) {
    const safe = isAncestor(pr.headRefName, "HEAD") || isAncestor(pr.headRefName, `origin/${repo.defaultBranch}`);
    localBranches.push({
      name: pr.headRefName,
      reason: pr.state === "MERGED" ? "merged-pr" : "gone-upstream",
      prNumber: pr.number,
      safeDelete: safe,
    });
  }
  const remoteBranches: RemoteBranchPlan[] = [];
  if (remoteExists && !protectedBranches.includes(pr.headRefName) && pr.state === "MERGED") {
    remoteBranches.push({ name: pr.headRefName, reason: "merged-pr", prNumber: pr.number });
  }

  const willDelete = new Set(localBranches.map(b => b.name));
  const notes: string[] = [];
  const worktrees: WorktreePlan[] = [];
  for (const w of listWorktrees()) {
    if (w.branch && willDelete.has(w.branch)) {
      worktrees.push({ path: w.path, branch: w.branch, reason: "branch-deleted" });
    }
  }
  // Detached-HEAD review worktree for this PR, if one is left over.
  worktrees.push(...discoverReviewWorktrees(repo, args, notes));

  const watcherDirs: WatcherDirPlan[] = [];
  if (!args.noWatcherCleanup) {
    const p = prDir(repo.host, repo.owner, repo.name, pr.number);
    if (fs.existsSync(p)) {
      watcherDirs.push({ path: p, prNumber: pr.number, state: pr.state as "MERGED" | "CLOSED" });
    }
  }

  return {
    repo,
    protectedBranches,
    fetchPruned: false,
    rebase: { skipped: true, reason: "single-PR mode" },
    configChanges: [],
    localBranches,
    remoteBranches,
    worktrees,
    watcherDirs,
    staleStashes: [],
    gc: { willRun: false, looseObjects: 0 },
    notes,
  };
}

// =============================================================================
// Execute
// =============================================================================

export interface ExecuteReceipt {
  configApplied: { key: string; value: string }[];
  rebased: boolean;
  localBranchesDeleted: string[];
  localBranchesSkipped: { name: string; reason: string }[];
  remoteBranchesDeleted: string[];
  remoteBranchesFailed: { name: string; reason: string }[];
  worktreesRemoved: string[];
  worktreesFailed: { path: string; reason: string }[];
  watcherDirsRemoved: string[];
  stashesDropped: string[];
  gcRan: boolean;
  errors: string[];
}

export function executePlan(plan: CleanupPlan, args: CleanupArgs): ExecuteReceipt {
  const r: ExecuteReceipt = {
    configApplied: [],
    rebased: false,
    localBranchesDeleted: [],
    localBranchesSkipped: [],
    remoteBranchesDeleted: [],
    remoteBranchesFailed: [],
    worktreesRemoved: [],
    worktreesFailed: [],
    watcherDirsRemoved: [],
    stashesDropped: [],
    gcRan: false,
    errors: [],
  };

  for (const c of plan.configChanges) {
    const res = tryGit(["config", c.key, c.value]);
    if (res.ok) r.configApplied.push(c);
    else r.errors.push(`config ${c.key}=${c.value}: ${res.stderr.trim()}`);
  }

  if (!plan.rebase.skipped) {
    const upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.ok) {
      const rb = tryGit(["rebase", upstream.stdout.trim()]);
      if (rb.ok) {
        r.rebased = true;
      } else {
        tryGit(["rebase", "--abort"]);
        r.errors.push(`rebase onto ${upstream.stdout.trim()} failed: ${rb.stderr.split("\n")[0]}`);
      }
    }
  } else if (plan.rebase.reason?.startsWith("on-default-branch")) {
    const ff = tryGit(["merge", "--ff-only", `origin/${plan.repo.defaultBranch}`]);
    if (ff.ok) r.rebased = true;
  }

  // Worktrees BEFORE branches — worktrees pin their branches.
  for (const w of plan.worktrees) {
    if (w.reason === "broken") {
      tryGit(["worktree", "prune"]);
      r.worktreesRemoved.push(w.path);
      continue;
    }
    const flags = args.force ? ["--force"] : [];
    const rm = tryGit(["worktree", "remove", ...flags, w.path]);
    if (rm.ok) r.worktreesRemoved.push(w.path);
    else r.worktreesFailed.push({ path: w.path, reason: rm.stderr.split("\n")[0] });
  }
  tryGit(["worktree", "prune"]);

  for (const b of plan.localBranches) {
    // merged-pr is the strongest signal — GitHub says the work is in main, so
    // local ancestry check (which fails on squash-merged branches) is irrelevant.
    const trusted = b.reason === "merged-pr";
    if (!b.safeDelete && !trusted && !args.force) {
      r.localBranchesSkipped.push({ name: b.name, reason: "unmerged (pass --force to delete)" });
      continue;
    }
    const flag = b.safeDelete ? "-d" : "-D";
    const del = tryGit(["branch", flag, b.name]);
    if (del.ok) r.localBranchesDeleted.push(b.name);
    else r.localBranchesSkipped.push({ name: b.name, reason: del.stderr.split("\n")[0] });
  }

  for (const b of plan.remoteBranches) {
    const ref = `repos/${plan.repo.nameWithOwner}/git/refs/heads/${b.name}`;
    const del = tryGh(["api", "-X", "DELETE", ref]);
    if (del.ok) r.remoteBranchesDeleted.push(b.name);
    else r.remoteBranchesFailed.push({ name: b.name, reason: del.stderr.split("\n")[0] });
  }

  tryGit(["fetch", "--prune", "origin"]);

  for (const w of plan.watcherDirs) {
    try {
      fs.rmSync(w.path, { recursive: true, force: true });
      r.watcherDirsRemoved.push(w.path);
    } catch (e) {
      r.errors.push(`rm ${w.path}: ${(e as Error).message}`);
    }
  }

  // Stale stashes — opt-in only. Drop highest index first so lower stash@{N}
  // refs stay valid as the list shrinks.
  if (args.dropStaleStashes && plan.staleStashes.length > 0) {
    const byIndexDesc = [...plan.staleStashes].sort((a, b) => {
      const ia = Number(/\{(\d+)\}/.exec(a.ref)?.[1] ?? -1);
      const ib = Number(/\{(\d+)\}/.exec(b.ref)?.[1] ?? -1);
      return ib - ia;
    });
    for (const s of byIndexDesc) {
      const del = tryGit(["stash", "drop", s.ref]);
      if (del.ok) r.stashesDropped.push(s.ref);
      else r.errors.push(`stash drop ${s.ref}: ${del.stderr.split("\n")[0]}`);
    }
  }

  // git gc — repack when the loose-object count crossed the threshold.
  if (plan.gc.willRun) {
    const gc = tryGit(["gc", "--quiet"]);
    if (gc.ok) r.gcRan = true;
    else r.errors.push(`git gc: ${gc.stderr.split("\n")[0]}`);
  }

  return r;
}

// =============================================================================
// Pretty-print
// =============================================================================

export function renderPlan(plan: CleanupPlan, args: CleanupArgs): string {
  const lines: string[] = [];
  const head = args.pr !== null ? `/stark-gh:cleanup --pr ${args.pr}` : `/stark-gh:cleanup`;
  lines.push(`${head} — ${plan.repo.nameWithOwner} (on ${plan.repo.currentBranch})`);
  if (args.dryRun) lines.push("DRY RUN — no changes will be made.");
  lines.push("");
  lines.push(plan.fetchPruned ? "✓ fetched + pruned remotes" : "✗ fetch + prune skipped or failed");
  if (plan.configChanges.length > 0) {
    lines.push(`Config changes (${plan.configChanges.length}):`);
    for (const c of plan.configChanges) lines.push(`  ${c.key} = ${c.value}`);
  } else if (!args.noConfig) {
    lines.push("Config: already linear-tree-aligned");
  }
  lines.push(
    plan.rebase.skipped
      ? `Rebase: skipped (${plan.rebase.reason ?? "n/a"})`
      : `Rebase: will rebase current branch onto upstream`,
  );
  lines.push(`Local branches to delete (${plan.localBranches.length}):`);
  for (const b of plan.localBranches) {
    // merged-pr means GitHub reports the PR as merged — local SHA divergence
    // (typical for squash-merge) is expected and not a problem.
    const localUnmerged = !b.safeDelete && b.reason !== "merged-pr";
    const tag = localUnmerged ? "  [UNMERGED]" : "";
    const pr = b.prNumber ? ` (PR #${b.prNumber})` : "";
    lines.push(`  ${b.name}  — ${b.reason}${pr}${tag}`);
  }
  lines.push(`Remote branches to delete (${plan.remoteBranches.length}):`);
  for (const b of plan.remoteBranches) lines.push(`  origin/${b.name}  — ${b.reason} (PR #${b.prNumber})`);
  lines.push(`Worktrees to remove (${plan.worktrees.length}):`);
  for (const w of plan.worktrees) {
    const tag = w.branch ? ` [${w.branch}]` : w.prNumber ? ` (PR #${w.prNumber})` : "";
    lines.push(`  ${w.path}  — ${w.reason}${tag}`);
  }
  lines.push(`Watcher state dirs to remove (${plan.watcherDirs.length}):`);
  for (const w of plan.watcherDirs) lines.push(`  ${w.path}  — PR #${w.prNumber} ${w.state}`);
  if (plan.staleStashes.length > 0) {
    const verb = args.dropStaleStashes ? "to drop" : "(stale — pass --drop-stale-stashes to drop)";
    lines.push(`Stale stashes ${verb} (${plan.staleStashes.length}):`);
    for (const s of plan.staleStashes) {
      lines.push(`  ${s.ref}  — base branch '${s.baseBranch}' is gone — ${s.message}`);
    }
  }
  if (plan.gc.looseObjects > 0) {
    lines.push(
      plan.gc.willRun
        ? `git gc: will run (${plan.gc.looseObjects} loose objects)`
        : `git gc: skipped (${plan.gc.looseObjects} loose objects, below threshold or --no-gc)`,
    );
  }
  if (plan.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const n of plan.notes) lines.push(`  • ${n}`);
  }
  return lines.join("\n") + "\n";
}

export function renderReceipt(r: ExecuteReceipt): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Cleanup complete.");
  if (r.configApplied.length > 0) lines.push(`  config: applied ${r.configApplied.length} key(s)`);
  if (r.rebased) lines.push(`  rebase/ff: done`);
  lines.push(`  local branches deleted: ${r.localBranchesDeleted.length}`);
  if (r.localBranchesSkipped.length > 0) {
    lines.push(`  local branches skipped: ${r.localBranchesSkipped.length}`);
    for (const s of r.localBranchesSkipped) lines.push(`    ${s.name}: ${s.reason}`);
  }
  lines.push(`  remote branches deleted: ${r.remoteBranchesDeleted.length}`);
  if (r.remoteBranchesFailed.length > 0) {
    lines.push(`  remote branches failed: ${r.remoteBranchesFailed.length}`);
    for (const f of r.remoteBranchesFailed) lines.push(`    ${f.name}: ${f.reason}`);
  }
  lines.push(`  worktrees removed: ${r.worktreesRemoved.length}`);
  if (r.worktreesFailed.length > 0) {
    for (const f of r.worktreesFailed) lines.push(`    ${f.path}: ${f.reason}`);
  }
  lines.push(`  watcher state dirs removed: ${r.watcherDirsRemoved.length}`);
  if (r.stashesDropped.length > 0) lines.push(`  stale stashes dropped: ${r.stashesDropped.length}`);
  if (r.gcRan) lines.push(`  git gc: done`);
  if (r.errors.length > 0) {
    lines.push(`  errors: ${r.errors.length}`);
    for (const e of r.errors) lines.push(`    ${e}`);
  }
  return lines.join("\n") + "\n";
}

// =============================================================================
// main
// =============================================================================

function preflight(): void {
  if (!tryGit(["rev-parse", "--git-dir"]).ok) {
    die(CleanupExit.NOT_GIT_REPO, "not inside a git repository");
  }
  if (!tryGh(["auth", "status"]).ok) {
    die(CleanupExit.GH_NOT_AUTHED, "gh is not authenticated; run `gh auth login`");
  }
  const dirty = git(["status", "--porcelain"]).trim();
  if (dirty) {
    die(CleanupExit.DIRTY_WORKTREE, `working tree is dirty:\n${dirty}\nCommit or stash before cleanup.`);
  }
}

function main(): void {
  const raw = (() => {
    const i = process.argv.indexOf("--raw-args");
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]!;
    return process.argv.slice(2).join(" ");
  })();
  let args: CleanupArgs;
  try {
    args = parseRawArgs(raw);
  } catch (e) {
    die(CleanupExit.UNRECOGNIZED_FLAG, `arg parse: ${(e as Error).message}`);
  }

  preflight();

  const plan = args.pr !== null ? buildPlanSinglePr(args.pr, args) : buildPlanFullSweep(args);

  if (args.json) printJson({ plan, dryRun: args.dryRun });
  else process.stdout.write(renderPlan(plan, args));

  if (args.dryRun) process.exit(CleanupExit.OK);

  const receipt = executePlan(plan, args);
  if (args.json) printJson({ receipt });
  else process.stdout.write(renderReceipt(receipt));

  process.exit(receipt.errors.length > 0 ? CleanupExit.GENERIC : CleanupExit.OK);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
