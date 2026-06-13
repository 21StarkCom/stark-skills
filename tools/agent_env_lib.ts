import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Standard binary directories that must be on PATH for the agent CLIs
// (claude, codex, gemini) — and the node runtime they need — to be found.
//
// The agent buildEnv functions forward only an allowlisted subset of env to
// the spawned subprocess, with PATH copied verbatim from the launching
// process. When a tool is launched from a context with a truncated PATH —
// cron, a sandbox, or a multiline shell that drops the login PATH — that
// stripped PATH gets forwarded and the agent binary can't be resolved, which
// Node surfaces as `spawn ENOTDIR`. We backfill these known-good dirs so the
// agent is always findable regardless of how the parent was launched.
const BASE_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function homeDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "Library", "pnpm", "bin"),
    path.join(home, "bin"),
  ];
}

/**
 * Return a PATH that includes the inherited PATH plus any standard binary
 * directories missing from it (and present on disk). Inherited entries keep
 * their original precedence; backfilled dirs are appended so they never
 * shadow a deliberately-chosen binary. Idempotent.
 */
export function resolvedPath(
  inherited: string | undefined = process.env.PATH,
): string {
  const existing = (inherited ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(existing);
  const extra: string[] = [];
  for (const dir of [...BASE_DIRS, ...homeDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (fs.existsSync(dir)) extra.push(dir);
  }
  return [...existing, ...extra].join(path.delimiter);
}
