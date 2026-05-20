/**
 * GitHub PAT resolver — TypeScript port of `scripts/user_token.py`.
 *
 * Two user identities are supported:
 *   - primary   → aryeh-evinced
 *   - secondary → aryeh-admin
 *
 * Tokens are read from the macOS Keychain (service `stark-gh-token`,
 * accounts `{primary,secondary}-{fine,classic}`).
 *
 * This intentionally only addresses *user-identity* gh calls. Bot calls
 * keep using GitHub App installation tokens minted by `tools/github_app.ts`.
 */

import { spawnSync } from "node:child_process";

export type UserId = "primary" | "secondary";
export type TokenKind = "fine" | "classic" | "auto";

export const KEYCHAIN_SERVICE = "stark-gh-token";

/** Return a keychain secret, or null if not found. */
export function keychainGet(account: string): string | null {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const val = (r.stdout ?? "").trim();
  return val || null;
}

/**
 * Return a PAT for the requested identity and kind. Throws if absent.
 *
 * `auto` mode: secondary prefers classic because GetEvinced's
 * fine-grained PAT permission picker has no "Checks" entry, so
 * secondary-fine can't reach the /check-runs API that `gh pr checks`
 * needs. Primary is unaffected.
 */
export function getUserToken(
  user: UserId = "primary",
  kind: TokenKind = "auto",
  lookup: (account: string) => string | null = keychainGet,
): string {
  const fine = lookup(`${user}-fine`);
  const classic = lookup(`${user}-classic`);

  if (kind === "fine") {
    if (!fine) {
      throw new Error(`keychain: ${KEYCHAIN_SERVICE}/${user}-fine not found`);
    }
    return fine;
  }
  if (kind === "classic") {
    if (!classic) {
      throw new Error(`keychain: ${KEYCHAIN_SERVICE}/${user}-classic not found`);
    }
    return classic;
  }
  // auto mode
  if (user === "secondary" && classic) return classic;
  if (fine) return fine;
  if (classic) return classic;
  throw new Error(
    `keychain: neither ${KEYCHAIN_SERVICE}/${user}-fine nor ` +
      `${KEYCHAIN_SERVICE}/${user}-classic found`,
  );
}

/** Resolve the user identity: CLI flag > STARK_GH_USER env > "primary". */
export function resolveUser(
  cli: string | null,
  env: NodeJS.ProcessEnv = process.env,
): UserId {
  const val = (cli ?? env.STARK_GH_USER ?? "primary").toLowerCase();
  if (val !== "primary" && val !== "secondary") {
    throw new Error(`invalid user: '${val}' (expected primary|secondary)`);
  }
  return val;
}

/** Resolve the token kind: CLI flag > STARK_GH_TOKEN_KIND env > "auto". */
export function resolveKind(
  cli: string | null,
  env: NodeJS.ProcessEnv = process.env,
): TokenKind {
  const val = (cli ?? env.STARK_GH_TOKEN_KIND ?? "auto").toLowerCase();
  if (val !== "fine" && val !== "classic" && val !== "auto") {
    throw new Error(`invalid kind: '${val}' (expected fine|classic|auto)`);
  }
  return val;
}
