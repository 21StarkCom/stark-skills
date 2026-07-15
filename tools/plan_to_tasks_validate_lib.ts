/**
 * Validation dispatch for plan-to-tasks decompositions — TypeScript port
 * of `scripts/plan_to_tasks_validate.py`.
 *
 * Dispatches the structured task breakdown to external LLM CLI tools
 * (Codex, Gemini) in parallel. Each agent reviews the breakdown against
 * the original plan and reports structural/completeness issues.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assetConfigPath } from "./asset_root_lib.ts";
import { CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parseJsonlOutput } from "./codex_utils_lib.ts";
import { GEMINI_MODEL, makeGeminiEnv, setupGeminiHome } from "./gemini_utils_lib.ts";

// ── Constants ────────────────────────────────────────────────────────────

const CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH;
export const DEFAULT_TIMEOUT = 300;

export const DEFAULT_PLAN_TO_TASKS_CONFIG: Record<string, unknown> = {
  validation_agents: ["codex"],
  timeout: DEFAULT_TIMEOUT,
};

export const SUPPORTED_VALIDATION_AGENTS: ReadonlySet<string> = new Set(["codex", "gemini"]);

function globalConfigPath(): string {
  return assetConfigPath();
}

// ── Data models ──────────────────────────────────────────────────────────

export interface ValidationIssue {
  phase_id: string;
  task_id: string;
  field: string;
  problem: string;
  suggestion: string;
}

export interface ValidationResult {
  agent: string;
  approved: boolean;
  issues: ValidationIssue[];
  raw_output: string;
  error: string | null;
  duration_s: number;
}

function makeResult(init: Partial<ValidationResult> & { agent: string }): ValidationResult {
  return {
    approved: false,
    issues: [],
    raw_output: "",
    error: null,
    duration_s: 0.0,
    ...init,
  };
}

// ── Config loading ───────────────────────────────────────────────────────

/** Load the plan_to_tasks config section (global → repo) over the defaults. */
export function loadConfig(
  repoDir?: string | null,
  globalConfig?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...DEFAULT_PLAN_TO_TASKS_CONFIG };

  const readSection = (file: string): void => {
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const section = data?.plan_to_tasks;
      if (section && typeof section === "object" && !Array.isArray(section)) {
        Object.assign(config, section);
      }
    } catch {
      // malformed — skip
    }
  };

  readSection(globalConfig ?? globalConfigPath());
  if (repoDir) readSection(path.join(repoDir, ".code-review", "config.json"));
  return config;
}

// ── Utilities ────────────────────────────────────────────────────────────

/** sha256 hex digest of `content`, prefixed with 'sha256:'. */
export function computePlanHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// ── Validation prompt ────────────────────────────────────────────────────

export const VALIDATION_PROMPT = `You are a validation agent for a plan decomposition. You receive a JSON envelope containing:
- plan_markdown: the original spec/design document
- breakdown: the structured task decomposition (phases → tasks)
- plan_hash: SHA-256 of the plan for integrity

Your job is adversarial — try to break the decomposition. Check:
1. Coverage — every requirement maps to at least one task
2. Self-containment — each task implementable without reading other issues
3. Dependency correctness — task_id references valid, no circular deps
4. Overlap — no two tasks describe same work
5. Sizing — tasks within guardrails (≤5 AC, ≤4 files, ≤500 words in how)
6. Review sufficiency — review hints specific, not generic
7. Metric sanity — story points consistent, risk ratings aligned
8. Cross-task name/type consistency — a method/type/file-path/env-var/label referenced across multiple tasks must use the same name. A function called \`clearLayers()\` in Task 3 but \`clearFullLayers()\` in Task 7 is a bug.

CALIBRATION — read this before flagging anything:
Only flag issues that would cause real problems during implementation — an implementer building the wrong thing, getting stuck, or shipping a bug. Minor wording, stylistic preferences, "could be clearer", and "nice to have" suggestions are NOT issues. Approve unless there are serious gaps: missing requirements, contradictory steps, placeholder content (TBD, "handle edge cases", "similar to above"), vague-to-the-point-of-unactionable tasks, or cross-task name/type mismatches.

SCOPE-MATCH — do not demand ceremony the plan never scoped:
Most of these plans are single-user, playground-scoped tools (one operator, a laptop, no fleet, no SLA). "Coverage" means every requirement THE PLAN STATES maps to a task — NOT that the decomposition adds production concerns the plan omitted. Do NOT flag a missing task for rollback/recovery, monitoring/alerting/retention, cloud-infra provisioning the plan doesn't deploy, credential rotation, migration frameworks, an E2E/load-test pyramid, or adversarial-input hardening when the plan's scope doesn't include them — their absence is correct, not a gap. If anything, a task that manufactures such machinery for a clearly single-user tool is itself the issue (over-engineering) — flag it to be cut, don't reward it.

Output ONLY a JSON object:
{"schema_version": 1, "approved": true/false, "issues": [{"phase_id": "...", "task_id": "...", "field": "...", "problem": "...", "suggestion": "..."}]}
If no issues: {"schema_version": 1, "approved": true, "issues": []}
Output ONLY the JSON, no other text.`;

const ISSUE_REQUIRED_FIELDS = ["phase_id", "task_id", "field", "problem"];

// ── Envelope builder ─────────────────────────────────────────────────────

/** Build the JSON envelope sent to each validation agent. */
export function buildValidationEnvelope(
  planContent: string,
  breakdown: Record<string, unknown>,
  planHash: string,
): Record<string, unknown> {
  return {
    schema_version: 1,
    plan_markdown: planContent,
    breakdown,
    plan_hash: planHash,
  };
}

// ── Output parsing ───────────────────────────────────────────────────────

/** Unwrap Gemini's `{"response": "..."}` envelope if present. */
function extractGeminiOutput(raw: string): string {
  const text = raw.trim();
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer === "object" && !Array.isArray(outer) && "response" in outer) {
      return String((outer as Record<string, unknown>).response);
    }
  } catch {
    // not JSON
  }
  return text;
}

/** Remove ```json … ``` (or bare ``` … ```) wrappers. */
function stripMarkdownFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

/** Parse agent output into a ValidationResult. */
export function parseValidationOutput(raw: string, agent: string): ValidationResult {
  let text = raw;
  if (agent === "codex") text = parseJsonlOutput(text);
  else if (agent === "gemini") text = extractGeminiOutput(text);
  text = stripMarkdownFences(text);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    return makeResult({
      agent,
      approved: false,
      raw_output: raw,
      error: `JSON parse error: ${(exc as Error).message}`,
    });
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const kind = Array.isArray(data) ? "list" : data === null ? "NoneType" : typeof data;
    return makeResult({
      agent,
      approved: false,
      raw_output: raw,
      error: `Expected JSON object, got ${kind}`,
    });
  }

  const obj = data as Record<string, unknown>;
  const approved = Boolean(obj.approved ?? false);
  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: ValidationIssue[] = [];
  for (const item of rawIssues) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    if (!ISSUE_REQUIRED_FIELDS.every((k) => k in it)) continue;
    issues.push({
      phase_id: String(it.phase_id),
      task_id: String(it.task_id),
      field: String(it.field),
      problem: String(it.problem),
      suggestion: String(it.suggestion ?? ""),
    });
  }

  return makeResult({ agent, approved, issues, raw_output: raw });
}

// ── Subprocess helper ────────────────────────────────────────────────────

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: boolean;
}

async function runProcess(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<ProcResult> {
  return await new Promise<ProcResult>((resolve) => {
    const child = spawn(cmd, args, { env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed: ProcResult | null = null;
    const tryFinish = () => {
      if (settled) return;
      if (closed === null) return;
      if (!stdoutEnded || !stderrEnded) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    if (child.stdout) child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    else stdoutEnded = true;
    if (child.stderr) child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    else stderrEnded = true;
    child.on("error", (err) => {
      spawnError = true;
      stdoutEnded = true;
      stderrEnded = true;
      closed = { status: null, stdout, stderr: stderr || String(err), timedOut, spawnError };
      tryFinish();
    });
    child.on("close", (code) => {
      closed = { status: code, stdout, stderr, timedOut, spawnError };
      tryFinish();
    });
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

// ── Agent dispatch ───────────────────────────────────────────────────────

async function runValidationAgent(
  agent: string,
  envelopeJson: string,
  timeout: number,
): Promise<ValidationResult> {
  const start = performance.now();
  const stdinPayload = `${VALIDATION_PROMPT}\n\n${envelopeJson}`;

  try {
    let raw: string;
    if (agent === "codex") {
      const proc = await runProcess(
        "codex",
        [
          "exec",
          "-m",
          CODEX_MODEL,
          "-c",
          CODEX_REASONING_CONFIG,
          "--ephemeral",
          "--json",
          "--full-auto",
          "-",
        ],
        { input: stdinPayload, timeoutMs: timeout * 2 * 1000 },
      );
      if (proc.spawnError) {
        return makeResult({
          agent,
          error: `agent_unavailable: ${agent} not found in PATH`,
          duration_s: (performance.now() - start) / 1000,
        });
      }
      if (proc.timedOut) {
        return makeResult({
          agent,
          error: `Timeout after ${timeout}s`,
          duration_s: (performance.now() - start) / 1000,
        });
      }
      raw = proc.stdout || proc.stderr;
    } else if (agent === "gemini") {
      const geminiHome = setupGeminiHome(
        "stark-gemini-validate-",
        process.cwd(),
        "validate",
        "plan",
      );
      try {
        const proc = await runProcess(
          "gemini",
          ["-m", GEMINI_MODEL, "-p", VALIDATION_PROMPT, "-o", "json"],
          {
            input: envelopeJson,
            timeoutMs: timeout * 1000,
            env: makeGeminiEnv(geminiHome),
          },
        );
        if (proc.spawnError) {
          return makeResult({
            agent,
            error: `agent_unavailable: ${agent} not found in PATH`,
            duration_s: (performance.now() - start) / 1000,
          });
        }
        if (proc.timedOut) {
          return makeResult({
            agent,
            error: `Timeout after ${timeout}s`,
            duration_s: (performance.now() - start) / 1000,
          });
        }
        raw = proc.stdout || proc.stderr;
      } finally {
        try {
          fs.rmSync(geminiHome, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    } else {
      return makeResult({
        agent,
        error: `Unknown agent: ${agent}`,
        duration_s: (performance.now() - start) / 1000,
      });
    }

    const result = parseValidationOutput(raw, agent);
    result.duration_s = (performance.now() - start) / 1000;
    return result;
  } catch (exc) {
    return makeResult({
      agent,
      error: `Unexpected error: ${exc instanceof Error ? exc.message : String(exc)}`,
      duration_s: (performance.now() - start) / 1000,
    });
  }
}

/** Dispatch validation agents in parallel. Returns one result per agent. */
export async function dispatchValidators(
  planContent: string,
  breakdown: Record<string, unknown> | string,
  planHash: string | null,
  agents: string[] | null,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<ValidationResult[]> {
  const hash = planHash ?? computePlanHash(planContent);

  let breakdownDict: Record<string, unknown>;
  if (typeof breakdown === "string") {
    try {
      const parsed = JSON.parse(breakdown);
      breakdownDict =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      breakdownDict = {};
    }
  } else {
    breakdownDict = breakdown;
  }

  let resolvedAgents = agents;
  if (!resolvedAgents || resolvedAgents.length === 0) {
    const config = loadConfig();
    const configured = config.validation_agents as string[] | undefined;
    resolvedAgents = configured && configured.length > 0 ? configured : ["codex"];
  }

  const envelope = buildValidationEnvelope(planContent, breakdownDict, hash);
  const envelopeJson = JSON.stringify(envelope);

  return Promise.all(
    resolvedAgents.map((agent) => runValidationAgent(agent, envelopeJson, timeout)),
  );
}
