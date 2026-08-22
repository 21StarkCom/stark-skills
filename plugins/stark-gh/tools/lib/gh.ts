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

// Mark a draft PR ready-for-review (un-draft) so its target-repo CI fires.
// `gh pr ready` issues the GraphQL markPullRequestReadyForReview mutation.
// Idempotent: readying an already-ready PR is treated as a no-op success.
export function markPrReady(prNumber: number, args: {
  repoSlug?: string;
} = {}, opts: { exec?: ExecFn } = {}): void {
  const argv = ["pr", "ready", String(prNumber)];
  if (args.repoSlug) argv.push("--repo", args.repoSlug);
  try {
    gh(argv, opts);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!/already .*review|not a draft|already open for review/i.test(msg)) {
      throw err;
    }
  }
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

// GitHub's own mergeability verdict for the PR (CLEAN, UNSTABLE, BLOCKED, BEHIND,
// DIRTY, HAS_HOOKS, DRAFT, UNKNOWN). Unlike the required-check ROLLUP — which is
// assembled from the check contexts currently ATTACHED to the head SHA — this is
// computed by GitHub against the base branch's full required-check configuration,
// so it knows a required check is still outstanding even before that check has
// registered a context. That is exactly the gap the merge watcher needs it for.
// A single field, deliberately not folded into MERGE_PR_FIELDS: that list feeds
// many callers and once broke the whole flow on an invalid field name.
export function prMergeStateStatus(number: number, repoSlug: string, opts: { exec?: ExecFn } = {}): string {
  const out = gh(["pr", "view", String(number), "--repo", repoSlug, "--json", "mergeStateStatus"], opts);
  return (JSON.parse(out) as { mergeStateStatus?: string }).mergeStateStatus ?? "UNKNOWN";
}

export function closePr(prNumber: number, repoSlug: string, opts: { exec?: ExecFn } = {}): void {
  gh(["pr", "close", String(prNumber), "--repo", repoSlug], opts);
}

// Idempotent, like markPrReady: reopening an already-open PR is a no-op success.
// This makes refirePrViaReopen's retry loop safe — a reopen whose first attempt
// timed out AFTER actually applying leaves the PR open, and the retry must not
// then read "already open" as a failure and manufacture a false LEFT_CLOSED.
export function reopenPr(prNumber: number, repoSlug: string, opts: { exec?: ExecFn } = {}): void {
  try {
    gh(["pr", "reopen", String(prNumber), "--repo", repoSlug], opts);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Swallow ONLY the "it is already open" family (the idempotency case). A
    // "cannot be reopened" (e.g. the PR was merged) is a real failure and must
    // propagate — silently accepting it would strand the flow believing it reopened.
    if (!/already open|is not closed/i.test(msg)) {
      throw err;
    }
  }
}

// Re-fire CI on a stuck PR by closing then immediately reopening it. The
// `reopened` activity is a DEFAULT `pull_request` type, so it re-triggers the
// target repo's workflows on the SAME head SHA — no commit rewrite. This is the
// only reliable recovery for a dropped `synchronize` webhook: re-running a
// workflow replays the original event payload (a draft-guarded job skips again),
// and a `workflow_dispatch` run never joins the PR's status rollup. Proven on
// 21StarkCom/atlas#103, where a rapid retarget+ready swallowed the synchronize
// event and a close+reopen on the same SHA fired a clean run.
//
// A PR left CLOSED by a half-done re-fire is worse than the stuck state it was
// meant to cure, so the reopen is retried and — if close SUCCEEDED but every
// reopen failed — a distinctive `LEFT_CLOSED` error is thrown so the caller can
// surface it loudly rather than silently strand the PR. A close that itself
// fails leaves the PR intact and is thrown plain (no `LEFT_CLOSED` marker): the
// caller can treat that as "the re-fire did not happen" and keep waiting.
export function refirePrViaReopen(
  prNumber: number,
  repoSlug: string,
  opts: { exec?: ExecFn; reopenAttempts?: number } = {},
): void {
  closePr(prNumber, repoSlug, opts); // throws plain on failure → PR untouched
  const attempts = Math.max(1, opts.reopenAttempts ?? 5);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      reopenPr(prNumber, repoSlug, opts);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `LEFT_CLOSED: PR #${prNumber} was closed to re-fire CI but reopen failed ${attempts}× — ` +
    `reopen it by hand: gh pr reopen ${prNumber} --repo ${repoSlug}. ` +
    `Cause: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

// GitHub's aggregate review verdict for the PR: REVIEW_REQUIRED (a required
// review is still outstanding), CHANGES_REQUESTED, APPROVED, or null (no review
// requirement / rule). The watcher consults it to tell a vacuous+BLOCKED that a
// close+reopen re-fire CAN cure (a required check that has not registered) from
// one it cannot (a required review) — mergeStateStatus alone reports BLOCKED for
// both. Returns "" when the field is absent so callers read "no review gate".
export function prReviewDecision(number: number, repoSlug: string, opts: { exec?: ExecFn } = {}): string {
  const out = gh(["pr", "view", String(number), "--repo", repoSlug, "--json", "reviewDecision"], opts);
  return (JSON.parse(out) as { reviewDecision?: string | null }).reviewDecision ?? "";
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
}

// NOTE: every name here must be a valid `gh pr view --json` field. gh rejects
// the whole call on an unknown one, and `fetchMergePrForCurrentBranch` reports
// that as "no PR for current branch" — which is how a `nameWithOwner` in this
// list (a `gh repo view` field) made the bare `/stark-gh:pr-merge` invocation
// fail on every branch until 2026-08-12. The repo slug comes from
// `repoView()`, never from the PR payload.

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
].join(",");

export function fetchMergePrByNumber(prNumber: number, repoSlug: string, opts: { exec?: ExecFn } = {}): MergePrMetadata {
  const out = gh(["pr", "view", String(prNumber), "--repo", repoSlug, "--json", MERGE_PR_FIELDS], opts);
  return JSON.parse(out);
}

export function fetchMergePrForCurrentBranch(opts: { exec?: ExecFn } = {}): MergePrMetadata | null {
  try {
    const out = gh(["pr", "view", "--json", MERGE_PR_FIELDS], opts);
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
