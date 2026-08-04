/**
 * GitHub PAT resolver — the rate-limit escape hatch behind `/stark-gh-user`.
 *
 *   - primary   → aryeh-stark   (THE identity; matches gh's own keyring login)
 *   - secondary → a deliberately-provisioned relief account, for when
 *                 aryeh-stark's GraphQL/REST hourly bucket runs dry
 *
 * IDENTITY POLICY: `aryeh-stark` authors everything unless Aryeh explicitly
 * asks otherwise. `secondary` therefore exists ONLY for a human to reach for by
 * hand — `/stark-gh-user` carries `disable-model-invocation: true` so no model
 * can select it, and nothing in this repo calls `getUserToken` automatically.
 * Do not wire this resolver into a tool, skill or hook: swapping identity mid-run
 * would silently re-author whatever came next.
 *
 * Tokens are read from the macOS Keychain (service `stark-gh-token`,
 * accounts `{primary,secondary}-{fine,classic}`).
 *
 * STATE (checked 2026-08-04): all four Keychain entries are ABSENT, so every
 * lookup throws until they are seeded — the skill is a working mechanism with no
 * credentials behind it yet. Provision `primary-*` from `aryeh-stark` first;
 * `secondary-*` only when a relief account is actually wanted.
 *
 * The three candidate accounts (`aryeh-stark`, `aryeh-evinced`, `aryeh-admin`)
 * all still EXIST on GitHub — verified live 2026-08-04. An earlier note in this
 * repo called the latter two retired; that was inferred from the empty Keychain
 * and is wrong. What is retired is their use as a default, not the accounts.
 *
 * This intentionally only addresses *user-identity* gh calls. Bot calls keep
 * using GitHub App installation tokens minted by `tools/github_app.ts`, whose
 * only sanctioned use is posting multi-LLM review findings.
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
