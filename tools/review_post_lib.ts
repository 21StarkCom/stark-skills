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
 *     successful-but-unacknowledged POST cannot double-post.
 *
 * REST-only by contract: `rejectGraphqlPath` refuses a GraphQL path, and
 * `check-rest-only.sh` guards this file in CI.
 */
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

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

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
  /** Signal that killed the child, if any. `status` is -1 in that case;
   * callers should consult `signal` before formatting "exit N" messages,
   * since signal-killed processes have no real exit code. Optional so
   * tests can construct SpawnResult literals without spelling it out. */
  signal?: NodeJS.Signals | null;
}

async function spawnCollect(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const sopts: SpawnOptionsWithoutStdio = {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    };
    const child = spawn(cmd, args, sopts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed: SpawnResult | null = null;
    let settled = false;
    const tryFinish = () => {
      if (settled) return;
      if (closed === null) return;
      if (!stdoutEnded || !stderrEnded) return;
      settled = true;
      resolve(closed);
    };
    child.stdout.on("data", (b) => out.push(b as Buffer));
    child.stderr.on("data", (b) => err.push(b as Buffer));
    child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: code ?? -1,
        signal: signal ?? null,
      };
      tryFinish();
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
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
  const res = await spawnCollect("gh", args, { input, env: { ...process.env } });
  const { headers, body, status } = parseHttpStream(res.stdout);
  if (status === 0) {
    throw new GhError(-1, res.stderr || res.stdout, {}, `gh api ${p} failed: ${res.stderr.slice(0, 400)}`);
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
  const gh = opts.ghJsonFn ?? ghJson;
  const r = await gh(`/repos/${opts.repo}/pulls/${opts.pr}/reviews`);
  if (!Array.isArray(r.data)) return false;
  for (const rev of r.data) {
    if (typeof rev !== "object" || rev === null) continue;
    const body = (rev as { body?: unknown }).body;
    if (typeof body === "string" && body.startsWith(opts.marker)) return true;
  }
  return false;
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
  } = {},
): string {
  const lines: string[] = [marker, "", humanSummary];
  if (opts.postingAgentNote) {
    lines.push("", opts.postingAgentNote);
  }
  if (bodyFindings.length > 0) {
    for (const [reason, group] of groupByBodyReason(bodyFindings)) {
      lines.push("", bodyReasonHeading(reason), "");
      for (const f of group) {
        const anchor = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no anchor)";
        lines.push(`- **${f.severity}** [${f.domain}] (${anchor}) — ${f.title}`);
        if (f.body) {
          const indented = f.body.split("\n").map((l) => `  ${l}`).join("\n");
          lines.push(indented);
        }
      }
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
    lines.push("", renderOverflowFooter(opts.overflowLinks));
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
 */
export const GITHUB_REVIEW_BODY_MAX = 65536;

/** GitHub's cap on an issue comment body. Same number, different endpoint —
 * named separately so a future divergence is a one-line change. */
export const GITHUB_ISSUE_COMMENT_MAX = 65536;

/** Upper bound on the rendered footer preamble, reserved while planning the
 * split because the real footer cannot be rendered until the overflow comments
 * exist and have URLs. */
const OVERFLOW_PREAMBLE_RESERVE = 400;
/** Upper bound on one rendered cross-link line, reserved per overflow chunk. */
const OVERFLOW_LINK_RESERVE = 200;

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

function renderOverflowFooter(links: string[]): string {
  const lines = [
    "## Overflow findings",
    "",
    `The review body hit GitHub's ${GITHUB_REVIEW_BODY_MAX}-char limit. ` +
      `${links.length} follow-up comment(s) on this PR carry the remaining findings ` +
      "in full — nothing was dropped, truncated or summarized:",
    "",
  ];
  links.forEach((url, i) => lines.push(`- overflow ${i + 1} of ${links.length}: ${url}`));
  return lines.join("\n");
}

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
    `**Review overflow — part ${part}.** These findings did not fit in the review ` +
      "body's character limit. They are reproduced here in full; none was dropped or truncated.",
    "",
  ];
  for (const f of findings) lines.push(...renderBodyFindingLines(f));
  return lines.join("\n");
}

export interface BodySplitPlan {
  /** Findings that stay in the review body, in the input order (severity-desc). */
  kept: Finding[];
  /** Overflow findings, chunked to fit one issue comment each. */
  chunks: Finding[][];
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
): BodySplitPlan {
  if (buildBody(bodyFindings).length <= cap) {
    return { kept: bodyFindings, chunks: [] };
  }
  // The footer reserve depends on the chunk count, which depends on the split.
  // Iterate to a fixpoint; the reserve is monotone in the chunk count, so this
  // converges. The bound keeps a pathological payload from looping.
  let chunkEstimate = 1;
  let plan: BodySplitPlan = { kept: [], chunks: [] };
  for (let iter = 0; iter < 8; iter++) {
    const reserve = OVERFLOW_PREAMBLE_RESERVE + OVERFLOW_LINK_RESERVE * chunkEstimate;
    let keptCount = 0;
    for (let n = 1; n <= bodyFindings.length; n++) {
      if (buildBody(bodyFindings.slice(0, n)).length + reserve > cap) break;
      keptCount = n;
    }
    const kept = bodyFindings.slice(0, keptCount);
    const chunks = chunkOverflow(bodyFindings.slice(keptCount), marker, commentCap);
    plan = { kept, chunks };
    if (chunks.length === chunkEstimate) return plan;
    chunkEstimate = Math.max(chunkEstimate + 1, chunks.length);
  }
  return plan;
}

/** Greedily pack overflow findings into comment-sized chunks. A single finding
 * larger than the cap gets its own chunk rather than being truncated — the
 * no-drop rule outranks the cap. */
function chunkOverflow(rest: Finding[], marker: string, commentCap: number): Finding[][] {
  const chunks: Finding[][] = [];
  let current: Finding[] = [];
  for (const f of rest) {
    const candidate = [...current, f];
    if (
      current.length > 0 &&
      renderOverflowComment(marker, chunks.length + 1, candidate).length > commentCap
    ) {
      chunks.push(current);
      current = [f];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
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

export interface PostReviewOpts {
  repo: string;
  pr: number;
  round: number;
  agent: AgentName;
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
  /** Issue-comment ids created to carry body findings that did not fit under
   * {@link GITHUB_REVIEW_BODY_MAX}. Empty (and `bodyOverflow` absent) on every
   * payload that fits, which is the overwhelming majority. */
  bodyOverflowComments?: number[];
  /** Set only when the body overflowed, so a caller can report the split. */
  bodyOverflow?: {
    cap: number;
    chunks: number;
    findingsInBody: number;
    findingsInOverflow: number;
  };
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
  const renderBody = (kept: Finding[], overflowLinks?: string[]) =>
    buildReviewBody(marker, opts.humanSummary, kept, { ...bodyOpts, overflowLinks });
  const plan = (findings: Finding[]) =>
    planBodySplit((kept) => renderBody(kept), findings, marker);

  let split = plan(part.bodyFindings);
  let body = renderBody(
    split.kept,
    split.chunks.length > 0
      ? split.chunks.map((_, i) => `(pending overflow comment ${i + 1})`)
      : undefined,
  );
  let inline = [...part.inline];
  const result: PostReviewResult = {
    posted: false,
    attempts: [],
    fallbacksApplied: 0,
    payloadSummary: { inlineCount: inline.length, bodyFindingsCount: part.bodyFindings.length, bodyChars: body.length },
  };
  if (split.chunks.length > 0) {
    result.bodyOverflow = {
      cap: GITHUB_REVIEW_BODY_MAX,
      chunks: split.chunks.length,
      findingsInBody: split.kept.length,
      findingsInOverflow: split.chunks.reduce((n, c) => n + c.length, 0),
    };
  }
  if (opts.dryRun) return result;
  const gh = opts.ghJsonFn ?? ghJson;
  // POST transport must NOT retry internally — the outer retry below re-checks
  // the marker before each retry to guarantee idempotency on 5xx. If both inner
  // (ghJson) and outer retried, a successful-but-unacknowledged POST could be
  // re-sent before the marker check ran, double-posting the review.
  const ghPost = opts.ghJsonOnceFn ?? opts.ghJsonFn ?? ghJsonOnce;
  const retry = opts.retryFn ?? withRetry;

  // Overflow comments are content-addressed: a 422-fallback rebuild that
  // produces the same chunk reuses the comment already posted for it instead of
  // duplicating its findings on the PR.
  const overflowUrlByContent = new Map<string, string>();
  const overflowIds: number[] = [];

  /**
   * Plan the split for `findings`, post any overflow chunk not already on the
   * PR, and return the review body carrying real cross-links. Returns null when
   * an overflow POST failed — the review is then not posted either and
   * `unposted` says why, so nothing is silently lost.
   */
  const buildBodyWithOverflow = async (findings: Finding[]): Promise<string | null> => {
    const s = plan(findings);
    split = s;
    if (s.chunks.length === 0) {
      delete result.bodyOverflow;
      return renderBody(s.kept);
    }
    const links: string[] = [];
    for (let i = 0; i < s.chunks.length; i++) {
      const content = renderOverflowComment(marker, i + 1, s.chunks[i]);
      const seen = overflowUrlByContent.get(content);
      if (seen !== undefined) {
        links.push(seen);
        continue;
      }
      try {
        const r = await ghPost(`/repos/${opts.repo}/issues/${opts.pr}/comments`, {
          method: "POST",
          body: { body: content },
        });
        const d = (r.data ?? {}) as { id?: unknown; html_url?: unknown };
        const id = typeof d.id === "number" ? d.id : undefined;
        const url = typeof d.html_url === "string"
          ? d.html_url
          : `https://github.com/${opts.repo}/pull/${opts.pr}#issuecomment-${id ?? "unknown"}`;
        if (id !== undefined) overflowIds.push(id);
        overflowUrlByContent.set(content, url);
        links.push(url);
      } catch (e) {
        result.unposted = true;
        result.unpostedReason = `overflow_comment_failed: ${
          e instanceof GhError ? `http_${e.status}: ${e.body.slice(0, 200)}` : String(e)
        }`;
        return null;
      }
    }
    result.bodyOverflowComments = [...overflowIds];
    result.bodyOverflow = {
      cap: GITHUB_REVIEW_BODY_MAX,
      chunks: s.chunks.length,
      findingsInBody: s.kept.length,
      findingsInOverflow: s.chunks.reduce((n, c) => n + c.length, 0),
    };
    return renderBody(s.kept, links);
  };

  const checkMarker = async (): Promise<{ stopReason?: string } | void> => {
    try {
      const found = await findExistingMarker({
        repo: opts.repo, pr: opts.pr, marker, ghJsonFn: gh,
      });
      if (found) return { stopReason: "marker_found" };
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
    const initial = await buildBodyWithOverflow(part.bodyFindings);
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
      const rebuilt = await buildBodyWithOverflow([...part.bodyFindings, ...demote]);
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
    const allBody = [...part.bodyFindings];
    for (const c of part.inline) {
      allBody.push(demoteInlineToFinding(c, opts.agent));
    }
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
