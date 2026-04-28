// Shared base/head OID re-verify helper. Used by:
//   - gh_pr_merge_execute.ts (--no-watch path, before merge)
//   - gh_pr_merge_complete.ts (watcher on-green callback, before merge)
// Single canonical comparison logic — no path-specific drift.

import { fetchRefs, revParse } from "./git.ts";
import { apiGraphql } from "./gh.ts";
import type { ExecFn } from "./types.ts";
import type { PrMergePlan } from "./plan.ts";

export type Mismatch =
  | { ok: true }
  | { ok: false; kind: "base_moved"; expected: string; actual: string }
  | { ok: false; kind: "head_moved"; expected: string; actual: string };

const HEAD_OID_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) { headRefOid }
  }
}
`;

export async function verifyMergeOids(
  plan: PrMergePlan,
  opts: { exec?: ExecFn } = {},
): Promise<Mismatch> {
  // 1. Re-fetch base and read its current SHA from the local remote-tracking ref.
  fetchRefs("origin", [plan.pr.baseRef], opts);
  const actualBaseOid = revParse(`refs/remotes/origin/${plan.pr.baseRef}`, opts);
  if (actualBaseOid !== plan.baseOid) {
    return { ok: false, kind: "base_moved", expected: plan.baseOid, actual: actualBaseOid };
  }

  // 2. Query PR head via GraphQL — authoritative for what we're about to merge.
  const expectedHead = plan.pushedHeadOid;
  if (!expectedHead) {
    // Defensive: caller invoked us before push completed.
    return { ok: false, kind: "head_moved", expected: "<null>", actual: "<no pushedHeadOid>" };
  }
  const resp = (await apiGraphql(HEAD_OID_QUERY, {
    owner: plan.pr.headRepositoryOwner,
    repo: plan.pr.headRepositoryName,
    pr: plan.pr.number,
  } as Record<string, unknown>, opts)) as Record<string, any>;
  const actualHead = resp?.data?.repository?.pullRequest?.headRefOid;
  if (typeof actualHead !== "string") {
    return { ok: false, kind: "head_moved", expected: expectedHead, actual: "<query failed>" };
  }
  if (actualHead !== expectedHead) {
    return { ok: false, kind: "head_moved", expected: expectedHead, actual: actualHead };
  }

  return { ok: true };
}
