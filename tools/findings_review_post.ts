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
): Finding[] {
  return (payload.findings ?? []).map((f) => {
    const domain = (f.category ?? "").trim() || "correctness";
    const title = titleFor(f);
    return {
      id: findingId(domain, agent, title),
      domain,
      agent,
      severity: severityFromVerdict(f.verdict),
      file: f.file ?? null,
      line: typeof f.line === "number" ? f.line : null,
      title,
      body: bodyFor(f),
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

export interface PrContext {
  headSha: string;
  changedFiles: Set<string>;
}

type RunFn = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRun: RunFn = (cmd, args) => {
  const sp = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: sp.status, stdout: sp.stdout ?? "", stderr: sp.stderr ?? "" };
};

export function parsePrContext(json: string): PrContext {
  const data = JSON.parse(json) as {
    headRefOid?: string;
    files?: Array<{ path?: string }>;
  };
  if (!data.headRefOid) throw new Error("gh pr view returned no headRefOid");
  const changed = new Set<string>();
  for (const f of data.files ?? []) {
    if (f.path) changed.add(f.path);
  }
  return { headSha: data.headRefOid, changedFiles: changed };
}

export async function fetchPrContext(
  repo: string,
  pr: number,
  run: RunFn = defaultRun,
): Promise<PrContext> {
  const sp = run("gh", [
    "pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,files",
  ]);
  if (sp.status !== 0) {
    throw new Error(`gh pr view ${pr} failed (exit ${sp.status}): ${sp.stderr.slice(0, 400)}`);
  }
  return parsePrContext(sp.stdout);
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
  const findings = toFindings(payload, args.agent);
  const ctx = await fetchPrContext(args.repo, args.pr);
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
