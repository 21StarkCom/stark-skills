/**
 * Claude Code CLI integration helpers — TypeScript port of
 * `scripts/claude_utils.py`.
 *
 * Constants and helpers shared by the dispatch orchestrators that invoke
 * the Claude CLI. The Python imported `config_loader` + `runtime_env`;
 * this port reads config via `stark_config_lib.ts` and builds the clean
 * env via `runtime_env_lib.ts`.
 */

import { AgentDisabledError } from "./agent_disabled_error.ts";
import { buildAgentEnv } from "./runtime_env_lib.ts";
import { getModelId, isAgentEnabled } from "./stark_config_lib.ts";

export { AgentDisabledError };

/** Default model — pinned to avoid drift when the CLI default changes. */
export const CLAUDE_MODEL = "claude-opus-4-8";

/**
 * Return an allowlisted env with the Anthropic API key, for headless
 * dispatch. Delegates to `runtime_env_lib.buildAgentEnv("claude", "local")`
 * so the subprocess sees only allowlisted vars and `ANTHROPIC_API_KEY`
 * sourced from `ANTHROPIC_AGENTS`. The "local" operation fetches no
 * GitHub App token — used by callers that don't touch GitHub.
 */
export function makeCleanEnv(): Promise<Record<string, string>> {
  return buildAgentEnv("claude", "local");
}

export interface BuildClaudeCmdOptions {
  /** "text" or "json" (default "text"). */
  outputFormat?: string;
  /** Comma-separated tool allowlist (e.g. "Edit,Write,Read,Bash"). */
  allowedTools?: string;
}

/**
 * Build a Claude CLI command for headless one-shot execution. The caller
 * appends the stdin marker (`-` is already included) or a literal prompt.
 * Throws if the claude agent is disabled in config.
 */
export function buildClaudeCmd(options: BuildClaudeCmdOptions = {}): string[] {
  if (!isAgentEnabled("claude")) {
    throw new AgentDisabledError("claude agent is disabled in config");
  }
  const modelId = getModelId("claude") || CLAUDE_MODEL;
  const cmd = [
    "claude",
    "-p",
    "-",
    "--output-format",
    options.outputFormat ?? "text",
    "--model",
    modelId,
    "--no-session-persistence",
  ];
  if (options.allowedTools) {
    cmd.push("--allowedTools", options.allowedTools);
  }
  return cmd;
}
