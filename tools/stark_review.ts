import type { AgentName } from "./stark_review_lib.ts";
import type { BuiltCommand, ParseResult } from "./agent_codex.ts";

/**
 * Structural interface every per-agent module satisfies. The dispatcher
 * resolves the chosen agent to one of these and uses it to drive the CLI.
 */
export interface AgentPort {
  buildCommand(prompt: string, model?: string): BuiltCommand;
  parseOutput(stdout: string): ParseResult;
}

const AGENT_MODULE_PATHS: Readonly<Record<AgentName, string>> = Object.freeze({
  claude: "./agent_claude.ts",
  codex: "./agent_codex.ts",
  gemini: "./agent_gemini.ts",
});

const portCache: Map<AgentName, Promise<AgentPort>> = new Map();

/**
 * Dynamically import the per-agent module and return its AgentPort.
 *
 * Cached per-process by agent name, so a multi-domain run that resolves to a
 * single agent imports the module exactly once. Module-load itself never
 * throws for V1.1 stubs — those throw only when their `buildCommand` /
 * `parseOutput` is invoked. Pre-dispatch failure for unsupported agents is
 * the dispatcher's responsibility (call `buildCommand` once per resolved
 * agent before spawning anything).
 */
export async function loadAgentPort(agent: AgentName): Promise<AgentPort> {
  const cached = portCache.get(agent);
  if (cached) return cached;

  const modulePath = AGENT_MODULE_PATHS[agent];
  if (!modulePath) {
    throw Object.assign(
      new Error(`loadAgentPort: unknown agent '${agent}'`),
      { code: "agent_not_supported" as const },
    );
  }

  const promise = import(modulePath).then((mod): AgentPort => {
    if (
      typeof mod.buildCommand !== "function" ||
      typeof mod.parseOutput !== "function"
    ) {
      throw Object.assign(
        new Error(
          `loadAgentPort: module ${modulePath} does not export buildCommand/parseOutput`,
        ),
        { code: "agent_not_supported" as const },
      );
    }
    return {
      buildCommand: mod.buildCommand as AgentPort["buildCommand"],
      parseOutput: mod.parseOutput as AgentPort["parseOutput"],
    };
  });

  portCache.set(agent, promise);
  try {
    return await promise;
  } catch (err) {
    portCache.delete(agent);
    throw err;
  }
}

/**
 * Eagerly resolve every unique agent in the resolved domain→agent map. Any
 * V1.1 stub trips its error here — before any subprocess is spawned — and
 * surfaces as `error.code='agent_not_supported'` with the original message.
 */
export async function resolveAgentPorts(
  agentByDomain: Record<string, AgentName>,
): Promise<Map<AgentName, AgentPort>> {
  const unique = new Set<AgentName>(Object.values(agentByDomain));
  const out = new Map<AgentName, AgentPort>();
  for (const agent of unique) {
    const port = await loadAgentPort(agent);
    // Probe the module: stubs throw at call time, not at import time. We do a
    // single buildCommand("") probe per agent to fail fast before dispatch.
    try {
      port.buildCommand("");
    } catch (err) {
      throw Object.assign(
        new Error(
          `agent '${agent}' is not supported by the TS pipeline yet: ${(err as Error).message}`,
        ),
        { code: "agent_not_supported" as const, cause: err },
      );
    }
    out.set(agent, port);
  }
  return out;
}

/**
 * Test-only: clear the per-process import cache. Production callers should
 * not need this — the cache is naturally per-process.
 */
export function _resetAgentPortCacheForTests(): void {
  portCache.clear();
}
