/**
 * review_post_lib.ts — the REST `gh` transport and the single-anchored-review
 * poster.
 *
 * Extracted verbatim from `stark_review.ts` when `/stark-review` was buried
 * (STARK-6098 — see the nastrond grave `graves/stark-skills/stark-review`).
 * The dispatcher around it died; this did not, because two living consumers
 * hold it up:
 *
 *   - `findings_review_post.ts` — publishes `/code-review`'s `ReportFindings`
 *     payload as ONE anchored review, which is the repo's actual review-posting
 *     path
 *   - `iac_review_lib.ts` — `/stark-terraform-review` + `/stark-terragrunt-review`
 *     use `ghJsonOnce` for their PR posting
 *
 * The two behaviours worth not losing in the move, both pinned by
 * `review_post_lib.test.ts`:
 *
 *   - **No-drop 422 fallback.** GitHub rejects an inline comment whose anchor
 *     is not in a diff hunk. Rather than lose the finding, `postReview` demotes
 *     the rejected anchors to the review body, retries, and on a second 422
 *     demotes every anchor. A finding never disappears because of an anchor.
 *   - **Marker-aware retry.** Every posted body starts with a marker
 *     (`buildMarker`). Between 5xx retries the poster re-reads the PR's reviews
 *     and stops if the marker is already there, so a
 *     successful-but-unacknowledged POST cannot double-post. The same read
 *     happens once up front (STARK-6125, `review_post_rerun.test.ts`), so a
 *     RERUN over a landed-but-`unposted` review writes nothing either.
 *
 * REST-only by contract: `rejectGraphqlPath` refuses a GraphQL path, and
 * `check-rest-only.sh` guards this file in CI.
 */
import { createHash } from "node:crypto";

import { spawnBounded } from "./bounded_spawn_lib.ts";

import { assertGhTimeoutMs, explainTermination, resolveGhTimeoutMs } from "./child_termination_lib.ts";
import {
  buildMarker,
  compareSeverityDesc,
  findingId,
  severityMeetsThreshold,
  type AgentName,
  type BodyReason,
  type Finding,
  type Severity,
} from "./finding_lib.ts";

// ─── REST transport ─────────────────────────────────────────────────────────

export interface GhJsonOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  paginate?: boolean;
  /** Bound on the `gh` subprocess. Default: `resolveGhTimeoutMs()`
   * (`STARK_GH_TIMEOUT_MS`, else the measured 120 s — see child_termination_lib). */
  timeoutMs?: number;
}

export interface GhJsonResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export class GhError extends Error {
  status: number;
  body: string;
  headers: Record<string, string>;
  constructor(status: number, body: string, headers: Record<string, string>, msg?: string) {
    super(msg ?? `gh api failed with status ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function rejectGraphqlPath(p: string): void {
  // Avoid embedding the literal token "graphql" preceded by '/' in this source
  // so tools/check-rest-only.sh (the REST-only CI guard) does not flag the
  // rejection itself as a violation.
  if (p.toLowerCase().includes("graph" + "ql")) {
    throw new Error(`REST-only contract violated: ${p} contains forbidden token`);
  }
}

/**
 * Call `gh api` against a REST endpoint. Forbids any 'graphql' substring in the
 * path. With paginate=true (default for GET array endpoints), uses gh's
 * --paginate flag and concatenates result arrays.
 */
export async function ghJsonOnce(p: string, opts: GhJsonOpts = {}): Promise<GhJsonResult> {
  rejectGraphqlPath(p);
  const method = opts.method ?? "GET";
  const args: string[] = ["api"];
  if (opts.paginate ?? method === "GET") args.push("--paginate");
  args.push("-X", method);
  args.push("-H", "Accept: application/vnd.github+json");
  args.push("-i");
  args.push(p);
  const input = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (input !== undefined) args.push("--input", "-");
  // Resolved before the spawn, so an unusable bound is refused outright instead
  // of running `gh` unbounded. `opts.timeoutMs` is held to the env var's rule:
  // `setTimeout` fires 0, NaN and anything past 2^31-1 ms after ~1 ms, so an
  // unvalidated `timeoutMs: 0` ("no timeout", by convention) kills every call.
  const timeoutMs = opts.timeoutMs === undefined
    ? resolveGhTimeoutMs()
    : assertGhTimeoutMs(opts.timeoutMs, "opts.timeoutMs");
  const res = await spawnBounded("gh", args, { input, env: { ...process.env }, timeoutMs });
  if (res.status === null) {
    // Checked BEFORE stdout is parsed: a `--paginate` killed between pages
    // leaves complete HTTP blocks behind, which parse as a clean 200 silently
    // missing every later page. A terminated child's output is never a result.
    const why = explainTermination("gh", res, res.stderr, undefined, timeoutMs);
    throw new GhError(-1, why, {}, `gh api ${p} failed: ${why.slice(0, 400)}`);
  }
  const { headers, body, status } = parseHttpStream(res.stdout);
  // `gh api` exits 0 on every 2xx, so a non-zero exit behind one is the kill
  // above reached by a plain exit: an earlier page landed, a later one died at
  // the transport with no HTTP block to parse. Same truncated 200, same answer.
  const partial = res.status !== 0 && status >= 200 && status < 300;
  if (status === 0 || partial) {
    const own = (partial ? res.stderr : res.stderr || res.stdout).trim();
    // The exit code goes in the BODY, not only the message: `postReview`
    // reports `err.body`, so a silent non-zero exit would otherwise surface in
    // `unpostedReason` as a bare `http_-1: `.
    const why = `gh exited ${res.status}${partial ? " after a partial 2xx response" : ""}: ${own}`;
    throw new GhError(-1, why, {}, `gh api ${p} failed: ${why.slice(0, 400)}`);
  }
  let data: unknown = null;
  if (body.length > 0) data = parseConcatenatedJson(body);
  if (status >= 400) throw new GhError(status, body, headers);
  return { status, data, headers };
}

/**
 * Public ghJson: same as ghJsonOnce but retries on 429 / 403 rate-limit / 5xx
 * per the retry policy. Non-retriable failures (4xx other than rate-limit, and
 * 422) still throw on the first attempt.
 */
export async function ghJson(p: string, opts: GhJsonOpts = {}): Promise<GhJsonResult> {
  return await withRetry(() => ghJsonOnce(p, opts));
}

function parseHttpStream(raw: string): { headers: Record<string, string>; body: string; status: number } {
  const blocks: string[] = raw.split(/(?=^HTTP\/[\d.]+ \d+)/m);
  let lastStatus = 0;
  let lastHeaders: Record<string, string> = {};
  const bodies: string[] = [];
  for (const blk of blocks) {
    if (!blk.trim()) continue;
    const sep = blk.indexOf("\r\n\r\n");
    const sep2 = blk.indexOf("\n\n");
    const splitAt =
      sep >= 0 && (sep2 < 0 || sep < sep2) ? { idx: sep, len: 4 } :
      sep2 >= 0 ? { idx: sep2, len: 2 } :
      null;
    let head: string, body: string;
    if (splitAt) {
      head = blk.slice(0, splitAt.idx);
      body = blk.slice(splitAt.idx + splitAt.len);
    } else {
      head = blk;
      body = "";
    }
    const lines = head.split(/\r?\n/);
    const statusLine = lines[0] ?? "";
    const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
    if (m) lastStatus = Number.parseInt(m[1], 10);
    lastHeaders = {};
    for (const line of lines.slice(1)) {
      const ci = line.indexOf(":");
      if (ci > 0) {
        const k = line.slice(0, ci).trim().toLowerCase();
        const v = line.slice(ci + 1).trim();
        lastHeaders[k] = v;
      }
    }
    if (body.length > 0) bodies.push(body);
  }
  return { headers: lastHeaders, body: bodies.join(""), status: lastStatus };
}

function parseConcatenatedJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const parts: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        parts.push(JSON.parse(trimmed.slice(start, i + 1)));
        let j = i + 1;
        while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
        start = j;
        i = j - 1;
      }
    }
  }
  if (parts.length > 0 && parts.every((p) => Array.isArray(p))) {
    return (parts as unknown[][]).flat();
  }
  if (parts.length === 1) return parts[0];
  return parts;
}


// ─── Retry policy ───────────────────────────────────────────────────────────

export interface RetryOpts {
  attempts?: number;
  backoffsMs?: number[];
  beforeRetry?: () => Promise<{ stopReason?: string } | void>;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFFS_MS = [1000, 4000, 16000];

function shouldRetry(err: unknown): boolean {
  if (!(err instanceof GhError)) return false;
  if (err.status === 429) return true;
  if (err.status === 403 && err.headers["x-ratelimit-remaining"] === "0") return true;
  if (err.status >= 500) return true;
  return false;
}

function retryAfterMs(err: GhError): number | null {
  const ra = err.headers["retry-after"];
  if (!ra) return null;
  const asNum = Number.parseInt(ra, 10);
  if (Number.isFinite(asNum) && /^\d+$/.test(ra.trim())) return asNum * 1000;
  const asDate = Date.parse(ra);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const total = (opts.attempts ?? backoffs.length + 1);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < total; attempt++) {
    if (attempt > 0) {
      const baseMs = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
      let wait = baseMs;
      if (lastErr instanceof GhError) {
        const ra = retryAfterMs(lastErr);
        if (ra !== null) wait = ra;
      }
      await sleep(wait);
      if (opts.beforeRetry) {
        const r = await opts.beforeRetry();
        if (r && r.stopReason) {
          return undefined as unknown as T;
        }
      }
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) throw err;
    }
  }
  throw lastErr;
}

// ─── Marker idempotency check ───────────────────────────────────────────────

/**
 * Look for an existing review on the PR whose body starts with the given marker.
 * Used to short-circuit POSTing when a previous run already completed.
 */
export async function findExistingMarker(opts: {
  repo: string;
  pr: number;
  marker: string;
  ghJsonFn?: typeof ghJson;
}): Promise<boolean> {
  return (await findMarkedReview(opts)) !== null;
}

/**
 * The rows of a list endpoint, or a throw. A 2xx whose body is not a JSON array
 * is an UNREADABLE read, not an empty one: both idempotency reads (the review
 * marker, the overflow comments) exist to stop a double-post, and reading
 * "nothing there" out of a body that said nothing is how one gets through.
 */
function listRows(r: GhJsonResult, what: string): unknown[] {
  if (Array.isArray(r.data)) return r.data;
  throw new GhError(-1, `${what} was not a JSON array (HTTP ${r.status})`, {});
}

/** One line naming why a `gh` call failed, for `unpostedReason`. Reads
 * `GhError.body`, never the message — that is where the transport puts the
 * cause (see `ghJsonOnce`). */
function describeGhFailure(e: unknown): string {
  return e instanceof GhError ? `http_${e.status}: ${e.body.slice(0, 200)}` : String(e);
}

/** {@link findExistingMarker}, returning the review it found (its id when
 * GitHub supplied a numeric one) so a skipped rerun can name what it skipped for.
 * Throws — never "not found" — when the list cannot be read. */
export async function findMarkedReview(opts: {
  repo: string;
  pr: number;
  marker: string;
  ghJsonFn?: typeof ghJson;
}): Promise<{ id?: number } | null> {
  const gh = opts.ghJsonFn ?? ghJson;
  const r = await gh(`/repos/${opts.repo}/pulls/${opts.pr}/reviews`);
  for (const rev of listRows(r, `the reviews list of ${opts.repo}#${opts.pr}`)) {
    if (typeof rev !== "object" || rev === null) continue;
    const { body, id } = rev as { body?: unknown; id?: unknown };
    if (typeof body === "string" && body.startsWith(opts.marker)) {
      return typeof id === "number" ? { id } : {};
    }
  }
  return null;
}

// ─── postReview: inline-vs-body routing + 422 no-drop fallback ──────────────

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  /** Original finding this inline maps back to; used to preserve metadata when
   * GitHub rejects the anchor (422) and we have to demote the comment to body. */
  origin?: Finding;
}

export interface PartitionResult {
  inline: InlineComment[];
  bodyFindings: Finding[];
}

export function partitionInlineVsBody(
  findings: Finding[],
  changedFiles: Set<string>,
  fixThreshold: Severity,
): PartitionResult {
  const inline: InlineComment[] = [];
  const bodyFindings: Finding[] = [];
  for (const f of findings) {
    const eligibleInline =
      f.classification === "fix" &&
      f.file !== null &&
      f.file !== undefined &&
      typeof f.line === "number" &&
      changedFiles.has(f.file) &&
      severityMeetsThreshold(f.severity, fixThreshold);
    if (eligibleInline) {
      inline.push({
        path: f.file as string,
        line: f.line as number,
        side: "RIGHT",
        body: `**${f.severity}** — ${f.title}\n\n${f.body}`,
        origin: f,
      });
    } else {
      bodyFindings.push(f);
    }
  }
  // origin is set above for every push; non-null assertion is safe here.
  inline.sort((a, b) => compareSeverityDesc(a.origin!, b.origin!));
  bodyFindings.sort(compareSeverityDesc);
  return { inline, bodyFindings };
}

/** Render the per-domain agent assignment as a markdown list. Used in the
 * review body for mixed-agent runs so a reader can tell which agent produced
 * each finding while gh posts through the operator's login. */
export function renderAgentsResolvedSummary(
  agentsResolved: Record<string, AgentName>,
): string {
  const entries = Object.entries(agentsResolved).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const lines: string[] = ["## agents_resolved", ""];
  for (const [domain, agent] of entries) {
    lines.push(`- \`${domain}\` → \`${agent}\``);
  }
  return lines.join("\n");
}

/** Choose the agent that owns the posted review when findings span multiple
 * agents. Strategy: agent with the most findings; ties broken by
 * lexicographic order on agent name. Returns null when findings is empty —
 * caller should fall back to the dispatcher's default agent. */
export function selectPostingAgent(findings: Finding[]): AgentName | null {
  if (findings.length === 0) return null;
  const counts = new Map<AgentName, number>();
  for (const f of findings) counts.set(f.agent, (counts.get(f.agent) ?? 0) + 1);
  let best: AgentName | null = null;
  let bestCount = -1;
  for (const [agent, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) {
      best = agent;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The heading for body findings that carry no {@link BodyReason} — the classic
 * class: unanchored findings, and findings whose file is not in the PR's diff.
 * This string is the canonical wording for that class and is pinned by its own
 * test; it must keep describing ONLY that class.
 *
 * It doubles as the fallback for a `body_reason` this build does not recognise
 * — see {@link groupByBodyReason}, where an unknown label must not cost a
 * finding its place in the body.
 */
export const OUT_OF_DIFF_HEADING = "## Cross-cutting / out-of-diff findings";

/**
 * Per-reason headings for body findings that DO carry a {@link BodyReason}.
 * Each must be accurate for its own class. Two ways to get that wrong, both
 * already paid for: a heading may not claim the finding was **out of** diff
 * (the falsehood STARK-6096 fixed), and it may not claim the finding was **in**
 * the diff either — a reviewer can report a finding on a generated file the PR
 * never touched, so `generated_path` spans both. Which one a given entry is, is
 * stated per finding by `generatedFindingNote` (`findings_review_post.ts`), the
 * only place that knows.
 */
export const BODY_REASON_HEADINGS: Record<BodyReason, string> = {
  generated_path: "## Findings on generated paths — withheld from inline threads",
};

/** Labelled groups in a fixed order, so the same findings always render the
 * same bytes. Hoisted out of the render: `postReview` rebuilds the body up to
 * twice more on the 422 fallback path. */
const ORDERED_BODY_REASONS: readonly BodyReason[] =
  (Object.keys(BODY_REASON_HEADINGS) as BodyReason[]).sort();

function isKnownBodyReason(reason: unknown): reason is BodyReason {
  return typeof reason === "string" && Object.hasOwn(BODY_REASON_HEADINGS, reason);
}

function bodyReasonHeading(reason: BodyReason | null): string {
  return reason === null ? OUT_OF_DIFF_HEADING : BODY_REASON_HEADINGS[reason];
}

/**
 * Split body findings into one group per reason, preserving the incoming order
 * (already severity-sorted by {@link partitionInlineVsBody}) inside each group.
 *
 * Labelled groups render FIRST. The generated-path preamble sits in
 * `humanSummary`, above every group, and promises "each is listed below" — with
 * the unlabelled group first that sentence pointed at the out-of-diff findings
 * rather than the ones it introduces. Byte-identity for the no-reason case does
 * NOT depend on the order: with zero labelled groups there is exactly one
 * group, one heading and one pass over the findings, whichever end it is
 * emitted from.
 *
 * A `body_reason` this build does not recognise degrades to the unlabelled
 * group. Grouping on the raw value instead would build a group with no heading
 * in {@link BODY_REASON_HEADINGS}, which the ordering loop then never emits —
 * silently deleting every finding in it from the review. Nothing in this file
 * may cost a finding its place in the body.
 */
function groupByBodyReason(
  bodyFindings: Finding[],
): Array<[BodyReason | null, Finding[]]> {
  const groups = new Map<BodyReason | null, Finding[]>();
  for (const f of bodyFindings) {
    const reason = isKnownBodyReason(f.body_reason) ? f.body_reason : null;
    const existing = groups.get(reason);
    if (existing) existing.push(f);
    else groups.set(reason, [f]);
  }
  const ordered: Array<[BodyReason | null, Finding[]]> = [];
  for (const reason of ORDERED_BODY_REASONS) {
    const group = groups.get(reason);
    if (group) ordered.push([reason, group]);
  }
  const unlabelled = groups.get(null);
  if (unlabelled) ordered.push([null, unlabelled]);
  return ordered;
}

export function buildReviewBody(
  marker: string,
  humanSummary: string,
  bodyFindings: Finding[],
  opts: {
    agentsResolved?: Record<string, AgentName>;
    postingAgentNote?: string;
    /** Rendered cross-links to overflow issue comments. Omitted (the normal
     * case) the body is byte-identical to a build without this option. */
    overflowLinks?: string[];
    /** How many of the leading `overflowLinks` point at the relocated review
     * summary rather than at findings (STARK-6116), so the footer can say so. */
    overflowSummaryParts?: number;
  } = {},
): string {
  const lines: string[] = [marker, "", humanSummary];
  if (opts.postingAgentNote) {
    lines.push("", opts.postingAgentNote);
  }
  if (bodyFindings.length > 0) {
    // Grouped by `body_reason` (STARK-6096) so a withheld generated-path
    // finding does not sit under a heading claiming it was out of diff, and
    // rendered through ONE shared renderer (STARK-6094) so "an overflow comment
    // is byte-for-byte the text the body would have carried" stays true of an
    // edit to either.
    for (const [reason, group] of groupByBodyReason(bodyFindings)) {
      lines.push("", bodyReasonHeading(reason), "");
      for (const f of group) lines.push(...renderBodyFindingLines(f));
    }
  }
  // Always render the per-domain `agents_resolved` summary when more than one
  // distinct agent is assigned across domains, even if only one of them
  // produced findings. Mixed `domain_agents` runs must remain debuggable from
  // the posted review alone (Task 8-4).
  if (opts.agentsResolved) {
    const distinct = new Set(Object.values(opts.agentsResolved));
    if (distinct.size > 1) {
      const summary = renderAgentsResolvedSummary(opts.agentsResolved);
      if (summary) lines.push("", summary);
    }
  }
  if (opts.overflowLinks && opts.overflowLinks.length > 0) {
    lines.push("", renderOverflowFooter(opts.overflowLinks, opts.overflowSummaryParts));
  }
  return lines.join("\n");
}

// ─── Oversize-body degrade: overflow issue comments ─────────────────────────

/**
 * GitHub's hard cap on a pull-request review body, in characters.
 *
 * It lives here, not in a caller, because every caller of {@link postReview}
 * inherits the failure it guards against. Over the cap the POST 422s on
 * `body is too long` carrying **no** `errors[].index`, so `extract422Indices`
 * returns `[]`, the no-drop fallback folds the remaining inline comments into
 * that SAME body, retries it *larger*, 422s again and reports `unposted` —
 * every finding lost, which is strictly worse than the gating threads the
 * generated-path split exists to prevent.
 *
 * The degrade (not a refusal, and never a truncation): the highest-severity
 * findings that fit stay in the review body, the rest are posted in full as
 * follow-up issue comments on the same PR and cross-linked from the body.
 *
 * Two shapes that moving findings cannot shrink (STARK-6116): one finding
 * larger than a comment is SEGMENTED across consecutive comments that
 * reassemble byte for byte, and a summary that alone blows the cap is RELOCATED
 * in full with its head + a pointer left behind. The one refusal left is a body
 * over the cap with nothing movable in it — named, and before any POST.
 */
export const GITHUB_REVIEW_BODY_MAX = 65536;

/** GitHub's cap on an issue comment body. Same number, different endpoint —
 * named separately so a future divergence is a one-line change. */
export const GITHUB_ISSUE_COMMENT_MAX = 65536;

/** Upper bound on the rendered footer preamble, reserved while planning the
 * split because the real footer cannot be rendered until the overflow comments
 * exist and have URLs. */
const OVERFLOW_PREAMBLE_RESERVE = 400;
/**
 * Upper bound on one rendered cross-link line, reserved per overflow chunk.
 *
 * This is a **true** bound, not an estimate, and {@link overflowLinkFor} is what
 * makes it one: a returned `html_url` longer than this is discarded in favour of
 * the canonical `#issuecomment-<id>` link, whose length is bounded by GitHub's
 * own owner (39) + repo (100) name limits. Without that clamp the reserve is a
 * guess, and a body that overshoots it cannot be repaired by moving findings
 * out — each one moved buys back a few hundred chars of finding while adding a
 * whole new link line, so the "fix" diverges and empties the body.
 */
const OVERFLOW_LINK_RESERVE = 320;

/** The cross-link for one overflow comment, clamped so a rendered link line can
 * never exceed {@link OVERFLOW_LINK_RESERVE}. */
export function overflowLinkFor(
  repo: string,
  pr: number,
  id: number | undefined,
  htmlUrl: unknown,
): string {
  const canonical = `https://github.com/${repo}/pull/${pr}#issuecomment-${id ?? "unknown"}`;
  if (typeof htmlUrl !== "string" || htmlUrl.length === 0) return canonical;
  // `- overflow 99 of 99: ` is the longest realistic prefix; budget generously.
  return htmlUrl.length + 64 <= OVERFLOW_LINK_RESERVE ? htmlUrl : canonical;
}

/** Render one body finding exactly as {@link buildReviewBody} does, so an
 * overflow comment is byte-for-byte the text the body would have carried. */
function renderBodyFindingLines(f: Finding): string[] {
  const anchor = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no anchor)";
  const lines = [`- **${f.severity}** [${f.domain}] (${anchor}) — ${f.title}`];
  if (f.body) {
    lines.push(f.body.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  return lines;
}

function renderOverflowFooter(links: string[], summaryParts = 0): string {
  // Say what the linked comments actually hold (STARK-6116). A relocated summary
  // takes the leading `summaryParts` slots, and once it is out every finding may
  // fit in the body — "carry the remaining findings" is then false in the one
  // place a reader is told where to look. With no relocated summary the text is
  // byte-identical to the STARK-6094 footer.
  const carried =
    summaryParts === 0
      ? "the remaining findings"
      : summaryParts >= links.length
        ? "the review summary"
        : `the review summary (overflow 1${summaryParts > 1 ? `–${summaryParts}` : ""}) and the remaining findings`;
  const lines = [
    "## Overflow findings",
    "",
    `The review body hit GitHub's ${GITHUB_REVIEW_BODY_MAX}-char limit. ` +
      `${links.length} follow-up comment(s) on this PR carry ${carried} ` +
      "in full — nothing was dropped, truncated or summarized:",
    "",
  ];
  links.forEach((url, i) => lines.push(`- overflow ${i + 1} of ${links.length}: ${url}`));
  return lines.join("\n");
}

/** Opening of an overflow comment's first line, up to the part number. Shared by
 * {@link renderOverflowComment} and its inverse {@link overflowPartOf}. */
const OVERFLOW_PART_PREFIX = "**Review overflow — part ";

/** Body of one overflow issue comment. Content-addressed: the same findings in
 * the same slot always render the same text, which is what lets a rebuild reuse
 * an already-posted comment instead of duplicating it. */
export function renderOverflowComment(
  marker: string,
  part: number,
  findings: Finding[],
): string {
  const lines: string[] = [
    marker,
    "",
    `${OVERFLOW_PART_PREFIX}${part}.** These findings did not fit in the review ` +
      "body's character limit. They are reproduced here in full; none was dropped or truncated.",
    "",
  ];
  for (const f of findings) lines.push(...renderBodyFindingLines(f));
  return lines.join("\n");
}

/** Separates a segment comment's header from the text it carries. Exported so a
 * reader (or a test) can recover the text exactly: everything after the FIRST
 * occurrence is payload, byte for byte. */
export const OVERFLOW_SEGMENT_DELIMITER = "\n\n---\n\n";

/** One overflow issue comment's worth of content. */
export interface OverflowChunk {
  /** Whole findings this comment carries. Empty for a segment comment. */
  findings: Finding[];
  /**
   * Set when this comment carries ONE SEGMENT of a text too large for a single
   * comment (STARK-6116): an over-cap finding, or the relocated review summary.
   * The segments of one text are consecutive chunks; concatenating their `text`
   * in order reproduces the original byte for byte.
   */
  segment?: SegmentSource & {
    /** 1-based. */
    index: number;
    total: number;
    text: string;
  };
}

/** What a segmented text IS. A union, so "a finding segment with no finding"
 * is unrepresentable rather than a `!` waiting to throw in the header. */
export type SegmentSource =
  | { of: "summary" }
  /** `finding` is the one being continued — for the header and the counts. */
  | { of: "finding"; finding: Finding };

/** How long a finding's title may run in a segment header before it is clipped.
 * The header is navigation, not payload — the full title is in the segments. */
const SEGMENT_HEADER_TITLE_MAX = 200;

/** `text` clipped to at most `max` UTF-16 units, never ending on the first half
 * of a surrogate pair — a lone surrogate is not valid UTF-8 on the wire. */
function clipToCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max);
}

function renderSegmentHeader(marker: string, part: number, seg: NonNullable<OverflowChunk["segment"]>): string {
  const position = `segment ${seg.index} of ${seg.total}`;
  if (seg.of === "summary") {
    return [
      marker,
      "",
      `${OVERFLOW_PART_PREFIX}${part}: review summary, ${position}.** The review summary did not fit ` +
        "under the review body's character limit, so it is reproduced here in full" +
        (seg.total > 1 ? " across consecutive comments — read the segments in order" : "") +
        ". Nothing was dropped or truncated.",
    ].join("\n");
  }
  const f = seg.finding;
  const anchor = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no anchor)";
  const title =
    f.title.length > SEGMENT_HEADER_TITLE_MAX ? `${clipToCodePoint(f.title, SEGMENT_HEADER_TITLE_MAX)}…` : f.title;
  return [
    marker,
    "",
    `${OVERFLOW_PART_PREFIX}${part}: one finding, ${position}.** This finding is larger than GitHub's ` +
      "comment limit, so its text continues across consecutive comments — read the segments in order. " +
      "Nothing was dropped or truncated.",
    "",
    `Finding: **${f.severity}** [${f.domain}] (${anchor}) — ${title}`,
  ].join("\n");
}

/** Body of one overflow issue comment, whole-findings or segment. */
export function renderOverflowChunk(marker: string, part: number, chunk: OverflowChunk): string {
  if (!chunk.segment) return renderOverflowComment(marker, part, chunk.findings);
  return renderSegmentHeader(marker, part, chunk.segment) + OVERFLOW_SEGMENT_DELIMITER + chunk.segment.text;
}

/** How much of a relocated summary stays in the review body as its head. */
export const RELOCATED_SUMMARY_HEAD_MAX = 2000;

/**
 * Close a fenced code block that `head` was cut inside of. Left open, the fence
 * swallows everything the review body renders after the head — the pointer, the
 * findings, the overflow links — into one code block, where a link is not a
 * link. Only the HEAD is touched, and only by appending: it is a preview, and
 * the summary itself is reproduced unedited in the overflow comments. (Segments
 * get no such repair — they reassemble byte for byte, which outranks rendering.)
 */
function closeOpenFence(head: string): string {
  let open: string | null = null;
  for (const line of head.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence) continue;
    if (open === null) {
      // CommonMark: a backtick opener's info string holds no backtick, so
      // "```x```" on one line is inline code, not a fence.
      if (!(fence[1][0] === "`" && fence[2].includes("`"))) open = fence[1];
    }
    // CommonMark: a closer is the same character, at least as long, and bare.
    else if (fence[1][0] === open[0] && fence[1].length >= open.length && fence[2].trim() === "") open = null;
  }
  return open === null ? head : `${head}\n${open}`;
}

/**
 * What the review body carries in place of a summary that had to be relocated
 * (STARK-6116): its head, then a pointer that SAYS the rest is elsewhere. The
 * pointer is the point — a summary shortened without one is a silent
 * truncation; with one, and the full text posted in the linked comment, it is
 * a table of contents. The full summary is never edited, only moved.
 */
export function relocatedSummaryStub(summary: string): string {
  // Only the first piece is wanted, so hand the splitter just enough text to
  // decide that cut (one unit past the budget) instead of segmenting a summary
  // of any size to keep element 0. The first cut is identical either way.
  const window = summary.slice(0, RELOCATED_SUMMARY_HEAD_MAX + 1);
  const head = closeOpenFence(splitTextToFit(window, RELOCATED_SUMMARY_HEAD_MAX)[0].trimEnd());
  return (
    `${head}\n\n` +
    `_…the review summary is longer than GitHub's ${GITHUB_REVIEW_BODY_MAX}-char review-body limit allows. ` +
    "Only its head is shown above; the summary continues in full, unedited, in the overflow comment(s) " +
    "linked under **Overflow findings** below, starting at overflow 1._"
  );
}

/** Findings a plan's chunks carry, counting a segmented finding ONCE. */
export function countOverflowFindings(chunks: OverflowChunk[]): number {
  return chunks.reduce(
    (n, c) => n + c.findings.length + (c.segment?.of === "finding" && c.segment.index === 1 ? 1 : 0),
    0,
  );
}

/**
 * The 1-based part number of an overflow comment {@link renderOverflowChunk}
 * wrote for `marker` — whole-findings (`part N.**`) or segment (`part N: …`) —
 * or null for anything else: another run's comment, a human quoting one, the
 * review body itself. The inverse of those renderers, kept beside them so they
 * cannot drift: a rerun uses it to find the comments an earlier run of the SAME
 * payload already left on the PR.
 */
export function overflowPartOf(marker: string, body: string): number | null {
  const head = `${marker}\n\n${OVERFLOW_PART_PREFIX}`;
  if (!body.startsWith(head)) return null;
  const m = /^(\d+)(?:\.\*\*|: )/.exec(body.slice(head.length));
  if (!m) return null;
  const part = Number.parseInt(m[1], 10);
  return part >= 1 ? part : null;
}

export interface BodySplitPlan {
  /** Findings that stay in the review body, in the input order (severity-desc). */
  kept: Finding[];
  /** Overflow content, one entry per issue comment, each fitting under the cap. */
  chunks: OverflowChunk[];
  /**
   * True when the body is over the cap even with NO findings in it — nothing
   * this function moves can fix that, and posting would 422 (STARK-6116).
   */
  unfittable?: boolean;
  /**
   * Set with `unfittable`: the size that was measured against the cap — the
   * body with no findings PLUS the cross-link footer reserved for `chunks`.
   * The footer is part of the floor, so a refusal that reports the body alone
   * can name a number that is under the cap it says was exceeded.
   */
  floorChars?: number;
}

/**
 * Split body findings between the review body and overflow comments.
 *
 * Deterministic by construction: the input is already severity-desc sorted by
 * `partitionInlineVsBody`, and the split is the longest prefix that fits. A
 * payload under the cap returns every finding in `kept` and no chunks, so the
 * body is byte-identical to a build that never knew about this function.
 */
export function planBodySplit(
  buildBody: (kept: Finding[]) => string,
  bodyFindings: Finding[],
  marker: string,
  cap = GITHUB_REVIEW_BODY_MAX,
  commentCap = GITHUB_ISSUE_COMMENT_MAX,
  /** Chunks that exist whatever the split decides — the relocated summary
   * (STARK-6116). They take the first slots and their links share the footer. */
  leading: OverflowChunk[] = [],
): BodySplitPlan {
  if (leading.length === 0 && buildBody(bodyFindings).length <= cap) {
    return { kept: bodyFindings, chunks: [] };
  }
  const footerReserve = (n: number) => (n > 0 ? OVERFLOW_PREAMBLE_RESERVE + OVERFLOW_LINK_RESERVE * n : 0);
  // The floor: every finding moved out. If THAT is over the cap, no split can
  // help — say so instead of returning a plan whose body is known to 422.
  const allOut = [...leading, ...chunkOverflow(bodyFindings, marker, commentCap, leading.length)];
  const floorChars = buildBody([]).length + footerReserve(allOut.length);
  if (floorChars > cap) {
    return { kept: [], chunks: allOut, unfittable: true, floorChars };
  }
  // The footer reserve depends on the chunk count, which depends on the split.
  // Iterate to a fixpoint; the reserve is monotone in the chunk count, so this
  // converges. The bound keeps a pathological payload from looping.
  let chunkEstimate = Math.max(1, leading.length);
  let plan: BodySplitPlan = { kept: [], chunks: allOut };
  for (let iter = 0; iter < 8; iter++) {
    const reserve = footerReserve(chunkEstimate);
    // `buildBody` is monotone in the prefix length, so the longest fitting
    // prefix is a binary search. A linear scan re-renders the WHOLE body once
    // per finding — quadratic in exactly the payload this function only ever
    // sees, the one too big to post.
    let lo = 0;
    let hi = bodyFindings.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (buildBody(bodyFindings.slice(0, mid)).length + reserve > cap) hi = mid - 1;
      else lo = mid;
    }
    const keptCount = lo;
    const kept = bodyFindings.slice(0, keptCount);
    const chunks = [...leading, ...chunkOverflow(bodyFindings.slice(keptCount), marker, commentCap, leading.length)];
    plan = { kept, chunks };
    if (chunks.length <= chunkEstimate) return plan;
    chunkEstimate = Math.max(chunkEstimate + 1, chunks.length);
  }
  return plan;
}

/**
 * Cut `text` into consecutive pieces of at most `budget` chars whose
 * concatenation is `text` exactly. A cut prefers the last newline in the
 * window — but only in its back half, so one early newline cannot shrink every
 * segment to a sliver — and never lands between the halves of a surrogate pair,
 * which would strand a broken code point at the end of one comment and the
 * start of the next.
 */
export function splitTextToFit(text: string, budget: number): string[] {
  if (budget < 2) throw new Error(`splitTextToFit: budget ${budget} cannot hold a surrogate pair`);
  const parts: string[] = [];
  let at = 0;
  while (text.length - at > budget) {
    let end = at + budget;
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl >= at + Math.floor(budget / 2)) end = nl + 1;
    else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(at, end));
    at = end;
  }
  if (at < text.length || parts.length === 0) parts.push(text.slice(at));
  return parts;
}

/**
 * Segment one over-cap text into chunks that each render under `commentCap`.
 * The header's length depends on `total` and the part number only through
 * their digit counts, so the budget is taken against a worst-case header
 * rather than solved for — a few chars of slack per comment, no fixpoint.
 */
export function segmentChunks(
  source: SegmentSource,
  text: string,
  marker: string,
  commentCap: number,
): OverflowChunk[] {
  const worst = renderSegmentHeader(marker, 99_999, { ...source, index: 99_999, total: 99_999, text: "" });
  const budget = commentCap - worst.length - OVERFLOW_SEGMENT_DELIMITER.length;
  const parts = splitTextToFit(text, budget);
  return parts.map((t, i) => ({
    findings: [],
    segment: { ...source, index: i + 1, total: parts.length, text: t },
  }));
}

/**
 * Greedily pack overflow findings into comment-sized chunks.
 *
 * A single finding larger than the cap used to get its own chunk "rather than
 * being truncated" — and that comment then 422'd on `body is too long`, which
 * failed the whole run to protect one finding (STARK-6116). It is now SEGMENTED
 * across consecutive comments instead: still every byte, still never cut short,
 * and each comment actually postable. `partOffset` is how many chunks precede
 * these (the relocated summary), so part numbers render as they will be posted.
 */
function chunkOverflow(rest: Finding[], marker: string, commentCap: number, partOffset = 0): OverflowChunk[] {
  const chunks: OverflowChunk[] = [];
  let current: Finding[] = [];
  const part = () => partOffset + chunks.length + 1;
  const flush = () => {
    if (current.length > 0) chunks.push({ findings: current });
    current = [];
  };
  for (const f of rest) {
    // Size `f` against the part it would hold ALONE. With a chunk already open
    // that is the NEXT part, not this one, and 9 → 10 adds a digit: a finding at
    // exactly the cap as part 9 is cap + 1 as part 10, and that comment 422s.
    // (It cannot fit beside `current` instead — that render is longer still.)
    const alonePart = part() + (current.length > 0 ? 1 : 0);
    if (renderOverflowComment(marker, alonePart, [f]).length > commentCap) {
      // Keeps its place in the severity order: flush what precedes it first.
      flush();
      chunks.push(...segmentChunks({ of: "finding", finding: f }, renderBodyFindingLines(f).join("\n"), marker, commentCap));
      continue;
    }
    const candidate = [...current, f];
    if (current.length > 0 && renderOverflowComment(marker, part(), candidate).length > commentCap) {
      flush();
      current = [f];
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

function extract422Indices(errBody: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errBody);
  } catch {
    return extract422IndicesFromString(errBody);
  }
  if (typeof parsed !== "object" || parsed === null) return extract422IndicesFromString(errBody);
  const errs = (parsed as Record<string, unknown>).errors;
  const idxs = new Set<number>();
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (typeof e !== "object" || e === null) continue;
      const ei = (e as Record<string, unknown>).index;
      if (typeof ei === "number") idxs.add(ei);
      const field = (e as Record<string, unknown>).field;
      if (typeof field === "string") {
        const m = field.match(/comments?\/(\d+)\b/);
        if (m) idxs.add(Number.parseInt(m[1], 10));
      }
      const msg = (e as Record<string, unknown>).message;
      if (typeof msg === "string") {
        const m = msg.match(/comments\[(\d+)\]/);
        if (m) idxs.add(Number.parseInt(m[1], 10));
      }
    }
  }
  if (idxs.size > 0) return [...idxs].sort((a, b) => a - b);
  return extract422IndicesFromString(errBody);
}

function extract422IndicesFromString(s: string): number[] {
  const idxs = new Set<number>();
  const re = /comments\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) idxs.add(Number.parseInt(m[1], 10));
  const re2 = /comments?\/(\d+)\b/g;
  while ((m = re2.exec(s)) !== null) idxs.add(Number.parseInt(m[1], 10));
  return [...idxs].sort((a, b) => a - b);
}

/**
 * The review marker's run hash: a digest of EVERYTHING the review would carry,
 * pinned to the head it anchors to. Pass its result as
 * {@link PostReviewOpts.runHash}.
 *
 * It lives here, beside the skip it protects, because every caller of
 * {@link postReview} inherits the failure: since STARK-6125 a run whose marker
 * is already on the PR writes NOTHING, so a marker that collides across
 * different payloads silently swallows a review nobody has seen. The hash this
 * replaced was the joined finding ids cut at 40 chars — three 12-hex ids, each
 * derived from a title alone — so a later review sharing its first three finding
 * titles, or the same titles with new bodies or lines, collided. That was
 * harmless while the marker was only read between retries of one run. A wrong
 * skip loses findings; a missed one only double-posts — so the hash is as narrow
 * as the payload. The head sha is in it because inline anchors are per-commit:
 * the same findings on a new head are a new review.
 */
export function computeRunHash(findings: Finding[], humanSummary: string, headSha: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([
    headSha,
    humanSummary,
    findings.map((f) => [f.id, f.severity, f.file ?? null, f.line ?? null, f.title, f.body, f.body_reason ?? null]),
  ]));
  return h.digest("hex").slice(0, 40);
}

export interface PostReviewOpts {
  repo: string;
  pr: number;
  round: number;
  agent: AgentName;
  /** Identifies THIS payload in the review marker. It is load-bearing: a marker
   * already on the PR makes {@link postReview} skip the whole run, so two
   * different payloads sharing a `runHash` means the second is never posted.
   * Derive it with {@link computeRunHash}; never from a prefix, a count, or the
   * finding ids alone. */
  runHash: string;
  findings: Finding[];
  changedFiles: Set<string>;
  fixThreshold: Severity;
  humanSummary: string;
  prHeadSha: string;
  dryRun: boolean;
  /** Per-domain agent assignment; rendered into the review body for
   * mixed-agent runs (Task 8-4). */
  agentsResolved?: Record<string, AgentName>;
  /** Optional model-attribution note for mixed-agent reviews. */
  postingAgentNote?: string;
  /** Retrying GH transport, used for the marker GET. Defaults to {@link ghJson}. */
  ghJsonFn?: typeof ghJson;
  /** Non-retrying GH transport, used for the POST itself so the outer
   * marker-aware retry is the only POST retry layer. Defaults to
   * {@link ghJsonOnce}. Falls back to {@link PostReviewOpts.ghJsonFn} for
   * back-compat when only one transport is injected by tests. */
  ghJsonOnceFn?: typeof ghJson;
  /** Inject a custom retry wrapper for tests. Defaults to {@link withRetry}. */
  retryFn?: typeof withRetry;
}

export interface PostReviewResult {
  posted: boolean;
  /** Attempt trail. `ok` means that POST landed; `failed` means it did not and
   * no further fallback was available — never conflate the two, since the only
   * consumer (`findings_review_post.ts`) prints this trail verbatim. */
  attempts: Array<{
    inline: number;
    status: "ok" | "fallback" | "body_only" | "failed";
    httpStatus?: number;
  }>;
  fallbacksApplied: number;
  payloadSummary: { inlineCount: number; bodyFindingsCount: number; bodyChars: number };
  reviewId?: number;
  /** Set when retry exhaustion (5xx/429/403 rate-limit) prevented posting; the
   * dispatcher must propagate this into receipt.unposted_reviews and exit
   * non-zero. */
  unposted?: boolean;
  unpostedReason?: string;
  /** Set when the PR already carried this payload's marker before anything was
   * sent: an earlier run landed it, so this one wrote nothing (no review, no
   * overflow comment). `posted` is true — the review IS on the PR — `attempts`
   * is empty, and `reviewId` names the review that was found. `payloadSummary`
   * and `bodyOverflow` then describe this run's first-pass PLAN, exactly as
   * `dryRun` reports it — not what the earlier run ended up sending, which a
   * 422 fallback may have reshaped — and `bodyOverflowComments` stays absent. */
  alreadyPosted?: boolean;
  /** Ids of the issue comments carrying body findings that did not fit under
   * {@link GITHUB_REVIEW_BODY_MAX} — posted by this run or adopted from an
   * earlier one, and only the ones this review links to. Empty (and
   * `bodyOverflow` absent) on every payload that fits, which is the
   * overwhelming majority. */
  bodyOverflowComments?: number[];
  /** Set only when the body overflowed, so a caller can report the split. */
  bodyOverflow?: {
    cap: number;
    chunks: number;
    findingsInBody: number;
    /** Distinct findings — one segmented across several comments counts once. */
    findingsInOverflow: number;
    /** Present (true) only when the summary itself was moved out (STARK-6116). */
    summaryRelocated?: true;
  };
}

/**
 * Merge demoted anchors back into the body findings in severity order.
 *
 * `partitionInlineVsBody` sorts each list severity-desc, but concatenating two
 * sorted lists does not give a sorted one — and the oversize-body split keeps
 * the longest PREFIX that fits, so a demoted `critical` appended after the body
 * findings is pushed into an overflow comment while `low` findings keep the
 * review body. It renders below them too. Sorting the merged list is what makes
 * "the highest-severity findings that fit stay in the body" true on the
 * fallback path, not just the first one.
 */
function mergeBodyFindings(bodyFindings: Finding[], demoted: Finding[]): Finding[] {
  return [...bodyFindings, ...demoted].sort(compareSeverityDesc);
}

/** Demote a rejected inline comment back to a body finding, preserving the
 * original Finding metadata (severity, domain, title, body). Anchor info is
 * carried only as routing metadata via file/line. */
function demoteInlineToFinding(c: InlineComment, agent: AgentName): Finding {
  if (c.origin) {
    // Drop `body_reason` on the way down. It records why a finding was routed
    // to the body BEFORE posting; this one is in the body because GitHub
    // rejected its anchor, which is the unlabelled class. Carrying the label
    // over would file it under a heading describing a different reason.
    const { body_reason: _routedBefore, ...origin } = c.origin;
    void _routedBefore;
    return { ...origin, file: c.path, line: c.line };
  }
  // Fallback when origin missing (defensive — partitionInlineVsBody now always
  // attaches origin, but keep this branch for older callers).
  return {
    id: findingId("anchor-rejected", agent, c.body.slice(0, 64)),
    domain: "anchor-rejected",
    agent,
    severity: "low",
    file: c.path,
    line: c.line,
    title: c.body.split("\n")[0].replace(/^\*\*[^*]+\*\* — /, ""),
    body: c.body,
  };
}

export async function postReview(opts: PostReviewOpts): Promise<PostReviewResult> {
  const part = partitionInlineVsBody(opts.findings, opts.changedFiles, opts.fixThreshold);
  const marker = buildMarker(opts.round, opts.agent, opts.runHash);
  const bodyOpts = {
    agentsResolved: opts.agentsResolved,
    postingAgentNote: opts.postingAgentNote,
  };
  /** A plan plus the summary text its body carries — the caller's own, or the
   * head-and-pointer form when the full summary had to be relocated. */
  type ReviewPlan = BodySplitPlan & { summary: string; summaryRelocated: boolean };
  const renderBody = (
    p: Pick<ReviewPlan, "summary"> & { chunks?: OverflowChunk[] },
    kept: Finding[],
    overflowLinks?: string[],
  ) =>
    buildReviewBody(marker, p.summary, kept, {
      ...bodyOpts,
      overflowLinks,
      overflowSummaryParts: p.chunks?.filter((c) => c.segment?.of === "summary").length,
    });
  /**
   * Plan the body. Moving findings out is always tried first and alone; only
   * when the body is over the cap with NO findings left in it (STARK-6116) is
   * the summary relocated — in full — to the leading overflow comment(s), with
   * its head and a pointer left behind. If even that floor is over the cap the
   * plan comes back `unfittable`: what remains (`postingAgentNote`, the
   * `agents_resolved` block) is not something this function may cut.
   */
  const plan = (findings: Finding[]): ReviewPlan => {
    const full = { summary: opts.humanSummary };
    const first = planBodySplit((kept) => renderBody(full, kept), findings, marker);
    if (!first.unfittable) return { ...first, ...full, summaryRelocated: false };
    const head = { summary: relocatedSummaryStub(opts.humanSummary) };
    // Relocation is a degrade, not a reflex: it only helps when the stub is
    // SHORTER than the summary it stands in for. A summary at or under
    // RELOCATED_SUMMARY_HEAD_MAX comes back whole, plus the pointer — so the
    // "degraded" body is bigger than the one that did not fit, an overflow
    // comment duplicates a summary that was never the problem, and the pointer
    // says "only its head is shown above" over the entire text. When the floor
    // is blown by `postingAgentNote` / `agents_resolved` instead, refuse on the
    // FIRST plan, whose `floorChars` is the real one.
    if (head.summary.length >= opts.humanSummary.length) {
      return { ...first, ...full, summaryRelocated: false };
    }
    const leading = segmentChunks({ of: "summary" }, opts.humanSummary, marker, GITHUB_ISSUE_COMMENT_MAX);
    const second = planBodySplit(
      (kept) => renderBody(head, kept), findings, marker,
      GITHUB_REVIEW_BODY_MAX, GITHUB_ISSUE_COMMENT_MAX, leading,
    );
    // A relocation that STILL does not fit is not a degrade either, for the same
    // reason spelled the other way: the leading summary chunks cost
    // OVERFLOW_PREAMBLE_RESERVE + OVERFLOW_LINK_RESERVE of footer, so a stub
    // saving less than that leaves `second.floorChars` LARGER than the first
    // plan's — and the refusal would then tell the operator to shorten by more
    // than is actually needed while asserting a relocation that never happened.
    // Nothing is posted either way, so report the plan that describes reality.
    if (second.unfittable) return { ...first, ...full, summaryRelocated: false };
    return { ...second, ...head, summaryRelocated: true };
  };
  const summarizeSplit = (s: ReviewPlan) => ({
    cap: GITHUB_REVIEW_BODY_MAX,
    chunks: s.chunks.length,
    findingsInBody: s.kept.length,
    findingsInOverflow: countOverflowFindings(s.chunks),
    ...(s.summaryRelocated ? { summaryRelocated: true as const } : {}),
  });

  const initialSplit = plan(part.bodyFindings);
  let body = renderBody(
    initialSplit,
    initialSplit.kept,
    initialSplit.chunks.length > 0
      ? initialSplit.chunks.map((_, i) => `(pending overflow comment ${i + 1})`)
      : undefined,
  );
  let inline = [...part.inline];
  const result: PostReviewResult = {
    posted: false,
    attempts: [],
    fallbacksApplied: 0,
    payloadSummary: { inlineCount: inline.length, bodyFindingsCount: part.bodyFindings.length, bodyChars: body.length },
  };
  if (initialSplit.chunks.length > 0) {
    result.bodyOverflow = summarizeSplit(initialSplit);
  }
  /** Refuse, by name and BEFORE any POST, a body that is over the cap with no
   * findings and no summary left to move. Posting it 422s with no index, and
   * the no-drop fallback answers that by folding the inline comments into the
   * same body — larger, 422 again, `unposted` with a reason that names nothing.
   * Reported in dry-run too, so the probe says what the real run would. */
  const refuseUnfittable = (s: ReviewPlan): boolean => {
    if (!s.unfittable) return false;
    result.unposted = true;
    // Name the number that was actually over the cap. The floor is the body's
    // non-finding parts PLUS the cross-link footer; reporting the first alone
    // reads as "310 chars against a 65536-char cap" when the footer is what
    // does not fit. The summary is always part of that floor and is named: a
    // refused plan is never a relocated one (`plan` falls back to the
    // un-relocated plan when relocation does not make the body fit), so this
    // number is the one the caller can act on.
    result.unpostedReason =
      `body_over_cap_without_findings: with every finding already moved out the review ` +
      `body still needs ${s.floorChars} chars against a ${GITHUB_REVIEW_BODY_MAX}-char cap — ` +
      `${renderBody(s, []).length} of non-finding parts (the summary, postingAgentNote, ` +
      `agents_resolved) plus the cross-link footer for ${s.chunks.length} overflow comment(s); ` +
      "shorten what the caller passes — nothing was posted";
    return true;
  };
  if (refuseUnfittable(initialSplit)) return result;
  if (opts.dryRun) return result;
  const gh = opts.ghJsonFn ?? ghJson;
  // POST transport must NOT retry internally — the outer retry below re-checks
  // the marker before each retry to guarantee idempotency on 5xx. If both inner
  // (ghJson) and outer retried, a successful-but-unacknowledged POST could be
  // re-sent before the marker check ran, double-posting the review.
  const ghPost = opts.ghJsonOnceFn ?? opts.ghJsonFn ?? ghJsonOnce;
  const retry = opts.retryFn ?? withRetry;

  // Idempotency ACROSS runs (STARK-6125). `checkMarker` below only runs between
  // retries of this run, but a POST can land and still be reported `unposted` —
  // a `gh` killed after writing a complete 2xx is refused as a terminated
  // child's output, and so is our own timeout kill — and the operator's rerun is
  // a fresh run. So look before the first write of ANY kind: the overflow
  // comments are synced before the review, and checking only ahead of the review
  // POST would re-post those while skipping the review.
  //
  // A failed read REFUSES rather than proceeding, unlike `checkMarker`: between
  // retries "unknown" costs one more attempt at a POST already owed, here it
  // would be the unguarded double-post this check exists to stop. Nothing is
  // lost by refusing — nothing has been written, and the rerun is safe.
  try {
    const existing = await findMarkedReview({
      repo: opts.repo, pr: opts.pr, marker, ghJsonFn: gh,
    });
    if (existing) {
      result.posted = true;
      result.alreadyPosted = true;
      if (existing.id !== undefined) result.reviewId = existing.id;
      return result;
    }
  } catch (e) {
    result.unposted = true;
    result.unpostedReason = `marker_check_failed: ${describeGhFailure(e)}`;
    return result;
  }

  // Overflow comments are SLOT-addressed: chunk i always lives in the same
  // issue comment, edited in place when a rebuild changes what is in it.
  // Addressing them by CONTENT instead looks equivalent and is not: the
  // 422-anchor fallback re-plans with the demoted findings merged in, which
  // shifts which finding lands in which chunk, so every shifted chunk misses the
  // cache and gets a SECOND comment — the findings it holds are then posted
  // twice and the first comment stays on the PR linked from nowhere, while
  // `bodyOverflow.chunks` counts one comment where two exist.
  interface OverflowSlot {
    /** Absent when GitHub's response carried no numeric id; such a slot cannot
     * be edited, so a changed chunk has to be posted fresh. */
    id?: number;
    url: string;
    content: string;
  }
  const slots: OverflowSlot[] = [];

  const failOverflow = (e: unknown): null => {
    result.unposted = true;
    result.unpostedReason = `overflow_comment_failed: ${describeGhFailure(e)}`;
    return null;
  };

  /**
   * Seed the slots, once and only when a chunk is about to be written, from the
   * overflow comments an earlier run of this same payload left on the PR. That
   * run's review POST truly failed (a landed one is caught by the marker check
   * above), so its comments sit there linked from nowhere; without this the
   * rerun posts every chunk a second time. An adopted slot then behaves like any
   * other: reused when identical, PATCHed when the content moved. Lazy, so the
   * overwhelming no-overflow majority never pays for the listing; a failed
   * listing fails the overflow — and with it the review — rather than guessing.
   */
  let slotsAdopted = false;
  const adoptOverflowSlots = async (): Promise<void> => {
    if (slotsAdopted) return;
    const r = await gh(`/repos/${opts.repo}/issues/${opts.pr}/comments`);
    // Unreadable is a throw, same as a failed request: "no comments" read out of
    // a body that was not a list re-posts every chunk.
    const rows = listRows(r, `the issue-comments list of ${opts.repo}#${opts.pr}`);
    slotsAdopted = true;
    for (const c of rows) {
      if (typeof c !== "object" || c === null) continue;
      const { id, body, html_url } = c as { id?: unknown; body?: unknown; html_url?: unknown };
      if (typeof id !== "number" || typeof body !== "string") continue;
      const part = overflowPartOf(marker, body);
      // First match wins: duplicates left by pre-STARK-6125 reruns stay orphans.
      if (part === null || slots[part - 1]) continue;
      slots[part - 1] = { id, url: overflowLinkFor(opts.repo, opts.pr, id, html_url), content: body };
    }
  };

  /** Put chunk `i` in its slot — posting the comment the first time, editing it
   * when a rebuild changed its contents, reusing it untouched otherwise — and
   * return the cross-link, or null after recording why it failed. */
  const syncOverflowSlot = async (i: number, chunk: OverflowChunk): Promise<string | null> => {
    const content = renderOverflowChunk(marker, i + 1, chunk);
    try {
      await adoptOverflowSlots();
    } catch (e) {
      return failOverflow(e);
    }
    const slot = slots[i];
    if (slot && slot.content === content) return slot.url;
    if (slot?.id !== undefined) {
      try {
        await ghPost(`/repos/${opts.repo}/issues/comments/${slot.id}`, {
          method: "PATCH",
          body: { body: content },
        });
        slot.content = content;
        return slot.url;
      } catch (e) {
        return failOverflow(e);
      }
    }
    try {
      const r = await ghPost(`/repos/${opts.repo}/issues/${opts.pr}/comments`, {
        method: "POST",
        body: { body: content },
      });
      const d = (r.data ?? {}) as { id?: unknown; html_url?: unknown };
      const id = typeof d.id === "number" ? d.id : undefined;
      const url = overflowLinkFor(opts.repo, opts.pr, id, d.html_url);
      slots[i] = { id, url, content };
      return url;
    } catch (e) {
      return failOverflow(e);
    }
  };

  /**
   * Plan the split for `findings`, put every overflow chunk in its slot on the
   * PR, and return the review body carrying real cross-links. Returns null when
   * an overflow POST failed — the review is then not posted either and
   * `unposted` says why, so nothing is silently lost.
   */
  const buildBodyWithOverflow = async (
    findings: Finding[],
    pre?: ReviewPlan,
  ): Promise<string | null> => {
    const s = pre ?? plan(findings);
    // A 422-fallback rebuild folds inline comments in and re-plans; the larger
    // payload can be the one that no longer fits. Checked before any slot sync
    // so THIS pass posts nothing for a review that cannot land. Comments a
    // previous pass already posted stay up — they hold real findings, and this
    // file deletes nothing — and stay listed in `bodyOverflowComments`.
    if (refuseUnfittable(s)) return null;
    if (s.chunks.length === 0) {
      // Rebuilds only ever ADD findings, so a payload that already overflowed
      // cannot come back under the cap; this is the first pass fitting.
      delete result.bodyOverflow;
      return renderBody(s, s.kept);
    }
    const links: string[] = [];
    for (let i = 0; i < s.chunks.length; i++) {
      const url = await syncOverflowSlot(i, s.chunks[i]);
      if (url === null) return null;
      links.push(url);
    }
    // Only the slots this plan links to: an adopted slot past the current chunk
    // count belongs to an earlier, larger split and is not part of this review.
    result.bodyOverflowComments = slots
      .slice(0, s.chunks.length)
      .map((sl) => sl.id)
      .filter((id): id is number => id !== undefined);
    result.bodyOverflow = summarizeSplit(s);
    // The reserve is an upper bound (see OVERFLOW_LINK_RESERVE), so the rendered
    // body is under the cap by construction rather than by luck.
    return renderBody(s, s.kept, links);
  };

  const checkMarker = async (): Promise<{ stopReason?: string } | void> => {
    try {
      const found = await findMarkedReview({
        repo: opts.repo, pr: opts.pr, marker, ghJsonFn: gh,
      });
      if (found) {
        // Same landed-but-unacknowledged event as `alreadyPosted`, so name the
        // review here too rather than only on the rerun.
        if (found.id !== undefined) result.reviewId = found.id;
        return { stopReason: "marker_found" };
      }
    } catch { /* swallow — retry continues */ }
    return undefined;
  };

  // Wrap every POST with the retry policy. Between 5xx attempts we re-do the
  // marker GET to short-circuit on success (idempotency under double-post).
  const post = async (): Promise<void> => {
    const path_ = `/repos/${opts.repo}/pulls/${opts.pr}/reviews`;
    await retry(async () => {
      const payload = {
        commit_id: opts.prHeadSha,
        event: "COMMENT",
        body,
        comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      };
      const r = await ghPost(path_, { method: "POST", body: payload });
      result.posted = true;
      if (r.data && typeof r.data === "object" && "id" in (r.data as object)) {
        const id = (r.data as { id?: unknown }).id;
        if (typeof id === "number") result.reviewId = id;
      }
      result.attempts.push({ inline: inline.length, status: "ok", httpStatus: r.status });
    }, { beforeRetry: checkMarker });
    if (!result.posted) {
      // beforeRetry returned stopReason — POST may have already landed on a
      // prior attempt; treat as success.
      result.posted = true;
      result.attempts.push({ inline: inline.length, status: "ok" });
    }
  };

  {
    const initial = await buildBodyWithOverflow(part.bodyFindings, initialSplit);
    if (initial === null) return result;
    body = initial;
    result.payloadSummary.bodyChars = body.length;
  }

  try {
    await post();
    return result;
  } catch (err) {
    if (!(err instanceof GhError)) {
      // Non-HTTP error from the retry wrapper — bubble.
      throw err;
    }
    if (err.status !== 422) {
      // Retry exhaustion on rate-limit / 5xx — surface as unposted, not throw.
      result.unposted = true;
      result.unpostedReason = `http_${err.status}: ${err.body.slice(0, 200)}`;
      result.attempts.push({ inline: inline.length, status: "failed", httpStatus: err.status });
      return result;
    }
    const indices = extract422Indices(err.body);
    if (indices.length > 0 && inline.length > 0) {
      const offenders = new Set(indices);
      const demote: Finding[] = [];
      const keep: InlineComment[] = [];
      for (let i = 0; i < inline.length; i++) {
        if (offenders.has(i)) {
          demote.push(demoteInlineToFinding(inline[i], opts.agent));
        } else {
          keep.push(inline[i]);
        }
      }
      inline = keep;
      const rebuilt = await buildBodyWithOverflow(mergeBodyFindings(part.bodyFindings, demote));
      if (rebuilt === null) return result;
      body = rebuilt;
      result.fallbacksApplied++;
      result.attempts.push({ inline: inline.length + offenders.size, status: "fallback", httpStatus: 422 });
      // Keep the summary describing what is actually being sent — a caller that
      // size-checks or logs it would otherwise read the pre-demotion payload.
      result.payloadSummary = {
        inlineCount: inline.length,
        bodyFindingsCount: part.bodyFindings.length + demote.length,
        bodyChars: body.length,
      };
      try {
        await post();
        return result;
      } catch (err2) {
        if (!(err2 instanceof GhError)) throw err2;
        if (err2.status !== 422) {
          result.unposted = true;
          result.unpostedReason = `http_${err2.status}: ${err2.body.slice(0, 200)}`;
          result.attempts.push({ inline: inline.length, status: "failed", httpStatus: err2.status });
          return result;
        }
      }
    }
    inline = [];
    const allBody = mergeBodyFindings(
      part.bodyFindings,
      part.inline.map((c) => demoteInlineToFinding(c, opts.agent)),
    );
    const rebuiltAll = await buildBodyWithOverflow(allBody);
    if (rebuiltAll === null) return result;
    body = rebuiltAll;
    result.fallbacksApplied++;
    result.attempts.push({ inline: 0, status: "body_only", httpStatus: 422 });
    result.payloadSummary = {
      inlineCount: 0,
      bodyFindingsCount: allBody.length,
      bodyChars: body.length,
    };
    try {
      await post();
    } catch (err3) {
      if (!(err3 instanceof GhError)) throw err3;
      result.unposted = true;
      result.unpostedReason = `http_${err3.status}: ${err3.body.slice(0, 200)}`;
      result.attempts.push({ inline: 0, status: "failed", httpStatus: err3.status });
    }
    return result;
  }
}
