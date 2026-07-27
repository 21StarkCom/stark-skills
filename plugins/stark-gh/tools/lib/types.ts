export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    /** Inherit the child's stderr instead of capturing it, so long-running commands show
     *  progress live. Only for callers that ignore the returned string — see `lib/git.ts`. */
    streamStderr?: boolean;
  },
) => Buffer;

export type Confidence = "high" | "low";
export type Relation = "Closes" | "Refs";
export type IssueSource = "branch" | "commit-keyword" | "commit-mention" | "cross-repo";
export type Provenance = "branch" | "pre-existing-history" | "user-provided" | "llm-drafted";

export interface Candidate {
  number: number;
  owner: string;
  repo: string;
  source: IssueSource;
  relation: Relation;
  provenance: Provenance;
  verified?: boolean;
}
