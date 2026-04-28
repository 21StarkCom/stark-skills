export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
) => Buffer;

export type Confidence = "high" | "low";
export type Relation = "Closes" | "Refs";
export type IssueSource = "branch" | "commit-keyword" | "commit-mention" | "cross-repo";

export interface Candidate {
  number: number;
  owner: string;
  repo: string;
  source: IssueSource;
  relation: Relation;
  verified?: boolean;
}
