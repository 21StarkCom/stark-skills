import * as fs from "node:fs";
import { sha256 } from "./git.ts";
import type { Candidate } from "./types.ts";
import type { StateFingerprint } from "./state.ts";

export interface Plan {
  schemaVersion: 1;
  createdAt: string;
  branch: string;
  baseBranch: string;
  remote: string;
  baseOid: string;
  baseOidSource: "remote" | "local";
  repo: { host: string; owner: string; name: string; nameWithOwner: string };
  stateFingerprint: StateFingerprint;
  tree: {
    dirty: boolean;
    dirtyFiles: { staged: string[]; unstaged: string[]; untracked: string[] };
    hasUpstream: boolean;
    unpushedCommits: number;
  };
  existingPr: null | { number: number; url: string; title: string; body: string; headRefOid: string };
  secretScan: {
    scanned: boolean;
    hits: { category: string; location: string }[];
    allowedCommit: boolean;
    allowedToLlm: boolean;
    redactions: { category: string; spans: number }[];
  };
  candidateIssues: { preflight: Candidate[]; lateFromCommitMessage?: Candidate[] };
  closesLines: { preflight: string[]; late?: string[] };
  refsLines: { preflight: string[]; late?: string[] };
  promptBudget: { estimatedInputTokens: number; cap: number; summarized: boolean };
  untrustedInputs: {
    combinedStat: string;
    committedDiff: string;
    stagedDiff: string;
    unstagedDiff: string | null;
    untrackedFiles: { path: string; size: number; content: string | null }[] | null;
    diffTruncated: boolean;
    prTemplate: string | null;
    commitMessages: string;
    userBody: string | null;
  };
  userArgs: {
    title: string | null;
    body: string | null;
    bodyFile: string | null;
    commitMessage: string | null;
    commitMessageFile: string | null;
    base: string | null;
    reviewer: string[];
    label: string[];
    assignee: string[];
    commitAll: boolean;
    fullContext: boolean;
    noWatch: boolean;
    draft: boolean;
    allowSecretCommit: boolean;
    allowSecretToLlm: boolean;
  };
  stage2: {
    needTitle: boolean;
    needBody: boolean;
    needCommitMessage: boolean;
    skip: boolean;
    outputs: { titleFile: string | null; bodyFile: string | null; commitMessageFile: string | null };
  };
  stage3: {
    action: "create" | "edit" | "push-only";
    willCommit: boolean;
    commitStrategy: "staged-only" | "commit-all";
    willPush: boolean;
    willEditTitle: boolean;
    willEditBody: boolean;
    willAddReviewers: string[];
    willAddLabels: string[];
    willAddAssignees: string[];
  };
}

function requirePlan(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`invalid plan-file: ${msg}`);
}

export function validatePlan(p: unknown): asserts p is Plan {
  requirePlan(typeof p === "object" && p !== null, "not an object");
  const o = p as Record<string, unknown>;
  requirePlan(o.schemaVersion === 1, "schemaVersion must be 1");
  for (const f of ["branch", "baseBranch", "remote", "createdAt"]) {
    requirePlan(typeof o[f] === "string", `${f} must be string`);
  }
  requirePlan(typeof o.baseOid === "string", "baseOid must be string");
  requirePlan(o.baseOidSource === "remote" || o.baseOidSource === "local", "baseOidSource invalid");
  requirePlan(typeof o.repo === "object" && o.repo !== null, "repo missing");
  requirePlan(typeof o.stateFingerprint === "object" && o.stateFingerprint !== null, "stateFingerprint missing");
  requirePlan(typeof o.tree === "object" && o.tree !== null, "tree missing");
  requirePlan(typeof o.candidateIssues === "object" && o.candidateIssues !== null, "candidateIssues missing");
  requirePlan("preflight" in (o.candidateIssues as object), "candidateIssues.preflight missing");
  requirePlan(typeof o.userArgs === "object" && o.userArgs !== null, "userArgs missing");
  requirePlan(typeof o.stage2 === "object" && o.stage2 !== null, "stage2 missing");
  requirePlan(typeof o.stage3 === "object" && o.stage3 !== null, "stage3 missing");
}

export function writePlan(filepath: string, plan: Plan): void {
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filepath);
}

export function readPlan(filepath: string): Plan {
  const raw = fs.readFileSync(filepath, "utf8");
  const parsed = JSON.parse(raw);
  validatePlan(parsed);
  return parsed;
}

export function planChecksum(plan: Plan): string {
  return sha256(JSON.stringify(plan));
}
