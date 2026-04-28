// GraphQL-based required-check rollup. Replaces `gh pr checks` (which lacks
// per-check SHA and isRequired). Uses authenticated `gh api graphql` via
// lib/gh.ts:apiGraphql.
//
// Caller-provided `expectedHeadOid` enforces SHA-match: if the PR's current
// `headRefOid` doesn't match, the helper returns `{mismatch: true, contexts: null}`
// so the caller can write a `head_moved` terminal state instead of consuming
// stale check data.

import { apiGraphql as defaultApiGraphql } from "./gh.ts";
import type { ExecFn } from "./types.ts";

export type ApiGraphqlFn = (
  query: string,
  vars: Record<string, unknown>,
  opts?: { exec?: ExecFn },
) => Promise<unknown> | unknown;

export type Context =
  | {
    kind: "CheckRun";
    name: string;
    isRequired: boolean;
    conclusion: "SUCCESS" | "NEUTRAL" | "SKIPPED" | "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" | null;
    status: string;
  }
  | {
    kind: "StatusContext";
    context: string;
    isRequired: boolean;
    state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
  };

export interface RollupResult {
  headRefOid: string;
  contexts: Context[] | null;
  mismatch: boolean;          // true ⇒ headRefOid !== expectedHeadOid; contexts is null
}

const QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    conclusion
                    status
                    isRequired(pullRequestNumber: $pr)
                  }
                  ... on StatusContext {
                    context
                    state
                    isRequired(pullRequestNumber: $pr)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

export interface FetchArgs {
  owner: string;
  repo: string;
  prNumber: number;
  expectedHeadOid: string;
}

// Pagination loop. Aggregates all pages of `contexts` before returning.
// Throws on transport / auth errors so the watcher can apply backoff.
export async function fetchRequiredCheckRollup(
  args: FetchArgs,
  opts: { exec?: ExecFn; apiGraphql?: ApiGraphqlFn } = {},
): Promise<RollupResult> {
  const apiGraphql = opts.apiGraphql ?? defaultApiGraphql;
  let cursor: string | null = null;
  const all: Context[] = [];
  let observedHeadRefOid = "";

  while (true) {
    const resp = (await apiGraphql(QUERY, {
      owner: args.owner,
      repo: args.repo,
      pr: args.prNumber,
      after: cursor,
    } as Record<string, unknown>, opts)) as Record<string, any>;

    const root = resp?.data?.repository?.pullRequest;
    if (!root) {
      throw new Error("checks_graphql: pullRequest payload missing");
    }
    observedHeadRefOid = root.headRefOid;
    const node = root.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    if (!node) {
      // No rollup at all (no checks ever associated with the SHA). Treat as empty.
      break;
    }
    const page = node.contexts;
    for (const n of page?.nodes ?? []) {
      if (n.__typename === "CheckRun") {
        all.push({
          kind: "CheckRun",
          name: n.name,
          isRequired: !!n.isRequired,
          conclusion: n.conclusion ?? null,
          status: n.status,
        });
      } else if (n.__typename === "StatusContext") {
        all.push({
          kind: "StatusContext",
          context: n.context,
          isRequired: !!n.isRequired,
          state: n.state,
        });
      }
    }
    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor as string;
  }

  if (observedHeadRefOid && observedHeadRefOid !== args.expectedHeadOid) {
    return { headRefOid: observedHeadRefOid, contexts: null, mismatch: true };
  }
  return { headRefOid: observedHeadRefOid, contexts: all, mismatch: false };
}

// Single canonical predicate, reused by preflight, --no-watch, watcher
// SHA-match, and on-green callback.
export function isCheckPassing(c: Context): boolean {
  if (!c.isRequired) return false;       // not a release gate
  if (c.kind === "CheckRun") {
    return c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED";
  }
  return c.state === "SUCCESS";
}

const FAILING_CHECK_RUN = new Set([
  "FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
]);
const FAILING_STATUS = new Set(["FAILURE", "ERROR"]);

export function isCheckFailing(c: Context): boolean {
  if (!c.isRequired) return false;
  if (c.kind === "CheckRun") return c.conclusion !== null && FAILING_CHECK_RUN.has(c.conclusion);
  return FAILING_STATUS.has(c.state);
}

export interface RollupVerdict {
  required: number;          // count of contexts where isRequired === true
  passing: number;
  failing: number;
  pending: number;
  allPassing: boolean;       // true iff (required === 0) OR (passing === required)
  anyFailing: boolean;
  vacuous: boolean;          // required === 0 ⇒ vacuous pass
}

export function summarizeVerdict(contexts: Context[]): RollupVerdict {
  let required = 0, passing = 0, failing = 0;
  for (const c of contexts) {
    if (!c.isRequired) continue;
    required++;
    if (isCheckPassing(c)) passing++;
    else if (isCheckFailing(c)) failing++;
  }
  const pending = required - passing - failing;
  return {
    required,
    passing,
    failing,
    pending,
    allPassing: required === 0 || passing === required,
    anyFailing: failing > 0,
    vacuous: required === 0,
  };
}
