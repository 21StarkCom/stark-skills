#!/usr/bin/env node
import * as fs from "node:fs";
import { tokenize } from "./lib/shell_quote.ts";
import { Exit } from "./lib/exit.ts";
import { die, printJson } from "./lib/output.ts";
import * as gitLib from "./lib/git.ts";
import * as ghLib from "./lib/gh.ts";
import { validateBranchName } from "./lib/branch.ts";
import type { Candidate, ExecFn, Provenance } from "./lib/types.ts";
import { fingerprintFromInputs } from "./lib/state.ts";
import { emitLines, extractCandidates } from "./lib/issue.ts";
import { scanSecrets } from "./lib/secret.ts";
import { estimateTokens, summarizeDiff, truncateDiffByFile, truncateLeading, withinBudget } from "./lib/budget.ts";
import { writePlan, type Plan } from "./lib/plan.ts";
import { mktempInRuntime } from "./lib/runtime.ts";
import { redactSecrets } from "./lib/redact.ts";
import { appendSecretOverride } from "./lib/audit.ts";

export interface UserArgs {
  pr: number | null;
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
}

const STRING_MAX = 4096;
const LIST_MAX = 16;
const PATCH_CAP = 30 * 1024;
const TEMPLATE_CAP = 32 * 1024;
const COMMITS_CAP = 16 * 1024;
const BUDGET_CAP_DEFAULT = 32_000;
const BUDGET_CAP_FULL = 100_000;

export function parseRawArgs(raw: string): UserArgs {
  const tokens = tokenize(raw);
  const a: UserArgs = {
    pr: null,
    title: null,
    body: null,
    bodyFile: null,
    commitMessage: null,
    commitMessageFile: null,
    base: null,
    reviewer: [],
    label: [],
    assignee: [],
    commitAll: true,
    fullContext: false,
    noWatch: false,
    draft: false,
    allowSecretCommit: false,
    allowSecretToLlm: false,
  };
  const need = (i: number, flag: string): string => {
    if (i >= tokens.length) throw new Error(`flag ${flag} requires a value`);
    const v = tokens[i]!;
    if (v.length > STRING_MAX) throw new Error(`flag ${flag} value too long (>${STRING_MAX})`);
    return v;
  };
  const list = (v: string, flag: string): string[] => {
    const items = v.split(",").map(s => s.trim()).filter(Boolean);
    if (items.length > LIST_MAX) throw new Error(`flag ${flag} has too many entries (>${LIST_MAX})`);
    return items;
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
      case "--title":
        a.title = need(++i, t);
        break;
      case "--body":
        a.body = need(++i, t);
        break;
      case "--body-file":
        a.bodyFile = need(++i, t);
        break;
      case "--commit-message":
        a.commitMessage = need(++i, t);
        break;
      case "--commit-message-file":
        a.commitMessageFile = need(++i, t);
        break;
      case "--base":
        a.base = need(++i, t);
        break;
      case "--reviewer":
        a.reviewer = list(need(++i, t), t);
        break;
      case "--label":
        a.label = list(need(++i, t), t);
        break;
      case "--assignee":
        a.assignee = list(need(++i, t), t);
        break;
      case "--commit-all":
        a.commitAll = true;
        break;
      case "--staged-only":
        a.commitAll = false;
        break;
      case "--full-context":
        a.fullContext = true;
        break;
      case "--no-watch":
        a.noWatch = true;
        break;
      case "--draft":
        a.draft = true;
        break;
      case "--allow-secret-commit":
        a.allowSecretCommit = true;
        break;
      case "--allow-secret-to-llm":
        a.allowSecretToLlm = true;
        break;
      default:
        throw new Error(`unrecognized flag: ${t}`);
    }
  }
  return a;
}

export interface CollectedState {
  branch: string;
  baseBranch: string;
  repo: ghLib.RepoInfo;
  headOid: string;
  dirty: boolean;
  dirtyFiles: { staged: string[]; unstaged: string[]; untracked: string[] };
  hasUpstream: boolean;
  unpushedCommits: number;
  existingPr: ghLib.ExistingPr | null;
  cachedDiff: string;
  worktreeDiff: string;
}

function parseStatusPorcelain(out: string): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const x = raw[0]!;
    const y = raw[1]!;
    const p = raw.slice(3).trim();
    if (x === "?" && y === "?") {
      untracked.push(p);
      continue;
    }
    if (x !== " " && x !== "?") staged.push(p);
    if (y !== " " && y !== "?") unstaged.push(p);
  }
  return { staged, unstaged, untracked };
}

export function collectState(
  opts: { exec?: ExecFn; baseOverride?: string | null; commitAll?: boolean } = {},
): CollectedState {
  if (!gitLib.isGitRepo(opts)) throw new Error("not a git repo");
  const branch = gitLib.currentBranch(opts);
  if (branch === "HEAD" || branch === "") {
    throw new Error("refuse: detached HEAD; checkout a feature branch first");
  }
  const repo = ghLib.repoView(opts);
  const baseBranch = opts.baseOverride ?? repo.defaultBranch;
  if (branch === baseBranch) {
    throw new Error(`refuse: on default branch '${baseBranch}'; create a feature branch first`);
  }
  const v = validateBranchName(branch);
  if (!v.ok) throw new Error(`invalid branch name: ${v.reason}`);

  const status = gitLib.statusPorcelain(opts);
  const dirtyFiles = parseStatusPorcelain(status);
  const hasStaged = dirtyFiles.staged.length > 0;
  const hasUnstagedOrUntracked = dirtyFiles.unstaged.length + dirtyFiles.untracked.length > 0;
  if (hasUnstagedOrUntracked && !hasStaged && !opts.commitAll) {
    throw new Error("unstaged-only changes with --staged-only; `git add` what you want, or drop --staged-only to stage everything");
  }

  const headOid = gitLib.headOid(opts);
  const dirty = dirtyFiles.staged.length + dirtyFiles.unstaged.length + dirtyFiles.untracked.length > 0;
  const hasUp = gitLib.hasUpstream(opts);
  const unpushed = hasUp ? gitLib.unpushedCount(opts) : gitLib.rangeCount(baseBranch, "HEAD", opts);
  const existingPr = ghLib.findOpenPrForBranch(branch, opts);
  return {
    branch,
    baseBranch,
    repo,
    headOid,
    dirty,
    dirtyFiles,
    hasUpstream: hasUp,
    unpushedCommits: unpushed,
    existingPr,
    cachedDiff: gitLib.diffCached(opts),
    worktreeDiff: gitLib.diffWorktree(opts),
  };
}

export function fetchBase(base: string, opts: { exec?: ExecFn } = {}): { baseOid: string; source: "remote" | "local" } {
  try {
    // Use an explicit refspec so the remote-tracking branch (origin/<base>)
    // is updated. Bare `git fetch origin <base>` only writes FETCH_HEAD; the
    // subsequent `rev-parse origin/<base>` then reads a stale ref and the
    // base-drift check downstream becomes a no-op.
    gitLib.git(
      ["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
      opts,
    );
    return { baseOid: gitLib.git(["rev-parse", `origin/${base}`], opts).trim(), source: "remote" };
  } catch {
    return { baseOid: gitLib.git(["rev-parse", base], opts).trim(), source: "local" };
  }
}

export interface BuildPlanInput {
  rawArgs: string;
  exec?: ExecFn;
}

function readPrTemplate(): string | null {
  for (const p of [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"]) {
    if (!fs.existsSync(p)) continue;
    // Refuse to follow symlinks: a branch could otherwise point a "template"
    // at ~/.ssh/id_rsa or another local file and have its contents shipped to
    // Codex via the Stage 2 prompt.
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    return fs.readFileSync(p, "utf8");
  }
  return null;
}

function listUntracked(paths: string[]): { path: string; size: number; content: string | null }[] {
  return paths.map(p => {
    try {
      const st = fs.lstatSync(p);
      // Don't read symlinked untracked entries — they could resolve to
      // arbitrary local files (~/.aws/credentials, ~/.ssh/*).
      if (st.isSymbolicLink() || !st.isFile()) {
        return { path: p, size: st.size, content: null };
      }
      const content = st.size <= 4 * 1024 ? fs.readFileSync(p, "utf8") : null;
      return { path: p, size: st.size, content };
    } catch {
      return { path: p, size: 0, content: null };
    }
  });
}

function provenanceRank(p: Provenance): number {
  return ({ "user-provided": 3, "pre-existing-history": 2, branch: 1, "llm-drafted": 0 } as const)[p];
}

function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = `${c.owner}/${c.repo}#${c.number}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, c);
      continue;
    }
    const cr = provenanceRank(c.provenance);
    const pr = provenanceRank(prev.provenance);
    if (cr > pr || (cr === pr && prev.relation === "Refs" && c.relation === "Closes")) map.set(key, c);
  }
  return [...map.values()];
}

function decideStage2(input: {
  existingPr: ghLib.ExistingPr | null;
  dirty: boolean;
  userArgs: UserArgs;
}): { needTitle: boolean; needBody: boolean; needCommitMessage: boolean; skip: boolean } {
  const T = input.userArgs.title !== null;
  const B = input.userArgs.body !== null || input.userArgs.bodyFile !== null;
  const C = input.userArgs.commitMessage !== null || input.userArgs.commitMessageFile !== null;
  const pr = input.existingPr !== null;
  const needTitle = !pr && !T;
  const needBody = !pr && !B;
  const needCommitMessage = input.dirty && !C;
  return { needTitle, needBody, needCommitMessage, skip: !needTitle && !needBody && !needCommitMessage };
}

function decideStage3(input: { existingPr: ghLib.ExistingPr | null; dirty: boolean; userArgs: UserArgs }): Plan["stage3"] {
  const T = input.userArgs.title !== null;
  const B = input.userArgs.body !== null || input.userArgs.bodyFile !== null;
  const meta =
    input.userArgs.reviewer.length > 0 ||
    input.userArgs.label.length > 0 ||
    input.userArgs.assignee.length > 0;
  const pr = input.existingPr !== null;
  const action: "create" | "edit" | "push-only" = pr ? (T || B || meta ? "edit" : "push-only") : "create";
  return {
    action,
    willCommit: input.dirty,
    commitStrategy: input.userArgs.commitAll ? "commit-all" : "staged-only",
    willPush: true,
    willEditTitle: pr && T,
    willEditBody: pr && B,
    willAddReviewers: input.userArgs.reviewer,
    willAddLabels: input.userArgs.label,
    willAddAssignees: input.userArgs.assignee,
  };
}

export function buildPlan(input: BuildPlanInput): Plan {
  const userArgs = parseRawArgs(input.rawArgs);
  const state = collectState({ exec: input.exec, baseOverride: userArgs.base, commitAll: userArgs.commitAll });
  const { baseOid, source: baseOidSource } = fetchBase(state.baseBranch, { exec: input.exec });
  const diffBaseRef = baseOidSource === "remote" ? `origin/${state.baseBranch}` : state.baseBranch;

  const committedDiff = truncateDiffByFile(gitLib.git(["diff", `${diffBaseRef}...HEAD`], { exec: input.exec }), PATCH_CAP);
  const stagedDiff = truncateDiffByFile(state.cachedDiff, PATCH_CAP);
  const unstagedDiff = userArgs.commitAll ? truncateDiffByFile(state.worktreeDiff, 15 * 1024) : null;
  const untrackedFiles = userArgs.commitAll ? listUntracked(state.dirtyFiles.untracked) : null;
  const combinedStat = gitLib.git(["diff", "--stat", `${diffBaseRef}...HEAD`], { exec: input.exec });
  const commitMessages = truncateLeading(
    gitLib.git(["log", "--format=%B%x1f", `${diffBaseRef}..HEAD`], { exec: input.exec }),
    COMMITS_CAP,
  );

  const userBodyForScan = userArgs.body ?? (userArgs.bodyFile ? fs.readFileSync(userArgs.bodyFile, "utf8") : "");
  const userCommitForScan =
    userArgs.commitMessage ?? (userArgs.commitMessageFile ? fs.readFileSync(userArgs.commitMessageFile, "utf8") : "");
  const prTemplateForScan = readPrTemplate() ?? "";
  const scanTargets = [
    committedDiff.text,
    stagedDiff.text,
    unstagedDiff?.text ?? "",
    ...(untrackedFiles ?? []).map(u => u.content ?? ""),
    commitMessages,
    userArgs.title ?? "",
    userBodyForScan,
    userCommitForScan,
    prTemplateForScan,
  ].join("\n");
  const hits = scanSecrets(scanTargets);
  if (hits.length > 0 && !userArgs.allowSecretCommit && !userArgs.allowSecretToLlm) {
    const cats = [...new Set(hits.map(h => h.category))].join(", ");
    throw new Error(`secret-scan-hit:${cats}`);
  }
  // Spec rt2-r2: every override use is appended to a durable audit log
  // before the plan-file is written, so the record survives plan unlink.
  if (hits.length > 0 && (userArgs.allowSecretCommit || userArgs.allowSecretToLlm)) {
    appendSecretOverride({
      timestamp: new Date().toISOString(),
      stage: "preflight",
      allowSecretCommit: userArgs.allowSecretCommit,
      allowSecretToLlm: userArgs.allowSecretToLlm,
      branch: state.branch,
      repoNameWithOwner: state.repo.nameWithOwner,
      hits: hits.map(h => ({ category: h.category, location: `line ${h.lineNumber}` })),
    });
  }

  const shouldRedact = userArgs.allowSecretCommit && !userArgs.allowSecretToLlm;
  const redactionsAccum: { category: string; spans: number }[] = [];
  const maybeRedact = (s: string | null): string | null => {
    if (s === null || !shouldRedact) return s;
    const r = redactSecrets(s);
    for (const sp of r.spans) redactionsAccum.push({ category: sp.category, spans: sp.replaced });
    return r.text;
  };

  const committedDiffText = maybeRedact(committedDiff.text)!;
  const stagedDiffText = maybeRedact(stagedDiff.text)!;
  const unstagedDiffText = maybeRedact(unstagedDiff?.text ?? null);
  const commitMessagesText = maybeRedact(commitMessages)!;
  const userBodyRaw = userArgs.body ?? (userArgs.bodyFile ? fs.readFileSync(userArgs.bodyFile, "utf8") : null);
  const userBody = maybeRedact(userBodyRaw);
  const untrackedFilesForLlm = untrackedFiles
    ? untrackedFiles.map(u => ({ ...u, content: maybeRedact(u.content) }))
    : null;
  const secretScan = {
    scanned: true,
    hits: hits.map(h => ({ category: h.category, location: `line ${h.lineNumber}` })),
    allowedCommit: userArgs.allowSecretCommit,
    allowedToLlm: userArgs.allowSecretToLlm,
    redactions: redactionsAccum,
  };

  const tmpl = readPrTemplate();
  const prTemplate = tmpl === null ? null : tmpl.length > TEMPLATE_CAP ? tmpl.slice(0, TEMPLATE_CAP) + "\n[... template truncated ...]" : tmpl;

  const baseRepoMeta = { owner: state.repo.owner, name: state.repo.name };
  const branchCands = extractCandidates({ branch: state.branch, commits: "", baseRepo: baseRepoMeta, provenance: "branch" });
  const historyCands = extractCandidates({
    branch: "",
    commits: commitMessages,
    baseRepo: baseRepoMeta,
    provenance: "pre-existing-history",
  });
  const userCommitText =
    userArgs.commitMessage ?? (userArgs.commitMessageFile ? fs.readFileSync(userArgs.commitMessageFile, "utf8") : "");
  const userCands = userCommitText
    ? extractCandidates({ branch: "", commits: userCommitText, baseRepo: baseRepoMeta, provenance: "user-provided" })
    : [];
  const finalCandidates = mergeCandidates([...branchCands, ...historyCands, ...userCands]).map(c => ({
    ...c,
    verified: ghLib.issueExists(c.owner, c.repo, c.number, { exec: input.exec }),
  }));
  const { closesLines, refsLines } = emitLines(finalCandidates, baseRepoMeta);

  const untrackedForBudget = (untrackedFilesForLlm ?? [])
    .map(u => (u.content ?? ""))
    .join("");
  const allInputs =
    combinedStat +
    committedDiffText +
    stagedDiffText +
    (unstagedDiffText ?? "") +
    (prTemplate ?? "") +
    commitMessagesText +
    (userBody ?? "") +
    untrackedForBudget;
  const cap = userArgs.fullContext ? BUDGET_CAP_FULL : BUDGET_CAP_DEFAULT;
  let estimated = estimateTokens(allInputs);
  let summarized = false;
  let llmCommittedDiff = committedDiffText;
  let llmStagedDiff = stagedDiffText;
  let llmUnstagedDiff = unstagedDiffText;
  let llmCommitMessages = commitMessagesText;
  if (!withinBudget(estimated, cap)) {
    const summary = summarizeDiff(committedDiffText + "\n" + stagedDiffText);
    const trimmedCommits = commitMessagesText.split("\n").slice(0, 50).join("\n");
    estimated = estimateTokens(summary + (prTemplate ?? "") + trimmedCommits);
    summarized = true;
    if (!withinBudget(estimated, cap)) throw new Error("prompt budget exceeded even after summarization");
    // The fields handed to Stage 2 must reflect the summarized payload, not
    // the original full diffs. Otherwise the prompt will overshoot the cap.
    llmCommittedDiff = summary;
    llmStagedDiff = "";
    llmUnstagedDiff = null;
    llmCommitMessages = trimmedCommits;
  }

  const worktreeContentBytes = userArgs.commitAll
    ? gitLib.git(["diff", "--binary"], { exec: input.exec }) + (untrackedFiles ?? []).map(u => gitLib.hashUntrackedFile(u.path)).join("")
    : null;
  const fingerprint = fingerprintFromInputs({
    headOid: state.headOid,
    indexBytes: state.cachedDiff,
    // Always include status so a clean->dirty change between preflight and
    // execute is detected as drift (not just dirty->different-dirty).
    worktreeBytes: gitLib.statusPorcelain({ exec: input.exec }),
    worktreeContentBytes,
    existingPrSha: state.existingPr?.headRefOid ?? null,
    baseOid,
    branch: state.branch,
    repoNameWithOwner: state.repo.nameWithOwner,
  });

  const stage2 = decideStage2({ existingPr: state.existingPr, dirty: state.dirty, userArgs });
  const stage3 = decideStage3({ existingPr: state.existingPr, dirty: state.dirty, userArgs });

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    branch: state.branch,
    baseBranch: state.baseBranch,
    remote: "origin",
    baseOid,
    baseOidSource,
    repo: { host: state.repo.host, owner: state.repo.owner, name: state.repo.name, nameWithOwner: state.repo.nameWithOwner },
    stateFingerprint: fingerprint,
    tree: {
      dirty: state.dirty,
      dirtyFiles: state.dirtyFiles,
      hasUpstream: state.hasUpstream,
      unpushedCommits: state.unpushedCommits,
    },
    existingPr: state.existingPr,
    secretScan,
    candidateIssues: { preflight: finalCandidates },
    closesLines: { preflight: closesLines },
    refsLines: { preflight: refsLines },
    promptBudget: { estimatedInputTokens: estimated, cap, summarized },
    untrustedInputs: {
      combinedStat,
      committedDiff: llmCommittedDiff,
      stagedDiff: llmStagedDiff,
      unstagedDiff: llmUnstagedDiff,
      untrackedFiles: untrackedFilesForLlm,
      diffTruncated: committedDiff.truncated || stagedDiff.truncated,
      prTemplate,
      commitMessages: llmCommitMessages,
      userBody,
    },
    userArgs,
    stage2: { ...stage2, outputs: { titleFile: null, bodyFile: null, commitMessageFile: null } },
    stage3,
  };
}

function main(): never {
  const argv = process.argv.slice(2);
  const rawIdx = argv.indexOf("--raw-args");
  const raw = rawIdx >= 0 ? argv[rawIdx + 1] ?? "" : "";
  const emitPath = argv.includes("--emit-plan-path");
  const printAll = argv.includes("--json");
  let plan: Plan;
  try {
    plan = buildPlan({ rawArgs: raw });
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.startsWith("secret-scan-hit:")) die(Exit.SECRET_HIT_PREFLIGHT, msg);
    if (msg.startsWith("unrecognized flag") || msg.includes("requires a value") || msg.includes("too many") || msg.includes("too long")) {
      die(Exit.UNRECOGNIZED_FLAG, msg);
    }
    if (msg === "not a git repo") die(Exit.NOT_GIT_REPO, msg);
    if (msg.startsWith("refuse: on default branch")) die(Exit.ON_DEFAULT_BRANCH, msg);
    if (msg.startsWith("invalid branch name")) die(Exit.INVALID_BRANCH_NAME, msg);
    if (msg.startsWith("unstaged-only changes")) die(Exit.UNSTAGED_ONLY, msg);
    if (msg === "prompt budget exceeded even after summarization") die(Exit.PROMPT_BUDGET_EXCEEDED, msg);
    die(Exit.GENERIC, msg);
  }

  const outIdx = argv.indexOf("--out");
  const planPath = outIdx >= 0 ? argv[outIdx + 1]! : mktempInRuntime("stark-gh-plan-XXXXXX.json");
  writePlan(planPath, plan);
  if (emitPath) process.stdout.write(planPath + "\n");
  else if (printAll) printJson(plan);
  else process.stdout.write(planPath + "\n");
  process.exit(0);
}

if (process.argv[1]?.endsWith("gh_pr_open_preflight.ts")) main();
