import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assetRootForHome } from "./asset_root_lib.ts";

export type AgentName = "claude" | "codex" | "gemini";
/** @deprecated alias for AgentName; kept for backwards compatibility */
export type Agent = AgentName;

export type Severity = "critical" | "high" | "medium" | "low";

export type Classification = "fix" | "false_positive" | "noise" | "ignored";

export type Finding = {
  id: string;
  domain: string;
  agent: AgentName;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  body: string;
  classification?: Classification;
  classification_reason?: string;
  extra?: Record<string, unknown>;
};

export interface RuntimeConfig {
  lock_ttl_minutes: number;
  subagent_env_allowlist: string[];
  max_concurrent_agents: number;
  /** Optional per-agent concurrency caps, applied IN ADDITION to
   * `max_concurrent_agents`. Absent / non-number means "no per-agent cap"
   * (the global cap is the only limit). Explicit 0 or negative means "block"
   * — the dispatcher fails affected assignments with `dispatch_blocked`
   * instead of spinning. Set this for agents whose backend imposes
   * account-level concurrent-stream throttling — e.g. codex on a ChatGPT-tier
   * account, where 3 concurrent xhigh-reasoning streams against the same
   * account get killed mid-stream. Defaulting codex to 1 here makes
   * multi-domain reviews serialize codex while leaving claude/gemini parallel. */
  max_concurrent_per_agent?: Partial<Record<AgentName, number>>;
  temp_dir_prefix: string;
  large_pr_file_threshold: number;
  large_pr_line_threshold: number;
  large_pr_timeout_s: number;
  /** Env allowlist for the trusted test_command runner (Phase 9 task 5). Distinct
   * from subagent_env_allowlist: test runners legitimately need broader
   * toolchain env (NODE_*, GOPATH, etc.) than reviewer agents do. Tokens
   * (GH_TOKEN, GITHUB_TOKEN, STARK_PUSH_TOKEN) are stripped regardless of
   * what this allowlist contains. */
  test_env_allowlist?: string[];
}

export const DEFAULT_TEST_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TMPDIR",
  "USER",
  "LOGNAME",
]);

/**
 * Resolved view of merged global/org/repo config consumed by the TS pipeline.
 * Only the fields actually read elsewhere are typed; the underlying merge keeps
 * unknown keys (extension config) intact via index access on the unresolved
 * structure if callers need them.
 */
export interface ResolvedConfig {
  quick_domains: string[];
  default_agent: AgentName;
  domain_agents: Record<string, AgentName>;
  severity_overrides: Record<string, Severity>;
  fix_threshold: Severity;
  runtime: RuntimeConfig;
  test_command: string | null;
  /** When true, the fix loop is allowed to run even with no test_command — the
   * test step is skipped and commits are pushed unconditionally. Off by default
   * (undefined treated as false) so the safety net stays on; opt in per
   * repo/org/global when you want autofixes to ship without a verification
   * gate. */
  allow_no_test_command?: boolean;
  untrusted_fix_loop: boolean;
  history_retention_days: number;
  lock_ttl_minutes: number;
  /** Optional global/org/repo override for the fix-loop round cap. CLI
   * `--max-rounds` still wins; absent → fall back to the CLI default (3).
   * Validated against MAX_ROUNDS_CEILING at consumption time. */
  max_rounds?: number;
}

/**
 * Canonical finding-output contract prepended to every domain prompt at render
 * time. Reviewer agents are instructed to emit JSONL (one Finding per line).
 *
 * Field nullability is the contract: `file` and `line` MAY be null when a
 * finding is repository-wide; `classification` / `classification_reason` are
 * filled by the classifier stage and SHOULD be omitted at first emission;
 * `extra` is an open object for domain-specific metadata.
 */
export const FINDING_SCHEMA_PROMPT = `## Reviewer Output Contract (CANONICAL)

Emit findings as JSONL — one JSON object per line. Output ONLY the JSONL stream: no prose, no markdown fences, no surrounding array, no preamble, no trailing commentary.

**You MUST emit at least one JSON line.** Output is parsed as JSONL; an empty stdout, or stdout containing only prose, is treated as a parser failure and your review is discarded.

### When you have no findings

Emit EXACTLY ONE line — the no-findings sentinel — and nothing else:

{"no_findings":true,"domain":"<domain-slug>","agent":"<your-agent-name>"}

Use this whenever you reviewed the diff and have nothing to report. Do not write "LGTM", "no issues found", or any prose explanation — the sentinel IS the explanation. Do not omit this line; silence is not a valid no-findings signal.

### When you have findings

Emit one JSON object per finding. Each line MUST be a JSON object with these fields:

- \`id\` (string, required) — stable identifier for this finding within the run (e.g. a short slug or hash)
- \`domain\` (string, required) — the review domain slug (e.g. \`architecture\`, \`security\`)
- \`agent\` (string, required) — one of \`claude\`, \`codex\`, \`gemini\`
- \`severity\` (string, required) — one of \`critical\`, \`high\`, \`medium\`, \`low\`
- \`file\` (string | null, required) — repo-relative path, or \`null\` for repo-wide findings
- \`line\` (number | null, required) — 1-based line number, or \`null\` when not applicable
- \`title\` (string, required) — short, single-line summary
- \`body\` (string, required) — full explanation including evidence and recommended fix
- \`classification\` (string, optional) — one of \`fix\`, \`false_positive\`, \`noise\`, \`ignored\`. Omit at initial emission; the classifier stage fills it.
- \`classification_reason\` (string, optional) — one-sentence justification, paired with \`classification\`.
- \`extra\` (object, optional) — open-ended metadata for domain-specific fields.

Example finding line:

{"id":"sec-001","domain":"security","agent":"codex","severity":"high","file":"src/api/handler.ts","line":42,"title":"Unvalidated input forwarded to query builder","body":"The handler reads req.query.id and passes it directly to db.raw(...). Validate or parameterize.","extra":{}}

Do NOT emit a JSON array. Do NOT wrap output in code fences. Do NOT include any preamble or trailing commentary. If you found nothing, emit the no-findings sentinel — never both findings AND the sentinel in the same run.
`;

const LEGACY_OUTPUT_PATTERNS: RegExp[] = [
  /\n##\s+Output\b[\s\S]*$/,
  /\nOutput a JSON array only:[\s\S]*$/,
  /\nOutput:\s*\n```json[\s\S]*$/,
  /\nIMPORTANT:\s*Output ONLY a raw JSON array[\s\S]*$/,
];

/**
 * Strip the trailing legacy output-contract section ("description"/"suggestion"
 * JSON-array shape) from a raw domain prompt. Returns the body without that
 * section. Idempotent: a prompt with no legacy section is returned unchanged.
 */
export function stripLegacyOutputSection(raw: string): string {
  let stripped = raw;
  for (const pat of LEGACY_OUTPUT_PATTERNS) {
    stripped = stripped.replace(pat, "");
  }
  return stripped.replace(/\s+$/u, "") + "\n";
}

/**
 * Render a per-domain prompt for the new TS pipeline.
 *
 * Reads the legacy NN-*.md source, strips its trailing JSON-array output
 * section, and appends FINDING_SCHEMA_PROMPT. Existing per-domain prompt files
 * remain unmodified on disk (the Python pipeline still parses them); the
 * normalization happens at render time only.
 */
export function renderDomainPrompt(rawPrompt: string): string {
  const body = stripLegacyOutputSection(rawPrompt);
  return body + "\n" + FINDING_SCHEMA_PROMPT;
}

/**
 * Convenience helper: load and render a domain prompt from disk.
 */
export function renderDomainPromptFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8");
  return renderDomainPrompt(raw);
}

/**
 * Discover every per-agent NN-*.md domain prompt under <repoRoot>/global/prompts.
 * Returns absolute paths for parametrized testing.
 */
export function listDomainPromptFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const agents: AgentName[] = ["claude", "codex", "gemini"];
  for (const agent of agents) {
    const dir = path.join(repoRoot, "global", "prompts", agent);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/^\d{2}-.+\.md$/.test(entry)) {
        out.push(path.join(dir, entry));
      }
    }
  }
  return out.sort();
}

const LEGACY_MARKERS: RegExp[] = [
  /"description"\s*:/,
  /"suggestion"\s*:/,
  /\bdescription\b.*\bsuggestion\b/i,
  /\[\{"severity"/,
];

/**
 * Returns the list of legacy markers still present in the rendered prompt.
 * Empty list = clean.
 */
export function findLegacyMarkers(rendered: string): string[] {
  const hits: string[] = [];
  for (const m of LEGACY_MARKERS) {
    if (m.test(rendered)) hits.push(m.source);
  }
  return hits;
}

// ─── Review-marker helper ───────────────────────────────────────────────────

/**
 * Build the HTML-comment marker that prefixes every posted review body. The
 * dispatcher uses this same string for both the POST payload and the GET-marker
 * idempotency check, so the format must be a single source of truth.
 */
export function buildMarker(round: number, agent: AgentName, runHash: string): string {
  return `<!-- stark-review:round=${round}:agent=${agent}:run=${runHash} -->`;
}

// ─── Severity & finding-id helpers ──────────────────────────────────────────

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
});

export function severityMeetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** Compare two findings so the higher-severity one sorts first. Ties break by
 * (domain, file, line) for stable, predictable rendering. */
export function compareSeverityDesc<
  T extends { severity: Severity; domain?: string; file?: string | null; line?: number | null },
>(a: T, b: T): number {
  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  const da = a.domain ?? "";
  const db = b.domain ?? "";
  if (da !== db) return da < db ? -1 : 1;
  const fa = a.file ?? "";
  const fb = b.file ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  const la = a.line ?? 0;
  const lb = b.line ?? 0;
  return la - lb;
}

/**
 * Stable 12-hex-char id derived from sha256(domain|agent|normalized-title).
 * Title normalization: lowercase, strip ASCII punctuation, collapse whitespace.
 */
export function findingId(domain: string, agent: AgentName, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[!-/:-@\[-`{-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`${domain}|${agent}|${normalized}`)
    .digest("hex")
    .slice(0, 12);
}

// ─── Domain & agent resolution ──────────────────────────────────────────────

const DOMAIN_FILE_RE = /^\d{2}-(.+)\.md$/;

export type DomainSelectMode = "explicit" | "quick" | "default";

export function selectDomains(opts: {
  mode: DomainSelectMode;
  explicitDomains?: string[];
  config: ResolvedConfig;
  promptRoot: string;
  /**
   * Required for `mode: 'default'`. Maps each candidate domain to the agent
   * that will run it (per the dispatcher's --agent > domain_agents > default
   * precedence). Default mode only includes a domain if its prompt exists in
   * the resolved agent's prompt directory — a domain present only under an
   * unrelated agent dir is skipped.
   */
  agentResolver?: (domain: string) => AgentName;
}): string[] {
  if (opts.mode === "explicit") {
    return [...(opts.explicitDomains ?? [])];
  }
  if (opts.mode === "quick") {
    const qd = opts.config.quick_domains ?? [];
    if (qd.length === 0) {
      throw new Error(
        "selectDomains: --quick requested but config.quick_domains is empty",
      );
    }
    return [...qd];
  }
  // default: scan promptRoot/<agent>/NN-*.md, but only keep a domain whose
  // prompt is present in the resolved agent's directory.
  if (!opts.agentResolver) {
    throw new Error(
      "selectDomains: agentResolver is required for mode='default'",
    );
  }
  const candidates = new Set<string>();
  const agents: AgentName[] = ["claude", "codex", "gemini"];
  for (const agent of agents) {
    const dir = path.join(opts.promptRoot, agent);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = entry.match(DOMAIN_FILE_RE);
      if (m) candidates.add(m[1]);
    }
  }
  const out: string[] = [];
  for (const domain of [...candidates].sort()) {
    const resolved = opts.agentResolver(domain);
    const agentDir = path.join(opts.promptRoot, resolved);
    if (findDomainFileNameInDir(agentDir, domain)) {
      out.push(domain);
    }
  }
  return out;
}

export function resolveAgentsForDomains(opts: {
  domains: string[];
  forcedAgent?: AgentName | null;
  config: ResolvedConfig;
}): Record<string, AgentName> {
  const out: Record<string, AgentName> = {};
  const fallback = opts.config.default_agent ?? ("codex" as AgentName);
  for (const d of opts.domains) {
    out[d] =
      opts.forcedAgent ??
      opts.config.domain_agents?.[d] ??
      fallback ??
      "codex";
  }
  return out;
}

// ─── Git ref resolution ─────────────────────────────────────────────────────

const QUALIFIED_REF_PREFIXES = ["refs/", "origin/", "remotes/"] as const;
const GIT_REV_KEYWORDS = new Set(["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]);
const REV_EXPRESSION_MARKERS = ["~", "^", "@{"] as const;

/**
 * Resolve a user/base-branch ref to the remote-tracking ref when one exists.
 *
 * The review worktree is detached at the PR head and may share a common git
 * dir with an operator checkout whose local `main` is stale. Using bare
 * `main` for trusted `git show main:.code-review/config.json` or prompt
 * overrides can silently read outdated config. `review_setup_worktree.ts`
 * force-fetches the PR base into `refs/remotes/origin/<base>`, so prefer that
 * ref for plain branch names while leaving commit-ish expressions untouched.
 */
export function resolveBaseRef(base: string, cwd?: string): string {
  if (!base) return base;
  if (QUALIFIED_REF_PREFIXES.some((prefix) => base.startsWith(prefix))) return base;
  if (GIT_REV_KEYWORDS.has(base)) return base;
  if (REV_EXPRESSION_MARKERS.some((marker) => base.includes(marker))) return base;

  const candidate = `origin/${base}`;
  try {
    const out = execFileSync("git", ["-C", cwd ?? process.cwd(), "rev-parse", "--verify", "--quiet", candidate], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (out) return candidate;
  } catch {
    // Fall through: callers may have passed a SHA, tag, deleted branch, or a
    // repo without remotes. Let the later git command handle the original ref.
  }
  return base;
}

/**
 * Resolve the filesystem root for global prompt files.
 *
 * `configRoot` is the caller's explicit trusted config walk root. Honor prompt
 * files there first, then fall back to the installed code-review prompt tree so
 * a normal target repo without top-level `prompts/` still reviews domains.
 */
export function resolvePromptRoot(opts: { configRoot: string; home: string }): string {
  const direct = path.join(opts.configRoot, "prompts");
  if (fs.existsSync(direct)) return direct;

  const sourceLayout = path.join(opts.configRoot, "global", "prompts");
  if (fs.existsSync(sourceLayout)) return sourceLayout;

  const installed = path.join(assetRootForHome(opts.home), "prompts");
  if (fs.existsSync(installed)) return installed;

  return installed;
}

// ─── Trusted config loading ─────────────────────────────────────────────────

function readJsonIfExists(p: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Run `git -C <cwd> <args...>` capturing stdout. Returns null on non-zero exit.
 */
function gitCapture(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Load and merge global, org-walked, and repo-override configs.
 *
 * - Global: `<home>/.claude/code-review/config.json`
 * - Org walk: every `<dir>/.code-review/config.json` from configRoot upward to home
 * - Repo override: read via `git show <baseRef>:.code-review/config.json` from the
 *   resolved repoRoot — NEVER from the worktree filesystem.
 *
 * `worktree` is used only for the realpath guard: configRoot must not resolve
 * inside the worktree.
 */
export function loadTrustedConfig(opts: {
  home: string;
  configRoot: string;
  baseRef: string;
  worktree: string;
}): ResolvedConfig {
  const realConfigRoot = fs.realpathSync(opts.configRoot);
  const realWorktree = fs.realpathSync(opts.worktree);
  if (
    realConfigRoot === realWorktree ||
    realConfigRoot.startsWith(realWorktree + path.sep)
  ) {
    throw new Error(
      `loadTrustedConfig: configRoot (${realConfigRoot}) resolves inside worktree (${realWorktree}); refusing to read trusted config from a PR-controlled tree`,
    );
  }

  const repoTopRaw = gitCapture(realConfigRoot, ["rev-parse", "--show-toplevel"]);
  const repoRootRaw = repoTopRaw ? repoTopRaw.trim() : realConfigRoot;
  const repoRoot = fs.existsSync(repoRootRaw)
    ? fs.realpathSync(repoRootRaw)
    : repoRootRaw;

  // Global (bundle-relative when running as an installed plugin).
  const globalCfg = readJsonIfExists(
    path.join(assetRootForHome(opts.home), "config.json"),
  );

  // Org walk: configRoot -> home (innermost wins among org overrides).
  // Constraints:
  //  - Skip configRoot itself (its on-disk .code-review/config.json is the repo
  //    override and is read via git show below — never from disk).
  //  - Skip repoRoot for the same reason: when configRoot is a subdirectory of
  //    the repo, the walk reaches repoRoot and would otherwise read the
  //    PR-controlled bytes.
  //  - Stop at $HOME, and refuse to walk past it: if configRoot is not under
  //    home, perform no org walk at all (org-level overrides are only valid
  //    inside the home subtree).
  const realHome = fs.existsSync(opts.home) ? fs.realpathSync(opts.home) : opts.home;
  const inHomeSubtree = (p: string): boolean =>
    p === realHome || p.startsWith(realHome + path.sep);
  const orgChain: Record<string, unknown>[] = [];
  if (inHomeSubtree(realConfigRoot)) {
    let cursor = realConfigRoot;
    for (let i = 0; i < 64; i++) {
      const candidate = path.join(cursor, ".code-review", "config.json");
      if (
        fs.existsSync(candidate) &&
        cursor !== realConfigRoot &&
        cursor !== repoRoot
      ) {
        orgChain.unshift(readJsonIfExists(candidate));
      }
      if (cursor === realHome) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      if (!inHomeSubtree(parent)) break;
      cursor = parent;
    }
  }

  // Repo override via git show (trusted base branch)
  let repoCfg: Record<string, unknown> = {};
  const repoRaw = gitCapture(repoRoot, [
    "show",
    `${opts.baseRef}:.code-review/config.json`,
  ]);
  if (repoRaw !== null) {
    try {
      repoCfg = JSON.parse(repoRaw);
    } catch {
      repoCfg = {};
    }
  }

  let merged: Record<string, unknown> = globalCfg;
  for (const layer of orgChain) merged = deepMerge(merged, layer);
  merged = deepMerge(merged, repoCfg);

  return merged as unknown as ResolvedConfig;
}

// ─── Phase 9: fix-loop authorization gate ───────────────────────────────────

export type FixLoopDenyReason =
  | "no_fix_loop"
  | "no_test_command"
  | "fork_no_mcm"
  | "auth_denied";

export interface FixLoopGateInput {
  testCommand: string | null | undefined;
  prHeadIsFork: boolean;
  maintainerCanModify: boolean;
  cliAllowUntrustedFixLoop: boolean;
  configUntrustedFixLoop: boolean;
  noFixLoop: boolean;
  /** When true, missing/empty testCommand does not deny the loop — the caller
   * is expected to skip the test step and push commits without verification. */
  allowNoTestCommand?: boolean;
}

export interface FixLoopGateResult {
  allow: boolean;
  reason: string;
  /** When true, this is a hard auth failure that must surface as a non-zero
   * exit and an `error.code` on the receipt. When false, the caller skips the
   * fix loop quietly (soft skip) — the PR review still posts. */
  terminal: boolean;
}

/**
 * Pure decision function: should we enter the fix loop for this PR?
 *
 * Rule precedence (first match wins):
 *  a) noFixLoop=true                                   → soft skip (no_fix_loop)
 *  b) testCommand empty AND allowNoTestCommand=false   → soft skip (no_test_command)
 *  b') testCommand empty AND allowNoTestCommand=true   → allow (no_test_command_skipped) — caller MUST skip the test step
 *  c) same-repo PR                                     → allow
 *  d) fork PR + maintainer_can_modify                  → allow
 *  e) fork PR, no MCM, no CLI opt-in                   → soft skip (fork_no_mcm)
 *  f) fork PR, CLI opt-in but config disabled          → terminal auth_denied
 *  g) fork PR, both opt-ins                            → allow
 *
 * test_command MUST be sourced from trusted config — never from CLAUDE.md or
 * package.json or any PR-controlled file. allowNoTestCommand is also trusted
 * config; setting it true ships unverified autofixes by design.
 */
export function evaluateFixLoopGate(input: FixLoopGateInput): FixLoopGateResult {
  if (input.noFixLoop) {
    return { allow: false, terminal: false, reason: "no_fix_loop" };
  }
  const tc = input.testCommand;
  const tcEmpty = tc === null || tc === undefined || tc === "" || (typeof tc === "string" && tc.trim() === "");
  if (tcEmpty && !input.allowNoTestCommand) {
    return { allow: false, terminal: false, reason: "no_test_command" };
  }
  if (!input.prHeadIsFork) {
    return { allow: true, terminal: false, reason: "same_repo" };
  }
  if (input.maintainerCanModify) {
    return { allow: true, terminal: false, reason: "fork_with_mcm" };
  }
  if (!input.cliAllowUntrustedFixLoop) {
    return { allow: false, terminal: false, reason: "fork_no_mcm" };
  }
  if (!input.configUntrustedFixLoop) {
    return { allow: false, terminal: true, reason: "auth_denied" };
  }
  return { allow: true, terminal: false, reason: "fork_untrusted_authorized" };
}

// ─── Phase 9: stage path validation ─────────────────────────────────────────

export class PathRejectedError extends Error {
  code = "path_rejected" as const;
  badPath: string;
  constructor(badPath: string, msg: string) {
    super(msg);
    this.badPath = badPath;
  }
}

/**
 * Validate that every path is a worktree-relative path that — once realpath'd
 * with all ancestor directories — stays inside the worktree. Returns the
 * cleaned (forward-slash, normalized-relative) list. Throws PathRejectedError
 * on first violation; the caller MUST treat any rejection as a terminal abort
 * for the round (no commit, no push).
 *
 * Checks:
 *  - reject absolute paths
 *  - reject any '..' segment
 *  - realpathSync the worktree
 *  - for each path, walk every ancestor directory under the worktree and
 *    realpath each one; reject if any ancestor's realpath escapes the worktree
 *  - realpath the leaf when it exists; reject if it escapes the worktree
 *
 * The ancestor walk catches the symlink-as-intermediate-dir attack: a path
 * like `subdir/file.ts` where `subdir` is a symlink pointing to `/etc`.
 */
export function validateStagePaths(worktree: string, paths: string[]): string[] {
  const realWorktree = fs.realpathSync(worktree);
  const cleaned: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new PathRejectedError(String(raw), `empty path`);
    }
    if (path.isAbsolute(raw)) {
      throw new PathRejectedError(raw, `absolute path rejected: ${raw}`);
    }
    const parts = raw.split(/[\\/]/u).filter((s) => s.length > 0);
    if (parts.some((s) => s === "..")) {
      throw new PathRejectedError(raw, `traversal segment rejected: ${raw}`);
    }
    if (parts.some((s) => s === ".")) {
      // Disallow '.' segments to keep the contract simple; real paths from the
      // fixer should never need them.
      throw new PathRejectedError(raw, `dot segment rejected: ${raw}`);
    }
    // Walk ancestors AND leaf, realpathing each existing entry.
    let cursorAbs = realWorktree;
    for (let i = 0; i < parts.length; i++) {
      cursorAbs = path.join(cursorAbs, parts[i]);
      if (fs.existsSync(cursorAbs) || fs.lstatSync(cursorAbs, { throwIfNoEntry: false })) {
        try {
          const real = fs.realpathSync(cursorAbs);
          if (real !== realWorktree && !real.startsWith(realWorktree + path.sep)) {
            throw new PathRejectedError(raw, `path escapes worktree via ${cursorAbs}: realpath=${real}`);
          }
        } catch (err) {
          if (err instanceof PathRejectedError) throw err;
          // Non-existent intermediate: fall through; resolved-relative check
          // below catches naive escapes that don't yet exist.
        }
      }
    }
    const resolved = path.resolve(realWorktree, raw);
    if (resolved !== realWorktree && !resolved.startsWith(realWorktree + path.sep)) {
      throw new PathRejectedError(raw, `resolved path escapes worktree: ${resolved}`);
    }
    cleaned.push(parts.join("/"));
  }
  return cleaned;
}

// ─── Prompt resolution & review-prompt rendering ────────────────────────────

export interface PromptSources {
  agentMd: string;
  domainPrompt: string;
}

export interface PromptRoots {
  /** Filesystem path to global per-agent prompts (e.g. ~/.claude/code-review/prompts). */
  global: string;
  /** Filesystem path to shared cross-agent prompts dir (e.g. <repo>/global/prompts/domains). */
  shared: string;
}

function findDomainFileNameInDir(dir: string, domain: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const m = entry.match(DOMAIN_FILE_RE);
    if (m && m[1] === domain) return entry;
  }
  return null;
}

function listFilesInGitTree(repoRoot: string, baseRef: string, dir: string): string[] {
  const out = gitCapture(repoRoot, ["ls-tree", "--name-only", `${baseRef}:${dir}`]);
  if (out === null) return [];
  return out.split("\n").filter(Boolean);
}

/**
 * Load raw prompt strings from the trusted layers (repo > global > shared).
 *
 * The repo layer is always read via `git show <baseRef>:<path>` — never from the
 * worktree filesystem. Returned `domainPrompt` has the legacy NN-*.md output
 * section stripped but does NOT yet include FINDING_SCHEMA_PROMPT — that is
 * appended exactly once by `renderReviewPrompt`.
 */
export function resolvePromptSources(opts: {
  agent: AgentName;
  domain: string;
  promptRoots: PromptRoots;
  baseRef: string;
  repoRoot: string;
}): PromptSources {
  const { agent, domain, promptRoots, baseRef, repoRoot } = opts;

  // ── Repo override (via git show) ───────────────────────────────────────────
  const repoDir = `.code-review/prompts/${agent}`;
  const repoEntries = listFilesInGitTree(repoRoot, baseRef, repoDir);
  let repoDomainFile: string | null = null;
  for (const entry of repoEntries) {
    const m = entry.match(DOMAIN_FILE_RE);
    if (m && m[1] === domain) {
      repoDomainFile = entry;
      break;
    }
  }

  let domainRaw: string | null = null;
  if (repoDomainFile) {
    domainRaw = gitCapture(repoRoot, [
      "show",
      `${baseRef}:${repoDir}/${repoDomainFile}`,
    ]);
  }

  let agentMd: string | null = gitCapture(repoRoot, [
    "show",
    `${baseRef}:${repoDir}/agent.md`,
  ]);

  // ── Global (filesystem) ────────────────────────────────────────────────────
  const globalAgentDir = path.join(promptRoots.global, agent);
  if (domainRaw === null) {
    const fname = findDomainFileNameInDir(globalAgentDir, domain);
    if (fname) {
      domainRaw = fs.readFileSync(path.join(globalAgentDir, fname), "utf8");
    }
  }
  if (agentMd === null) {
    const ap = path.join(globalAgentDir, "agent.md");
    if (fs.existsSync(ap)) agentMd = fs.readFileSync(ap, "utf8");
  }

  // ── Shared fallback ────────────────────────────────────────────────────────
  if (domainRaw === null) {
    const shared = promptRoots.shared;
    if (fs.existsSync(shared)) {
      const fname = findDomainFileNameInDir(shared, domain);
      if (fname) {
        domainRaw = fs.readFileSync(path.join(shared, fname), "utf8");
      } else {
        // permit unprefixed <domain>.md fallback
        const flat = path.join(shared, `${domain}.md`);
        if (fs.existsSync(flat)) domainRaw = fs.readFileSync(flat, "utf8");
      }
    }
  }

  if (domainRaw === null) {
    throw new Error(
      `resolvePromptSources: domain prompt not found for agent=${agent} domain=${domain} (checked repo override, global, and shared)`,
    );
  }

  return {
    agentMd: agentMd ?? "",
    domainPrompt: stripLegacyOutputSection(domainRaw).trimEnd(),
  };
}

/**
 * Fallback used when no `classifier.md` is found in repo override or global
 * prompts. Keeps the loop functional but lacks bucket definitions, so the
 * model will skew toward `fix`. Surface this via the returned `source` so
 * the caller can log a warning.
 */
export const FALLBACK_CLASSIFIER_PROMPT =
  "Classify each finding as fix|false_positive|noise|ignored.";

export interface ClassifierPromptResult {
  prompt: string;
  source: "repo" | "global" | "fallback";
}

/**
 * Resolve the classifier prompt for a single agent.
 *
 * Lookup order (first match wins):
 *  1. Repo override via `git show <baseRef>:.code-review/prompts/<agent>/classifier.md`
 *  2. Global on disk: `<promptRoot>/<agent>/classifier.md`
 *  3. Hardcoded `FALLBACK_CLASSIFIER_PROMPT` (signaled via `source: "fallback"`).
 *
 * The repo override path is read via `git show` against the trusted base ref —
 * never from the worktree filesystem — so a PR cannot inject its own classifier
 * prompt by adding a file under `.code-review/prompts/`.
 */
export function resolveClassifierPrompt(opts: {
  agent: AgentName;
  promptRoot: string;
  baseRef: string;
  repoRoot: string;
}): ClassifierPromptResult {
  const { agent, promptRoot, baseRef, repoRoot } = opts;

  const repoPath = `.code-review/prompts/${agent}/classifier.md`;
  const repoRaw = gitCapture(repoRoot, ["show", `${baseRef}:${repoPath}`]);
  if (repoRaw !== null && repoRaw.trim().length > 0) {
    return { prompt: repoRaw.trimEnd(), source: "repo" };
  }

  const globalPath = path.join(promptRoot, agent, "classifier.md");
  if (fs.existsSync(globalPath)) {
    const body = fs.readFileSync(globalPath, "utf8");
    if (body.trim().length > 0) {
      return { prompt: body.trimEnd(), source: "global" };
    }
  }

  return { prompt: FALLBACK_CLASSIFIER_PROMPT, source: "fallback" };
}

/**
 * Pure prompt assembler. Assembles agent.md + domain prompt + FINDING_SCHEMA_PROMPT
 * + PR title/body/diff into the final reviewer prompt. No I/O.
 */
export function renderReviewPrompt(opts: {
  agent: AgentName;
  domain: string;
  promptSources: PromptSources;
  prTitle: string;
  prBody: string;
  prDiff: string;
}): string {
  const { agentMd, domainPrompt } = opts.promptSources;
  return [
    agentMd,
    "",
    domainPrompt,
    "",
    FINDING_SCHEMA_PROMPT,
    "",
    `PR Title: ${opts.prTitle}`,
    "PR Body:",
    opts.prBody,
    "PR Diff:",
    opts.prDiff,
  ].join("\n");
}
