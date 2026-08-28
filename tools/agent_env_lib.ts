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

/**
 * Env vars forwarded to a spawned agent CLI (claude, codex, gemini).
 *
 * Deliberately minimal — GH_TOKEN/GITHUB_TOKEN/STARK_PUSH_TOKEN and the
 * Anthropic keys are excluded so a reviewer subprocess cannot exfiltrate
 * posting credentials. This is the single owner of that list; the three
 * agent modules and `optimize_skill_description.ts` import it rather than
 * each keeping a copy, because they previously kept four copies and they
 * drifted (see USER below).
 *
 * USER is load-bearing, not cosmetic. Without it the claude CLI cannot
 * resolve its Keychain identity and degrades to an unauthenticated path,
 * failing with "Not logged in · Please run /login" or "Credit balance is
 * too low" depending on account state — with no other signal that the env
 * is at fault. Reproduced deterministically against 2.1.220:
 *
 *   env -i HOME=… PATH=… LANG=… TMPDIR=…        claude -p x  -> is_error
 *   env -i HOME=… PATH=… LANG=… TMPDIR=… USER=… claude -p x  -> ok
 *
 * `copilot_dispatch.ts` already allowlisted USER; that fix was never
 * back-ported here, which is exactly the drift this shared constant ends.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_SCOPES` /
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` must NEVER be added here. Measured: the
 * claude CLI authenticates from those env vars alone (empty HOME, no
 * credentials written, `oauthAccount` left absent, global Keychain item
 * untouched), so a dispatch site can hand a subprocess its OWN seat instead of
 * riding the one global login every parallel session fights over. Allowlisting
 * them forwards whatever the LAUNCHING shell happens to carry, which silently
 * shadows an injected seat — the subprocess then bills an account nobody chose,
 * and a personal-org token on a team seat surfaces as "Credit balance is too
 * low" with nothing pointing at the env. `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` is
 * additionally inert: injected with an expired access token the CLI fails
 * `401 OAuth access token has expired` without attempting a refresh, so it buys
 * nothing even when it is the value you wanted. Two of the three are already
 * credential-shaped (`isCredentialEnvKey`), but `..._SCOPES` is not — the
 * exclusion is pinned explicitly in `subagent_env_allowlist.test.ts`.
 */
export const AGENT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
];

/**
 * Credentials an agent subprocess must never receive, by exact name.
 *
 * The allowlist above is the primary defense, but not every dispatch path
 * uses one: `copilot_dispatch.ts::makeGeminiEnv` copies the ambient env
 * wholesale because the gemini CLI needs its own auth vars, and a denylist is
 * the only control available there. A gemini lead runs `--yolo` (every tool
 * call auto-approved) over attacker-controllable diff text, so an inherited
 * PAT or App private key is one prompt injection away from leaving the host.
 *
 * Deliberately NOT here: `DATABASE_URL` / `TEST_DATABASE_URL`. They are
 * credentials, but the copilot lead is their declared consumer — blocking
 * them globally would be a capability removal, not a hardening. The reviewer
 * path blocks them locally instead (`stark_review.ts::FORBIDDEN_ENV_KEYS`),
 * which is the per-consumer split the leak actually calls for.
 */
const CREDENTIAL_ENV_EXACT: ReadonlySet<string> = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ADMIN_TOKEN",
  "STARK_PUSH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AGENTS",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
]);

/**
 * Keys that match a credential pattern but are an agent's OWN model auth, so
 * withholding them breaks dispatch rather than protecting anything. Kept
 * narrow by construction: only what a spawned agent CLI authenticates with.
 */
const CREDENTIAL_ENV_KEEP: ReadonlySet<string> = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

/** Matches the credential-shaped names the exact list cannot enumerate — in
 *  particular `STARK_{CLAUDE,CODEX,GEMINI}_PRIVATE_KEY_21S`, which
 *  `github_app_lib` reads as its Keychain fallback. */
const CREDENTIAL_ENV_PATTERN =
  /PRIVATE_KEY|(^|_)(TOKEN|SECRET|PASSWORD)($|_)|_API_KEY$/;

/**
 * True when `key` names a credential that must not reach an agent subprocess.
 * Single owner of that judgement — denylist sites import it rather than each
 * keeping a two-key set, which is how the gemini path came to forward every
 * posting credential the other builders deliberately withhold.
 */
export function isCredentialEnvKey(key: string): boolean {
  if (CREDENTIAL_ENV_KEEP.has(key)) return false;
  if (CREDENTIAL_ENV_EXACT.has(key)) return true;
  return CREDENTIAL_ENV_PATTERN.test(key);
}
