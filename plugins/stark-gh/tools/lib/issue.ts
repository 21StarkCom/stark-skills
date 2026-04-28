import type { Candidate, ExecFn, Provenance } from "./types.ts";
import * as gh from "./gh.ts";

const BRANCH_RE = /^(feat|fix|chore|docs|refactor|test|perf|ci|build|style|revert)\/(\d+)-/;
const CLOSE_KEYWORD_RE = /\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;
const CROSS_REPO_RE = /\b([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})#(\d+)\b/gi;
const PLAIN_NUM_RE = /(?:^|[^\w/])#(\d+)\b/g;

export interface ExtractInput {
  branch: string;
  commits: string;
  baseRepo: { owner: string; name: string };
  provenance: Provenance;
}

function provenanceRank(p: Provenance): number {
  return ({ "user-provided": 3, "pre-existing-history": 2, branch: 1, "llm-drafted": 0 } as const)[p];
}

export function extractCandidates(input: ExtractInput): Candidate[] {
  const map = new Map<string, Candidate>();
  const key = (c: { owner: string; repo: string; number: number }) => `${c.owner}/${c.repo}#${c.number}`;

  const push = (c: Candidate) => {
    const k = key(c);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, c);
      return;
    }
    const prevRank = provenanceRank(prev.provenance);
    const nextRank = provenanceRank(c.provenance);
    if (nextRank > prevRank || (nextRank === prevRank && prev.relation === "Refs" && c.relation === "Closes")) {
      map.set(k, { ...c });
    }
  };

  const m = BRANCH_RE.exec(input.branch);
  if (m) {
    push({
      number: Number(m[2]),
      owner: input.baseRepo.owner,
      repo: input.baseRepo.name,
      source: "branch",
      relation: "Refs",
      provenance: input.provenance,
    });
  }
  for (const cm of input.commits.matchAll(CROSS_REPO_RE)) {
    push({
      number: Number(cm[3]),
      owner: cm[1]!,
      repo: cm[2]!,
      source: "cross-repo",
      relation: "Refs",
      provenance: input.provenance,
    });
  }
  for (const cm of input.commits.matchAll(CLOSE_KEYWORD_RE)) {
    push({
      number: Number(cm[2]),
      owner: input.baseRepo.owner,
      repo: input.baseRepo.name,
      source: "commit-keyword",
      relation: "Closes",
      provenance: input.provenance,
    });
  }
  for (const cm of input.commits.matchAll(PLAIN_NUM_RE)) {
    push({
      number: Number(cm[1]),
      owner: input.baseRepo.owner,
      repo: input.baseRepo.name,
      source: "commit-mention",
      relation: "Refs",
      provenance: input.provenance,
    });
  }
  return [...map.values()];
}

export function downgradeLlmCloses(candidates: Candidate[]): Candidate[] {
  return candidates.map(c =>
    c.provenance === "llm-drafted" && c.relation === "Closes" ? { ...c, relation: "Refs" } : c,
  );
}

export async function verify(candidates: Candidate[], opts: { exec?: ExecFn } = {}): Promise<Candidate[]> {
  return candidates.map(c => ({
    ...c,
    verified: gh.issueExists(c.owner, c.repo, c.number, opts),
  }));
}

export function formatLine(c: Candidate, baseRepo: { owner: string; name: string }): string {
  const sameRepo = c.owner === baseRepo.owner && c.repo === baseRepo.name;
  return sameRepo ? `${c.relation} #${c.number}` : `${c.relation} ${c.owner}/${c.repo}#${c.number}`;
}

export function emitLines(
  candidates: Candidate[],
  baseRepo: { owner: string; name: string },
): { closesLines: string[]; refsLines: string[] } {
  const closesLines: string[] = [];
  const refsLines: string[] = [];
  for (const c of candidates) {
    if (c.verified === false) continue;
    const line = formatLine(c, baseRepo);
    if (c.relation === "Closes" && c.owner === baseRepo.owner && c.repo === baseRepo.name) {
      closesLines.push(line);
    } else {
      refsLines.push(line);
    }
  }
  return { closesLines, refsLines };
}
