#!/usr/bin/env node

// Verify a review worktree is safe to discard, then remove it. "Safe" means:
// no working-tree changes, no staged changes, and HEAD still equal to the
// PR head we recorded at setup time. If anything's drifted (e.g. unpushed
// fix commits) we leave the worktree in place and tell the caller why so
// nothing gets lost.

import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type CleanupReason =
  | "removed"
  | "no-such-worktree"
  | "unstaged-changes"
  | "staged-changes"
  | "head-drift";

export type CleanupReceipt = {
  removed: boolean;
  reason: CleanupReason;
  worktreePath: string;
  expectedHead: string;
  observedHead: string | null;
};

export type Runner = {
  git: (args: string[], cwd?: string) => string;
  worktreeRemove: (worktreePath: string) => string;
  worktreeExists: (worktreePath: string) => boolean;
};

const REAL_RUNNER: Runner = {
  git: (args, cwd) => execFileSync("git", args, { encoding: "utf8", cwd }),
  worktreeRemove: (worktreePath) =>
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
      encoding: "utf8",
    }),
  worktreeExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
};

export type CleanupOptions = {
  worktreePath: string;
  expectedHead: string;
  runner?: Runner;
};

export function cleanupWorktree(opts: CleanupOptions): CleanupReceipt {
  const runner = opts.runner ?? REAL_RUNNER;
  if (!runner.worktreeExists(opts.worktreePath)) {
    return {
      removed: false,
      reason: "no-such-worktree",
      worktreePath: opts.worktreePath,
      expectedHead: opts.expectedHead,
      observedHead: null,
    };
  }
  if (!gitDiffQuiet(["diff", "--quiet"], opts.worktreePath, runner)) {
    return {
      removed: false,
      reason: "unstaged-changes",
      worktreePath: opts.worktreePath,
      expectedHead: opts.expectedHead,
      observedHead: safeHead(opts.worktreePath, runner),
    };
  }
  if (!gitDiffQuiet(["diff", "--cached", "--quiet"], opts.worktreePath, runner)) {
    return {
      removed: false,
      reason: "staged-changes",
      worktreePath: opts.worktreePath,
      expectedHead: opts.expectedHead,
      observedHead: safeHead(opts.worktreePath, runner),
    };
  }
  const head = safeHead(opts.worktreePath, runner);
  if (head !== opts.expectedHead) {
    return {
      removed: false,
      reason: "head-drift",
      worktreePath: opts.worktreePath,
      expectedHead: opts.expectedHead,
      observedHead: head,
    };
  }
  runner.worktreeRemove(opts.worktreePath);
  return {
    removed: true,
    reason: "removed",
    worktreePath: opts.worktreePath,
    expectedHead: opts.expectedHead,
    observedHead: head,
  };
}

function safeHead(worktreePath: string, runner: Runner): string | null {
  try {
    return runner.git(["rev-parse", "HEAD"], worktreePath).trim();
  } catch {
    return null;
  }
}

function gitDiffQuiet(args: string[], cwd: string, runner: Runner): boolean {
  try {
    runner.git(args, cwd);
    return true;
  } catch (err) {
    const status = (err as SpawnSyncReturns<string>).status;
    // git diff --quiet exits 1 when there are differences. Anything else
    // is a real error (corrupt repo, wrong cwd) and we propagate so the
    // caller doesn't silently destroy a worktree it can't inspect.
    if (status === 1) return false;
    throw err;
  }
}

// ── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  worktreePath: string | null;
  expectedHead: string | null;
  asJson: boolean;
} {
  let worktreePath: string | null = null;
  let expectedHead: string | null = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--worktree") worktreePath = argv[++i] ?? null;
    else if (arg === "--head-sha") expectedHead = argv[++i] ?? null;
    else if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: review_cleanup_worktree --worktree PATH --head-sha SHA [--json]",
      );
      process.exit(0);
    }
  }
  return { worktreePath, expectedHead, asJson };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.worktreePath) {
    console.error("--worktree is required");
    process.exit(2);
  }
  if (!opts.expectedHead) {
    console.error("--head-sha is required");
    process.exit(2);
  }
  const receipt = cleanupWorktree({
    worktreePath: opts.worktreePath,
    expectedHead: opts.expectedHead,
  });
  if (opts.asJson) {
    console.log(JSON.stringify(receipt, null, 2));
  } else if (receipt.removed) {
    console.log(`removed: ${receipt.worktreePath}`);
  } else {
    console.log(
      `kept ${receipt.worktreePath} (${receipt.reason}; ` +
        `expected ${receipt.expectedHead}, observed ${receipt.observedHead ?? "?"})`,
    );
  }
  // Exit 0 even when the worktree was kept — a non-removal isn't a tool
  // failure, it's a deliberate safety decision and the receipt explains why.
  process.exit(0);
}

// Match against both the lexical and realpath form of argv[1]:
//   - Node's --experimental-strip-types loader (Node 25+) sets import.meta.url
//     to the realpath, so a symlinked invocation needs the realpath comparison.
//   - NODE_OPTIONS=--preserve-symlinks-main keeps import.meta.url at the
//     symlink URL, so we need the lexical comparison too.
//   - realpathSync throws if argv[1] doesn't exist on disk (embedded runners
//     that fake argv[1]); swallow that and fall through to "not invoked".
function isInvokedAsScript(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(path.resolve(argv1)).href) return true;
  try {
    return metaUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main();
}
