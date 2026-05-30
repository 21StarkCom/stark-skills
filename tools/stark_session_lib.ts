/**
 * Collectors for the /stark-session SKILL. Each collector takes injected
 * subprocess + filesystem deps, returns its slot or null on failure, and
 * pushes a structured `{source, message}` entry to the shared `errors`
 * accumulator when something goes wrong.
 *
 * The top-level `collectStart` / `collectEnd` orchestrate every collector
 * in parallel with a single wall-clock deadline, then assemble the final
 * JSON shape that `tools/stark_session.ts` prints to stdout for the
 * SKILL.md to render via Claude.
 *
 * See docs/specs/stark-session-ts-2026-05-18.md for the contract.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Public types ─────────────────────────────────────────────────────

export type ErrSlot = { source: string; message: string };

export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
};

export type Deps = {
  home: string;
  scriptsDir: string;
  toolsDir: string;
  now: () => Date;
  run(
    cmd: string[],
    opts?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<RunResult>;
  readFile(p: string): Promise<string | null>;
  fileExists(p: string): Promise<boolean>;
};

export type HealerCategory = { name: string; count: number };

const HEALER_TOP_N = 5;

function healerLogPath(home: string): string {
  return `${home}/.claude/code-review/healer.jsonl`;
}

// ── Constants ────────────────────────────────────────────────────────

const SUBPROCESS_TIMEOUT_MS = 15_000;
const SKILL_SUGGESTIONS_CAP = 2;
const START_WALLTIME_MS_DEFAULT = 45_000;

// Token/secret patterns — anything we hand to errors[] (or any stderr we surface
// to the SKILL for rendering) must not leak credentials.
const REDACT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9_]{10,}/g, "ghp_[REDACTED]"],
  [/ghs_[A-Za-z0-9_]{10,}/g, "ghs_[REDACTED]"],
  [/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_[REDACTED]"],
  [/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]"],
  [/\bBearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/\btoken\s+\S+/gi, "token [REDACTED]"],
  [/Authorization:\s*\S+/gi, "Authorization: [REDACTED]"],
];

function redact(text: string): string {
  let out = text;
  for (const [pat, repl] of REDACT_PATTERNS) out = out.replace(pat, repl);
  return out;
}

// ── Real Deps factory ────────────────────────────────────────────────

/**
 * Build a Deps backed by real subprocess + filesystem. The defaults
 * resolve `scriptsDir` to `$HOME/.claude/code-review/scripts` and
 * `toolsDir` to `$HOME/.claude/code-review/tools`, matching how
 * install.sh symlinks the repo. Tests inject their own Deps via
 * `makeDeps` — this factory is for the production CLI only.
 */
export function realDeps(overrides: Partial<Deps> = {}): Deps {
  const home = overrides.home ?? os.homedir();
  const baseDir = path.join(home, ".claude", "code-review");
  return {
    home,
    scriptsDir: overrides.scriptsDir ?? path.join(baseDir, "scripts"),
    toolsDir: overrides.toolsDir ?? path.join(baseDir, "tools"),
    now: overrides.now ?? (() => new Date()),
    run: overrides.run ?? runReal,
    readFile: overrides.readFile ?? readFileReal,
    fileExists: overrides.fileExists ?? fileExistsReal,
  };
}

async function runReal(
  cmd: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? SUBPROCESS_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || String(e), code: 127, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0, timedOut });
    });
  });
}

async function readFileReal(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function fileExistsReal(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Subprocess error helper ──────────────────────────────────────────

function pushSubprocessError(
  errors: ErrSlot[],
  source: string,
  result: RunResult,
): void {
  const detail = result.timedOut
    ? "timeout"
    : `exit ${result.code}${result.stderr ? ": " + redact(result.stderr.trim()).slice(0, 200) : ""}`;
  errors.push({ source, message: detail });
}

function pushParseError(
  errors: ErrSlot[],
  source: string,
  exc: unknown,
): void {
  const raw = exc instanceof Error ? exc.message : String(exc);
  errors.push({ source, message: `parse: ${redact(raw)}` });
}

// ── collectCanaryStatus ──────────────────────────────────────────────

export type CanaryStatus = {
  circuits_open: string[];
  near_promotion: string[];
};

export async function collectCanaryStatus(
  deps: Deps,
  errors: ErrSlot[],
): Promise<CanaryStatus | null> {
  // healer_canary went pure-TS in the 2026-05-18 cutover (Python deleted).
  const toolsDir = `${deps.scriptsDir.replace(/\/scripts$/, "")}/tools`;
  const cmd = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    `${toolsDir}/healer_canary.ts`,
    "--status",
    "--json",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "canary", result);
    return null;
  }
  try {
    const obj = JSON.parse(result.stdout);
    const patterns: any[] = Array.isArray(obj?.patterns) ? obj.patterns : [];
    const circuits_open: string[] = [];
    const near_promotion: string[] = [];
    for (const p of patterns) {
      if (p?.circuit === "open") circuits_open.push(String(p.name ?? ""));
      if (p?.mode === "suggest" && Number(p?.successful_suggests ?? 0) >= 3) {
        near_promotion.push(String(p.name ?? ""));
      }
    }
    return { circuits_open, near_promotion };
  } catch (e) {
    pushParseError(errors, "canary", e);
    return null;
  }
}

// ── collectAlerts ────────────────────────────────────────────────────

export type AlertsState = {
  unacknowledged: Array<{ level: string; message: string; context: string }>;
};

export async function collectAlerts(
  deps: Deps,
  errors: ErrSlot[],
): Promise<AlertsState | null> {
  // alert_delivery is pure TS as of the 2026-05-18 cutover (Python
  // gone with the self_healer slice — that was the last in-process
  // consumer). Talks to the CLI sibling under `tools/`.
  const toolsDir = `${deps.scriptsDir.replace(/\/scripts$/, "")}/tools`;
  const cmd = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    `${toolsDir}/alert_delivery.ts`,
    "--check",
    "--json",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "alerts", result);
    return null;
  }
  try {
    const obj = JSON.parse(result.stdout);
    const raw: any[] = Array.isArray(obj?.unacknowledged) ? obj.unacknowledged : [];
    return {
      unacknowledged: raw.map((a) => ({
        level: String(a?.level ?? "warning"),
        message: String(a?.message ?? ""),
        context: String(a?.context ?? ""),
      })),
    };
  } catch (e) {
    pushParseError(errors, "alerts", e);
    return null;
  }
}

// ── collectSkillSuggestions ──────────────────────────────────────────

export type SkillSuggestion = { name: string; reason: string };

export async function collectSkillSuggestions(
  deps: Deps,
  errors: ErrSlot[],
): Promise<SkillSuggestion[]> {
  // skill_router went pure-TS in the 2026-05-18 cutover (the Python
  // was deleted with that slice — no other callers).
  const toolsDir = `${deps.scriptsDir.replace(/\/scripts$/, "")}/tools`;
  const cmd = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    `${toolsDir}/skill_router.ts`,
    "--context",
    "session",
    "--json",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "skills", result);
    return [];
  }
  try {
    const obj = JSON.parse(result.stdout);
    const raw: any[] = Array.isArray(obj?.suggestions) ? obj.suggestions : [];
    return raw.slice(0, SKILL_SUGGESTIONS_CAP).map((s) => ({
      name: String(s?.name ?? ""),
      reason: String(s?.reason ?? ""),
    }));
  } catch (e) {
    pushParseError(errors, "skills", e);
    return [];
  }
}

// ── collectPersona ───────────────────────────────────────────────────

export type PersonaState = Record<string, unknown>;

export async function collectPersona(
  deps: Deps,
  errors: ErrSlot[],
): Promise<PersonaState | null> {
  // Persona went pure-TS in the 2026-05-18 cutover. `deps.scriptsDir` still
  // points at `~/.claude/code-review/scripts/`; the TS sibling tools live one
  // directory up under `tools/`, so derive the path rather than carrying a
  // second config knob.
  const toolsDir = `${deps.scriptsDir.replace(/\/scripts$/, "")}/tools`;
  const cmd = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    `${toolsDir}/stark_persona.ts`,
    "select",
    "--auto",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "persona", result);
    return null;
  }
  try {
    const obj = JSON.parse(result.stdout);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    pushParseError(errors, "persona", e);
    return null;
  }
}

// ── collectBoard ─────────────────────────────────────────────────────

export type BoardItem = { title: string; issue_number: string };
export type BoardState = {
  in_flight: BoardItem[];
  blocked: BoardItem[];
  needs_attention: BoardItem[];
};

export async function collectBoard(
  deps: Deps,
  errors: ErrSlot[],
): Promise<BoardState | null> {
  const cmd = [
    "python3", `${deps.scriptsDir}/github_projects.py`, "list-items",
    "--status", "In Progress,Blocked,Needs Clarification", "--json",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "board", result);
    return null;
  }
  try {
    const items: any[] = JSON.parse(result.stdout);
    const out: BoardState = { in_flight: [], blocked: [], needs_attention: [] };
    for (const it of items) {
      const item: BoardItem = {
        title: String(it?.title ?? ""),
        issue_number: String(it?.number ?? it?.issue_number ?? ""),
      };
      const s = String(it?.status ?? "").toLowerCase();
      if (s.includes("block")) out.blocked.push(item);
      else if (s.includes("progress")) out.in_flight.push(item);
      else out.needs_attention.push(item);
    }
    return out;
  } catch (e) {
    pushParseError(errors, "board", e);
    return null;
  }
}

// ── collectSessionState ──────────────────────────────────────────────

export type SessionStateSlot = {
  session_id: string;
  started_at: string;
  branch: string;
  repo: string;
  tasks_completed: string[];
  last_checkpoint: string | null;
  name: string | null;
  start_head: string | null;
};

export async function collectSessionState(
  deps: Deps,
  errors: ErrSlot[],
): Promise<SessionStateSlot | null> {
  // Session state went pure-TS in the 2026-05-18 cutover. The Python
  // `scripts/session_state.py` is still in place for `context_compactor.py`,
  // but the collector talks to the TS CLI sibling under `tools/`. Same
  // JSON shape as before so the parse path below is unchanged.
  const toolsDir = `${deps.scriptsDir.replace(/\/scripts$/, "")}/tools`;
  const cmd = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    `${toolsDir}/session_state.ts`,
    "--json",
  ];
  const result = await deps.run(cmd, { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (result.code !== 0) {
    pushSubprocessError(errors, "session_state", result);
    return null;
  }
  try {
    const obj = JSON.parse(result.stdout);
    return {
      session_id: String(obj?.session_id ?? ""),
      started_at: String(obj?.started_at ?? ""),
      branch: String(obj?.branch ?? ""),
      repo: String(obj?.repo ?? ""),
      tasks_completed: Array.isArray(obj?.tasks_completed) ? obj.tasks_completed.map(String) : [],
      last_checkpoint: obj?.last_checkpoint ?? null,
      name: obj?.name ?? null,
      start_head: obj?.start_head ?? null,
    };
  } catch (e) {
    pushParseError(errors, "session_state", e);
    return null;
  }
}

// ── collectGit ───────────────────────────────────────────────────────

export type GitCommit = { sha: string; message: string; age: string };
export type GitState = {
  branch: string;
  ahead: number;
  behind: number;
  uncommitted: string[];
  stashes: number;
  recent_commits: GitCommit[];
};

export async function collectGit(
  deps: Deps,
  errors: ErrSlot[],
): Promise<GitState | null> {
  const br = await deps.run(["git", "branch", "--show-current"], { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  if (br.code !== 0) {
    pushSubprocessError(errors, "git", br);
    return null;
  }
  const branch = br.stdout.trim();

  const ab = await deps.run(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], {
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  let ahead = 0, behind = 0;
  if (ab.code === 0) {
    const parts = ab.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
  }

  const st = await deps.run(["git", "status", "--short"], { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  const uncommitted = st.code === 0 && st.stdout.trim()
    ? st.stdout.split("\n").filter((l) => l.trim())
    : [];

  const sl = await deps.run(["git", "stash", "list"], { timeoutMs: SUBPROCESS_TIMEOUT_MS });
  const stashes = sl.code === 0 && sl.stdout.trim() ? sl.stdout.split("\n").filter((l) => l.trim()).length : 0;

  const lg = await deps.run(
    ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"],
    { timeoutMs: SUBPROCESS_TIMEOUT_MS },
  );
  const recent_commits: GitCommit[] = [];
  if (lg.code === 0 && lg.stdout.trim()) {
    for (const line of lg.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 3) {
        recent_commits.push({
          sha: parts[0],
          message: parts[1],
          age: parts.slice(2).join("|"),
        });
      }
    }
  }

  return { branch, ahead, behind, uncommitted, stashes, recent_commits };
}

// ── collectPRs ───────────────────────────────────────────────────────

export type PRInfo = {
  number: number;
  title: string;
  head: string;
  review_decision: string;
  url: string;
};
export type CurrentPR = {
  number: number;
  title: string;
  state: string;
  review_decision: string;
  checks: { pass: number; fail: number; pending: number };
};
export type PRsState = { mine: PRInfo[]; current_branch: CurrentPR | null };

export async function collectPRs(
  deps: Deps,
  currentBranch: string,
  errors: ErrSlot[],
): Promise<PRsState | null> {
  const mineRes = await deps.run(
    ["gh", "pr", "list", "--author", "@me", "--state", "open",
     "--json", "number,title,headRefName,reviewDecision,url", "--limit", "20"],
    { timeoutMs: SUBPROCESS_TIMEOUT_MS },
  );
  if (mineRes.code !== 0) {
    pushSubprocessError(errors, "prs", mineRes);
    return null;
  }
  let mine: PRInfo[] = [];
  try {
    const arr: any[] = JSON.parse(mineRes.stdout);
    mine = arr.map((p) => ({
      number: Number(p?.number ?? 0),
      title: String(p?.title ?? ""),
      head: String(p?.headRefName ?? ""),
      review_decision: String(p?.reviewDecision ?? ""),
      url: String(p?.url ?? ""),
    }));
  } catch (e) {
    pushParseError(errors, "prs", e);
    return null;
  }

  let current_branch: CurrentPR | null = null;
  if (currentBranch) {
    const cur = await deps.run(
      ["gh", "pr", "view", "--json", "number,title,state,reviewDecision,statusCheckRollup"],
      { timeoutMs: SUBPROCESS_TIMEOUT_MS },
    );
    if (cur.code === 0 && cur.stdout.trim()) {
      try {
        const obj = JSON.parse(cur.stdout);
        const rollup: any[] = Array.isArray(obj?.statusCheckRollup) ? obj.statusCheckRollup : [];
        let pass = 0, fail = 0, pending = 0;
        for (const c of rollup) {
          const concl = String(c?.conclusion ?? "").toUpperCase();
          if (concl === "SUCCESS") pass++;
          else if (concl === "FAILURE" || concl === "CANCELLED" || concl === "TIMED_OUT") fail++;
          else pending++;
        }
        current_branch = {
          number: Number(obj?.number ?? 0),
          title: String(obj?.title ?? ""),
          state: String(obj?.state ?? ""),
          review_decision: String(obj?.reviewDecision ?? ""),
          checks: { pass, fail, pending },
        };
      } catch {
        // No current-branch PR — common, leave null.
      }
    }
  }

  return { mine, current_branch };
}

// ── collectAvailableSkills ───────────────────────────────────────────

export async function collectAvailableSkills(
  deps: Deps,
  _errors: ErrSlot[],
): Promise<string[]> {
  const result = await deps.run(
    ["sh", "-c", `ls ${deps.home}/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md 2>/dev/null`],
    { timeoutMs: SUBPROCESS_TIMEOUT_MS },
  );
  if (result.code !== 0 && !result.stdout.trim()) return [];
  const names = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("/");
    const idx = parts.indexOf("skills");
    if (idx >= 0 && idx + 1 < parts.length) names.add(parts[idx + 1]);
  }
  return Array.from(names).sort();
}

// ── collectHealthChecks ──────────────────────────────────────────────

export type HealthCheck = {
  name: string;
  passed: boolean | null;
  detail: string;
  duration: number | null;
};

export async function collectHealthChecks(
  deps: Deps,
  errors: ErrSlot[],
): Promise<HealthCheck[]> {
  let raw = await deps.readFile(".code-review/config.json");
  if (raw === null) {
    // Fallback: walk to repo root (mirrors the Python original).
    const top = await deps.run(["git", "rev-parse", "--show-toplevel"], {
      timeoutMs: SUBPROCESS_TIMEOUT_MS,
    });
    if (top.code === 0 && top.stdout.trim()) {
      raw = await deps.readFile(`${top.stdout.trim()}/.code-review/config.json`);
    }
  }
  if (raw === null) return [];
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    pushParseError(errors, "health", e);
    return [];
  }
  const entries: any[] = cfg?.session?.health_checks ?? [];
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out: HealthCheck[] = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? "Unknown");
    const command = String(entry?.command ?? "");
    if (!command) continue;
    const start = Date.now();
    const result = await deps.run(["sh", "-c", command], { timeoutMs: SUBPROCESS_TIMEOUT_MS });
    const dur = Math.round((Date.now() - start) / 100) / 10;
    if (result.timedOut) {
      out.push({ name, passed: null, detail: "unavailable: timeout", duration: null });
    } else {
      out.push({
        name,
        passed: result.code === 0,
        detail: result.stdout.trim().slice(0, 200) || (result.code === 0 ? "OK" : `exit ${result.code}`),
        duration: dur,
      });
    }
  }
  return out;
}

// ── collectDiffSummary ───────────────────────────────────────────────

export type KeyFile = { path: string; added: number; removed: number; status: string };
export type DiffSummary = {
  added: number;
  removed: number;
  file_count: number;
  key_files: KeyFile[];
  approximate: boolean;
};

const DIFF_KEY_FILES_MAX = 8;

export async function collectDiffSummary(
  deps: Deps,
  startHead: string | null,
  errors: ErrSlot[],
): Promise<DiffSummary | null> {
  let sha = startHead;
  let approximate = false;
  if (!sha) {
    const mb = await deps.run(["git", "merge-base", "origin/main", "HEAD"], {
      timeoutMs: SUBPROCESS_TIMEOUT_MS,
    });
    if (mb.code !== 0 || !mb.stdout.trim()) {
      pushSubprocessError(errors, "diff", mb);
      return null;
    }
    sha = mb.stdout.trim();
    approximate = true;
  }

  const num = await deps.run(["git", "diff", "--numstat", sha, "HEAD"], {
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  if (num.code !== 0) {
    pushSubprocessError(errors, "diff", num);
    return null;
  }
  const ns = await deps.run(["git", "diff", "--name-status", sha, "HEAD"], {
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  const statusMap = new Map<string, string>();
  if (ns.code === 0) {
    for (const line of ns.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2) statusMap.set(parts.slice(1).join(" "), parts[0]);
    }
  }
  let added = 0, removed = 0, file_count = 0;
  const files: Array<KeyFile & { total: number }> = [];
  for (const line of num.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const r = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const p = parts.slice(2).join("\t");
    added += a;
    removed += r;
    file_count++;
    files.push({ path: p, added: a, removed: r, status: statusMap.get(p) ?? "M", total: a + r });
  }
  files.sort((x, y) => y.total - x.total);
  const key_files = files.slice(0, DIFF_KEY_FILES_MAX).map(({ total: _t, ...rest }) => rest);
  return { added, removed, file_count, key_files, approximate };
}

// ── collectBranchState ───────────────────────────────────────────────

export type BranchState = {
  ahead: number;
  behind: number;
  upstream: string | null;
  has_pr: boolean;
};

export async function collectBranchState(
  deps: Deps,
  _errors: ErrSlot[],
): Promise<BranchState> {
  let upstream: string | null = null;
  let ahead = 0, behind = 0;
  const up = await deps.run(["git", "rev-parse", "--abbrev-ref", "@{u}"], {
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  if (up.code === 0 && up.stdout.trim()) {
    upstream = up.stdout.trim();
    const ab = await deps.run(
      ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"],
      { timeoutMs: SUBPROCESS_TIMEOUT_MS },
    );
    if (ab.code === 0) {
      const parts = ab.stdout.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = Number(parts[0]) || 0;
        ahead = Number(parts[1]) || 0;
      }
    }
  }
  const pr = await deps.run(["gh", "pr", "view", "--json", "number"], {
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  const has_pr = pr.code === 0 && pr.stdout.trim().length > 0;
  return { ahead, behind, upstream, has_pr };
}

// ── Orchestrators ────────────────────────────────────────────────────

export type StartOpts = {
  session_id: string;
  start_head: string | null;
  started_at: string;
  /** Total wall-clock budget for the whole start collection. Defaults to 45s. */
  walltimeMs?: number;
};

export type StartState = {
  session: SessionStateSlot | null;
  git: GitState | null;
  prs: PRsState | null;
  board: BoardState | null;
  alerts: AlertsState | null;
  health: HealthCheck[];
  healer: { categories: HealerCategory[]; canary: CanaryStatus | null } | null;
  skills: { available: string[]; suggestions: SkillSuggestion[] };
  persona: PersonaState | null;
  errors: ErrSlot[];
};

export type EndOpts = {
  session_id: string;
  start_head: string | null;
  started_at: string;
  name: string | null;
};

export type EndState = {
  session: {
    session_id: string;
    branch: string;
    repo: string;
    started_at: string;
    name: string | null;
    start_head: string | null;
    ended_at: string;
  };
  diff: DiffSummary | null;
  branch: BranchState;
  errors: ErrSlot[];
};

export async function collectStart(deps: Deps, opts: StartOpts): Promise<StartState> {
  const errors: ErrSlot[] = [];

  // Propagate CLI session id to subprocess children so session_state.py and
  // any other Python helper sees the same id the SKILL invoked us with.
  const childDeps: Deps = opts.session_id
    ? { ...deps, run: (cmd, runOpts) => deps.run(cmd, {
        ...runOpts,
        env: { ...(runOpts?.env ?? process.env), CLAUDE_SESSION_ID: opts.session_id },
      }) }
    : deps;

  // Slot accumulator: each collector resolves its slot when done; collectors
  // still in flight when the wall-clock deadline trips stay null.
  const slots = {
    session: null as SessionStateSlot | null,
    git: null as GitState | null,
    board: null as BoardState | null,
    alerts: null as AlertsState | null,
    canary: null as CanaryStatus | null,
    suggestions: [] as SkillSuggestion[],
    persona: null as PersonaState | null,
    available: [] as string[],
    healerCats: null as HealerCategory[] | null,
    prs: null as PRsState | null,
    health: [] as HealthCheck[],
  };

  const tasks: Promise<unknown>[] = [
    collectSessionState(childDeps, errors).then((v) => { slots.session = v; }),
    collectGit(childDeps, errors).then(async (v) => {
      slots.git = v;
      // PRs depends on knowing the current branch.
      if (v) slots.prs = await collectPRs(childDeps, v.branch, errors);
    }),
    collectBoard(childDeps, errors).then((v) => { slots.board = v; }),
    collectAlerts(childDeps, errors).then((v) => { slots.alerts = v; }),
    collectCanaryStatus(childDeps, errors).then((v) => { slots.canary = v; }),
    collectSkillSuggestions(childDeps, errors).then((v) => { slots.suggestions = v; }),
    collectPersona(childDeps, errors).then((v) => { slots.persona = v; }),
    collectAvailableSkills(childDeps, errors).then((v) => { slots.available = v; }),
    collectHealerCategories(childDeps, errors).then((v) => { slots.healerCats = v; }),
    collectHealthChecks(childDeps, errors).then((v) => { slots.health = v; }),
  ];

  const walltime = opts.walltimeMs ?? START_WALLTIME_MS_DEFAULT;
  let deadlineHit = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => { deadlineHit = true; resolve(); }, walltime);
  });
  try {
    await Promise.race([
      Promise.all(tasks).catch(() => {/* swallow — per-collector errors already pushed */}),
      deadlinePromise,
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  if (deadlineHit) {
    errors.push({
      source: "wall_clock_deadline",
      message: `start collection exceeded ${walltime}ms budget; partial result returned`,
    });
  }

  // Override session block with CLI-supplied values where present.
  const session = slots.session
    ? {
        ...slots.session,
        session_id: opts.session_id || slots.session.session_id,
        start_head: opts.start_head ?? slots.session.start_head,
        started_at: opts.started_at || slots.session.started_at,
      }
    : null;

  const healer = slots.healerCats !== null || slots.canary !== null
    ? { categories: slots.healerCats ?? [], canary: slots.canary }
    : null;

  return {
    session,
    git: slots.git,
    prs: slots.prs,
    board: slots.board,
    alerts: slots.alerts,
    health: slots.health,
    healer,
    skills: { available: slots.available, suggestions: slots.suggestions },
    persona: slots.persona,
    errors,
  };
}

export async function collectEnd(deps: Deps, opts: EndOpts): Promise<EndState> {
  const errors: ErrSlot[] = [];

  const childDeps: Deps = opts.session_id
    ? { ...deps, run: (cmd, runOpts) => deps.run(cmd, {
        ...runOpts,
        env: { ...(runOpts?.env ?? process.env), CLAUDE_SESSION_ID: opts.session_id },
      }) }
    : deps;

  // session_state runs first; its persisted start_head feeds collectDiffSummary
  // when the SKILL didn't capture one. branch state is independent and runs in
  // parallel with diff to keep total wall-clock short.
  const stateRow = await collectSessionState(childDeps, errors);
  const startHead = opts.start_head ?? stateRow?.start_head ?? null;
  const [diff, branch] = await Promise.all([
    collectDiffSummary(childDeps, startHead, errors),
    collectBranchState(childDeps, errors),
  ]);
  return {
    session: {
      session_id: opts.session_id || stateRow?.session_id || "",
      branch: stateRow?.branch ?? "",
      repo: stateRow?.repo ?? "",
      started_at: opts.started_at || stateRow?.started_at || "",
      name: opts.name ?? stateRow?.name ?? null,
      start_head: startHead,
      ended_at: deps.now().toISOString(),
    },
    diff,
    branch,
    errors,
  };
}

/**
 * Top-N failure categories from `~/.claude/code-review/healer.jsonl`.
 * Returns null when the log file is absent (common in fresh installs).
 */
export async function collectHealerCategories(
  deps: Deps,
  _errors: ErrSlot[],
): Promise<HealerCategory[] | null> {
  const raw = await deps.readFile(healerLogPath(deps.home));
  if (raw === null) return null;
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let cat: string | undefined;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && typeof obj.category === "string") {
        cat = obj.category;
      }
    } catch {
      // malformed lines are skipped silently (matches Python behavior)
      continue;
    }
    if (!cat) continue;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const arr: HealerCategory[] = [];
  for (const [name, count] of counts) arr.push({ name, count });
  // Sort by count desc, then by insertion order (stable) — Python's
  // Counter.most_common ties go to first-seen.
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, HEALER_TOP_N);
}
