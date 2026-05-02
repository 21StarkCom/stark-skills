#!/usr/bin/env node

// stark-review-design Phase 4 renderer. Takes the classified rounds payload
// (output of plan_review_dispatch.py + the skill's per-finding classification
// overlay) and emits the consolidated markdown summary.
//
// Sections 4a–4f and 4h are pure data → markdown. Sections 4g (Misalignment
// Analysis) and 4i (Prompt Improvement Assessment) require LLM judgment, so
// the tool emits structured placeholder blocks the skill fills in.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Severity = "critical" | "high" | "medium" | "low";

export type Classification =
  | "fix"
  | "recurring"
  | "false_positive"
  | "noise"
  | "ignored";

export type Finding = {
  severity: Severity | string;
  section: string;
  title: string;
  agent: string;
  domain: string;
  description?: string;
  classification?: Classification;
  classification_reason?: string;
};

export type SubAgentResult = {
  agent: string;
  domain: string;
  duration_s?: number;
  findings_count?: number;
  error?: string;
  stderr?: string;
};

export type RoundSummary = {
  total_sub_agents: number;
  succeeded: number;
  failed: number;
  total_findings: number;
  by_severity?: Record<string, number>;
};

export type RoundData = {
  round: number;
  agents: string[];
  models?: Record<string, string>;
  summary: RoundSummary;
  findings: Finding[];
  results?: SubAgentResult[];
};

export type SummaryInput = {
  designPath: string;
  rounds: RoundData[];
  /** Optional `git diff` of the design file across fix rounds — rendered into 4h. */
  designDiff?: string;
  /** Optional CLI availability map for the dispatch-failure template. */
  cliAvailability?: Record<string, boolean>;
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

// ── Top-level orchestrator ──────────────────────────────────────

export function renderSummary(input: SummaryInput): string {
  if (isDispatchFailure(input)) {
    return renderDispatchFailure(input);
  }
  const sections: string[] = [];
  const allFindings = collectFindings(input.rounds);
  sections.push(renderHeadlineCounts(allFindings));
  sections.push(renderFindingsTable(input.rounds));
  sections.push(renderFixedGrouped(input.rounds));
  sections.push(renderRecurring(input.rounds));
  sections.push(renderUnresolved(input.rounds));
  sections.push(renderNoiseAndFp(input.rounds));
  sections.push(renderMisalignmentPlaceholder(allFindings));
  if (input.designDiff !== undefined) {
    sections.push(renderChangesMade(input.designDiff));
  }
  sections.push(renderPromptImprovementPlaceholder());
  return sections.join("\n\n").trim() + "\n";
}

// ── Helpers ─────────────────────────────────────────────────────

export function isDispatchFailure(input: SummaryInput): boolean {
  // Any round in which every sub-agent failed counts as a dispatch failure
  // for summary purposes (matches the SKILL.md fail-closed contract).
  return input.rounds.some(
    (r) => r.summary.total_sub_agents > 0 && r.summary.succeeded === 0,
  );
}

function collectFindings(rounds: RoundData[]): Array<Finding & { round: number }> {
  const out: Array<Finding & { round: number }> = [];
  for (const r of rounds) {
    for (const f of r.findings) out.push({ ...f, round: r.round });
  }
  return out;
}

function classify<T extends Finding>(
  findings: T[],
  cls: Classification,
): T[] {
  return findings.filter((f) => f.classification === cls);
}

// ── Dispatch-failure template ───────────────────────────────────

export function renderDispatchFailure(input: SummaryInput): string {
  const failureRound =
    input.rounds.find(
      (r) => r.summary.total_sub_agents > 0 && r.summary.succeeded === 0,
    ) ?? input.rounds[input.rounds.length - 1];
  const out: string[] = [];
  out.push("## Design Review — Dispatch Failure");
  out.push("");
  out.push(`**File:** ${input.designPath}`);
  out.push(
    `**Status:** Review could not complete — ` +
      `${failureRound.summary.succeeded}/${failureRound.summary.total_sub_agents} ` +
      `sub-agents succeeded.`,
  );
  out.push("");
  out.push("### Error Details");
  out.push("| Agent | Domain | Error | Stderr (truncated) |");
  out.push("|-------|--------|-------|--------------------|");
  for (const r of failureRound.results ?? []) {
    if (!r.error) continue;
    const stderr = (r.stderr ?? "").replace(/\s+/g, " ").slice(0, 80);
    out.push(`| ${r.agent} | ${r.domain} | ${escapePipes(r.error)} | ${escapePipes(stderr)} |`);
  }
  if (input.cliAvailability) {
    out.push("");
    out.push("### Diagnostics");
    const items = Object.entries(input.cliAvailability)
      .map(([cli, ok]) => `${cli}=${ok ? "yes" : "no"}`)
      .join(", ");
    out.push(`- CLI availability: ${items}`);
  }
  out.push("");
  out.push("### Recommendation");
  out.push("<!-- TODO: skill fills in the most likely cause and next steps -->");
  return out.join("\n") + "\n";
}

// ── 4a Headline counts ──────────────────────────────────────────

export function renderHeadlineCounts(findings: Finding[]): string {
  const issues = findings.filter(
    (f) => f.classification === "fix" || f.classification === "recurring",
  ).length;
  const noise = findings.filter(
    (f) => f.classification === "false_positive" || f.classification === "noise",
  ).length;
  const ignored = findings.filter((f) => f.classification === "ignored").length;
  const denominator = issues + noise;
  const ratio = denominator === 0 ? 100 : Math.round((issues / denominator) * 100);
  return [
    "### Headline",
    "",
    `**Issues found:** ${issues} | **Noise:** ${noise} | **Ignored:** ${ignored}`,
    `**Signal-to-noise:** ${ratio}%`,
  ].join("\n");
}

// ── 4b Findings table ───────────────────────────────────────────

export function renderFindingsTable(rounds: RoundData[]): string {
  const rows = collectFindings(rounds);
  rows.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    const sa = SEVERITY_ORDER.indexOf(a.severity as Severity);
    const sb = SEVERITY_ORDER.indexOf(b.severity as Severity);
    return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);
  });
  const out: string[] = [];
  out.push("### All findings");
  out.push("");
  out.push("| # | Round | Agent | Domain | Severity | Section | Title | Outcome |");
  out.push("|---|-------|-------|--------|----------|---------|-------|---------|");
  rows.forEach((f, idx) => {
    out.push(
      `| ${idx + 1} | ${f.round} | ${f.agent} | ${f.domain} | ${f.severity} | ` +
        `${escapePipes(f.section)} | ${escapePipes(f.title)} | ${f.classification ?? "—"} |`,
    );
  });
  if (rows.length === 0) out.push("| — | — | — | — | — | — | _no findings_ | — |");
  return out.join("\n");
}

// ── 4c Fixed (grouped by round) ─────────────────────────────────

export function renderFixedGrouped(rounds: RoundData[]): string {
  const out: string[] = ["### Fixed"];
  let any = false;
  for (const round of rounds) {
    const fixed = classify(round.findings, "fix");
    if (fixed.length === 0) continue;
    any = true;
    out.push("");
    out.push(`#### Round ${round.round} — ${fixed.length} fixed`);
    for (const f of fixed) {
      out.push(`- **[${f.severity}]** \`${f.section}\` — ${f.title} _(${f.agent}/${f.domain})_`);
    }
  }
  if (!any) out.push("\n_None._");
  return out.join("\n");
}

// ── 4d Recurring ────────────────────────────────────────────────

export function renderRecurring(rounds: RoundData[]): string {
  const out: string[] = ["### Recurring"];
  // Bucket recurrings by (section, domain) so the reader sees how a
  // single underlying issue persisted across rounds, including which
  // round resolved it (the last round it appears in is implicitly the
  // "still here" boundary).
  const buckets = new Map<string, Array<Finding & { round: number }>>();
  for (const round of rounds) {
    for (const f of classify(round.findings, "recurring")) {
      const key = `${f.section}|${f.domain}`;
      const list = buckets.get(key) ?? [];
      list.push({ ...f, round: round.round });
      buckets.set(key, list);
    }
  }
  if (buckets.size === 0) {
    out.push("\n_None._");
    return out.join("\n");
  }
  for (const [, items] of buckets) {
    items.sort((a, b) => a.round - b.round);
    const head = items[0];
    const roundList = items.map((i) => `r${i.round}`).join(", ");
    out.push(
      `- **\`${head.section}\`** [${head.domain}] — ${head.title} _(${roundList})_`,
    );
  }
  return out.join("\n");
}

// ── 4e Unresolved (from the final round) ───────────────────────

export function renderUnresolved(rounds: RoundData[]): string {
  const out: string[] = ["### Unresolved"];
  const final = rounds[rounds.length - 1];
  if (!final) {
    out.push("\n_No rounds._");
    return out.join("\n");
  }
  const unresolved = final.findings.filter(
    (f) => f.classification === "fix" || f.classification === "recurring",
  );
  if (unresolved.length === 0) {
    out.push("\n_None — final round produced zero actionable findings._");
    return out.join("\n");
  }
  for (const f of unresolved) {
    out.push(`- **[${f.severity}]** \`${f.section}\` — ${f.title} _(${f.agent}/${f.domain})_`);
  }
  return out.join("\n");
}

// ── 4f Noise & False Positives ──────────────────────────────────

export function renderNoiseAndFp(rounds: RoundData[]): string {
  const out: string[] = ["### Noise & False Positives"];
  const items = collectFindings(rounds).filter(
    (f) => f.classification === "noise" || f.classification === "false_positive",
  );
  if (items.length === 0) {
    out.push("\n_None._");
    return out.join("\n");
  }
  for (const f of items) {
    const reason = f.classification_reason ?? "(no reason recorded)";
    const tag = f.classification === "noise" ? "noise" : "false-positive";
    out.push(`- **[${tag}]** \`${f.section}\` — ${f.title}: ${reason}`);
  }
  return out.join("\n");
}

// ── 4g Misalignment placeholder ─────────────────────────────────

export function renderMisalignmentPlaceholder(findings: Finding[]): string {
  const noiseLike = findings.filter(
    (f) => f.classification === "noise" || f.classification === "false_positive",
  );
  const out: string[] = ["### Misalignment Analysis"];
  if (noiseLike.length === 0) {
    out.push("");
    out.push("_No noise or false-positive findings to analyze._");
    return out.join("\n");
  }
  out.push("");
  out.push(
    `<!-- skill: classify the ${noiseLike.length} noise/FP finding(s) above ` +
      `into one of the four root causes below. -->`,
  );
  out.push("");
  out.push("| Root Cause | Count | Improvement Action |");
  out.push("|------------|-------|--------------------|");
  out.push("| Missing context in design | <!-- N --> | <!-- skill fills in --> |");
  out.push("| Overly aggressive prompt | <!-- N --> | <!-- skill fills in --> |");
  out.push("| Scope mismatch | <!-- N --> | <!-- skill fills in --> |");
  out.push("| Already addressed elsewhere | <!-- N --> | <!-- skill fills in --> |");
  return out.join("\n");
}

// ── 4h Changes made ─────────────────────────────────────────────

export function renderChangesMade(designDiff: string): string {
  const out: string[] = ["### Changes Made"];
  out.push("");
  if (!designDiff.trim()) {
    out.push("_No changes — design file is identical to its pre-review state._");
    return out.join("\n");
  }
  out.push("```diff");
  out.push(designDiff.trimEnd());
  out.push("```");
  return out.join("\n");
}

// ── 4i Prompt improvement placeholder ───────────────────────────

export function renderPromptImprovementPlaceholder(): string {
  return [
    "### Prompt Improvement Assessment",
    "",
    "<!-- skill: classify each noise/FP into one of the rows below and recommend a level. -->",
    "",
    "| Signal | Recommended Level | File |",
    "|--------|-------------------|------|",
    "| <!-- e.g. claude false positives in `general` across designs --> | Global | `global/prompts/design-review/{agent}/{domain}.md` |",
    "| <!-- e.g. claude false positives only in this repo --> | Repo | `{repo}/.code-review/design-prompts/{agent}/{domain}.md` |",
    "| <!-- e.g. all agents miss same issue found during fixing --> | Global (all agents) | `global/prompts/design-review/*/{domain}.md` |",
    "| <!-- e.g. findings irrelevant to this design type --> | Repo config | `disabled_domains` in config |",
  ].join("\n");
}

// ── Utilities ───────────────────────────────────────────────────

function escapePipes(s: string): string {
  // Markdown table cells can't contain raw `|`. Replace with the HTML
  // entity; the rendered output looks identical to the source.
  return s.replace(/\|/g, "&#124;");
}

// ── CLI ─────────────────────────────────────────────────────────

function readInput(source: string): string {
  if (source === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(source, "utf8");
}

function parseArgs(argv: string[]): { input: string; asJson: boolean } {
  let input = "-";
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") input = argv[++i] ?? "-";
    else if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: design_review_summary [--input PATH | -] [--json]\n" +
          "\n" +
          "Reads the SummaryInput JSON from --input (or stdin if '-') and\n" +
          "emits the Phase 4 markdown summary on stdout.",
      );
      process.exit(0);
    }
  }
  return { input, asJson };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  let raw: string;
  try {
    raw = readInput(opts.input);
  } catch (err) {
    console.error(`failed to read input: ${(err as Error).message}`);
    process.exit(2);
  }
  let parsed: SummaryInput;
  try {
    parsed = JSON.parse(raw) as SummaryInput;
  } catch (err) {
    console.error(`input is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }
  const md = renderSummary(parsed);
  if (opts.asJson) {
    console.log(JSON.stringify({ markdown: md }, null, 2));
  } else {
    process.stdout.write(md);
  }
  process.exit(0);
}

// Match against both the lexical and realpath form of argv[1]:
//   - Node's --experimental-strip-types loader (Node 25+) sets import.meta.url
//     to the realpath, so a symlinked invocation needs the realpath comparison.
//   - NODE_OPTIONS=--preserve-symlinks-main keeps import.meta.url at the
//     symlink URL, so we need the lexical comparison too.
//   - realpathSync throws if argv[1] doesn't exist on disk (embedded runners
//     that fake argv[1]); swallow that and fall through to "not invoked".
function isInvokedAsScript(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(path.resolve(argv1)).href) return true;
  try {
    return metaUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main();
}
