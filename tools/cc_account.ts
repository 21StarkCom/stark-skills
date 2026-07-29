#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * cc_account.ts — CLI behind `/stark-cc-user`. Switches the active Claude Code
 * account and reports each profile's rate-limit headroom.
 *
 * All inference lives in `cc_account_lib.ts`; this file is I/O only — Keychain
 * via `security`, `~/.claude.json`, and the statusline's usage snapshots.
 *
 * Subcommands:
 *   show                 active account + its headroom
 *   list                 registered profiles, active one marked
 *   add <name>           capture the CURRENT login as profile <name>
 *   use <name>           switch to profile <name>
 *   limits               headroom for every profile, best target first
 *   next [--apply]       print the best target (and optionally switch to it)
 *
 * Switching takes effect on the NEXT `claude` launch — the CLI reads its
 * credentials once at startup. Every mutating path says so on stdout.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  KEYCHAIN,
  describeProjection,
  parseSnapshot,
  projectUsage,
  rankProfiles,
  readClaudeCredsArgv,
  readProfileArgv,
  sanitizeEmail,
  validateStoredProfile,
  writeClaudeCredsArgv,
  writeProfileArgv,
  type Profile,
  type UsageSnapshot,
} from "./cc_account_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

const HOME = os.homedir();
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const REGISTRY = path.join(HOME, ".claude", ".cc-profiles.json");
const SNAPSHOT_DIR = path.join(HOME, ".claude");
const SNAPSHOT_PREFIX = ".cc-usage-";

// ── keychain ────────────────────────────────────────────────────────────

function security(argv: string[]): string {
  return execFileSync("/usr/bin/security", argv, {
    encoding: "utf8",
    // Keychain blobs are small; a bounded buffer keeps a corrupt item from
    // ballooning memory.
    maxBuffer: 4 * 1024 * 1024,
  }).replace(/\n$/, "");
}

function securityOrNull(argv: string[]): string | null {
  try {
    return security(argv);
  } catch {
    return null;
  }
}

// ── ~/.claude.json ──────────────────────────────────────────────────────

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Replace `oauthAccount` in place, preserving every other key.
 *
 * `~/.claude.json` holds the entire CLI state (project history, caches,
 * onboarding flags) — rewriting it wholesale would destroy that. The write is
 * staged to a temp file and renamed so an interrupted run cannot leave a
 * truncated file behind; on this filesystem `rename` is atomic.
 */
function writeOauthAccount(account: Record<string, unknown>): void {
  const cfg = readClaudeJson();
  cfg["oauthAccount"] = account;
  const tmp = `${CLAUDE_JSON}.cc-account.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, CLAUDE_JSON);
}

function currentAccount(): Record<string, unknown> | null {
  try {
    const acct = readClaudeJson()["oauthAccount"];
    return typeof acct === "object" && acct !== null
      ? (acct as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function currentEmail(): string | null {
  const email = currentAccount()?.["emailAddress"];
  return typeof email === "string" ? email : null;
}

// ── profile registry ────────────────────────────────────────────────────

function readRegistry(): Profile[] {
  if (!existsSync(REGISTRY)) return [];
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((e): Profile[] => {
      if (typeof e !== "object" || e === null) return [];
      const r = e as Record<string, unknown>;
      if (typeof r["name"] !== "string" || typeof r["email"] !== "string") {
        return [];
      }
      return [
        {
          name: r["name"],
          email: r["email"],
          ...(typeof r["label"] === "string" ? { label: r["label"] } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeRegistry(profiles: Profile[]): void {
  mkdirSync(path.dirname(REGISTRY), { recursive: true });
  const tmp = `${REGISTRY}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, REGISTRY);
  chmodSync(REGISTRY, 0o600);
}

// ── usage snapshots (written by statusline-command.sh) ──────────────────

/**
 * Load every snapshot the statusline has written, keyed by lowercased email.
 *
 * Read by directory scan rather than by iterating the registry, so a profile
 * that has never been registered still contributes a reading — and so a
 * renamed profile does not silently lose its history.
 */
function loadSnapshots(): Map<string, UsageSnapshot> {
  const out = new Map<string, UsageSnapshot>();
  let entries: string[];
  try {
    entries = readdirSync(SNAPSHOT_DIR);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    try {
      const snap = parseSnapshot(
        readFileSync(path.join(SNAPSHOT_DIR, name), "utf8"),
      );
      if (snap) out.set(sanitizeEmail(snap.email), snap);
    } catch {
      // A partially-written snapshot is skipped, not fatal — the statusline
      // rewrites it on the next tick.
    }
  }
  return out;
}

// ── commands ────────────────────────────────────────────────────────────

function cmdShow(): void {
  const acct = currentAccount();
  if (!acct) {
    console.log("no active account (could not read ~/.claude.json)");
    return;
  }
  const email = String(acct["emailAddress"] ?? "?");
  const org = String(acct["organizationName"] ?? "?");
  const type = String(acct["organizationType"] ?? "?");
  const seat = String(acct["seatTier"] ?? "?");
  const snap = loadSnapshots().get(sanitizeEmail(email));
  console.log(`active   ${email}`);
  console.log(`org      ${org} (${type}, seat ${seat})`);
  console.log(`usage    ${describeProjection(projectUsage(snap, nowSec()))}`);
}

function cmdList(): void {
  const profiles = readRegistry();
  if (profiles.length === 0) {
    console.log("no profiles registered — run `cc_account.ts add <name>`");
    return;
  }
  const active = currentEmail()?.toLowerCase();
  for (const p of profiles) {
    const mark = p.email.toLowerCase() === active ? "*" : " ";
    const stored = securityOrNull(readProfileArgv(p.name)) !== null;
    const state = stored ? "" : "  (no stored credentials — re-run `add`)";
    console.log(`${mark} ${p.name.padEnd(8)} ${p.email}${state}`);
  }
}

/**
 * Capture the CURRENT login as a named profile.
 *
 * Both halves are stored together so `use` can restore them as a unit. The
 * account must be logged in — there is no way to mint a profile for an account
 * you are not currently authenticated as; `claude /login` first, then `add`.
 */
function cmdAdd(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    fail(`invalid profile name ${JSON.stringify(name)} — use [a-z0-9._-]`);
  }
  const creds = securityOrNull(readClaudeCredsArgv());
  if (creds === null) {
    fail(
      `no \`${KEYCHAIN.claudeService}\` item in the login keychain — ` +
        `run \`claude\` and log in first`,
    );
  }
  const acct = currentAccount();
  if (!acct || typeof acct["emailAddress"] !== "string") {
    fail("~/.claude.json has no oauthAccount.emailAddress — log in first");
  }
  const email = acct["emailAddress"] as string;

  const record = JSON.stringify({ credentials: creds, oauthAccount: acct });
  validateStoredProfile(JSON.parse(record));
  security(writeProfileArgv(name, record));

  const profiles = readRegistry().filter(
    (p) => p.name !== name && p.email.toLowerCase() !== email.toLowerCase(),
  );
  profiles.push({ name, email });
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  writeRegistry(profiles);

  console.log(`stored profile ${name} → ${email}`);
}

function cmdUse(name: string): void {
  const raw = securityOrNull(readProfileArgv(name));
  if (raw === null) {
    fail(
      `no stored profile ${JSON.stringify(name)} under keychain service ` +
        `\`${KEYCHAIN.profileService}\` — run \`add ${name}\` while logged in as it`,
    );
  }
  let record;
  try {
    record = validateStoredProfile(JSON.parse(raw));
  } catch (err) {
    fail(`profile ${name} is corrupt: ${(err as Error).message}`);
  }

  // Snapshot the outgoing login first. Without this, switching away from an
  // account that was never `add`ed loses it permanently — the Keychain item is
  // about to be overwritten and OAuth blobs cannot be re-derived.
  const outgoing = currentEmail();
  const outgoingCreds = securityOrNull(readClaudeCredsArgv());
  const outgoingAcct = currentAccount();
  if (outgoing && outgoingCreds && outgoingAcct) {
    const known = readRegistry().find(
      (p) => p.email.toLowerCase() === outgoing.toLowerCase(),
    );
    if (known) {
      security(
        writeProfileArgv(
          known.name,
          JSON.stringify({
            credentials: outgoingCreds,
            oauthAccount: outgoingAcct,
          }),
        ),
      );
    }
  }

  // Both halves, or neither: the Keychain write is the one that can fail on a
  // locked keychain, so it goes first. If it throws, ~/.claude.json is
  // untouched and the previous account is still coherent.
  security(writeClaudeCredsArgv(record.credentials));
  writeOauthAccount(record.oauthAccount);

  console.log(`switched to ${name} → ${record.oauthAccount["emailAddress"]}`);
  console.log("restart `claude` to pick it up (credentials load at startup)");
}

function cmdLimits(): void {
  const profiles = readRegistry();
  if (profiles.length === 0) {
    console.log("no profiles registered — run `cc_account.ts add <name>`");
    return;
  }
  const active = currentEmail()?.toLowerCase();
  const ranked = rankProfiles(profiles, loadSnapshots(), nowSec());
  for (const { profile, projection } of ranked) {
    const mark = profile.email.toLowerCase() === active ? "*" : " ";
    console.log(
      `${mark} ${profile.name.padEnd(8)} ${describeProjection(projection)}`,
    );
  }
  console.log("");
  console.log(
    "reset = window provably rolled · floor = live window, usage only rises",
  );
}

function cmdNext(apply: boolean): void {
  const profiles = readRegistry();
  const active = currentEmail();
  const ranked = rankProfiles(profiles, loadSnapshots(), nowSec(), {
    exclude: active ? [active] : [],
  });
  const best = ranked[0];
  if (!best) {
    fail("no candidate profile — register one with `add <name>`");
  }
  if (!apply) {
    console.log(
      `${best.profile.name}  ${best.profile.email}  ` +
        `${describeProjection(best.projection)}`,
    );
    console.log("# re-run with --apply to switch");
    return;
  }
  cmdUse(best.profile.name);
}

// ── plumbing ────────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function fail(msg: string): never {
  process.stderr.write(`cc_account: ${msg}\n`);
  process.exit(1);
}

const USAGE = `usage: cc_account.ts <command>

  show              active account + headroom
  list              registered profiles ('*' = active)
  add <name>        store the current login as profile <name>
  use <name>        switch to profile <name>
  limits            headroom for every profile, best target first
  next [--apply]    best target other than the active one
`;

export function main(argv: string[] = process.argv.slice(2)): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "show":
      return cmdShow();
    case "list":
      return cmdList();
    case "add":
      if (!rest[0]) fail("add requires a profile name");
      return cmdAdd(rest[0]);
    case "use":
      if (!rest[0]) fail("use requires a profile name");
      return cmdUse(rest[0]);
    case "limits":
      return cmdLimits();
    case "next":
      return cmdNext(rest.includes("--apply"));
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
