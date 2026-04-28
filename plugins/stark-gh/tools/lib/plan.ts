import * as fs from "node:fs";
import { sha256 } from "./git.ts";
import type { Candidate } from "./types.ts";
import type { StateFingerprint } from "./state.ts";
import type { ReasoningEffort } from "./config.ts";

// Backwards-compat alias: existing pr-open plans are PrOpenPlan. New plans
// MAY include a `command` discriminator; absent means pr-open.
export type Plan = PrOpenPlan;

export interface PrOpenPlan {
  command?: "pr-open";       // optional for backwards compat with pre-discriminator plans
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
  const ci = o.candidateIssues as Record<string, unknown>;
  requirePlan(Array.isArray(ci.preflight), "candidateIssues.preflight must be array");
  for (const c of ci.preflight as unknown[]) {
    requirePlan(isObj(c), "candidate not object");
    const cc = c as Record<string, unknown>;
    requirePlan(typeof cc.number === "number", "candidate.number");
    requirePlan(typeof cc.owner === "string" && typeof cc.repo === "string", "candidate.owner/repo");
    requirePlan(cc.relation === "Closes" || cc.relation === "Refs", "candidate.relation");
  }

  for (const k of ["closesLines", "refsLines"]) {
    requirePlan(isObj(o[k]), `${k} missing`);
    const v = (o[k] as Record<string, unknown>).preflight;
    requirePlan(Array.isArray(v) && v.every(s => typeof s === "string"), `${k}.preflight must be string[]`);
  }

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
  const outs = s2.outputs as Record<string, unknown>;
  for (const f of ["titleFile", "bodyFile", "commitMessageFile"]) {
    requirePlan(outs[f] === null || typeof outs[f] === "string", `stage2.outputs.${f} must be string|null`);
  }

  requirePlan(isObj(o.stage3), "stage3 missing");
  const s3 = o.stage3 as Record<string, unknown>;
  requirePlan(s3.action === "create" || s3.action === "edit" || s3.action === "push-only", "stage3.action invalid");
  requirePlan(s3.commitStrategy === "staged-only" || s3.commitStrategy === "commit-all", "stage3.commitStrategy invalid");
  for (const f of ["willCommit", "willPush", "willEditTitle", "willEditBody"]) {
    requirePlan(typeof s3[f] === "boolean", `stage3.${f} must be boolean`);
  }

  requirePlan(isObj(o.untrustedInputs), "untrustedInputs missing");
  const ui = o.untrustedInputs as Record<string, unknown>;
  for (const f of ["combinedStat", "committedDiff", "stagedDiff", "commitMessages"]) {
    requirePlan(typeof ui[f] === "string", `untrustedInputs.${f} must be string`);
  }
  for (const f of ["unstagedDiff", "prTemplate", "userBody"]) {
    requirePlan(ui[f] === null || typeof ui[f] === "string", `untrustedInputs.${f} must be string|null`);
  }
  requirePlan(typeof ui.diffTruncated === "boolean", "untrustedInputs.diffTruncated must be boolean");
  requirePlan(ui.untrackedFiles === null || Array.isArray(ui.untrackedFiles), "untrustedInputs.untrackedFiles");
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

// =============================================================================
// PrMergePlan — pr-merge plan-file schema. Discriminated by command === "pr-merge".
// =============================================================================

export interface PrMergePlan {
  command: "pr-merge";
  schemaVersion: 1;
  createdAt: string;
  runId: string;
  pr: {
    number: number;
    headRef: string;
    baseRef: string;
    url: string;
    nameWithOwner: string;
    headRepositoryOwner: string;
    headRepositoryName: string;
    isCrossRepository: boolean;
  };
  baseOid: string;
  originalHeadOid: string;
  rebasedHeadOid: string;
  changelogCommitOid: string | null;
  pushedHeadOid: string | null;
  originalChangelogPath: string;     // absolute path to durable tempfile copy
  changelog: {
    filePath: string;
    section: "Added" | "Changed" | "Fixed" | "Removed" | "Deprecated" | "Security";
    markerComment: string;
  };
  startingRef: string;
  forceReason: string | null;
  stage2: {
    skip: boolean;
    subjectFile: string | null;
    bodyFile: string | null;
    changelogBulletFile: string | null;
    model: string;
    reasoningEffort: ReasoningEffort;
  };
  execute: {
    watch: boolean;
    force: boolean;
    watchTimeoutHours: number;       // default 6
    secretOverrides: { commit: boolean; toLlm: boolean };
    allowNoRequiredChecks: boolean;
  };
}

export function isPrMergePlan(p: unknown): p is PrMergePlan {
  return isObj(p) && (p as Record<string, unknown>).command === "pr-merge";
}

const CHANGELOG_SECTIONS = new Set(["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"]);

export function validatePrMergePlan(p: unknown): asserts p is PrMergePlan {
  requirePlan(isObj(p), "not an object");
  const o = p as Record<string, unknown>;
  requirePlan(o.command === "pr-merge", "command must be 'pr-merge'");
  requirePlan(o.schemaVersion === 1, "schemaVersion must be 1");
  for (const f of ["createdAt", "runId", "baseOid", "originalHeadOid", "rebasedHeadOid",
    "originalChangelogPath", "startingRef"]) {
    requirePlan(typeof o[f] === "string", `${f} must be string`);
  }
  for (const f of ["changelogCommitOid", "pushedHeadOid", "forceReason"]) {
    requirePlan(o[f] === null || typeof o[f] === "string", `${f} must be string|null`);
  }

  requirePlan(isObj(o.pr), "pr missing");
  const pr = o.pr as Record<string, unknown>;
  requirePlan(typeof pr.number === "number" && Number.isInteger(pr.number), "pr.number must be integer");
  for (const f of ["headRef", "baseRef", "url", "nameWithOwner", "headRepositoryOwner", "headRepositoryName"]) {
    requirePlan(typeof pr[f] === "string", `pr.${f} must be string`);
  }
  requirePlan(typeof pr.isCrossRepository === "boolean", "pr.isCrossRepository must be boolean");

  requirePlan(isObj(o.changelog), "changelog missing");
  const cl = o.changelog as Record<string, unknown>;
  for (const f of ["filePath", "markerComment"]) {
    requirePlan(typeof cl[f] === "string", `changelog.${f} must be string`);
  }
  requirePlan(typeof cl.section === "string" && CHANGELOG_SECTIONS.has(cl.section as string),
    "changelog.section must be one of Added|Changed|Fixed|Removed|Deprecated|Security");

  requirePlan(isObj(o.stage2), "stage2 missing");
  const s2 = o.stage2 as Record<string, unknown>;
  requirePlan(typeof s2.skip === "boolean", "stage2.skip must be boolean");
  for (const f of ["subjectFile", "bodyFile", "changelogBulletFile"]) {
    requirePlan(s2[f] === null || typeof s2[f] === "string", `stage2.${f} must be string|null`);
  }
  requirePlan(typeof s2.model === "string", "stage2.model must be string");
  requirePlan(s2.reasoningEffort === "medium" || s2.reasoningEffort === "high" || s2.reasoningEffort === "xhigh",
    "stage2.reasoningEffort invalid");

  requirePlan(isObj(o.execute), "execute missing");
  const ex = o.execute as Record<string, unknown>;
  for (const f of ["watch", "force", "allowNoRequiredChecks"]) {
    requirePlan(typeof ex[f] === "boolean", `execute.${f} must be boolean`);
  }
  requirePlan(typeof ex.watchTimeoutHours === "number" && (ex.watchTimeoutHours as number) > 0,
    "execute.watchTimeoutHours must be positive number");
  requirePlan(isObj(ex.secretOverrides), "execute.secretOverrides missing");
  const so = ex.secretOverrides as Record<string, unknown>;
  for (const f of ["commit", "toLlm"]) {
    requirePlan(typeof so[f] === "boolean", `execute.secretOverrides.${f} must be boolean`);
  }

  // forceReason required when force=true (audit invariant).
  if (ex.force === true) {
    requirePlan(typeof o.forceReason === "string" && (o.forceReason as string).trim().length > 0,
      "forceReason required when execute.force=true");
  }
}

export function readPrMergePlan(filepath: string): PrMergePlan {
  const raw = fs.readFileSync(filepath, "utf8");
  const parsed = JSON.parse(raw);
  validatePrMergePlan(parsed);
  return parsed;
}

export function writePrMergePlan(filepath: string, plan: PrMergePlan): void {
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filepath);
}
