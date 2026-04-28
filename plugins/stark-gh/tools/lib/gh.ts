import { execFileSync } from "node:child_process";
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

export function originMatches(plan: { owner: string; name: string }, originUrl: string): boolean {
  const cleaned = originUrl.replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/^https?:\/\/[^/]+\/(.+)$/);
  const sshMatch = cleaned.match(/^git@[^:]+:(.+)$/);
  const repoPath = httpsMatch?.[1] ?? sshMatch?.[1];
  if (!repoPath) return false;
  return repoPath === `${plan.owner}/${plan.name}`;
}
