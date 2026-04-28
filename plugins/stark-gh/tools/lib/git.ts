import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { ExecFn } from "./types.ts";

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

export function git(args: string[], opts: { exec?: ExecFn; input?: string } = {}): string {
  const exec = opts.exec ?? defaultExec;
  return exec("git", args, { input: opts.input }).toString("utf8");
}

export function isGitRepo(opts: { exec?: ExecFn } = {}): boolean {
  try {
    git(["rev-parse", "--git-dir"], opts);
    return true;
  } catch {
    return false;
  }
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

export function commitWithMessageFile(messageFile: string, opts: { exec?: ExecFn } = {}): void {
  git(["commit", "-F", messageFile], opts);
}

export function pushExplicit(branch: string, opts: { exec?: ExecFn } = {}): void {
  git(["push", "origin", `HEAD:refs/heads/${branch}`], opts);
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
