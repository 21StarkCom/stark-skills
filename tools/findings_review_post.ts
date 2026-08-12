#!/usr/bin/env node
/**
 * findings_review_post.ts — publish a Claude Code `ReportFindings` payload to a
 * PR as ONE anchored review.
 *
 * The gap this closes: `/code-review --comment` posts one standalone
 * `POST /pulls/N/comments` per finding, and GitHub wraps each in its own empty
 * review object — 30 findings become 30 zero-body reviews. `postReview()` in
 * `stark_review.ts` already posts a single review with inline anchoring and a
 * three-tier no-drop guarantee; all that was missing is the payload adapter.
 *
 * Everything here is mapping plus a CLI: no new posting logic, no new retry or
 * fallback behavior.
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

import {
  postReview,
  tokenForAgent,
  type PostReviewResult,
} from "./stark_review.ts";
import {
  findingId,
  type AgentName,
  type Finding,
  type Severity,
} from "./stark_review_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

/** One entry of the `ReportFindings` tool payload. */
export interface ReportFinding {
  file?: string | null;
  line?: number | null;
  summary?: string;
  short_summary?: string;
  failure_scenario?: string;
  category?: string;
  verdict?: "CONFIRMED" | "PLAUSIBLE" | string;
  outcome?: "fixed" | "skipped" | "no_change_needed" | string;
}

export interface ReportFindingsPayload {
  level?: string;
  findings: ReportFinding[];
}

const AGENTS: readonly AgentName[] = ["claude", "codex", "gemini"];
const TITLE_MAX = 120;

/**
 * `ReportFindings` carries no severity field, so severity is INFERRED from
 * `verdict`. The review body says so explicitly — an inferred severity that
 * reads as measured is exactly the kind of false precision the review prompts
 * ban.
 */
export function severityFromVerdict(verdict: string | undefined): Severity {
  return verdict === "CONFIRMED" ? "high" : "medium";
}

/** Title: `short_summary` when present, else `summary` truncated to one line. */
export function titleFor(f: ReportFinding): string {
  const short = f.short_summary?.trim();
  if (short) return short;
  const long = (f.summary ?? "").trim().split("\n")[0];
  if (long.length <= TITLE_MAX) return long || "(untitled finding)";
  return `${long.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Body: the summary, then the failure scenario, then any applied outcome. */
export function bodyFor(f: ReportFinding): string {
  const parts: string[] = [];
  const summary = (f.summary ?? "").trim();
  if (summary) parts.push(summary);
  const scenario = (f.failure_scenario ?? "").trim();
  if (scenario) parts.push(`**Failure scenario:** ${scenario}`);
  if (f.outcome) parts.push(`**Outcome:** \`${f.outcome}\``);
  if (parts.length === 0) parts.push("(no detail provided)");
  return parts.join("\n\n");
}

/**
 * Map a `ReportFindings` payload into the `Finding[]` `postReview` consumes.
 *
 * `classification: "fix"` is set on every finding deliberately and is
 * load-bearing: `partitionInlineVsBody` (`stark_review.ts:1487`) requires it
 * for inline eligibility, so without it every finding lands in the review body
 * and nothing is ever anchored. `ReportFindings` only emits findings that
 * survived verification, so "fix" is the honest classification for all of them.
 */
export function toFindings(
  payload: ReportFindingsPayload,
  agent: AgentName,
  anchorable?: AnchorableLines,
): Finding[] {
  return (payload.findings ?? []).map((f) => {
    const domain = (f.category ?? "").trim() || "correctness";
    const title = titleFor(f);
    const file = f.file ?? null;
    const line = typeof f.line === "number" ? f.line : null;
    // Drop an anchor GitHub would reject, and say where the finding pointed in
    // the body instead. A single unanchorable line used to sink the whole batch:
    // the API 422s naming no index, and postReview's fallback then posts
    // body-only, demoting every valid anchor with it. Measured on PR #870 —
    // three of four anchors sat in valid hunks and none survived.
    const anchored = file !== null && line !== null &&
      (anchorable === undefined || isAnchorable(anchorable, file, line));
    return {
      id: findingId(domain, agent, title),
      domain,
      agent,
      severity: severityFromVerdict(f.verdict),
      file,
      line: anchored ? line : null,
      title,
      body: anchored || file === null
        ? bodyFor(f)
        : `**Location:** \`${file}${line !== null ? `:${line}` : ""}\` (outside this PR's diff — not anchorable)\n\n${bodyFor(f)}`,
      classification: "fix" as const,
    };
  });
}

/** Human-facing preamble for the review body. */
export function buildHumanSummary(
  findings: Finding[],
  level: string | undefined,
): string {
  const bySeverity = new Map<Severity, number>();
  for (const f of findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  }
  const counts = (["critical", "high", "medium", "low"] as Severity[])
    .filter((s) => bySeverity.has(s))
    .map((s) => `${bySeverity.get(s)} ${s}`)
    .join(", ");
  const lines = [
    `## Code review — ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    "",
    counts ? `Severity mix: ${counts}.` : "No findings.",
    "",
    "Severity is **inferred** from each finding's verdict " +
      "(`CONFIRMED` → high, otherwise medium) — `ReportFindings` carries no " +
      "severity field. Treat it as a sort order, not a measurement.",
  ];
  if (level) lines.push("", `Review effort level: \`${level}\`.`);
  return lines.join("\n");
}

// ─── PR context ─────────────────────────────────────────────────────────────

/**
 * Per-file set of right-side line numbers a review comment can anchor to.
 * A file mapped to `null` has no usable patch (too large, binary, omitted by
 * the API), so every line in it is treated as anchorable — degrading to the old
 * file-granularity behavior rather than silently refusing to anchor anything.
 */
export type AnchorableLines = Map<string, Set<number> | null>;

export function isAnchorable(anchorable: AnchorableLines, file: string, line: number): boolean {
  if (!anchorable.has(file)) return false;
  const lines = anchorable.get(file);
  // `has` is true, so an undefined value can only mean the map literally stored
  // undefined; treat it like a missing patch and stay permissive.
  return lines == null ? true : lines.has(line);
}

/**
 * Right-side line numbers addressable in a unified-diff patch: every context
 * and added line inside a hunk. Deleted lines belong to the left side and are
 * not addressable with `side: "RIGHT"`.
 */
export function anchorableLinesFromPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  let cursor: number | null = null;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      cursor = Number(header[1]);
      continue;
    }
    if (cursor === null) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      lines.add(cursor);
      cursor += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // Deleted line, or "\ No newline at end of file" — neither advances the
      // right-side cursor.
    } else if (raw === "") {
      // An empty context line arrives with its leading space stripped by some
      // producers; treat it as context so the cursor stays aligned.
      lines.add(cursor);
      cursor += 1;
    }
  }
  return lines;
}

export interface PrContext {
  headSha: string;
  changedFiles: Set<string>;
  anchorable: AnchorableLines;
}

type RunFn = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

/**
 * 64 MiB. Node's spawnSync default is 1 MiB, and `gh api /pulls/N/files
 * --paginate --slurp` carries every file's full PATCH — so the payload scales
 * with the size of the diff, not the number of findings. A 78-file branch
 * measured 1.27 MB and blew straight through it.
 *
 * The failure was worse than the limit: exceeding maxBuffer makes Node KILL the
 * child, which sets `status` to null and leaves `stderr` empty, so the tool
 * reported `failed (exit null):` with nothing after the colon — a review-posting
 * tool that fails silently on exactly the large PRs whose findings matter most.
 * The cause is now surfaced explicitly below.
 */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

export const defaultRun: RunFn = (cmd, args) => {
  const sp = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER });
  // A signal kill with no stderr is otherwise indistinguishable from a crash.
  // ENOBUFS is the one cause we can name precisely, so name it.
  let stderr = sp.stderr ?? "";
  if (sp.status === null && !stderr) {
    const why = (sp.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS"
      ? `output exceeded maxBuffer (${GH_MAX_BUFFER} bytes)`
      : sp.error?.message ?? `killed by signal ${sp.signal ?? "unknown"}`;
    stderr = `${cmd} produced no stderr and was terminated: ${why}`;
  }
  return { status: sp.status, stdout: sp.stdout ?? "", stderr };
};

/**
 * Build the PR context from the head sha plus the files listing. `filesJson` is
 * the raw `/pulls/N/files` payload — `gh pr view --json files` is NOT usable
 * here because it omits `patch`, and without patches anchors can only be
 * validated per-file, which is the defect this exists to fix.
 */
export function parsePrContext(headSha: string, filesJson: string): PrContext {
  const sha = headSha.trim();
  if (!sha) throw new Error("PR has no head sha — a review cannot anchor without commit_id");
  const files = JSON.parse(filesJson) as Array<{ filename?: string; patch?: string }>;
  if (!Array.isArray(files)) throw new Error("pulls/N/files did not return an array");
  const changed = new Set<string>();
  const anchorable: AnchorableLines = new Map();
  for (const f of files) {
    if (!f.filename) continue;
    changed.add(f.filename);
    anchorable.set(f.filename, typeof f.patch === "string" ? anchorableLinesFromPatch(f.patch) : null);
  }
  return { headSha: sha, changedFiles: changed, anchorable };
}

export async function fetchPrContext(
  repo: string,
  pr: number,
  run: RunFn = defaultRun,
): Promise<PrContext> {
  const head = run("gh", ["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]);
  if (head.status !== 0) {
    throw new Error(`gh api pulls/${pr} failed (exit ${head.status}): ${head.stderr.slice(0, 400)}`);
  }
  // --paginate --slurp merges every page into one array; a PR over 30 changed
  // files would otherwise silently expose only the first page, and a finding in
  // an unlisted file loses its anchor for no visible reason.
  const files = run("gh", [
    "api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--slurp",
  ]);
  if (files.status !== 0) {
    throw new Error(`gh api pulls/${pr}/files failed (exit ${files.status}): ${files.stderr.slice(0, 400)}`);
  }
  return parsePrContext(head.stdout, flattenSlurped(files.stdout));
}

/** `gh api --paginate --slurp` yields an array OF page arrays; flatten to one. */
export function flattenSlurped(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return stdout;
  const flat = parsed.every((p) => Array.isArray(p)) ? (parsed as unknown[][]).flat() : parsed;
  return JSON.stringify(flat);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const HELP = `usage: findings_review_post.ts --repo O/R --pr N --findings <path|-> [options]

Publish a Claude Code ReportFindings payload to a pull request as ONE review,
with each anchored finding as an inline review thread.

options:
  --repo O/R        target repository (required)
  --pr N            pull request number (required)
  --findings PATH   ReportFindings JSON; "-" reads stdin (required)
  --app AGENT       posting bot identity: claude|codex|gemini (default: claude)
  --dry-run         build the payload and print the plan without posting
  -h, --help        show this help message and exit

The review is posted as event=COMMENT under stark-<agent>[bot], never as
APPROVE or REQUEST_CHANGES — approvals and blocks stay human.`;

export interface CliArgs {
  repo: string;
  pr: number;
  findingsPath: string;
  agent: AgentName;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let repo: string | undefined;
  let pr: number | undefined;
  let findingsPath: string | undefined;
  let agent: AgentName = "claude";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--repo": repo = need(); break;
      case "--pr": {
        const raw = need();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--pr must be a positive integer, got ${raw}`);
        pr = n;
        break;
      }
      case "--findings": findingsPath = need(); break;
      case "--app": {
        const v = need() as AgentName;
        if (!AGENTS.includes(v)) throw new Error(`--app must be one of ${AGENTS.join("|")}, got ${v}`);
        agent = v;
        break;
      }
      case "--dry-run": dryRun = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!repo) throw new Error("--repo is required");
  if (pr === undefined) throw new Error("--pr is required");
  if (!findingsPath) throw new Error("--findings is required");
  return { repo, pr, findingsPath, agent, dryRun };
}

export function readPayload(path: string): ReportFindingsPayload {
  const raw = path === "-"
    ? fs.readFileSync(0, "utf8")
    : fs.readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as ReportFindingsPayload | ReportFinding[];
  // Accept a bare array as well as the {level, findings} envelope.
  if (Array.isArray(parsed)) return { findings: parsed };
  if (!Array.isArray(parsed.findings)) {
    throw new Error("payload has no findings[] array");
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const payload = readPayload(args.findingsPath);
  const ctx = await fetchPrContext(args.repo, args.pr);
  const findings = toFindings(payload, args.agent, ctx.anchorable);
  const posterToken = args.dryRun
    ? undefined
    : await tokenForAgent(args.agent, { repo: args.repo, forceRefresh: true });

  const result: PostReviewResult = await postReview({
    repo: args.repo,
    pr: args.pr,
    round: 1,
    agent: args.agent,
    runHash: findings.map((f) => f.id).join(",").slice(0, 40) || "empty",
    findings,
    changedFiles: ctx.changedFiles,
    // "low" so severity never filters a finding out of the review — the
    // no-drop rule is the whole point of this path.
    fixThreshold: "low",
    humanSummary: buildHumanSummary(findings, payload.level),
    prHeadSha: ctx.headSha,
    dryRun: args.dryRun,
    posterToken,
  });
  console.log(JSON.stringify({ findings: findings.length, ...result }, null, 2));
  return result.unposted ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(2);
    });
}
