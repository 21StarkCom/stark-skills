// `isMainModule` — the "am I the process entrypoint?" guard for this plugin.
//
// Two idioms have already failed here, both the same way: silently. The guard
// evaluates false, `main()` never runs, nothing is written to stdout or stderr,
// and the process exits 0. It reads as success.
//
//   1. `import.meta.url === `file://${process.argv[1]}``
//      Breaks on any path containing a space (or any other character a URL must
//      percent-encode): `import.meta.url` encodes it, the template literal does
//      not. Claude Code can be configured with a config dir under
//      `~/Library/Application Support/...`, so this is a real install shape.
//
//   2. `import.meta.url === pathToFileURL(process.argv[1]).href`
//      Fixes (1) but breaks on **symlinks**: Node resolves `import.meta.url` to
//      the real path while `process.argv[1]` stays the path as invoked. That is
//      not hypothetical here — `housekeeping_infra.ts::ASSET_SYMLINKS` keeps
//      `~/.claude/plugins/stark-gh` pointed into the source checkout, and on
//      macOS `/tmp` and `/var` are themselves symlinks.
//
// This resolves BOTH sides to a canonical filesystem path before comparing, so
// spaces and symlinks are handled. Mirrors `tools/main_module_lib.ts`, which
// cannot be imported from here: `plugins/stark-gh/` is packaged by Bifrost as a
// self-contained plugin and carries no imports out of its own tree.
//
// Usage — pass the *caller's* own `import.meta.url`; inside this module
// `import.meta` would refer to the helper, not the entrypoint:
//
//   import { isMainModule } from "./lib/main_module.ts";
//   if (isMainModule(import.meta.url)) main();

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True iff the module identified by `importMetaUrl` is the process entrypoint
 * (`node <that-file>`), robust to spaces and to the entrypoint being reached
 * through a symlink. Never throws: a missing `argv[1]` or an unresolvable path
 * yields `false`, which is the correct answer when the module is imported as a
 * library.
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
