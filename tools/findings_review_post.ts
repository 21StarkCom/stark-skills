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
import { spawnBounded, type BoundedSpawnResult } from "./bounded_spawn_lib.ts";

import {
  GITHUB_REVIEW_BODY_MAX,
  computeRunHash,
  postReview,
  type PostReviewResult,
} from "./review_post_lib.ts";
import {
  findingId,
  type AgentName,
  type Finding,
  type Severity,
} from "./finding_lib.ts";
import { assertGhTimeoutMs, explainTermination, resolveGhTimeoutMs } from "./child_termination_lib.ts";
import { isMainModule } from "./main_module_lib.ts";
import {
  DEFAULT_GENERATED_PATHS_CONFIG,
  getGeneratedPathsConfig,
  type GeneratedPathsConfig,
} from "./stark_config_lib.ts";

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
 * This constant is now only the BUILT-IN FALLBACK, the last layer of
 * {@link resolveGeneratedPaths}'s precedence order (CLI flag > repo config >
 * the target repo's own `.gitattributes` > here). It used to be the sole
 * source: a hand-copied mirror of bifrost's `linguist-generated=true` rows,
 * which had already drifted on arrival (the first cut omitted
 * `.claude-plugin/**`, the one file every sync rewrites) and applied bifrost's
 * tree shape to every `--repo O/R` the tool was pointed at. The list a run
 * actually uses comes from `tools/stark_config_lib.ts`'s `generated_paths`
 * section; this frozen copy is kept so the mapping helpers stay usable without
 * touching config or the network, and so its shape is pinned by a test.
 *
 * It is DERIVED from `DEFAULT_GENERATED_PATHS_CONFIG.default`, never restated.
 * The list previously existed three times — here, in the config default, and in
 * `global/config.json` — so a new generated path had to be added in three
 * places, and forgetting one silently re-opens a gating thread on that path,
 * which is the failure this whole split exists to prevent. (`.claude-plugin/**`
 * is in it because every bifrost sync PR rewrites
 * `.claude-plugin/marketplace.json`; omitting it left the one machine-written
 * file every sync touches still opening a thread.)
 */
export const DEFAULT_GENERATED_PATHS: readonly string[] = Object.freeze([
  ...DEFAULT_GENERATED_PATHS_CONFIG.default,
]);

/**
 * Translate a target repo's `.gitattributes` into the generated-path globs
 * this tool matches with.
 *
 * DELIBERATELY NOT a gitattributes parser. Real precedence there is
 * last-match-wins with negation, unset, and `[attr]` macros; this reads one
 * attribute and refuses to guess about anything else:
 *
 *  - a row is taken only when its attribute list carries `linguist-generated`
 *    Set — written either `linguist-generated=true` or bare (in git, an
 *    attribute listed bare IS Set, so reading bare as true is a reading, not
 *    a guess);
 *  - `-linguist-generated`, `!linguist-generated` and
 *    `linguist-generated=false` are skipped, never inverted into something
 *    else's meaning;
 *  - `[attr]` macro definitions are skipped entirely — resolving a macro
 *    would be exactly the guessing this avoids.
 *
 * ONE deliberate semantic divergence, pinned by test: git matches a
 * slash-less pattern like `index.json` against the BASENAME at any depth, and
 * this tool matches the whole repo-relative path. The divergence is the
 * conservative direction and is the behaviour STARK-5637 chose on purpose —
 * under basename matching, bifrost's declared `index.json` would also swallow
 * its hand-written `web/src/__fixtures__/index.json`, whose findings ARE
 * fixable where they are posted. Demoting a fixable finding costs the author
 * the thread they needed; leaving a generated one inline costs a thread that
 * `--add-generated-paths` can put back. A repo that really means any depth
 * writes the doubled-star prefix itself.
 */
export function parseGeneratedGlobs(gitattributes: string): string[] {
  const out: string[] = [];
  for (const raw of gitattributes.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[attr]")) continue;
    // git lets a pattern containing spaces be double-quoted. Splitting the
    // whole line on whitespace would tear `"my dir/*" linguist-generated=true`
    // into the glob `"my` — a garbage pattern that matches nothing and joins
    // the list silently, which is a fail-narrow wearing a parse bug's hat.
    const quoted = line.match(/^"((?:[^"\\]|\\.)*)"\s*(.*)$/);
    const [pattern, ...attrs] = quoted
      ? [quoted[1], ...(quoted[2] ? quoted[2].split(/\s+/) : [])]
      : line.split(/\s+/);
    if (!pattern) continue;
    const set = attrs.some(
      (a) => a === "linguist-generated" || a === "linguist-generated=true",
    );
    if (!set) continue;
    // A leading slash anchors to the repo root in gitattributes; whole-path
    // matching is already root-anchored, so the slash is redundant noise.
    let glob = pattern.replace(/^\/+/, "");
    // A trailing slash means "this directory's contents".
    if (glob.endsWith("/")) glob = glob + "**";
    if (glob) out.push(glob);
  }
  return [...new Set(out)];
}

export interface GitattributesFetch {
  /** The file's text, or null when it could not be read. */
  text: string | null;
  /**
   * Why `text` is null, or null when the read succeeded. A plain 404 is NOT a
   * failure — the repo simply has no `.gitattributes` — so it leaves this null
   * too and only `text` says so.
   */
  failure: string | null;
}

/**
 * Read the target repo's `.gitattributes`.
 *
 * `ref` pins the read to a commit (the PR head), so a PR that ADDS or CHANGES a
 * `linguist-generated` row is reviewed against the declaration it ships rather
 * than the default branch's older one. A fork PR's head sha is not in the base
 * repo, so that read 404s — callers fall back to the unpinned read.
 *
 * A 404 and a 403/rate-limit/network failure are NOT the same event and must
 * not degrade the same way silently: both fall back to the configured default,
 * but only the second means the fallback list may be wrong for this repo, which
 * is the exact defect STARK-6095 exists to kill. The reason is returned so the
 * warning can say which happened.
 */
export async function fetchGitattributesResult(
  repo: string,
  run: RunFn = defaultRun,
  ref?: string,
): Promise<GitattributesFetch> {
  const path = `repos/${repo}/contents/.gitattributes${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const r = await run("gh", ["api", path, "-H", "Accept: application/vnd.github.raw"]);
  if (r.status === 0) return { text: r.stdout, failure: null };
  const stderr = (r.stderr ?? "").trim();
  // A TERMINATED child (`status: null` — timeout, maxBuffer, signal) is never a
  // 404, whatever its stderr reads. Its text is now partly ours: a bound of 404
  // renders "timed out after 404 ms", which would otherwise match, null the
  // failure and drop the one warning that says the fallback list may be wrong.
  const notFound = r.status !== null && /\b404\b|Not Found/i.test(stderr);
  return {
    text: null,
    failure: notFound ? null : `gh api ${path} failed (exit ${r.status}): ${stderr.slice(0, 200)}`,
  };
}

/** Read the target repo's `.gitattributes`, or null when it could not be read. */
export async function fetchGitattributes(
  repo: string,
  run: RunFn = defaultRun,
  ref?: string,
): Promise<string | null> {
  return (await fetchGitattributesResult(repo, run, ref)).text;
}

/** Which layer of the precedence order supplied the base list. */
export type GeneratedPathsSource =
  | "disabled"
  | "cli"
  | "repo-config"
  | "gitattributes"
  | "default";

export interface ResolvedGeneratedPaths {
  patterns: string[];
  source: GeneratedPathsSource;
  /** Globs layered on top of the base list, in the order they were added. */
  added: string[];
  /**
   * Declared patterns this tool anchored at the repo ROOT that git would have
   * matched by basename at any depth — the one deliberate divergence, disclosed
   * so a repo whose declarations all narrow (e.g. a lone `*.pb.go`) is legible
   * instead of looking configured while splitting nothing. Empty unless
   * `source === "gitattributes"`.
   */
  rootAnchored: string[];
  /** Fail-open notices — every one of these is also written to stderr. */
  warnings: string[];
}

/**
 * Resolve the generated-path globs for ONE run.
 *
 * Precedence, highest first — each layer REPLACES the ones below it:
 *
 *   1. `--generated-paths` / `--no-generated-split` (the operator, this run)
 *   2. `generated_paths.repos["O/R"].paths` (this repo, config)
 *   3. the target repo's `.gitattributes` `linguist-generated=true` rows
 *   4. `generated_paths.default` (built-in fallback)
 *
 * On top of whichever layer won: `generated_paths.repos["O/R"].add` (skipped
 * when the CLI replaced the list, because the CLI outranks repo config) and
 * then `--add-generated-paths`.
 *
 * FAIL-OPEN, never fail-narrow. An absent, unfetchable or generated-row-free
 * `.gitattributes` falls back to the configured default and says so on stderr;
 * it never resolves to an empty list, because an empty list silently disables
 * the split and re-opens the gating threads this whole path exists to prevent.
 * Disabling stays explicit: `--no-generated-split`, or `enabled: false` — and
 * `enabled: false` is a GLOBAL default, so an explicit `--generated-paths` this
 * run outranks it like every other layer; only `--no-generated-split` disables
 * a run the operator gave globs to.
 */
export function resolveGeneratedPaths(opts: {
  repo: string;
  /** `null` = no `--generated-paths`; `[]` = `--no-generated-split`. */
  cliPaths?: readonly string[] | null;
  cliAdd?: readonly string[];
  /** Raw `.gitattributes` text; `null` = absent or unfetchable. */
  gitattributes?: string | null;
  /** Why `gitattributes` is null, when it was a real failure and not a 404. */
  gitattributesFailure?: string | null;
  config?: GeneratedPathsConfig;
}): ResolvedGeneratedPaths {
  const cfg = opts.config ?? getGeneratedPathsConfig();
  const warnings: string[] = [];
  const cliPaths = opts.cliPaths ?? null;
  const cliAdd = [...(opts.cliAdd ?? [])];

  /**
   * Config is user-editable JSON with no schema, so a glob list can arrive as
   * any shape. A bare string is the dangerous one: `"default": "vendor/**"`
   * passes a `.length` truthiness test and spreads into the one-character globs
   * `["v","e","n",...]`, which match nothing — a silent disable of the split
   * wearing a config typo's hat. Anything that is not an array of non-empty
   * strings is refused loudly and treated as unset.
   */
  const globList = (value: unknown, where: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
      warnings.push(
        `${where} must be an array of non-empty glob strings — ignoring it and using the layer below`,
      );
      return [];
    }
    return (value as string[]).map((v) => v.trim());
  };

  if (cliPaths !== null && cliPaths.length === 0) {
    if (cliAdd.length > 0) {
      // Not a hard error only because `--no-generated-split` + `--generated-paths`
      // is already pinned as last-wins; but it must never be silent, since a
      // swallowed `--add-generated-paths` is how a repo's extra generated path
      // ends up back on a gating thread.
      warnings.push(
        "--no-generated-split disables the split, so --add-generated-paths " +
          `(${cliAdd.join(", ")}) was ignored`,
      );
    }
    return { patterns: [], source: "disabled", added: [], rootAnchored: [], warnings };
  }
  if (!cfg.enabled && cliPaths === null) {
    warnings.push("generated_paths.enabled is false — every finding anchors inline");
    return { patterns: [], source: "disabled", added: [], rootAnchored: [], warnings };
  }

  const repoCfg = cfg.repos?.[opts.repo] ?? {};
  const configuredDefault = globList(cfg.default, "generated_paths.default");
  const builtIn = configuredDefault.length ? configuredDefault : [...DEFAULT_GENERATED_PATHS];
  const repoPaths = globList(repoCfg.paths, `generated_paths.repos["${opts.repo}"].paths`);
  const repoAdd = globList(repoCfg.add, `generated_paths.repos["${opts.repo}"].add`);

  let base: string[];
  let source: GeneratedPathsSource;
  let rootAnchored: string[] = [];
  if (cliPaths !== null) {
    base = [...cliPaths];
    source = "cli";
    if (!cfg.enabled) {
      warnings.push(
        "generated_paths.enabled is false, but an explicit --generated-paths outranks it — " +
          "pass --no-generated-split to disable the split for this run",
      );
    }
  } else if (repoPaths.length) {
    base = repoPaths;
    source = "repo-config";
  } else if (typeof opts.gitattributes === "string") {
    const declared = parseGeneratedGlobs(opts.gitattributes);
    if (declared.length > 0) {
      base = declared;
      source = "gitattributes";
      // Git matches a slash-less pattern against the BASENAME at any depth; this
      // tool anchors it at the repo root (STARK-5637, on purpose: bifrost's
      // declared `index.json` must not swallow its hand-written
      // `web/src/__fixtures__/index.json`, whose findings ARE fixable inline).
      // The divergence stands — but now that the list is read from the REPO's
      // OWN words rather than hand-authored, a run silently narrows what the
      // repo said, and a declaration like `*.pb.go` (the most common generated
      // row there is) then matches nothing at all while `source` still reads
      // `gitattributes`. Report it in the summary rather than warning on stderr:
      // a warning would fire on EVERY bifrost run and advise `**/index.json`,
      // which is precisely the thing STARK-5637 refused.
      rootAnchored = declared.filter((p) => !p.includes("/"));
    } else {
      warnings.push(
        `${opts.repo}: .gitattributes declares no linguist-generated=true paths — ` +
          "falling back to the configured default list",
      );
      base = builtIn;
      source = "default";
    }
  } else {
    warnings.push(
      opts.gitattributesFailure
        ? `${opts.repo}: .gitattributes could not be read (${opts.gitattributesFailure}) — ` +
          "falling back to the configured default list, which may not describe this repo"
        : `${opts.repo}: .gitattributes is absent — ` +
          "falling back to the configured default list",
    );
    base = builtIn;
    source = "default";
  }

  // Repo-config `add` is a statement about the repo, so the CLI's explicit
  // replacement outranks it; `--add-generated-paths` is the operator's own
  // word this run and always applies.
  const added = [
    ...(source === "cli" ? [] : repoAdd),
    ...cliAdd,
  ];
  const patterns = [...new Set([...base, ...added])];
  return { patterns, source, added: [...new Set(added)], rootAnchored, warnings };
}

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
    // `body_reason` is how the body render learns WHY this finding has no
    // thread. Without it `buildReviewBody` files an in-diff, file-and-line
    // finding under "Cross-cutting / out-of-diff findings" — which reads as
    // "outside this PR's scope", the exact downgrade the split promises never
    // happens (STARK-6096).
    findings.push({ ...f, body_reason: "generated_path", body: `${note}\n\n${bodyFor(raw)}` });
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

interface RunResult { status: number | null; stdout: string; stderr: string }

/** Async since STARK-6131 (see `runCapturing`); a synchronous fake still fits. */
type RunFn = (cmd: string, args: string[]) => RunResult | Promise<RunResult>;

/**
 * 64 MiB. Node's spawnSync default is 1 MiB, and `gh api /pulls/N/files
 * --paginate --slurp` carries every file's full PATCH — so the payload scales
 * with the size of the diff, not the number of findings. A 78-file branch
 * measured 1.27 MB and blew straight through it.
 *
 * The failure was worse than the limit: exceeding maxBuffer makes Node KILL the
 * child, which sets `status` to null, so the tool reported `failed (exit null):`
 * with nothing useful after the colon — a review-posting tool that fails
 * silently on exactly the large PRs whose findings matter most. Note that the
 * killed child does NOT necessarily leave `stderr` empty: it keeps whatever it
 * had already written, and `gh` writes there routinely (rate-limit notices,
 * warnings). `explainTermination` (child_termination_lib.ts, shared with
 * review_post_lib.ts's posting path) therefore names the cause whenever the
 * child was terminated, never gated on an empty stderr.
 */
export const GH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `defaultRun` with an explicit buffer cap. Exported so the termination paths
 * can be exercised against a SMALL cap: forcing a real ENOBUFS kill through
 * `GH_MAX_BUFFER` costs a 64 MiB write in the child and ~250 MB RSS in the
 * parent, on every `npm test`, for a mechanism that behaves identically at
 * 64 KiB.
 *
 * `timeoutMs` bounds the child (STARK-6113): without it a `gh api --paginate`
 * stalled on a hung connection blocks forever. The kill is SIGKILL, not SIGTERM
 * — a bound a child can ignore is not a bound, and `gh` on a read call has
 * nothing to clean up. A timeout leaves `status: null` + `error.code:
 * ETIMEDOUT`, which `explainTermination` names with the value.
 *
 * Async since STARK-6131: the kill has to reach the child's whole process
 * GROUP, or whatever `gh` spawned is orphaned rather than bounded, and
 * `spawnSync` can do neither half of that — its `killSignal` goes to one pid,
 * and it blocks the event loop the Ctrl-C forwarding handler needs. Both live
 * in `bounded_spawn_lib.ts`, shared with `review_post_lib.ts`.
 */
export async function runCapturing(
  cmd: string,
  args: string[],
  maxBuffer: number,
  timeoutMs: number,
): Promise<RunResult> {
  // Held to the env var's rule whichever door it arrives by: `setTimeout` fires
  // 0, NaN and anything past 2^31-1 ms after ~1 ms.
  assertGhTimeoutMs(timeoutMs, "runCapturing timeoutMs");
  let sp: BoundedSpawnResult;
  try {
    sp = await spawnBounded(cmd, args, { maxBuffer, timeoutMs });
  } catch (e) {
    // A spawn failure (`gh` not on PATH) stays a RESULT, as it was under
    // `spawnSync`: every caller reports `status`/`stderr`, none catches.
    sp = { stdout: "", stderr: "", status: null, signal: null, error: e as Error };
  }
  return {
    status: sp.status,
    stdout: sp.stdout,
    stderr: explainTermination(cmd, sp, sp.stderr, maxBuffer, timeoutMs),
  };
}

// The bound is resolved per call, not at import: an unusable
// `STARK_GH_TIMEOUT_MS` must fail the run that reads it, not every importer.
export const defaultRun: RunFn = (cmd, args) => runCapturing(cmd, args, GH_MAX_BUFFER, resolveGhTimeoutMs());

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
  // Independent reads, so they run together now that `run` is async (it was
  // `spawnSync` until STARK-6131, which forced them in series). The head sha's
  // failure is still reported first.
  const [head, files] = await Promise.all([
    run("gh", ["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]),
    // --paginate --slurp merges every page into one array; a PR over 30 changed
    // files would otherwise silently expose only the first page, and a finding
    // in an unlisted file loses its anchor for no visible reason.
    run("gh", ["api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--slurp"]),
  ]);
  if (head.status !== 0) {
    throw new Error(`gh api pulls/${pr} failed (exit ${head.status}): ${head.stderr.slice(0, 400)}`);
  }
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
                    REPLACE the resolved generated-output glob list
  --add-generated-paths GLOB[,GLOB...]
                    EXTEND the resolved list (repeatable)
  --no-generated-split
                    anchor generated-path findings inline like any other
  --dry-run         build the payload and print the plan without posting
  -h, --help        show this help message and exit

Environment:
  STARK_GH_TIMEOUT_MS
                    bound on each gh subprocess, in ms (default 120000). A hung
                    gh is killed and the error names the timeout. An unusable
                    value (0, negative, non-integer) is refused, never "unbounded".

A finding whose only anchor is a generated path is reported in the review BODY,
with the file and line it would have anchored to, instead of as an inline
thread: the fix belongs upstream, and an unresolved thread on a shared publish
branch blocks every session's merge. Nothing is dropped, downgraded, or
auto-resolved — only the gating thread is withheld. Globs are matched against
the whole repo-relative path, so \`index.json\` means the root file, not every
file with that name; write the doubled-star prefix to match at any depth.

The glob list is resolved per run, highest layer first: --generated-paths >
the \`generated_paths.repos["O/R"]\` config entry > the TARGET repo's own
.gitattributes \`linguist-generated=true\` rows (read at the PR head, so a PR
that ADDS a row is reviewed against it) > the built-in default. An absent or
unreadable .gitattributes falls back to the configured default and warns on
stderr; it never narrows the list to nothing. --no-generated-split disables the
split; \`generated_paths.enabled: false\` disables it too, but an explicit
--generated-paths outranks that global default like every other layer.

A declared slash-less pattern (\`index.json\`, \`*.pb.go\`) stays ROOT-anchored
here while git would match it at any depth. That divergence is deliberate, and
every pattern it applies to is listed in the JSON summary as
\`generatedPathSplit.rootAnchored\` — pass \`--add-generated-paths '**/<pat>'\`
when the repo really meant any depth.

The review is posted as event=COMMENT through the existing gh login.
The agent selects model attribution only; it never changes authentication.`;

export interface CliArgs {
  repo: string;
  pr: number;
  findingsPath: string;
  agent: AgentName;
  dryRun: boolean;
  /**
   * The list `--generated-paths` / `--no-generated-split` asked for, already
   * defaulted to {@link DEFAULT_GENERATED_PATHS} when neither was passed.
   * Read {@link CliArgs.generatedPathsExplicit} before treating it as the
   * operator's word — only an explicit flag outranks the repo's own
   * `.gitattributes`.
   */
  generatedPaths: string[];
  /** True when the operator passed `--generated-paths` or `--no-generated-split`. */
  generatedPathsExplicit: boolean;
  /** `--add-generated-paths`: globs layered ON TOP of whatever resolved. */
  addGeneratedPaths: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  let repo: string | undefined;
  let pr: number | undefined;
  let findingsPath: string | undefined;
  let agent: AgentName = "claude";
  let dryRun = false;
  let generatedPaths: string[] = [...DEFAULT_GENERATED_PATHS];
  let generatedPathsExplicit = false;
  const addGeneratedPaths: string[] = [];
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
        generatedPathsExplicit = true;
        break;
      }
      case "--add-generated-paths": {
        const raw = need();
        const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        // Same rule as --generated-paths: an empty value is a typo, not an
        // instruction. Here it would be a silent no-op rather than a silent
        // disable, but a flag that quietly does nothing is how a repo's extra
        // generated path ends up back on a gating thread.
        if (list.length === 0) {
          throw new Error("--add-generated-paths requires at least one glob");
        }
        addGeneratedPaths.push(...list);
        break;
      }
      case "--no-generated-split":
        generatedPaths = [];
        generatedPathsExplicit = true;
        break;
      case "--dry-run": dryRun = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!repo) throw new Error("--repo is required");
  if (pr === undefined) throw new Error("--pr is required");
  if (!findingsPath) throw new Error("--findings is required");
  return {
    repo, pr, findingsPath, agent, dryRun,
    generatedPaths, generatedPathsExplicit, addGeneratedPaths,
  };
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
 * Re-exported from `review_post_lib.ts`, where the cap now lives.
 *
 * STARK-5637 put a *refusal* here: a dry-run probe measured the body and this
 * tool exited 2 rather than post into a guaranteed 422. That stopped the data
 * loss but posted nothing, and it protected only this caller. STARK-6094 moved
 * both the constant and the handling into `postReview`, which now **degrades**
 * — the findings that fit stay in the review body, the rest are posted in full
 * as cross-linked follow-up comments on the same PR. Every caller inherits it,
 * and an oversize payload lands instead of needing a hand re-run.
 */
export { GITHUB_REVIEW_BODY_MAX };

/**
 * Re-exported from `review_post_lib.ts`, where the marker's run hash lives
 * beside the up-front skip it protects (STARK-6125) — same reason the body cap
 * above moved there: every caller of `postReview` inherits the failure.
 */
export { computeRunHash };

async function main(argv: string[]): Promise<number> {
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const payload = readPayload(args.findingsPath);
  const ctx = await fetchPrContext(args.repo, args.pr);
  // Only ask GitHub for `.gitattributes` when a lower layer could actually use
  // it: BOTH higher layers — an explicit flag and a repo-config `paths` entry —
  // already outrank it, so fetching under either is a round trip bought for
  // nothing.
  const cfg = getGeneratedPathsConfig();
  const repoPinned = Array.isArray(cfg.repos?.[args.repo]?.paths)
    && (cfg.repos[args.repo].paths as string[]).length > 0;
  let gitattributes: string | null = null;
  let gitattributesFailure: string | null = null;
  if (!args.generatedPathsExplicit && cfg.enabled && !repoPinned) {
    // Pin the read to the PR head so a PR that ADDS a `linguist-generated` row
    // is reviewed against the declaration it ships. A fork PR's head sha is not
    // in the base repo, so fall back to the default branch rather than
    // degrading a fork review to the built-in default list.
    let r = await fetchGitattributesResult(args.repo, defaultRun, ctx.headSha);
    if (r.text === null) r = await fetchGitattributesResult(args.repo);
    gitattributes = r.text;
    gitattributesFailure = r.failure;
  }
  const resolved = resolveGeneratedPaths({
    repo: args.repo,
    cliPaths: args.generatedPathsExplicit ? args.generatedPaths : null,
    cliAdd: args.addGeneratedPaths,
    gitattributes,
    gitattributesFailure,
    config: cfg,
  });
  for (const w of resolved.warnings) console.error(`findings_review_post: ${w}`);
  const plan = planReview(payload, ctx, {
    agent: args.agent,
    generatedPaths: resolved.patterns,
  });

  const postOpts = {
    repo: args.repo,
    pr: args.pr,
    round: 1,
    agent: args.agent,
    runHash: computeRunHash(plan.findings, plan.humanSummary, ctx.headSha),
    findings: plan.findings,
    changedFiles: plan.inlineEligibleFiles,
    // "low" so severity never filters a finding out of the review — the
    // no-drop rule is the whole point of this path.
    fixThreshold: "low" as const,
    humanSummary: plan.humanSummary,
    prHeadSha: ctx.headSha,
  };

  // No size refusal here any more: `postReview` owns the cap and degrades over
  // it (overflow comments), so an oversize payload posts rather than exiting 2.
  const result: PostReviewResult = await postReview({ ...postOpts, dryRun: args.dryRun });
  if (result.alreadyPosted) {
    console.error(
      `findings_review_post: this exact review is already on ${args.repo}#${args.pr}` +
        `${result.reviewId !== undefined ? ` (review ${result.reviewId})` : ""} — nothing posted.`,
    );
  }
  console.log(JSON.stringify({
    findings: plan.findings.length,
    generatedPathSplit: {
      enabled: plan.generated.enabled,
      source: resolved.source,
      added: resolved.added,
      rootAnchored: resolved.rootAnchored,
      warnings: resolved.warnings,
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
