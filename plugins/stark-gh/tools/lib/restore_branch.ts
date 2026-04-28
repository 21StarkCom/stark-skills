// Cross-stage cleanup tool. Invoked by the slash-body trap on any non-zero
// exit from preflight/draft/execute *before successful push*. Idempotent.
//
// Two-step restore:
//   1. git update-ref refs/heads/<headRef> <originalHeadOid>
//      (undoes the rebase on the head branch — required because resetting
//      HEAD alone doesn't move the branch ref when starting on headRef)
//   2. git checkout <startingRef>
//      (puts the user back on their original symbolic ref)
//
// Plus restores CHANGELOG.md from originalChangelogPath if present and differs.
//
// Usage: node --experimental-strip-types lib/restore_branch.ts <plan-file>
// Exits 0 if restore succeeded or was a no-op; non-zero on hard error.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { readPrMergePlan } from "./plan.ts";
import type { ExecFn } from "./types.ts";

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

export interface RestoreResult {
  branchUpdated: boolean;       // true if update-ref ran (false if branch already at originalHeadOid)
  checkedOut: boolean;          // true if checkout ran (false if already on startingRef)
  changelogRestored: boolean;   // true if CHANGELOG.md was overwritten from tempfile
  warnings: string[];
}

export function restoreBranchFromPlan(planFilePath: string, opts: { exec?: ExecFn } = {}): RestoreResult {
  const exec = opts.exec ?? defaultExec;
  const plan = readPrMergePlan(planFilePath);
  const result: RestoreResult = {
    branchUpdated: false,
    checkedOut: false,
    changelogRestored: false,
    warnings: [],
  };

  // Determine the user's current symbolic ref up front; the restore strategy
  // differs depending on whether they were on the PR head branch (where the
  // rebase happened) or somewhere else.
  let currentSymRef = "";
  try {
    currentSymRef = exec("git", ["symbolic-ref", "--short", "HEAD"], {}).toString("utf8").trim();
  } catch {
    // detached HEAD — fall through
  }

  // Step 1: undo the rebase on the head branch back to originalHeadOid.
  // If the user is currently checked out on the head branch, a bare
  // `update-ref` would leave HEAD->branch->originalHeadOid but the index
  // and worktree still at the rebased tree — invariants broken. Use
  // `git reset --hard` in that case so HEAD, index, and worktree all move
  // together.
  let currentBranchSha = "";
  try {
    currentBranchSha = exec("git", ["rev-parse", `refs/heads/${plan.pr.headRef}`], {}).toString("utf8").trim();
  } catch {
    result.warnings.push(`could not rev-parse refs/heads/${plan.pr.headRef}; skipping update-ref`);
  }
  if (currentBranchSha && currentBranchSha !== plan.originalHeadOid) {
    if (currentSymRef === plan.pr.headRef) {
      try {
        exec("git", ["reset", "--hard", plan.originalHeadOid], {});
        result.branchUpdated = true;
      } catch (err) {
        result.warnings.push(`reset --hard failed: ${(err as Error).message}`);
      }
    } else {
      try {
        exec("git", ["update-ref", `refs/heads/${plan.pr.headRef}`, plan.originalHeadOid], {});
        result.branchUpdated = true;
      } catch (err) {
        result.warnings.push(`update-ref failed: ${(err as Error).message}`);
      }
    }
  }

  // Step 2: checkout startingRef (only if not already there).
  if (currentSymRef !== plan.startingRef) {
    try {
      exec("git", ["checkout", plan.startingRef], {});
      result.checkedOut = true;
    } catch (err) {
      result.warnings.push(`checkout ${plan.startingRef} failed: ${(err as Error).message}`);
    }
  }

  // Step 3: restore CHANGELOG.md from originalChangelogPath if both exist and differ.
  try {
    const tempExists = fs.existsSync(plan.originalChangelogPath);
    const liveExists = fs.existsSync(plan.changelog.filePath);
    if (tempExists && liveExists) {
      const tempContent = fs.readFileSync(plan.originalChangelogPath);
      const liveContent = fs.readFileSync(plan.changelog.filePath);
      if (!tempContent.equals(liveContent)) {
        fs.writeFileSync(plan.changelog.filePath, tempContent);
        result.changelogRestored = true;
      }
    } else if (tempExists && !liveExists) {
      // Live deleted — restore from temp.
      fs.writeFileSync(plan.changelog.filePath, fs.readFileSync(plan.originalChangelogPath));
      result.changelogRestored = true;
    }
  } catch (err) {
    result.warnings.push(`CHANGELOG.md restore failed: ${(err as Error).message}`);
  }

  return result;
}

// CLI entry point.
function main(): number {
  const planFile = process.argv[2];
  if (!planFile) {
    process.stderr.write("usage: restore_branch.ts <plan-file>\n");
    return 2;
  }
  try {
    const result = restoreBranchFromPlan(planFile);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`restore_branch failed: ${(err as Error).message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
