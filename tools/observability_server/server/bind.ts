/**
 * Pure binding-rules logic. Extracted from `index.ts` so unit tests can
 * exercise every refusal path without standing up Fastify or SQLite.
 *
 * Bind decision tree (matches plan §1 Task 3):
 *   1. Read OBSERVABILITY_BIND (default 0.0.0.0) + OBSERVABILITY_PORT
 *      (default 7700). Refuse on non-integer/out-of-range port.
 *   2. Require OBSERVABILITY_PUBLISHED_HOST. Refuse if missing.
 *   3. If PUBLISHED_HOST is not in the loopback allowlist:
 *      - require OBSERVABILITY_ALLOW_LAN=1, OR
 *      - require OBSERVABILITY_TLS_TERMINATED=1, OR
 *      - require markerExists=true (i.e. /data/last_bootstrap_at present).
 *      Refuse with the operator-facing instructions otherwise.
 */

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1:7700",
  "::1:7700",
  "localhost:7700",
  "127.0.0.1:7799",
  "::1:7799",
  "localhost:7799",
]);

export interface BindDecision {
  bindHost: string;
  bindPort: number;
  publishedHost: string;
  isLan: boolean;
}

export class BindRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindRefused";
  }
}

export interface BindInputs {
  env: NodeJS.ProcessEnv;
  markerExists: boolean;
  /** absolute path to the bootstrap marker file (for error messages) */
  markerPath: string;
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

export function resolveBindDecision(inputs: BindInputs): BindDecision {
  const { env } = inputs;
  const bindHost = env.OBSERVABILITY_BIND ?? "0.0.0.0";
  const bindPortRaw = env.OBSERVABILITY_PORT ?? "7700";
  const bindPort = Number(bindPortRaw);
  if (!Number.isInteger(bindPort) || bindPort <= 0 || bindPort > 65535) {
    throw new BindRefused(`invalid OBSERVABILITY_PORT: ${bindPortRaw}`);
  }
  const publishedHost = env.OBSERVABILITY_PUBLISHED_HOST;
  if (!publishedHost) {
    throw new BindRefused(
      "OBSERVABILITY_PUBLISHED_HOST is required — the container cannot " +
        "infer the host-side publish address from inside Docker; set it " +
        "explicitly in the compose env block (e.g. 127.0.0.1:7700).",
    );
  }
  const isLan = !LOOPBACK_HOSTS.has(publishedHost);
  if (isLan) {
    const allow = envFlag(env, "OBSERVABILITY_ALLOW_LAN");
    const tls = envFlag(env, "OBSERVABILITY_TLS_TERMINATED");
    if (!allow || !tls || !inputs.markerExists) {
      throw new BindRefused(
        buildLanRefusalMessage({
          allow,
          tls,
          marker: inputs.markerExists,
          markerPath: inputs.markerPath,
        }),
      );
    }
  }
  return { bindHost, bindPort, publishedHost, isLan };
}

/**
 * Port-agnostic loopback check for the retention listener boot guard
 * (Phase 4 Task 1). Accepts host:port where host is 127.0.0.1, ::1
 * (bracketed `[::1]:N` or bare `::1:N`), or localhost. Anything else
 * is rejected so the prune-token-authenticated endpoint cannot be
 * republished outside the host.
 */
export function isLoopbackPublishedHost(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const trimmed = value.trim();
  let host: string;
  let portStr: string;
  if (trimmed.startsWith("[")) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
    if (m === null) return false;
    host = (m[1] ?? "").toLowerCase();
    portStr = m[2] ?? "";
  } else {
    const idx = trimmed.lastIndexOf(":");
    if (idx <= 0 || idx === trimmed.length - 1) return false;
    host = trimmed.slice(0, idx).toLowerCase();
    portStr = trimmed.slice(idx + 1);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function buildLanRefusalMessage(state: {
  allow: boolean;
  tls: boolean;
  marker: boolean;
  markerPath: string;
}): string {
  const reasons: string[] = [];
  if (!state.allow) reasons.push("OBSERVABILITY_ALLOW_LAN=1 missing");
  if (!state.tls) reasons.push("OBSERVABILITY_TLS_TERMINATED=1 missing");
  if (!state.marker) reasons.push(`${state.markerPath} not present`);
  return [
    `[server] non-loopback bind requested but ${reasons.join(", ")}.`,
    "[server] Required steps:",
    "[server]   1. Stop this stack.",
    "[server]   2. Restart with the default loopback bind (no OBSERVABILITY_BIND override, no docker-compose.override.yml).",
    "[server]   3. On the host, run: node --experimental-strip-types tools/observability_open.ts",
    "[server]   4. After the helper prints \"session established\", stop the stack.",
    "[server]   5. Apply the LAN override and restart.",
  ].join("\n");
}
