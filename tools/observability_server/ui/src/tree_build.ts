/**
 * Aggregate the flat list returned by `GET /api/runs` into the tree
 * shape the left rail renders. Pure function — unit-testable.
 *
 * Hierarchy: repo → branch → PR → run → sub-agent. Sub-agents come
 * from the per-run detail load; the list-only build emits runs with
 * empty `children`.
 */
import type { Run, Subagent, TreeNode } from "./types";

const UNKNOWN_REPO = "<no repo>";
const UNKNOWN_BRANCH = "<no branch>";
const NO_PR = "<no PR>";

export interface BuildTreeOpts {
  runs: Run[];
  /** run_id → list of sub-agents for the detail load. */
  subagentsByRun?: Record<string, Subagent[]>;
  /**
   * Set of sub-agent ids that have emitted a stdout/stderr/gap event
   * recently (within the live-pulse window). Driven by a `live: true`
   * WebSocket subscription per visible running run — see
   * `useLivePulse.ts`. When omitted (or empty), nothing pulses; the
   * subagent's persisted `status === "running"` is NOT used as a
   * stand-in for "currently emitting" (per plan §1.5.3 / Phase 5
   * Task 3: pulse is driven by live emission, not stored status).
   */
  livePulse?: ReadonlySet<string>;
}

export function buildTree(opts: BuildTreeOpts): TreeNode[] {
  const pulse = opts.livePulse;
  const repoMap = new Map<string, Map<string, Map<string, Run[]>>>();
  for (const r of opts.runs) {
    const repo = r.repo ?? UNKNOWN_REPO;
    const branch = r.branch ?? UNKNOWN_BRANCH;
    const pr = r.pr_number === null ? NO_PR : `PR #${r.pr_number}`;
    let byBranch = repoMap.get(repo);
    if (byBranch === undefined) {
      byBranch = new Map();
      repoMap.set(repo, byBranch);
    }
    let byPr = byBranch.get(branch);
    if (byPr === undefined) {
      byPr = new Map();
      byBranch.set(branch, byPr);
    }
    let runs = byPr.get(pr);
    if (runs === undefined) {
      runs = [];
      byPr.set(pr, runs);
    }
    runs.push(r);
  }

  const repos: TreeNode[] = [];
  for (const [repoName, byBranch] of repoMap) {
    const repoChildren: TreeNode[] = [];
    for (const [branchName, byPr] of byBranch) {
      const branchChildren: TreeNode[] = [];
      for (const [prLabel, runs] of byPr) {
        // newest run first
        runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
        const runNodes: TreeNode[] = runs.map((run) => {
          const saList = opts.subagentsByRun?.[run.run_id] ?? [];
          let anyLive = false;
          const saChildren: TreeNode[] = saList.map((sa) => {
            const live = pulse?.has(sa.subagent_id) ?? false;
            if (live) anyLive = true;
            return {
              id: `sa:${run.run_id}:${sa.subagent_id}`,
              kind: "subagent",
              label: `${sa.agent}: ${sa.task}`,
              // aria-label carries the short subagent id so screen-reader
              // users (and the Phase 5 Playwright E2E selectors, which
              // pivot on `aria-label*=…`) can disambiguate sub-agents
              // sharing the same agent+task pair.
              ariaLabel: `${sa.agent} — ${sa.task} — ${sa.status ?? "pending"} — ${shortSubagentId(
                sa.subagent_id,
              )}`,
              status: sa.status,
              children: [],
              subagent: sa,
              isLive: live,
            };
          });
          return {
            id: `run:${run.run_id}`,
            kind: "run",
            label: `${run.dispatcher} · ${shortRunId(run.run_id)}`,
            ariaLabel: `${run.dispatcher} ${shortRunId(run.run_id)} ${run.status ?? "pending"}`,
            status: run.status,
            children: saChildren,
            run,
            isLive: anyLive,
          };
        });
        branchChildren.push({
          id: `pr:${repoName}/${branchName}/${prLabel}`,
          kind: "pr",
          label: prLabel,
          children: runNodes,
        });
      }
      repoChildren.push({
        id: `branch:${repoName}/${branchName}`,
        kind: "branch",
        label: branchName,
        children: branchChildren,
      });
    }
    repos.push({
      id: `repo:${repoName}`,
      kind: "repo",
      label: repoName,
      children: repoChildren,
    });
  }
  repos.sort((a, b) => a.label.localeCompare(b.label));
  return repos;
}

export function shortRunId(runId: string): string {
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8) + "…" + runId.slice(-4);
}

export function shortSubagentId(subagentId: string): string {
  if (subagentId.length <= 8) return subagentId;
  return subagentId.slice(0, 8);
}

/**
 * Flatten the tree into the visible row list (respecting per-node
 * `expanded` state). Returns the rows in render/keyboard-order. Used
 * by the Tree component for Up/Down navigation.
 */
export interface FlatRow {
  node: TreeNode;
  depth: number;
  parentIds: string[];
  hasChildren: boolean;
}

export function flattenTree(
  roots: TreeNode[],
  expanded: ReadonlySet<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  function walk(node: TreeNode, depth: number, parents: string[]): void {
    const hasChildren = node.children.length > 0;
    out.push({ node, depth, parentIds: parents, hasChildren });
    if (hasChildren && expanded.has(node.id)) {
      const next = parents.concat(node.id);
      for (const c of node.children) walk(c, depth + 1, next);
    }
  }
  for (const r of roots) walk(r, 0, []);
  return out;
}
