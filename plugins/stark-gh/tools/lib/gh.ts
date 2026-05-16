import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { ExecFn } from "./types.ts";

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

function gh(args: string[], opts: { exec?: ExecFn; input?: string } = {}): string {
  const exec = opts.exec ?? defaultExec;
  return exec("gh", args, { input: opts.input }).toString("utf8");
}

export interface RepoInfo {
  host: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  defaultBranch: string;
}

export function repoView(opts: { exec?: ExecFn } = {}): RepoInfo {
  const out = gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"], opts);
  const j = JSON.parse(out);
  const [owner, name] = j.nameWithOwner.split("/");
  const url = new URL(j.url);
  return {
    host: url.host,
    owner,
    name,
    nameWithOwner: j.nameWithOwner,
    defaultBranch: j.defaultBranchRef.name,
  };
}

export interface ExistingPr {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefOid: string;
}

export function findOpenPrForBranch(branch: string, opts: { exec?: ExecFn } = {}): ExistingPr | null {
  const out = gh(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,title,body,headRefOid"],
    opts,
  );
  const arr = JSON.parse(out);
  return arr.length > 0 ? arr[0] : null;
}

export function issueExists(owner: string, repo: string, number: number, opts: { exec?: ExecFn } = {}): boolean {
  try {
    gh(["issue", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "state"], opts);
    return true;
  } catch {
    return false;
  }
}

export function prCreate(args: {
  title: string;
  bodyFile: string;
  base: string;
  reviewers?: string[];
  labels?: string[];
  assignees?: string[];
  draft?: boolean;
}, opts: { exec?: ExecFn } = {}): void {
  const argv = ["pr", "create", "--title", args.title, "--body-file", args.bodyFile, "--base", args.base];
  if (args.reviewers?.length) argv.push("--reviewer", args.reviewers.join(","));
  if (args.labels?.length) argv.push("--label", args.labels.join(","));
  if (args.assignees?.length) argv.push("--assignee", args.assignees.join(","));
  if (args.draft) argv.push("--draft");
  gh(argv, opts);
}

export function prEdit(number: number, args: {
  title?: string;
  bodyFile?: string;
  addReviewers?: string[];
  addLabels?: string[];
  addAssignees?: string[];
}, opts: { exec?: ExecFn } = {}): void {
  const argv = ["pr", "edit", String(number)];
  if (args.title !== undefined) argv.push("--title", args.title);
  if (args.bodyFile !== undefined) argv.push("--body-file", args.bodyFile);
  if (args.addReviewers?.length) argv.push("--add-reviewer", args.addReviewers.join(","));
  if (args.addLabels?.length) argv.push("--add-label", args.addLabels.join(","));
  if (args.addAssignees?.length) argv.push("--add-assignee", args.addAssignees.join(","));
  gh(argv, opts);
}

export function prView(number: number, opts: { exec?: ExecFn } = {}): { url: string; number: number; headRefOid: string } {
  const out = gh(["pr", "view", String(number), "--json", "url,number,headRefOid"], opts);
  return JSON.parse(out);
}

export function prHeadOid(number: number, owner: string, repo: string, opts: { exec?: ExecFn } = {}): string {
  const out = gh(["pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "headRefOid"], opts);
  return JSON.parse(out).headRefOid as string;
}

export function prChecks(pr: number, owner: string, repo: string, opts: { exec?: ExecFn } = {}): unknown[] {
  const out = gh(
    [
      "pr",
      "checks",
      String(pr),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "bucket,name,state,link,workflow,startedAt,completedAt",
    ],
    opts,
  );
  return JSON.parse(out);
}

export function isAuthed(opts: { exec?: ExecFn } = {}): boolean {
  try {
    gh(["auth", "status"], opts);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// pr-merge helpers (additive).
// =============================================================================

export interface MergePrMetadata {
  number: number;
  url: string;
  title: string;
  body: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string } | null;
  headRepository: { name: string } | null;
  labels: { name: string }[];
  files: { path: string }[];
  nameWithOwner: string;
}

const MERGE_PR_FIELDS = [
  "number",
  "url",
  "title",
  "body",
  "isDraft",
  "state",
  "mergeable",
  "reviewDecision",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "isCrossRepository",
  "headRepositoryOwner",
  "headRepository",
  "labels",
  "files",
].join(",");

export function fetchMergePrByNumber(prNumber: number, repoSlug: string, opts: { exec?: ExecFn } = {}): MergePrMetadata {
  const out = gh(["pr", "view", String(prNumber), "--repo", repoSlug, "--json", MERGE_PR_FIELDS], opts);
  const j = JSON.parse(out);
  return { ...j, nameWithOwner: repoSlug };
}

export function fetchMergePrForCurrentBranch(opts: { exec?: ExecFn } = {}): MergePrMetadata | null {
  try {
    const out = gh(["pr", "view", "--json", `${MERGE_PR_FIELDS},nameWithOwner`], opts);
    const j = JSON.parse(out);
    return j;
  } catch {
    return null;
  }
}

// Authenticated GraphQL passthrough.
//
// gh CLI variable flags:
//   -f  STRING (string body)
//   -F  TYPED  (number / true / false / null literal — when value is "null"
//              gh forwards a real JSON null)
// We must NOT use `-f key=null` for a null cursor: that sends the literal
// string "null" to GitHub, breaking pagination/filter queries that expect
// `String` (not nullable string-or-null). For null we drop the variable;
// for booleans and the explicit `null` sentinel we use -F so gh forwards a
// real JSON value.
export function apiGraphql(query: string, vars: Record<string, unknown>, opts: { exec?: ExecFn } = {}): unknown {
  const argv = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) {
      // Skip; GraphQL treats omitted variables as null.
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      argv.push("-F", `${k}=${v}`);
    } else {
      argv.push("-f", `${k}=${String(v)}`);
    }
  }
  const out = gh(argv, opts);
  return JSON.parse(out);
}

// Squash-merge a PR. Reads subject tempfile in TS and passes via --subject;
// passes --body-file directly. Does NOT pass --delete-branch (deferred to
// /stark-gh:cleanup so the branch remains as a recovery anchor).
// Includes --match-head-commit <expectedHeadOid> for atomic SHA-bound merge.
//
// Subject-flag fallback: gh pr merge supports --subject in modern versions.
// Caller may pre-detect via `gh pr merge --help | grep -- '--subject string'`
// at first use. v1 assumes --subject is supported; if missing, mergeSquashPr
// throws and the operator must upgrade gh.
export function mergeSquashPr(args: {
  prNumber: number;
  subjectFile: string;
  bodyFile: string;
  expectedHeadOid: string;
  repoSlug?: string;            // optional; for cross-repo invocation
}, opts: { exec?: ExecFn } = {}): { mergeSha: string } {
  // Read subject in TS and pass as --subject <text> (no shell interpolation).
  const subject = fs.readFileSync(args.subjectFile, "utf8").replace(/\n+$/, "");
  const argv = [
    "pr", "merge", String(args.prNumber),
    "--squash",
    "--subject", subject,
    "--body-file", args.bodyFile,
    "--match-head-commit", args.expectedHeadOid,
  ];
  if (args.repoSlug) argv.push("--repo", args.repoSlug);
  // gh pr merge prints nothing useful on success; capture merge SHA via prView.
  gh(argv, opts);
  // Re-fetch to capture merge commit SHA for terminal state.
  const view = gh(
    [
      "pr", "view", String(args.prNumber),
      ...(args.repoSlug ? ["--repo", args.repoSlug] : []),
      "--json", "mergeCommit",
    ],
    opts,
  );
  const parsed = JSON.parse(view);
  return { mergeSha: parsed.mergeCommit?.oid ?? "" };
}

export function originMatches(plan: { owner: string; name: string; host?: string }, originUrl: string): boolean {
  const cleaned = originUrl.replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/^https?:\/\/([^/]+)\/(.+)$/);
  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/);
  const host = httpsMatch?.[1] ?? sshMatch?.[1];
  const repoPath = httpsMatch?.[2] ?? sshMatch?.[2];
  if (!host || !repoPath) return false;
  if (repoPath !== `${plan.owner}/${plan.name}`) return false;
  // Reject any host that doesn't match plan.repo.host. Without this check an
  // origin like https://attacker.example/<owner>/<repo>.git would silently
  // receive the push even though PR metadata is resolved against GitHub.
  if (plan.host && host !== plan.host) return false;
  return true;
}

// =============================================================================
// Generic passthrough helpers for callers that need ad-hoc gh calls without
// a dedicated wrapper. Used by /stark-gh:cleanup.
// =============================================================================

export function ghRaw(args: string[], opts: { exec?: ExecFn; input?: string } = {}): string {
  return gh(args, opts);
}

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function tryGh(args: string[], opts: { exec?: ExecFn; input?: string } = {}): GhResult {
  try {
    return { ok: true, stdout: gh(args, opts), stderr: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    return {
      ok: false,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? err.message,
    };
  }
}
