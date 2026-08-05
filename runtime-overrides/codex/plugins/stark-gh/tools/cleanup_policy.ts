// Codex cleanup safety policy kept pure so destructive decisions are directly
// regression-testable without running git or gh.

export function shouldFetchForPlan(args: { dryRun: boolean }): boolean {
  return !args.dryRun;
}

export function mayDeleteLocalBranch(
  branch: { safeDelete: boolean },
  args: { force: boolean },
): boolean {
  return branch.safeDelete || args.force;
}
