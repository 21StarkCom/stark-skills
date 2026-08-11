// `isMainModule` — the symlink-safe "am I the process entrypoint?" guard.
//
// The naive idiom
//   `import.meta.url === pathToFileURL(process.argv[1]).href`
// silently breaks when the entrypoint is invoked through a **symlink**: Node
// sets `import.meta.url` to the real (symlink-resolved) path, while
// `process.argv[1]` stays the path as invoked (the symlink). The two hrefs
// differ, the guard is `false`, `main()` never runs, and the CLI exits 0 having
// done nothing — a silent no-op that looks like success.
//
// That is not an edge case here: these tools are *designed* to be reached
// through the `~/.claude/code-review` fallback (a symlink into this repo) on
// direct (non-plugin) invocations — see `asset_root_lib.ts`. So the
// symlinked path is the common one, and the naive guard no-ops exactly it.
//
// This resolves BOTH sides to a canonical filesystem path (following symlinks)
// before comparing, so a symlinked entrypoint still matches. Usage:
//
//   import { isMainModule } from "./main_module_lib.ts";
//   if (isMainModule(import.meta.url)) { main(); }
//
// Pass the *caller's* own `import.meta.url` — inside this module `import.meta`
// would refer to the helper, not the entrypoint.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True iff the module identified by `importMetaUrl` is the process entrypoint
 * (`node <that-file>`), robust to the entrypoint being invoked via a symlink.
 * Never throws: a missing `argv[1]` or an unresolvable path yields `false`.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
