#!/usr/bin/env node
/**
 * findings_review_post.ts — publish a Claude Code `ReportFindings` payload to a
 * PR as ONE anchored review.
 *
 * The gap this closes: `/code-review --comment` posts one standalone
 * `POST /pulls/N/comments` per finding, and GitHub wraps each in its own empty
 * review object — 30 findings become 30 zero-body reviews. `postReview()` in
 * `review_post_lib.ts` already posts a single review with inline anchoring and a
 * three-tier no-drop guarantee; all that was missing is the payload adapter.
 *
 * Everything here is mapping plus a CLI: no new posting logic, no new retry or
 * fallback behavior.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { spawnSync } from "node:child_process";

import {
  postReview,
  type PostReviewResult,
} from "./review_post_lib.ts";
import {
  findingId,
  type AgentName,
  type Finding,
  type Severity,
} from "./finding_lib.ts";
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
 * Map ONE `ReportFindings` entry into the `Finding` `postReview` consumes.
 *
 * `classification: "fix"` is set on every finding deliberately and is
 * load-bearing: `partitionInlineVsBody` (`review_post_lib.ts`) requires it
 * for inline eligibility, so without it every finding lands in the review body
 * and nothing is ever anchored. `ReportFindings` only emits findings that
 * survived verification, so "fix" is the honest classification for all of them.
 */
export function toFinding(
  f: ReportFinding,
  agent: AgentName,
  anchorable?: AnchorableLines,
): Finding {
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
}

/** Map a whole `ReportFindings` payload. One `Finding` per entry, in order. */
export function toFindings(
  payload: ReportFindingsPayload,
  agent: AgentName,
  anchorable?: AnchorableLines,
): Finding[] {
  return (payload.findings ?? []).map((f) => toFinding(f, agent, anchorable));
}

// ─── generated-path routing ─────────────────────────────────────────────────

/**
 * Path globs whose findings are reported in the review BODY instead of as
 * inline threads.
 *
 * Why this exists (STARK-5637, measured on bifrost#264): three reviews posted
 * 34 inline threads against `vendor/stark-skills/tools/gru*.ts` and generated
 * `dist` output. Every finding was real and every one already carried a
 * disposition in its body, but bifrost `main` enforces
 * `required_conversation_resolution`, so 34 open threads pinned the PR at
 * `mergeStateStatus: BLOCKED` with all five checks green and
 * `mergeable: MERGEABLE`. `auto/marketplace-sync` is a SHARED branch,
 * force-updated by every sync from every session, so those threads blocked a
 * DIFFERENT session's publish. And they could not have been fixed where they
 * were posted: these paths are a generated snapshot of code already merged
 * upstream, the drift gate rejects hand-edits, and the next regeneration
 * overwrites the tree.
 *
 * The finding is not dropped, downgraded, or auto-resolved. It moves from a
 * gating inline thread to a non-gating body entry that keeps its file, line,
 * severity and disposition. Dispositioning stays the author's job.
 *
 * This list MIRRORS bifrost's `.gitattributes` `linguist-generated=true`
 * entries (`dist/**`, `vendor/**`, `index.json`, `bundles/**`,
 * `.claude-plugin/**`) plus `catalog/**`, which a sync PR machine-rewrites
 * without declaring generated. Because it is a mirror it can drift — when a
 * target repo declares a generated path this list does not carry, pass it with
 * `--generated-paths` rather than assuming the default covers the repo.
 */
export const DEFAULT_GENERATED_PATHS: readonly string[] = Object.freeze([
  "vendor/**",
  "dist/**",
  "bundles/**",
  "catalog/**",
  // Every bifrost sync PR rewrites `.claude-plugin/marketplace.json`, and
  // bifrost's `.gitattributes` marks the tree `linguist-generated=true`.
  // Omitting it left the one machine-written file the sync touches on every
  // run still opening a gating thread.
  ".claude-plugin/**",
  "index.json",
]);

/**
 * The first configured glob `file` matches, or null when it matches none.
 *
 * Matching is `node:path`'s own `matchesGlob` — a doubled star crosses path
 * separators, a single star and `?` stay inside one segment, and the pattern is
 * anchored against the WHOLE repo-relative path.
 *
 * That whole-path anchoring is load-bearing, not a simplification. Under
 * gitignore's basename rule a bare `index.json` would also match bifrost's
 * `web/src/__fixtures__/index.json` and its `engine/internal/*` testdata copies
 * — hand-written source fixtures whose findings must keep their inline threads,
 * because those ARE fixable where they are posted. To match a generated file at
 * any depth, write the doubled-star prefix yourself.
 */
export function matchGeneratedPath(
  file: string | null | undefined,
  patterns: readonly string[],
): string | null {
  if (!file) return null;
  // Compare in the shape GitHub reports a changed file: repo-relative, no `./`
  // or `/` prefix. A finding that names `./vendor/x.ts` must demote exactly
  // like the `vendor/x.ts` GitHub listed.
  const rel = file.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!rel) return null;
  for (const pattern of patterns) {
    if (nodePath.matchesGlob(rel, pattern)) return pattern;
  }
  return null;
}

/** One finding held out of the inline set because its only anchor is generated. */
export interface GeneratedEntry {
  file: string;
  /** The line the finding declared — the line it would have anchored to. */
  line: number | null;
  /** Which configured glob matched, so the demotion is explainable. */
  pattern: string;
}

export interface GeneratedSplit {
  /** False when the glob list is empty — via `--no-generated-split` on the CLI. */
  enabled: boolean;
  patterns: string[];
  entries: GeneratedEntry[];
}

/**
 * The per-finding note prepended to a generated-path finding's body. It REPLACES
 * `toFinding`'s `**Location:**` prefix rather than stacking on top of it, so a
 * demoted finding carries one location line, not two contradictory ones.
 *
 * It states the file and line itself because `buildReviewBody`'s `(file:line)`
 * header drops the line whenever the anchor was invalidated as out-of-hunk —
 * exactly the case where the reader most needs to know where the finding
 * pointed. It stays SHORT on purpose: the full rationale lives once in
 * {@link generatedPathPreamble}, and this note is paid once per finding into a
 * review body that has no size guard and a hard 65,536-char ceiling.
 */
export function generatedFindingNote(
  file: string,
  declaredLine: number | null,
  pattern: string,
  outsideDiff = false,
): string {
  const at = `\`${file}${declaredLine !== null ? `:${declaredLine}` : ""}\``;
  const where = outsideDiff ? ", outside this PR's diff" : "";
  return `**Generated output** ${at} (matched \`${pattern}\`${where}) — fix it upstream; see the note above.`;
}

/** The review-body preamble explaining why these findings have no threads. */
export function generatedPathPreamble(split: GeneratedSplit): string {
  const n = split.entries.length;
  if (n === 0) return "";
  const patterns = [...new Set(split.entries.map((e) => e.pattern))].sort();
  return [
    `### ${n} finding${n === 1 ? "" : "s"} on generated paths — in this body, not inline`,
    "",
    `Matched ${patterns.map((p) => `\`${p}\``).join(", ")}. Each is listed below with the ` +
      "file and line it would have anchored to.",
    "",
    "They are deliberately not inline threads. The path is **generated output**, so the fix " +
      "belongs **upstream** in the source it is generated from — an edit here is overwritten " +
      "by the next regeneration and rejected by the drift gate. And this is a **shared** " +
      "branch, so an unresolved thread on it blocks every session's merge under " +
      "`required_conversation_resolution`, not just this review's.",
    "",
    "Nothing is dropped, downgraded, or auto-resolved: every finding keeps its severity and " +
      "its disposition. Only the gating thread is withheld.",
  ].join("\n");
}

/** Human-facing preamble for the review body. */
export function buildHumanSummary(
  findings: Finding[],
  level: string | undefined,
  agent: AgentName = findings[0]?.agent ?? "claude",
  generated?: GeneratedSplit,
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
    `Review model: ${agent}. Posted through the operator's gh login.`,
    "",
    counts ? `Severity mix: ${counts}.` : "No findings.",
    "",
    "Severity is **inferred** from each finding's verdict " +
      "(`CONFIRMED` → high, otherwise medium) — `ReportFindings` carries no " +
      "severity field. Treat it as a sort order, not a measurement.",
  ];
  if (level) lines.push("", `Review effort level: \`${level}\`.`);
  if (generated) {
    const preamble = generatedPathPreamble(generated);
    if (preamble) lines.push("", preamble);
  }
  return lines.join("\n");
}

/**
 * Everything `postReview` needs, with the generated-path split already applied.
 *
 * Split mechanism: a generated path is removed from the `changedFiles` set
 * handed to `postReview`. `partitionInlineVsBody` requires
 * `changedFiles.has(f.file)` for inline eligibility and routes everything else
 * to the review body WITH its file and line intact, so this demotes the thread
 * and touches nothing else — not severity, not `classification`, not the
 * finding's disposition. Reusing that seam rather than re-implementing the
 * partition also means the 422 fallback still only ever demotes inline → body,
 * so nothing can promote a generated-path finding back into a thread.
 */
export interface ReviewPlan {
  findings: Finding[];
  /** The PR's changed files minus every generated path. */
  inlineEligibleFiles: Set<string>;
  humanSummary: string;
  generated: GeneratedSplit;
}

export function planReview(
  payload: ReportFindingsPayload,
  ctx: { changedFiles: Set<string>; anchorable?: AnchorableLines },
  opts: { agent: AgentName; generatedPaths: readonly string[] },
): ReviewPlan {
  const patterns = [...opts.generatedPaths];
  const entries: GeneratedEntry[] = [];
  const findings: Finding[] = [];
  for (const raw of payload.findings ?? []) {
    const f = toFinding(raw, opts.agent, ctx.anchorable);
    const pattern = matchGeneratedPath(f.file, patterns);
    if (pattern === null) {
      findings.push(f);
      continue;
    }
    const declaredLine = typeof raw.line === "number" ? raw.line : null;
    const file = f.file as string;
    entries.push({ file, line: declaredLine, pattern });
    // Rebuild the body from `bodyFor` rather than prefixing `f.body`: for an
    // out-of-hunk anchor `toFinding` has already prepended its own
    // `**Location:**` line, and stacking the two reads as two different
    // reasons for the same demotion.
    const note = generatedFindingNote(file, declaredLine, pattern, f.line === null && declaredLine !== null);
    findings.push({ ...f, body: `${note}\n\n${bodyFor(raw)}` });
  }
  const generated: GeneratedSplit = { enabled: patterns.length > 0, patterns, entries };
  return {
    findings,
    inlineEligibleFiles: new Set(
      [...ctx.changedFiles].filter((file) => matchGeneratedPath(file, patterns) === null),
    ),
    humanSummary: buildHumanSummary(findings, payload.level, opts.agent, generated),
    generated,
  };
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
  // A signal kill is otherwise indistinguishable from a crash, and ENOBUFS is
  // the one cause we can name precisely — so name it whenever the child was
  // terminated, NOT only when stderr happens to be empty. `gh` writes to stderr
  // routinely (rate-limit notices, warnings), and a child killed for exceeding
  // maxBuffer keeps whatever it already wrote there; gating on an empty stderr
  // let an unrelated warning swallow the real cause and put the caller back to
  // reporting `failed (exit null): gh: a warning` on exactly the large PRs this
  // buffer exists for. The child's own stderr is preserved alongside.
  let stderr = sp.stderr ?? "";
  if (sp.status === null) {
    const why = (sp.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS"
      ? `output exceeded maxBuffer (${GH_MAX_BUFFER} bytes)`
      : sp.error?.message ?? `killed by signal ${sp.signal ?? "unknown"}`;
    const own = stderr.trim();
    stderr = own
      ? `${cmd} was terminated: ${why}; its own stderr followed: ${own}`
      : `${cmd} produced no stderr and was terminated: ${why}`;
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
  --agent AGENT     review attribution: claude|codex|gemini (default: claude)
  --generated-paths GLOB[,GLOB...]
                    replace the generated-output glob list
                    (default: ${DEFAULT_GENERATED_PATHS.join(",")})
  --no-generated-split
                    anchor generated-path findings inline like any other
  --dry-run         build the payload and print the plan without posting
  -h, --help        show this help message and exit

A finding whose only anchor is a generated path is reported in the review BODY,
with the file and line it would have anchored to, instead of as an inline
thread: the fix belongs upstream, and an unresolved thread on a shared publish
branch blocks every session's merge. Nothing is dropped, downgraded, or
auto-resolved — only the gating thread is withheld. Globs are matched against
the whole repo-relative path, so \`index.json\` means the root file, not every
file with that name; write the doubled-star prefix to match at any depth.

The review is posted as event=COMMENT through the existing gh login.
The agent selects model attribution only; it never changes authentication.`;

export interface CliArgs {
  repo: string;
  pr: number;
  findingsPath: string;
  agent: AgentName;
  dryRun: boolean;
  generatedPaths: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  let repo: string | undefined;
  let pr: number | undefined;
  let findingsPath: string | undefined;
  let agent: AgentName = "claude";
  let dryRun = false;
  let generatedPaths: string[] = [...DEFAULT_GENERATED_PATHS];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      // A flag's value must not be the NEXT flag. `--generated-paths --dry-run`
      // would otherwise parse to the glob list ["--dry-run"] — matching nothing,
      // so every generated finding regains a gating thread — while `--dry-run`
      // itself is consumed and never set, so the review really posts. The
      // empty-value guard below exists to stop a silent disable; this stops the
      // same thing arriving one keystroke earlier. `-` stays legal: it is the
      // documented stdin value for `--findings`.
      if (v.startsWith("--")) {
        throw new Error(`${a} requires a value, got the flag ${v}`);
      }
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
      case "--agent": {
        const v = need() as AgentName;
        if (!AGENTS.includes(v)) throw new Error(`--agent must be one of ${AGENTS.join("|")}, got ${v}`);
        agent = v;
        break;
      }
      case "--generated-paths": {
        const raw = need();
        const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        // An empty value must not silently disable the split — that is the
        // failure this whole tool exists to stop, arriving as a typo instead.
        // Disabling is an explicit flag.
        if (list.length === 0) {
          throw new Error(
            "--generated-paths requires at least one glob; pass --no-generated-split to disable the split",
          );
        }
        generatedPaths = list;
        break;
      }
      case "--no-generated-split": generatedPaths = []; break;
      case "--dry-run": dryRun = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!repo) throw new Error("--repo is required");
  if (pr === undefined) throw new Error("--pr is required");
  if (!findingsPath) throw new Error("--findings is required");
  return { repo, pr, findingsPath, agent, dryRun, generatedPaths };
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

/**
 * GitHub's hard cap on a pull-request review body, in characters.
 *
 * This matters more since the generated-path split: a demoted finding's full
 * text moves OUT of an inline comment, which carries its own budget, and INTO
 * the one shared review body. Over the cap the POST 422s on `body is too long`
 * with no `errors[].index`, so `extract422Indices` returns `[]` and
 * `postReview`'s fallback demotes the REMAINING inline comments into that same
 * body, retries it larger, 422s again and reports `unposted` — every finding
 * lost, not one. Refusing up front turns that into one actionable message.
 */
export const GITHUB_REVIEW_BODY_MAX = 65536;

/** The cap check, split out so a test can pin it without a network round trip. */
export function bodyTooLarge(bodyChars: number): string | null {
  if (bodyChars <= GITHUB_REVIEW_BODY_MAX) return null;
  return `review body is ${bodyChars} chars, over GitHub's ${GITHUB_REVIEW_BODY_MAX}-char limit. ` +
    "Posting would 422 on `body is too long`, and the fallback would fold the inline comments " +
    "into the same body and fail again, losing every finding. Split the payload into smaller " +
    "batches, or narrow --generated-paths so fewer findings are routed to the body.";
}

async function main(argv: string[]): Promise<number> {
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const payload = readPayload(args.findingsPath);
  const ctx = await fetchPrContext(args.repo, args.pr);
  const plan = planReview(payload, ctx, {
    agent: args.agent,
    generatedPaths: args.generatedPaths,
  });

  const postOpts = {
    repo: args.repo,
    pr: args.pr,
    round: 1,
    agent: args.agent,
    runHash: plan.findings.map((f) => f.id).join(",").slice(0, 40) || "empty",
    findings: plan.findings,
    changedFiles: plan.inlineEligibleFiles,
    // "low" so severity never filters a finding out of the review — the
    // no-drop rule is the whole point of this path.
    fixThreshold: "low" as const,
    humanSummary: plan.humanSummary,
    prHeadSha: ctx.headSha,
  };

  // Measure the body EXACTLY rather than estimating it: a dry-run postReview
  // builds the real body — same marker, same renderer — and returns before any
  // network call, so this costs one string build and cannot drift from what the
  // real post would send.
  const probe = await postReview({ ...postOpts, dryRun: true });
  const oversize = bodyTooLarge(probe.payloadSummary.bodyChars);
  if (oversize) throw new Error(oversize);

  const result: PostReviewResult = args.dryRun
    ? probe
    : await postReview({ ...postOpts, dryRun: false });
  console.log(JSON.stringify({
    findings: plan.findings.length,
    generatedPathSplit: {
      enabled: plan.generated.enabled,
      patterns: plan.generated.patterns,
      routedToBody: plan.generated.entries.length,
      findings: plan.generated.entries.map((e) => ({
        file: e.file,
        line: e.line,
        pattern: e.pattern,
      })),
    },
    ...result,
  }, null, 2));
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
