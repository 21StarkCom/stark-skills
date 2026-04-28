export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
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
