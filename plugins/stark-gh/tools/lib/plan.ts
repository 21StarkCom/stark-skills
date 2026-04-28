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

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validatePlan(p: unknown): asserts p is Plan {
  requirePlan(isObj(p), "not an object");
  const o = p as Record<string, unknown>;
  requirePlan(o.schemaVersion === 1, "schemaVersion must be 1");
  for (const f of ["branch", "baseBranch", "remote", "createdAt", "baseOid"]) {
    requirePlan(typeof o[f] === "string", `${f} must be string`);
  }
  requirePlan(o.baseOidSource === "remote" || o.baseOidSource === "local", "baseOidSource invalid");

  requirePlan(isObj(o.repo), "repo missing");
  const repo = o.repo as Record<string, unknown>;
  for (const f of ["host", "owner", "name", "nameWithOwner"]) {
    requirePlan(typeof repo[f] === "string", `repo.${f} must be string`);
  }

  requirePlan(isObj(o.stateFingerprint), "stateFingerprint missing");
  const fp = o.stateFingerprint as Record<string, unknown>;
  for (const f of ["headOid", "indexHash", "worktreeHash", "baseOid", "branch", "repoNameWithOwner"]) {
    requirePlan(typeof fp[f] === "string", `stateFingerprint.${f} must be string`);
  }

  requirePlan(isObj(o.tree), "tree missing");
  const tree = o.tree as Record<string, unknown>;
  requirePlan(typeof tree.dirty === "boolean", "tree.dirty must be boolean");
  requirePlan(isObj(tree.dirtyFiles), "tree.dirtyFiles missing");
  for (const f of ["staged", "unstaged", "untracked"]) {
    const arr = (tree.dirtyFiles as Record<string, unknown>)[f];
    requirePlan(Array.isArray(arr) && arr.every(s => typeof s === "string"), `tree.dirtyFiles.${f} must be string[]`);
  }

  requirePlan(isObj(o.candidateIssues), "candidateIssues missing");
  requirePlan(Array.isArray((o.candidateIssues as Record<string, unknown>).preflight), "candidateIssues.preflight must be array");

  requirePlan(isObj(o.userArgs), "userArgs missing");
  const ua = o.userArgs as Record<string, unknown>;
  for (const f of ["commitAll", "fullContext", "noWatch", "draft", "allowSecretCommit", "allowSecretToLlm"]) {
    requirePlan(typeof ua[f] === "boolean", `userArgs.${f} must be boolean`);
  }
  for (const f of ["reviewer", "label", "assignee"]) {
    requirePlan(Array.isArray(ua[f]), `userArgs.${f} must be array`);
  }

  requirePlan(isObj(o.stage2), "stage2 missing");
  const s2 = o.stage2 as Record<string, unknown>;
  for (const f of ["needTitle", "needBody", "needCommitMessage", "skip"]) {
    requirePlan(typeof s2[f] === "boolean", `stage2.${f} must be boolean`);
  }
  requirePlan(isObj(s2.outputs), "stage2.outputs missing");

  requirePlan(isObj(o.stage3), "stage3 missing");
  const s3 = o.stage3 as Record<string, unknown>;
  requirePlan(s3.action === "create" || s3.action === "edit" || s3.action === "push-only", "stage3.action invalid");
  requirePlan(s3.commitStrategy === "staged-only" || s3.commitStrategy === "commit-all", "stage3.commitStrategy invalid");
  for (const f of ["willCommit", "willPush", "willEditTitle", "willEditBody"]) {
    requirePlan(typeof s3[f] === "boolean", `stage3.${f} must be boolean`);
  }

  requirePlan(isObj(o.untrustedInputs), "untrustedInputs missing");
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
