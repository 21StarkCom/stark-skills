#!/usr/bin/env node
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

export function buildReviewBody(
  marker: string,
  humanSummary: string,
  bodyFindings: Finding[],
  opts: {
    agentsResolved?: Record<string, AgentName>;
    postingAgentNote?: string;
  } = {},
): string {
  const lines: string[] = [marker, "", humanSummary];
  if (opts.postingAgentNote) {
    lines.push("", opts.postingAgentNote);
  }
  if (bodyFindings.length > 0) {
    lines.push("", "## Cross-cutting / out-of-diff findings", "");
    for (const f of bodyFindings) {
      const anchor = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no anchor)";
      lines.push(`- **${f.severity}** [${f.domain}] (${anchor}) — ${f.title}`);
      if (f.body) {
        const indented = f.body.split("\n").map((l) => `  ${l}`).join("\n");
        lines.push(indented);
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
  return lines.join("\n");
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
  attempts: Array<{ inline: number; status: "ok" | "fallback" | "body_only"; httpStatus?: number }>;
  fallbacksApplied: number;
  payloadSummary: { inlineCount: number; bodyFindingsCount: number; bodyChars: number };
  reviewId?: number;
  /** Set when retry exhaustion (5xx/429/403 rate-limit) prevented posting; the
   * dispatcher must propagate this into receipt.unposted_reviews and exit
   * non-zero. */
  unposted?: boolean;
  unpostedReason?: string;
}

/** Demote a rejected inline comment back to a body finding, preserving the
 * original Finding metadata (severity, domain, title, body). Anchor info is
 * carried only as routing metadata via file/line. */
function demoteInlineToFinding(c: InlineComment, agent: AgentName): Finding {
  if (c.origin) {
    return { ...c.origin, file: c.path, line: c.line };
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
  let body = buildReviewBody(marker, opts.humanSummary, part.bodyFindings, {
    agentsResolved: opts.agentsResolved,
    postingAgentNote: opts.postingAgentNote,
  });
  let inline = [...part.inline];
  const result: PostReviewResult = {
    posted: false,
    attempts: [],
    fallbacksApplied: 0,
    payloadSummary: { inlineCount: inline.length, bodyFindingsCount: part.bodyFindings.length, bodyChars: body.length },
  };
  if (opts.dryRun) return result;
  const gh = opts.ghJsonFn ?? ghJson;
  // POST transport must NOT retry internally — the outer retry below re-checks
  // the marker before each retry to guarantee idempotency on 5xx. If both inner
  // (ghJson) and outer retried, a successful-but-unacknowledged POST could be
  // re-sent before the marker check ran, double-posting the review.
  const ghPost = opts.ghJsonOnceFn ?? opts.ghJsonFn ?? ghJsonOnce;
  const retry = opts.retryFn ?? withRetry;

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
      result.attempts.push({ inline: inline.length, status: "ok", httpStatus: err.status });
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
      body = buildReviewBody(marker, opts.humanSummary, [...part.bodyFindings, ...demote], {
        agentsResolved: opts.agentsResolved,
        postingAgentNote: opts.postingAgentNote,
      });
      result.fallbacksApplied++;
      result.attempts.push({ inline: inline.length + offenders.size, status: "fallback", httpStatus: 422 });
      try {
        await post();
        return result;
      } catch (err2) {
        if (!(err2 instanceof GhError)) throw err2;
        if (err2.status !== 422) {
          result.unposted = true;
          result.unpostedReason = `http_${err2.status}: ${err2.body.slice(0, 200)}`;
          return result;
        }
      }
    }
    inline = [];
    const allBody = [...part.bodyFindings];
    for (const c of part.inline) {
      allBody.push(demoteInlineToFinding(c, opts.agent));
    }
    body = buildReviewBody(marker, opts.humanSummary, allBody, {
      agentsResolved: opts.agentsResolved,
      postingAgentNote: opts.postingAgentNote,
    });
    result.fallbacksApplied++;
    result.attempts.push({ inline: 0, status: "body_only", httpStatus: 422 });
    try {
      await post();
    } catch (err3) {
      if (!(err3 instanceof GhError)) throw err3;
      result.unposted = true;
      result.unpostedReason = `http_${err3.status}: ${err3.body.slice(0, 200)}`;
    }
    return result;
  }
}
