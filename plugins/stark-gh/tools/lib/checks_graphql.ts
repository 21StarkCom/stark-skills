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
    startedAt: string | null;
    completedAt: string | null;
  }
  | {
    kind: "StatusContext";
    context: string;
    isRequired: boolean;
    state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
    createdAt: string | null;
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
                    startedAt
                    completedAt
                    isRequired(pullRequestNumber: $pr)
                  }
                  ... on StatusContext {
                    context
                    state
                    createdAt
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
          startedAt: n.startedAt ?? null,
          completedAt: n.completedAt ?? null,
        });
      } else if (n.__typename === "StatusContext") {
        all.push({
          kind: "StatusContext",
          context: n.context,
          isRequired: !!n.isRequired,
          state: n.state,
          createdAt: n.createdAt ?? null,
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
//
// SKIPPED is deliberately NOT passing here, which is a departure from GitHub's
// own required-check semantics (GitHub counts a skipped check as satisfying the
// requirement, so a skip is *visually and mechanically* indistinguishable from
// a pass in the merge box). That equivalence is exactly the hole this predicate
// exists to close: a skipped job is proof that the suite never ran, not proof
// that it passed. Measured on 21StarkCom/stark-skills#877 — the draft guard
// skipped `test` on the head sha, nothing else replaced it, and the PR merged
// with the suite having never executed against what landed.
//
// Repos that legitimately skip a required check by design (path filters) opt
// back in with `--allow-skipped-checks`, which is honoured by the callers
// rather than here — this predicate always reports what actually happened.
export function isCheckPassing(c: Context): boolean {
  if (!c.isRequired) return false;       // not a release gate
  if (c.kind === "CheckRun") {
    return c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL";
  }
  return c.state === "SUCCESS";
}

// A required check that ran nothing. Kept separate from failing: nothing is
// broken, but nothing was verified either, and — unlike a failure — no amount
// of waiting repairs it (see the watcher's terminal handling).
export function isCheckSkipped(c: Context): boolean {
  if (!c.isRequired) return false;
  return c.kind === "CheckRun" && c.conclusion === "SKIPPED";
}

export function contextName(c: Context): string {
  return c.kind === "CheckRun" ? c.name : c.context;
}

// Still running — no verdict yet. A CheckRun carries no `conclusion` until it
// finishes, which is the reliable signal; `status` corroborates but is not
// populated in every payload shape, so conclusion is the anchor.
export function isCheckPending(c: Context): boolean {
  if (c.kind === "StatusContext") return c.state === "PENDING" || c.state === "EXPECTED";
  return c.conclusion === null;
}

// Recency key for same-named contexts, used ONLY to order contexts that have
// both finished. `max` rather than a preferred field because GitHub's own data
// is not internally ordered: on #877's head sha the skipped `test` reported
// startedAt=10:32:17Z with completedAt=10:32:08Z, i.e. completed nine seconds
// before it started. Taking the max makes the key monotone regardless of which
// field is populated or sane.
//
// It must NEVER be used to rank a running context against a finished one — see
// latestPerName.
function recencyKey(c: Context): string {
  if (c.kind === "StatusContext") return c.createdAt ?? "";
  const a = c.startedAt ?? "";
  const b = c.completedAt ?? "";
  return a > b ? a : b;
}

// One rollup can carry several contexts with the SAME name — one per run that
// reported it. GitHub evaluates only the most recent of each when deciding
// whether a required check is satisfied; counting every entry instead inflates
// `required` and lets a stale entry decide the verdict. Observed on #877, whose
// rollup carried `sync` twice (SKIPPED 10:32:08Z, then SUCCESS 10:35:15Z).
//
// A STILL-RUNNING context always wins its group, regardless of timestamps. That
// is not a tie-break preference — timestamps cannot order these two states at
// all. A running check has `completedAt: null`, so its key is frozen at
// startedAt while a finished sibling's key advances to its completedAt; whenever
// two runs for one check overlap, the OLDER finished one therefore out-keys the
// newer running one. Ranking by timestamp would hand the verdict to the stale
// row and report `pending: 0` while the check that actually gates the merge is
// mid-flight — merging on a result that has not happened yet. A queued run is
// worse still: it has no startedAt either, so its key is the empty string and
// it loses to everything.
//
// Among contexts that have all finished, ties are broken fail-closed: with
// indistinguishable timestamps we keep the entry that is NOT passing, so an
// ambiguous pair can never resolve to green.
export function latestPerName(contexts: Context[]): Context[] {
  const byName = new Map<string, Context>();
  for (const c of contexts) {
    const key = contextName(c);
    const incumbent = byName.get(key);
    if (!incumbent) { byName.set(key, c); continue; }
    const dPending = isCheckPending(c);
    const iPending = isCheckPending(incumbent);
    if (dPending !== iPending) {
      if (dPending) byName.set(key, c);   // running beats finished, either direction
      continue;
    }
    const dk = recencyKey(c);
    const ik = recencyKey(incumbent);
    if (dk > ik) byName.set(key, c);
    else if (dk === ik && isCheckPassing(incumbent) && !isCheckPassing(c)) byName.set(key, c);
  }
  return [...byName.values()];
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
  required: number;          // count of DISTINCT required check names
  passing: number;
  failing: number;
  skipped: number;
  pending: number;
  allPassing: boolean;       // true iff (required === 0) OR (passing === required)
  anyFailing: boolean;
  anySkipped: boolean;
  skippedNames: string[];    // for operator-facing messages
  vacuous: boolean;          // required === 0 ⇒ vacuous pass
}

// Policy-aware green test. `allPassing` on the verdict is the strict reading —
// every required check actually reported success — and stays that way so the
// skipped count is never silently folded into it. Callers additionally refuse a
// skipped required check outright (with their own operator-facing message)
// before reaching here; this helper is what lets an allowed skip still count
// toward green once they have.
export function isGreen(v: RollupVerdict, opts: { allowSkippedChecks?: boolean } = {}): boolean {
  if (v.required === 0) return true;
  const passing = opts.allowSkippedChecks ? v.passing + v.skipped : v.passing;
  return passing === v.required;
}

// Counts the LATEST context per name (see latestPerName), so `required` is a
// count of distinct required checks rather than of rollup rows.
//
// Required-filter FIRST, dedupe second. The other order lets a non-required
// context erase a required one of the same name: dedupe would pick the
// non-required row as the group's winner, the `isRequired` filter would then
// drop it, and the required check would vanish from the count entirely rather
// than fail the verdict — shrinking `required` toward the vacuous pass. Filtering
// first makes the two sets disjoint, so no non-required row can ever shadow a
// gate.
export function summarizeVerdict(contexts: Context[]): RollupVerdict {
  let required = 0, passing = 0, failing = 0;
  const skippedNames: string[] = [];
  for (const c of latestPerName(contexts.filter(c => c.isRequired))) {
    required++;
    if (isCheckPassing(c)) passing++;
    else if (isCheckFailing(c)) failing++;
    else if (isCheckSkipped(c)) skippedNames.push(contextName(c));
  }
  const skipped = skippedNames.length;
  const pending = required - passing - failing - skipped;
  return {
    required,
    passing,
    failing,
    skipped,
    pending,
    allPassing: required === 0 || passing === required,
    anyFailing: failing > 0,
    anySkipped: skipped > 0,
    skippedNames,
    vacuous: required === 0,
  };
}
