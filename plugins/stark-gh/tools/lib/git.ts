import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ExecFn } from "./types.ts";

const defaultExec: ExecFn = (cmd, args, opts) => {
  const { streamStderr, ...rest } = opts ?? {};
  return execFileSync(cmd, args, {
    ...rest,
    // stderr is INHERITED when the caller opts in. `git push` fires the repo's pre-push hook, and
    // a hook that runs a build + test suite prints for minutes (Mímir's `make ci`: ~110s). Captured,
    // none of that reaches the terminal until the push finishes — and only then if it FAILED — so a
    // perfectly healthy push is indistinguishable from a hang. Inherited, hook progress streams
    // live. Safe only because every streaming caller ignores the returned string.
    stdio: ["pipe", "pipe", streamStderr ? "inherit" : "pipe"],
    // Node's default maxBuffer is 1 MiB; large feature-branch diffs
    // (e.g. >100 file changes, >1 MiB combined patch) trip ENOBUFS on
    // `git diff`/`git log -p`. 64 MiB is comfortable headroom while
    // still bounded against accidental runaway output.
    maxBuffer: 64 * 1024 * 1024,
  });
};

export function git(
  args: string[],
  opts: { exec?: ExecFn; input?: string; streamStderr?: boolean } = {},
): string {
  const exec = opts.exec ?? defaultExec;
  return exec("git", args, { input: opts.input, streamStderr: opts.streamStderr }).toString("utf8");
}

// Content of a path as it exists at `ref`, or null when the path is absent
// there. Used to read repo policy from a trusted ref rather than the checked
// out branch, so a PR cannot supply the settings that police its own diff.
//
// Absence is established by ASKING git (`ls-tree` prints nothing for a path
// that is not in the tree), never by matching its error text. The message is
// localized — under a non-English locale a repo that simply has no config file
// would have looked like a fatal error and aborted every merge. A bad ref still
// throws, because an unreachable ref is not the same as an absent file and
// treating it as one would silently drop the policy.
export function fileAtRef(ref: string, relPath: string, opts: { exec?: ExecFn } = {}): string | null {
  const listed = git(["ls-tree", "--name-only", ref, "--", relPath], opts).trim();
  if (listed === "") return null;
  return git(["show", `${ref}:${relPath}`], opts);
}

export function isGitRepo(opts: { exec?: ExecFn } = {}): boolean {
  try {
    git(["rev-parse", "--git-dir"], opts);
    return true;
  } catch {
    return false;
  }
}

export function repoRoot(opts: { exec?: ExecFn } = {}): string {
  return git(["rev-parse", "--show-toplevel"], opts).trim();
}

export function currentBranch(opts: { exec?: ExecFn } = {}): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], opts).trim();
}

export function headOid(opts: { exec?: ExecFn } = {}): string {
  return git(["rev-parse", "HEAD"], opts).trim();
}

export function statusPorcelain(opts: { exec?: ExecFn } = {}): string {
  return git(["status", "--porcelain"], opts);
}

export function diffCached(opts: { exec?: ExecFn } = {}): string {
  return git(["diff", "--cached"], opts);
}

export function diffWorktree(opts: { exec?: ExecFn } = {}): string {
  return git(["diff"], opts);
}

export function diffRange(base: string, head = "HEAD", opts: { exec?: ExecFn } = {}): string {
  return git(["diff", `${base}...${head}`], opts);
}

export function diffStat(base: string, head = "HEAD", opts: { exec?: ExecFn } = {}): string {
  return git(["diff", "--stat", `${base}...${head}`], opts);
}

export function logMessages(base: string, head = "HEAD", opts: { exec?: ExecFn } = {}): string {
  return git(["log", "--format=%B%x1f", `${base}..${head}`], opts);
}

export function hasUpstream(opts: { exec?: ExecFn } = {}): boolean {
  try {
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], opts);
    return true;
  } catch {
    return false;
  }
}

export function unpushedCount(opts: { exec?: ExecFn } = {}): number {
  if (!hasUpstream(opts)) {
    return -1;
  }
  return Number(git(["rev-list", "--count", "@{u}..HEAD"], opts).trim());
}

export function rangeCount(base: string, head = "HEAD", opts: { exec?: ExecFn } = {}): number {
  return Number(git(["rev-list", "--count", `${base}..${head}`], opts).trim());
}

export function add(args: string[] = ["-A"], opts: { exec?: ExecFn } = {}): void {
  git(["add", ...args], opts);
}

// The files `git add -A` would NEWLY stage: untracked and not already
// ignored. --exclude-standard is what makes a correct .gitignore mean "this
// guard never sees the file", so a repo that ignores its local config
// notices no behaviour change at all.
export function listUntracked(opts: { exec?: ExecFn } = {}): string[] {
  return git(["ls-files", "--others", "--exclude-standard"], opts)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
}

export function commitWithMessageFile(messageFile: string, opts: { exec?: ExecFn } = {}): void {
  git(["commit", "-F", messageFile], opts);
}

// Streams stderr: this is where a pre-push hook runs, and its progress belongs on screen.
export function pushExplicit(branch: string, opts: { exec?: ExecFn } = {}): void {
  git(["push", "origin", `HEAD:refs/heads/${branch}`], { ...opts, streamStderr: true });
}

export function setUpstream(branch: string, opts: { exec?: ExecFn } = {}): void {
  git(["branch", `--set-upstream-to=origin/${branch}`], opts);
}

export function originUrl(opts: { exec?: ExecFn } = {}): string | null {
  try {
    return git(["remote", "get-url", "origin"], opts).trim();
  } catch {
    return null;
  }
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// =============================================================================
// pr-merge helpers (additive; pr-open does not use these).
// =============================================================================

export function revParse(ref: string, opts: { exec?: ExecFn } = {}): string {
  return git(["rev-parse", ref], opts).trim();
}

// fetchRefs uses explicit destination refspecs so remote-tracking refs are
// updated. Plain `origin <ref>` updates only FETCH_HEAD. Force-update with `+`
// because remote may have rewound (e.g., pre-rebase) before the run.
export function fetchRefs(remote: string, refs: string[], opts: { exec?: ExecFn } = {}): void {
  if (refs.length === 0) return;
  const refspecs = refs.map(r => `+refs/heads/${r}:refs/remotes/${remote}/${r}`);
  git(["fetch", "--no-tags", remote, ...refspecs], opts);
}

export function checkout(ref: string, opts: { exec?: ExecFn } = {}): void {
  git(["checkout", ref], opts);
}

export function rebaseOnto(onto: string, opts: { exec?: ExecFn } = {}): void {
  git(["rebase", onto], opts);
}

export function abortRebase(opts: { exec?: ExecFn } = {}): void {
  git(["rebase", "--abort"], opts);
}

export function commitWithSubject(subject: string, opts: { exec?: ExecFn } = {}): void {
  git(["commit", "-m", subject], opts);
}

export function resetHard(oid: string, opts: { exec?: ExecFn } = {}): void {
  git(["reset", "--hard", oid], opts);
}

export function updateRef(ref: string, oid: string, opts: { exec?: ExecFn } = {}): void {
  git(["update-ref", ref, oid], opts);
}

export function symbolicHead(opts: { exec?: ExecFn } = {}): string {
  // Returns "HEAD" detached, else "<branch>".
  try {
    return git(["symbolic-ref", "--short", "HEAD"], opts).trim();
  } catch {
    return git(["rev-parse", "HEAD"], opts).trim();
  }
}

export function diffCachedEmpty(opts: { exec?: ExecFn } = {}): boolean {
  try {
    git(["diff", "--cached", "--quiet"], opts);
    return true;
  } catch {
    return false;
  }
}

export function inProgressGitOp(gitDir: string, exists: (p: string) => boolean): string | null {
  // Returns the marker file name if a git op is in progress, else null.
  // Pure function over a filesystem-existence predicate — easy to mock in tests.
  const markers = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "BISECT_LOG", "REVERT_HEAD"];
  for (const m of markers) {
    if (exists(`${gitDir}/${m}`)) return m;
  }
  return null;
}

// Force-push with explicit-OID lease. The lease string is built via argv only.
// Throws on rejection (caller catches and runs rollback).
export function forcePushWithLease(args: {
  remote: string;
  headRef: string;
  expectedRemoteOid: string;     // originalHeadOid — must match remote at push time
}, opts: { exec?: ExecFn } = {}): void {
  git(
    [
      "push",
      `--force-with-lease=refs/heads/${args.headRef}:${args.expectedRemoteOid}`,
      args.remote,
      `HEAD:refs/heads/${args.headRef}`,
    ],
    // Same reason as pushExplicit: the pre-push hook runs here, so let it be seen.
    { ...opts, streamStderr: true },
  );
}

// Binary-safe untracked-file hash. Used by both preflight and execute reverify
// so the worktree-content fingerprint stays symmetric regardless of file size.
export function hashUntrackedFile(absPath: string): string {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return crypto.createHash("sha256").update("").digest("hex");
  }
}

// Non-throwing variant for callers (like cleanup) that probe for success and
// want to surface stderr rather than bubble exceptions. Always returns a
// structured result; stdout/stderr captured as utf-8 strings.
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function tryGit(args: string[], opts: { exec?: ExecFn; input?: string } = {}): GitResult {
  try {
    const out = git(args, opts);
    return { ok: true, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    return {
      ok: false,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? err.message,
    };
  }
}
