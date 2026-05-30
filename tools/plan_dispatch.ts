#!/usr/bin/env -S node --experimental-strip-types
/**
 * Plan dispatch — paired lead/wing plan generation with review-fix loop.
 *
 * Round 1: lead reads the design doc + generate prompt, emits a plan markdown
 *          draft on stdout.
 * Wing reviews the draft text, returns an `approve | revise | block` JSON
 * verdict. If `revise` and fix budget remains, lead receives its prior draft
 * + wing's blocking findings + revise template and emits a new draft. Loop.
 *
 * No worktree (plans are text). No tool use — lead and wing both operate
 * purely on stdin/stdout, no codebase mutation. Drop-in replacement for the
 * deleted scripts/design_to_plan_dispatch.py (3-agent tournament + cross-
 * review). Sibling of tools/copilot_dispatch.ts, from which it imports the
 * shared subprocess + env + gemini-home helpers — see those exports there.
 */
import { readFile } from "node:fs/promises";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAgentEnv,
  extractVerdictJson,
  isAgentEnabled,
  isPlainObject,
  makeGeminiEnv,
  normalizeVerdict,
  parseCodexJsonl,
  parseGeminiJson,
  releaseAgentTempDir,
  resolveModel,
  run,
  setupGeminiHome,
  shouldFallbackToApiKey,
  tryGeminiApiKeyFallback,
  VALID_AGENTS,
  type AgentName,
} from "./copilot_dispatch.ts";

// Constants ---------------------------------------------------------------

export const DEFAULT_LEAD: AgentName = "claude";
export const DEFAULT_WING: AgentName = "codex";
export const DEFAULT_MAX_ROUNDS = 4;
export const DEFAULT_TIMEOUT_SEC = 900;
export const WING_TIMEOUT_DEFAULT_SEC = 600;

const CODEX_REASONING_EFFORT = 'model_reasoning_effort="medium"';

// Types -------------------------------------------------------------------

export interface PlanRoundResult {
  round_num: number;
  draft: string;
  draft_length: number;
  verdict: string;
  blocking_findings: string[];
  suggestions: string[];
  summary: string;
  wing_raw: string;
  parse_retry_used: boolean;
  duration_s: number;
  error: string | null;
}

export type FinalVerdict =
  | "approved"
  | "blocked"
  | "aborted"
  | "max_rounds_unresolved"
  | "unresolved";

export interface PlanDispatchResult {
  lead: AgentName;
  wing: AgentName;
  final_verdict: FinalVerdict;
  error: string | null;
  duration_s: number;
  rounds: Array<{
    round: number;
    draft_length: number;
    verdict: string;
    blocking_findings: string[];
    non_blocking_suggestions: string[];
    summary: string;
    parse_retry_used: boolean;
    duration_s: number;
    error: string | null;
  }>;
  final_plan: string;
}

export interface PreflightFailure {
  error: string;
  rounds: [];
}

// Agent command builders --------------------------------------------------

function buildClaudeCmd(): { cmd: string; args: string[] } {
  return {
    cmd: "claude",
    args: [
      "-p", "-",
      "--output-format", "text",
      "--model", resolveModel("claude"),
      "--no-session-persistence",
    ],
  };
}

function buildCodexCmd(): { cmd: string; args: string[] } {
  return {
    cmd: "codex",
    args: [
      "exec",
      "-m", resolveModel("codex"),
      "-c", CODEX_REASONING_EFFORT,
      "--ephemeral", "--json",
      "-s", "read-only",
      "-",
    ],
  };
}

// Agent invocation (text-in, text-out, no worktree) -----------------------

interface AgentCallOutcome {
  raw: string;
  error: string | null;
  duration_s: number;
  api_key_fallback: boolean;
}

async function callAgent(
  agent: AgentName,
  prompt: string,
  timeoutSec: number,
  geminiPrefix: string,
  contextLabel: string,
): Promise<AgentCallOutcome> {
  const t0 = process.hrtime.bigint();
  const out: AgentCallOutcome = {
    raw: "",
    error: null,
    duration_s: 0,
    api_key_fallback: false,
  };

  if (!isAgentEnabled(agent)) {
    out.error = "agent_disabled";
    out.duration_s = elapsedSec(t0);
    return out;
  }

  let cmd: string;
  let args: string[];
  let stdin: string | undefined;
  let geminiHome: string | null = null;
  let geminiCwd: string | null = null;
  let agentTempDir: string | null = null;
  let env: NodeJS.ProcessEnv;

  try {
    if (agent === "claude") {
      const c = buildClaudeCmd();
      cmd = c.cmd;
      args = c.args;
      stdin = prompt;
      const built = await buildAgentEnv("claude", "local");
      env = built.env;
      agentTempDir = built.tempDir;
    } else if (agent === "codex") {
      const c = buildCodexCmd();
      cmd = c.cmd;
      args = c.args;
      stdin = prompt;
      const built = await buildAgentEnv("codex", "local");
      env = built.env;
      agentTempDir = built.tempDir;
    } else {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "stark-plan-gemini-cwd-"));
      geminiCwd = cwd;
      geminiHome = setupGeminiHome(geminiPrefix, cwd, "plan", "plan");
      cmd = "gemini";
      args = ["-m", resolveModel("gemini"), "--skip-trust", "-p", prompt];
      env = makeGeminiEnv(geminiHome);
    }
  } catch (err) {
    out.error = `env_setup_failed:${(err as Error).message}`;
    out.duration_s = elapsedSec(t0);
    if (geminiHome) {
      try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (geminiCwd) {
      try { rmSync(geminiCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return out;
  }

  try {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const cwd = agent === "gemini" && geminiCwd ? geminiCwd : undefined;
      const res = await run(cmd, args, { timeoutSec, env, stdin, cwd });
      if (res.notFound) {
        out.error = "agent_unavailable";
        break;
      }
      if (res.timedOut) {
        if (attempt < maxAttempts) {
          process.stderr.write(`  [${agent}:${contextLabel}] timed out, retrying...\n`);
          continue;
        }
        out.error = "timeout";
        break;
      }
      if (res.code !== 0) {
        const stderrSnippet = res.stderr.slice(0, 500);
        process.stderr.write(
          `  [${agent}:${contextLabel}] CLI error (exit ${res.code}): ${stderrSnippet}\n`,
        );
        if (
          agent === "gemini" &&
          attempt < maxAttempts &&
          shouldFallbackToApiKey(stderrSnippet) &&
          (await tryGeminiApiKeyFallback(env, contextLabel, stderrSnippet))
        ) {
          out.api_key_fallback = true;
          await sleep(2_000);
          continue;
        }
        if (attempt < maxAttempts) {
          await sleep(5_000 * attempt);
          continue;
        }
        out.error = "cli_error";
        break;
      }
      let raw = res.stdout;
      if (agent === "codex") raw = parseCodexJsonl(raw);
      else if (agent === "gemini") raw = parseGeminiJson(raw);
      out.raw = raw;
      break;
    }
  } finally {
    if (geminiHome) {
      try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (geminiCwd) {
      try { rmSync(geminiCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (agentTempDir) releaseAgentTempDir(agentTempDir);
  }

  out.duration_s = elapsedSec(t0);
  return out;
}

// Prompt builders ---------------------------------------------------------

export function buildLeadGeneratePrompt(
  generateTemplate: string,
  designContent: string,
): string {
  return (
    generateTemplate +
    "\n\n## Design document to plan from\n\n" +
    designContent +
    "\n"
  );
}

export function buildWingReviewPayload(
  reviewTemplate: string,
  designContent: string,
  draft: string,
  priorRounds: ReadonlyArray<Pick<PlanRoundResult, "round_num" | "verdict" | "blocking_findings" | "summary">>,
): string {
  const parts: string[] = [
    reviewTemplate,
    "\n\n## Design document the plan must implement\n\n",
    designContent,
    "\n\n## Plan draft under review\n\n",
    draft.trim() ? draft : "(empty draft)",
    "\n",
  ];
  if (priorRounds.length > 0) {
    parts.push("\n## Prior review history (most recent last)\n");
    for (const r of priorRounds) {
      parts.push(`\n### Round ${r.round_num}: ${r.verdict}\n`);
      if (r.blocking_findings.length > 0) {
        parts.push("Blocking findings:\n");
        for (const f of r.blocking_findings) parts.push(`- ${f}\n`);
      }
      if (r.summary) parts.push(`Summary: ${r.summary}\n`);
    }
  }
  return parts.join("");
}

export function buildRevisePrompt(
  reviseTemplate: string,
  designContent: string,
  priorDraft: string,
  findings: ReadonlyArray<string>,
  roundNum: number,
): string {
  const findingsBlock =
    findings.length > 0
      ? findings.map((f) => `- ${f}`).join("\n")
      : "(no specific findings — revise based on the wing's general feedback)";
  return (
    `# Revision Round ${roundNum} — address wing reviewer findings\n\n` +
    reviseTemplate +
    "\n\n## Wing's blocking findings (address every one)\n\n" +
    findingsBlock +
    "\n\n## Design document the plan must implement\n\n" +
    designContent +
    "\n\n## Your prior draft (revise this)\n\n" +
    priorDraft +
    "\n"
  );
}

// Main loop ---------------------------------------------------------------

export interface RunPlanOpts {
  designContent: string;
  generatePrompt: string;
  reviewPrompt: string;
  revisePrompt: string;
  lead: AgentName;
  wing: AgentName;
  maxRounds: number;
  timeoutSec: number;
  wingTimeoutSec: number;
}

function newRound(round_num: number): PlanRoundResult {
  return {
    round_num,
    draft: "",
    draft_length: 0,
    verdict: "",
    blocking_findings: [],
    suggestions: [],
    summary: "",
    wing_raw: "",
    parse_retry_used: false,
    duration_s: 0,
    error: null,
  };
}

export async function runPlanDispatch(
  opts: RunPlanOpts,
): Promise<PlanDispatchResult | PreflightFailure> {
  const {
    designContent, generatePrompt, reviewPrompt, revisePrompt,
    lead, wing, maxRounds, timeoutSec, wingTimeoutSec,
  } = opts;

  if (lead === wing) return { error: "lead_eq_wing", rounds: [] };
  if (!VALID_AGENTS.includes(lead) || !VALID_AGENTS.includes(wing)) {
    return { error: "invalid_agent", rounds: [] };
  }
  if (!isAgentEnabled(lead)) return { error: `lead_disabled:${lead}`, rounds: [] };
  if (!isAgentEnabled(wing)) return { error: `wing_disabled:${wing}`, rounds: [] };

  const t0 = process.hrtime.bigint();
  const rounds: PlanRoundResult[] = [];

  // Round 1: lead generates ------------------------------------------------
  const leadPrompt1 = buildLeadGeneratePrompt(generatePrompt, designContent);
  const r1Result = await callAgent(lead, leadPrompt1, timeoutSec, "gemini-plan-lead-", "lead-generate");
  const r1 = newRound(1);
  r1.duration_s = r1Result.duration_s;
  r1.draft = r1Result.raw.trim();
  r1.draft_length = r1.draft.length;
  r1.error = r1Result.error;

  if (r1Result.error) {
    rounds.push(r1);
    return buildPlanResult(lead, wing, rounds, "aborted",
      `lead_round1_failed:${r1Result.error}`, elapsedSec(t0));
  }
  if (!r1.draft) {
    rounds.push(r1);
    return buildPlanResult(lead, wing, rounds, "aborted",
      "lead_round1_empty_draft", elapsedSec(t0));
  }

  // Review-fix loop --------------------------------------------------------
  let finalVerdict: FinalVerdict = "unresolved";
  let error: string | null = null;
  let currentRound = r1;

  for (let roundNum = 1; roundNum <= maxRounds + 1; roundNum++) {
    const prior = rounds.slice();
    const payload = buildWingReviewPayload(reviewPrompt, designContent, currentRound.draft, prior);

    let wingResult = await callAgent(wing, payload, wingTimeoutSec, "gemini-plan-wing-", "wing-review");
    if (wingResult.error === "timeout") {
      wingResult = await callAgent(wing, payload, wingTimeoutSec, "gemini-plan-wing-retry-", "wing-review-retry");
    }

    if (wingResult.error) {
      currentRound.wing_raw = wingResult.raw;
      currentRound.verdict = "unparseable";
      currentRound.blocking_findings = [`wing review ${wingResult.error}`];
      currentRound.summary = `Wing dispatch error: ${wingResult.error}`;
      rounds.push(currentRound);
      finalVerdict = "unresolved";
      error = `wing_error:${wingResult.error}`;
      break;
    }

    let verdictObj = extractVerdictJson(wingResult.raw);
    let parseRetry = false;
    if (verdictObj === null) {
      const retryPayload =
        payload +
        "\n\n## CRITICAL\nYour previous response did not contain a parseable JSON " +
        "verdict block. Respond again ending with EXACTLY one ```json fenced block " +
        "containing keys verdict, blocking_findings, non_blocking_suggestions, summary.";
      const retry = await callAgent(
        wing, retryPayload, wingTimeoutSec,
        "gemini-plan-wing-parse-retry-", "wing-parse-retry",
      );
      parseRetry = true;
      wingResult = retry;
      if (!retry.error) verdictObj = extractVerdictJson(retry.raw);
    }

    currentRound.wing_raw = wingResult.raw;
    currentRound.parse_retry_used = parseRetry;

    if (verdictObj === null) {
      currentRound.verdict = "revise";
      currentRound.blocking_findings = [
        "wing review failed to parse — manual inspection required",
      ];
      currentRound.summary = "Unparseable verdict; treated as revise.";
    } else {
      const n = normalizeVerdict(verdictObj);
      currentRound.verdict = n.verdict;
      currentRound.blocking_findings = n.blocking;
      currentRound.suggestions = n.suggestions;
      currentRound.summary = n.summary;
    }

    rounds.push(currentRound);

    if (currentRound.verdict === "approve") {
      finalVerdict = "approved";
      break;
    }
    if (currentRound.verdict === "block") {
      finalVerdict = "blocked";
      error = "wing_blocked";
      break;
    }

    if (roundNum > maxRounds) {
      finalVerdict = "max_rounds_unresolved";
      error = `unresolved_after_${maxRounds}_fix_rounds`;
      break;
    }

    // Revise round -------------------------------------------------------
    const nextRoundNum = roundNum + 1;
    const reviseText = buildRevisePrompt(
      revisePrompt, designContent, currentRound.draft,
      currentRound.blocking_findings, nextRoundNum,
    );
    const fixResult = await callAgent(
      lead, reviseText, timeoutSec,
      "gemini-plan-lead-revise-", "lead-revise",
    );
    const nextRound = newRound(nextRoundNum);
    nextRound.duration_s = fixResult.duration_s;
    nextRound.draft = fixResult.raw.trim();
    nextRound.draft_length = nextRound.draft.length;
    nextRound.error = fixResult.error;

    if (fixResult.error) {
      rounds.push(nextRound);
      finalVerdict = "unresolved";
      error = `lead_fix_round_failed:${fixResult.error}`;
      break;
    }
    if (!nextRound.draft) {
      rounds.push(nextRound);
      finalVerdict = "unresolved";
      error = "lead_fix_round_empty_draft";
      break;
    }
    if (nextRound.draft === currentRound.draft) {
      rounds.push(nextRound);
      finalVerdict = "unresolved";
      error = "lead_fix_round_no_change";
      break;
    }

    currentRound = nextRound;
  }

  return buildPlanResult(lead, wing, rounds, finalVerdict, error, elapsedSec(t0));
}

function buildPlanResult(
  lead: AgentName,
  wing: AgentName,
  rounds: PlanRoundResult[],
  finalVerdict: FinalVerdict,
  error: string | null,
  totalDuration: number,
): PlanDispatchResult {
  const finalRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  return {
    lead,
    wing,
    final_verdict: finalVerdict,
    error,
    duration_s: totalDuration,
    rounds: rounds.map((r) => ({
      round: r.round_num,
      draft_length: r.draft_length,
      verdict: r.verdict,
      blocking_findings: r.blocking_findings,
      non_blocking_suggestions: r.suggestions,
      summary: r.summary,
      parse_retry_used: r.parse_retry_used,
      duration_s: r.duration_s,
      error: r.error,
    })),
    final_plan: finalRound ? finalRound.draft : "",
  };
}

// Helpers -----------------------------------------------------------------

function elapsedSec(t0: bigint): number {
  const ns = process.hrtime.bigint() - t0;
  return Number(ns) / 1e9;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// `isPlainObject` re-export keeps the test file's import surface compact.
export { isPlainObject };

// CLI ---------------------------------------------------------------------

interface CliArgs {
  designFile: string;
  generatePromptFile: string;
  reviewPromptFile: string;
  revisePromptFile: string;
  lead: AgentName;
  wing: AgentName;
  maxRounds: number;
  timeoutSec: number;
  wingTimeoutSec: number;
}

function usage(): string {
  return [
    "Usage: plan_dispatch.ts --design-file PATH --generate-prompt-file PATH \\",
    "                        --review-prompt-file PATH --revise-prompt-file PATH [options]",
    "",
    "Required:",
    "  --design-file PATH              Design doc the lead reads",
    "  --generate-prompt-file PATH     Lead round-1 generate-prompt template",
    "  --review-prompt-file PATH       Wing review-prompt template",
    "  --revise-prompt-file PATH       Lead revise-prompt template (rounds 2..N+1)",
    "",
    "Options:",
    `  --lead AGENT                    one of: ${VALID_AGENTS.join(", ")} (default ${DEFAULT_LEAD})`,
    `  --wing AGENT                    one of: ${VALID_AGENTS.join(", ")} (default ${DEFAULT_WING})`,
    `  --max-rounds N                  Max fix rounds (default ${DEFAULT_MAX_ROUNDS})`,
    `  --timeout N                     Per-lead-invocation timeout sec (default ${DEFAULT_TIMEOUT_SEC})`,
    `  --wing-timeout N                Per-wing-invocation timeout sec (default ${WING_TIMEOUT_DEFAULT_SEC})`,
  ].join("\n");
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = {
    designFile: "",
    generatePromptFile: "",
    reviewPromptFile: "",
    revisePromptFile: "",
    lead: DEFAULT_LEAD,
    wing: DEFAULT_WING,
    maxRounds: DEFAULT_MAX_ROUNDS,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    wingTimeoutSec: WING_TIMEOUT_DEFAULT_SEC,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const asAgent = (v: string, flag: string): AgentName => {
    if ((VALID_AGENTS as readonly string[]).includes(v)) return v as AgentName;
    throw new Error(`${flag} must be one of ${VALID_AGENTS.join(", ")} (got ${v})`);
  };
  const asInt = (v: string, flag: string): number => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`${flag} must be an integer (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--design-file":          args.designFile = need(i, a); i++; break;
      case "--generate-prompt-file": args.generatePromptFile = need(i, a); i++; break;
      case "--review-prompt-file":   args.reviewPromptFile = need(i, a); i++; break;
      case "--revise-prompt-file":   args.revisePromptFile = need(i, a); i++; break;
      case "--lead":                 args.lead = asAgent(need(i, a), a); i++; break;
      case "--wing":                 args.wing = asAgent(need(i, a), a); i++; break;
      case "--max-rounds":           args.maxRounds = asInt(need(i, a), a); i++; break;
      case "--timeout":              args.timeoutSec = asInt(need(i, a), a); i++; break;
      case "--wing-timeout":         args.wingTimeoutSec = asInt(need(i, a), a); i++; break;
      case "-h":
      case "--help":                 process.stdout.write(usage() + "\n"); process.exit(0);
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!args.designFile) throw new Error("--design-file is required");
  if (!args.generatePromptFile) throw new Error("--generate-prompt-file is required");
  if (!args.reviewPromptFile) throw new Error("--review-prompt-file is required");
  if (!args.revisePromptFile) throw new Error("--revise-prompt-file is required");
  if (args.maxRounds < 0) throw new Error("--max-rounds must be >= 0");
  if (args.timeoutSec <= 0) throw new Error("--timeout must be > 0");
  if (args.wingTimeoutSec <= 0) throw new Error("--wing-timeout must be > 0");
  return args;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${usage()}\n`);
    return 2;
  }

  const [designContent, generatePrompt, reviewPrompt, revisePrompt] = await Promise.all([
    readFile(args.designFile, "utf-8"),
    readFile(args.generatePromptFile, "utf-8"),
    readFile(args.reviewPromptFile, "utf-8"),
    readFile(args.revisePromptFile, "utf-8"),
  ]);

  const result: PlanDispatchResult | PreflightFailure = await runPlanDispatch({
    designContent,
    generatePrompt,
    reviewPrompt,
    revisePrompt,
    lead: args.lead,
    wing: args.wing,
    maxRounds: args.maxRounds,
    timeoutSec: args.timeoutSec,
    wingTimeoutSec: args.wingTimeoutSec,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return "final_verdict" in result && result.final_verdict === "approved" ? 0 : 1;
}

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
