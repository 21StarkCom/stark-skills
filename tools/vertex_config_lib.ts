/**
 * Resolve the Vertex AI project + location for headless Gemini dispatch
 * WITHOUT baking a GCP project id into committed source.
 *
 * Project precedence (first non-empty wins):
 *   1. STARK_GEMINI_VERTEX_PROJECT env            (explicit per-run override)
 *   2. models.gemini.vertex_project config         (ships EMPTY in global/config.json)
 *   3. GOOGLE_CLOUD_PROJECT env                     (GCP-standard ambient)
 *   4. `gcloud config get-value project`            (local machine, cached, best-effort)
 *   5. null  → caller degrades to the GEMINI_API_KEY path
 *
 * Location precedence:
 *   1. STARK_GEMINI_VERTEX_LOCATION env
 *   2. models.gemini.vertex_location config
 *   3. "global"  — preview models (e.g. gemini-3.1-pro-preview) ONLY exist on
 *      the global endpoint, so ambient GOOGLE_CLOUD_LOCATION (often a regional
 *      value like us-east1) is deliberately NOT consulted here.
 *
 * No project id is hardcoded anywhere in this file or its callers.
 */
import { execFileSync } from "node:child_process";

import { getModelsConfig } from "./stark_config_lib.ts";

export const DEFAULT_VERTEX_LOCATION = "global";

// undefined = not yet probed; null = probed, unset/failed; string = the project.
let gcloudProjectCache: string | null | undefined;

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** `gcloud config get-value project`, cached + best-effort (never throws). */
function gcloudProject(): string | null {
  if (gcloudProjectCache !== undefined) return gcloudProjectCache;
  try {
    const out = execFileSync("gcloud", ["config", "get-value", "project"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    gcloudProjectCache = out && out !== "(unset)" ? out : null;
  } catch {
    gcloudProjectCache = null;
  }
  return gcloudProjectCache;
}

/** Test seam: clear the cached gcloud-derived project. */
export function __resetVertexProjectCache(): void {
  gcloudProjectCache = undefined;
}

/**
 * Resolve the Vertex project, or null if none is configured. Pass
 * `{ allowGcloud: false }` to skip the local `gcloud` derivation (tests/CI).
 */
export function resolveVertexProject(opts: { allowGcloud?: boolean } = {}): string | null {
  const { allowGcloud = true } = opts;
  return (
    nonEmpty(process.env.STARK_GEMINI_VERTEX_PROJECT) ??
    nonEmpty(getModelsConfig().gemini?.vertex_project) ??
    nonEmpty(process.env.GOOGLE_CLOUD_PROJECT) ??
    (allowGcloud ? gcloudProject() : null)
  );
}

/** Resolve the Vertex location (always returns a value; defaults to "global"). */
export function resolveVertexLocation(): string {
  return (
    nonEmpty(process.env.STARK_GEMINI_VERTEX_LOCATION) ??
    nonEmpty(getModelsConfig().gemini?.vertex_location) ??
    DEFAULT_VERTEX_LOCATION
  );
}
