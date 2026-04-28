// Stable exit codes for pr-open. See pr-open design spec for meanings.
// pr-merge has its own MergeExit constants below — separate namespaces so
// existing pr-open codes stay stable.
export const Exit = {
  OK: 0,
  GENERIC: 1,
  NOT_GIT_REPO: 10,
  ON_DEFAULT_BRANCH: 11,
  INVALID_BRANCH_NAME: 12,
  GH_NOT_AUTHED: 13,
  NO_REMOTE: 14,
  CANNOT_RESOLVE_BASE: 15,
  SECRET_HIT_PREFLIGHT: 16,
  UNRECOGNIZED_FLAG: 17,
  PROMPT_BUDGET_EXCEEDED: 18,
  UNSTAGED_ONLY: 19,
  GH_PR_CREATE_FAILED: 21,
  GH_PR_EDIT_FAILED: 22,
  PUSH_FAILED: 23,
  STATE_DRIFT: 25,
  PLAN_FILE_INVALID: 26,
  NOTHING_STAGED: 27,
  SECRET_HIT_POST_STAGE: 28,
  ORIGIN_MISMATCH: 29,
  DRAFT_INVALID_OUTPUT: 30,
  BASE_OID_DRIFT: 31,
  PR_NOT_RESOLVED: 32,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];

// Stable exit codes for pr-merge. Per design spec.
// Numeric ranges intentionally separate from pr-open codes where they collide
// (e.g., 10/11/13/14/etc. mean different things in pr-merge); merge tools
// should import MergeExit, not Exit.
export const MergeExit = {
  OK: 0,
  BAD_ARGS: 10,                  // bad args / unknown PR / no PR for current branch
  PR_GATE: 11,                   // PR is draft, closed, or merged (no --force for draft)
  CHECK_FAIL: 12,                // failing/missing required checks; or --no-watch with non-green
  CONFLICT_OR_DIRTY: 13,         // rebase conflict; or working tree dirty / git op in progress
  BASE_OID_MOVED: 14,            // base OID moved between fetch and plan write
  NO_CHANGELOG: 15,              // CHANGELOG.md missing or no [Unreleased] section
  SECRET_LLM: 16,                // secret in pre-LLM scan, no --allow-secret-to-llm
  FORK_OR_HEAD_MISMATCH: 17,     // cross-repo PR; or origin/<headRef> != PR's headRefOid
  LOCAL_DIVERGED: 18,            // local <headRef> has unpushed commits or diverges from origin
  SELF_MODIFYING_PR: 19,         // PR diff touches stark-skills runtime files
  DRAFT_INVALID: 20,             // codex error / invalid output after retry
  SECRET_COMMIT: 28,             // secret in pre-commit scan, no --allow-secret-commit
  OID_DRIFT: 30,                 // base OID or rebased HEAD moved between push and merge
  PUSH_REJECTED: 31,             // force-push rejected, or origin URL mismatch
  MERGE_FAILED: 32,              // gh merge failed (non-OID; e.g., branch protection)
  SPAWN_FAILED: 33,              // watcher spawn failed
  WATCHER_RUNNING: 34,           // watcher already running for this PR (recovery hint printed)
} as const;

export type MergeExitCode = (typeof MergeExit)[keyof typeof MergeExit];
