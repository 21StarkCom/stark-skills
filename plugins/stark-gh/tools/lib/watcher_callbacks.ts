// Whitelist of allowed --on-green callback names. The watcher resolves a
// flag value against this map; arbitrary tool paths are forbidden.

import * as path from "node:path";
import * as url from "node:url";

export const WATCHER_CALLBACKS = {
  "pr-merge-complete": "gh_pr_merge_complete.ts",
  // Future: "pr-rebase-complete": "...",
} as const;

export type CallbackName = keyof typeof WATCHER_CALLBACKS;

export function isCallbackName(s: string): s is CallbackName {
  return Object.prototype.hasOwnProperty.call(WATCHER_CALLBACKS, s);
}

// Resolve callback name to absolute tool path. The tools dir is the
// directory containing this file's parent (lib/) — so .../tools/<file>.
// Returns null for unknown names; callers must reject before any spawn.
export function resolveCallback(name: string): string | null {
  if (!isCallbackName(name)) return null;
  const filename = WATCHER_CALLBACKS[name];
  // import.meta.url ⇒ .../tools/lib/watcher_callbacks.ts
  const here = url.fileURLToPath(import.meta.url);
  const toolsDir = path.dirname(path.dirname(here));
  return path.join(toolsDir, filename);
}
