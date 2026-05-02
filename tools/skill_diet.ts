#!/usr/bin/env node

// Detects duplicated boilerplate across SKILL.md files (preflight, dispatch
// failure handling, GH App token export, multi-agent posting block) and
// reports byte savings opportunities. Patterns are checked against the
// canonical extracted version under `standards/` — if a skill already
// links to that doc, the inline copy is treated as already-extracted.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverSkillBundles,
  findRepoRoot,
  type SkillBundle,
} from "./skill_lib.ts";

export type DietPatternId =
  | "inline-preflight"
  | "inline-dispatch-failure"
  | "inline-gh-app-token-export"
  | "inline-multi-agent-posting"
  | "inline-scripts-constants";

export type DietHit = {
  patternId: DietPatternId;
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  bytes: number; // size of the inline block including its trailing newline
  refTarget: string; // canonical extracted location (relative to repo root)
};

export type DietReport = {
  skillPath: string;
  lineCount: number;
  byteCount: number;
  hits: DietHit[];
  bytesInline: number;
};

export type DietSummary = {
  repoRoot: string;
  reports: DietReport[];
  totals: {
    skills: number;
    bytes: number;
    bytesInline: number;
    hitsByPattern: Record<DietPatternId, number>;
  };
};

type Detector = (raw: string) => DietHit[];

// ── Detectors ───────────────────────────────────────────────────

export function detectInlinePreflight(raw: string): DietHit[] {
  // A skill that already links to the canonical doc is considered extracted.
  if (raw.includes("standards/preflight.md")) return [];
  const lines = raw.split("\n");
  const idx = lines.findIndex((line) => line.includes("preflight.py"));
  if (idx === -1) return [];

  // Require all three result-handling keywords within a 25-line window so
  // a stray `preflight.py` mention (e.g. in a code path comment) doesn't
  // trip the detector.
  const window = lines.slice(idx, Math.min(lines.length, idx + 25)).join("\n");
  if (!/blocked/i.test(window) || !/degraded/i.test(window) || !/ready/i.test(window)) {
    return [];
  }

  const { startLine, endLine } = sectionBounds(lines, idx, /^#{1,4}\s/);
  return [
    {
      patternId: "inline-preflight",
      startLine: startLine + 1,
      endLine: endLine + 1,
      bytes: blockBytes(lines, startLine, endLine),
      refTarget: "standards/preflight.md",
    },
  ];
}

export function detectInlineDispatchFailure(raw: string): DietHit[] {
  if (raw.includes("standards/dispatch-failure.md")) return [];
  const lines = raw.split("\n");
  const idx = lines.findIndex((line) => /summary\.succeeded\s*==\s*0/.test(line));
  if (idx === -1) return [];

  const window = lines.slice(idx, Math.min(lines.length, idx + 25)).join("\n");
  if (!/dispatch failure/i.test(window) && !/all sub-agents failed/i.test(window)) {
    return [];
  }

  const { startLine, endLine } = sectionBounds(lines, idx, /^#{2,4}\s/);
  return [
    {
      patternId: "inline-dispatch-failure",
      startLine: startLine + 1,
      endLine: endLine + 1,
      bytes: blockBytes(lines, startLine, endLine),
      refTarget: "standards/dispatch-failure.md",
    },
  ];
}

export function detectInlineGhAppTokenExport(raw: string): DietHit[] {
  const lines = raw.split("\n");
  const re = /export\s+GH_TOKEN\s*=\s*["']?\$\([^)]*github_app\.py[^)]*token[^)]*\)/;
  const hits: DietHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      hits.push({
        patternId: "inline-gh-app-token-export",
        startLine: i + 1,
        endLine: i + 1,
        bytes: lines[i].length + 1,
        refTarget: "standards/github-app-auth.md",
      });
    }
  }
  return hits;
}

export function detectInlineMultiAgentPosting(raw: string): DietHit[] {
  const lines = raw.split("\n");
  const re = /github_app\.py\s+--app\s+stark-(claude|codex|gemini)\s+pr\s+review/;
  const matches: { line: number; agent: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) matches.push({ line: i, agent: m[1] });
  }
  // Need at least two distinct agents posting close together to qualify as
  // the inline multi-agent block. Spread > 30 lines is more likely scattered
  // examples in different sections.
  const distinctAgents = new Set(matches.map((m) => m.agent));
  if (distinctAgents.size < 2) return [];
  const first = matches[0].line;
  const last = matches[matches.length - 1].line;
  if (last - first > 30) return [];
  return [
    {
      patternId: "inline-multi-agent-posting",
      startLine: first + 1,
      endLine: last + 1,
      bytes: blockBytes(lines, first, last),
      refTarget: "standards/multi-agent-posting.md",
    },
  ];
}

export function detectInlineScriptsConstants(raw: string): DietHit[] {
  const lines = raw.split("\n");
  const hits: DietHit[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*SCRIPTS\s*=\s*/.test(lines[i]) && /^\s*PYTHON\s*=\s*/.test(lines[i + 1])) {
      let endLine = i + 1;
      // Optionally absorb the `[ -x "$PYTHON" ] || PYTHON=python3` fallback
      // line that almost always follows.
      if (
        i + 2 < lines.length &&
        /\[\s*-x\s+["']?\$\{?PYTHON\}?["']?\s*\].*\|\|\s*PYTHON\s*=\s*python3/.test(lines[i + 2])
      ) {
        endLine = i + 2;
      }
      hits.push({
        patternId: "inline-scripts-constants",
        startLine: i + 1,
        endLine: endLine + 1,
        bytes: blockBytes(lines, i, endLine),
        refTarget: "standards/skill-constants.md",
      });
      i = endLine; // Avoid double-counting an overlapping match.
    }
  }
  return hits;
}

const DETECTORS: Detector[] = [
  detectInlinePreflight,
  detectInlineDispatchFailure,
  detectInlineGhAppTokenExport,
  detectInlineMultiAgentPosting,
  detectInlineScriptsConstants,
];

export function detectAll(raw: string): DietHit[] {
  return DETECTORS.flatMap((detector) => detector(raw)).sort(
    (a, b) => a.startLine - b.startLine,
  );
}

// ── Reporting ────────────────────────────────────────────────────

export function reportSkill(repoRoot: string, bundle: SkillBundle): DietReport {
  const absolutePath = path.join(repoRoot, bundle.skillPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const hits = detectAll(raw);
  return {
    skillPath: bundle.skillPath,
    lineCount: bundle.lineCount,
    byteCount: raw.length,
    hits,
    bytesInline: hits.reduce((sum, hit) => sum + hit.bytes, 0),
  };
}

export function summarize(repoRoot: string): DietSummary {
  const reports = discoverSkillBundles(repoRoot).map((bundle) =>
    reportSkill(repoRoot, bundle),
  );
  const hitsByPattern: Record<DietPatternId, number> = {
    "inline-preflight": 0,
    "inline-dispatch-failure": 0,
    "inline-gh-app-token-export": 0,
    "inline-multi-agent-posting": 0,
    "inline-scripts-constants": 0,
  };
  let bytesInline = 0;
  let bytes = 0;
  for (const report of reports) {
    bytes += report.byteCount;
    bytesInline += report.bytesInline;
    for (const hit of report.hits) {
      hitsByPattern[hit.patternId] += 1;
    }
  }
  return {
    repoRoot,
    reports,
    totals: {
      skills: reports.length,
      bytes,
      bytesInline,
      hitsByPattern,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function sectionBounds(
  lines: string[],
  anchorIndex: number,
  headingPattern: RegExp,
): { startLine: number; endLine: number } {
  let startLine = anchorIndex;
  for (let i = anchorIndex - 1; i >= Math.max(0, anchorIndex - 10); i--) {
    if (headingPattern.test(lines[i])) {
      startLine = i;
      break;
    }
  }
  let endLine = anchorIndex;
  for (let i = anchorIndex + 1; i < Math.min(lines.length, anchorIndex + 40); i++) {
    if (headingPattern.test(lines[i])) {
      endLine = i - 1;
      break;
    }
    endLine = i;
  }
  return { startLine, endLine };
}

function blockBytes(lines: string[], startLine: number, endLine: number): number {
  // +1 to include the trailing newline that joins to the next line.
  return lines.slice(startLine, endLine + 1).join("\n").length + 1;
}

// ── CLI ──────────────────────────────────────────────────────────

function formatText(summary: DietSummary): string {
  const out: string[] = [];
  out.push(
    `Skill diet — ${summary.totals.skills} skills, ` +
      `${summary.totals.bytes} bytes total, ` +
      `${summary.totals.bytesInline} bytes savable inline`,
  );
  out.push("");
  for (const report of summary.reports) {
    if (!report.hits.length) continue;
    out.push(
      `${report.skillPath} (${report.lineCount} lines, ${report.byteCount} bytes)`,
    );
    for (const hit of report.hits) {
      out.push(
        `  ${hit.patternId} at L${hit.startLine}-${hit.endLine} ` +
          `(~${hit.bytes} bytes) → extract to ${hit.refTarget}`,
      );
    }
  }
  out.push("");
  out.push("By pattern:");
  for (const [id, count] of Object.entries(summary.totals.hitsByPattern)) {
    out.push(`  ${id.padEnd(32)} ${count} skill(s)`);
  }
  return out.join("\n");
}

function main(): void {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error(
      `skill_diet must run from inside a git repository; ` +
        `no .git/ found walking up from ${process.cwd()}.`,
    );
    process.exit(2);
  }
  const args = new Set(process.argv.slice(2));
  const asJson = args.has("--json");
  const failOnHits = args.has("--check");

  const summary = summarize(repoRoot);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatText(summary));
  }

  // --check mode: non-zero exit if any inline boilerplate remains. Useful
  // as a CI gate so freshly-added skills can't reintroduce duplicated
  // preflight/dispatch-failure blocks once they've been extracted.
  if (failOnHits && summary.totals.bytesInline > 0) {
    process.exit(1);
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
