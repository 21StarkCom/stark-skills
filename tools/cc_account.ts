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
 *   remove <name>        forget a profile (credentials + registry entry)
 *   prune                forget every profile with no stored credentials
 *   reset [--yes]        forget EVERY stored login (irreversible; previews first)
 *   limits               headroom for every profile, best target first
 *   next [--dry-run]     switch to the next profile in the rotation
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
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  KEYCHAIN,
  applyOrder,
  describeProjection,
  nextInCycle,
  orderedProfiles,
  seatKeyOf,
  parseSnapshot,
  projectUsage,
  deleteAnyProfileArgv,
  deleteProfileArgv,
  mergeProfile,
  parseNextFlags,
  parseResetFlags,
  rankProfiles,
  readClaudeCredsArgv,
  readProfileArgv,
  removeProfile,
  resolveClaudeKeychainAccount,
  seatIncoherence,
  validateStoredProfile,
  writeClaudeCredsArgv,
  writeProfileArgv,
  type Profile,
  type UsageSnapshot,
} from "./cc_account_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

const HOME = os.homedir();
/** The Keychain account the Claude CLI keys its credentials item by. */
const CLAUDE_ACCOUNT = resolveClaudeKeychainAccount(process.env);
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
    // A missing item is an expected state (`list` probes every profile), and
    // inherited stderr would spray `SecKeychainSearchCopyNext` noise per probe.
    stdio: ["ignore", "pipe", "pipe"],
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

/** Seat key of the live login — the identity of the active account. */
function currentSeatKey(): string | null {
  return seatKeyOf(currentAccount());
}

// ── profile registry ────────────────────────────────────────────────────

/**
 * Read the registry, backfilling `seatKey` on entries from earlier versions.
 *
 * Earlier versions keyed profiles by email, then by org alone. Both merged
 * distinct seats. Entries written then carry no seat key; the stored Keychain
 * record always holds both halves, so the key is recovered from there and the
 * registry rewritten. An entry whose record is gone keeps its (unusable) shape
 * and simply ranks `unknown`, rather than being silently dropped.
 */
function readRegistry(): Profile[] {
  if (!existsSync(REGISTRY)) return [];
  let parsed: Profile[];
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    parsed = raw.flatMap((e): Profile[] => {
      if (typeof e !== "object" || e === null) return [];
      const r = e as Record<string, unknown>;
      if (typeof r["name"] !== "string" || typeof r["email"] !== "string") {
        return [];
      }
      return [
        {
          name: r["name"],
          email: r["email"],
          ...(typeof r["seatKey"] === "string"
            ? { seatKey: r["seatKey"] }
            : {}),
          ...(typeof r["label"] === "string" ? { label: r["label"] } : {}),
          ...(typeof r["order"] === "number" && Number.isFinite(r["order"])
            ? { order: r["order"] }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }

  let changed = false;
  const migrated = parsed.map((p): Profile => {
    if (p.seatKey) return p;
    const stored = securityOrNull(readProfileArgv(p.name));
    if (!stored) return p;
    try {
      const acct = (JSON.parse(stored) as { oauthAccount?: unknown })
        .oauthAccount as Record<string, unknown> | undefined;
      const seatKey = seatKeyOf(acct);
      if (!seatKey) return p;
      changed = true;
      const label = acct?.["organizationName"];
      return {
        ...p,
        seatKey,
        ...(typeof label === "string" ? { label } : {}),
      };
    } catch {
      return p;
    }
  });
  if (changed) {
    try {
      writeRegistry(migrated);
    } catch {
      // Backfill is an optimization; a read-only home must not break `list`.
    }
  }
  return migrated;
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
 * Load every snapshot the statusline has written, keyed by lowercased seatKey.
 *
 * Read by directory scan rather than by iterating the registry, so a profile
 * that has never been registered still contributes a reading — and so a
 * renamed profile does not silently lose its history.
 *
 * Keyed on the record's own `seat_key` rather than on the filename: the two
 * agree, and trusting the content means a file left by an earlier keying scheme
 * cannot be mistaken for a valid entry (it has no `seat_key`, so
 * `parseSnapshot` rejects it outright).
 *
 * The map key is the RAW lowercased seat key, never `sanitizeKey`'d.
 * `sanitizeKey` exists only to make a key safe as a FILENAME — it rewrites `:`
 * to `_`, so using it here would key the map on a form that no caller looks up
 * (`rankProfiles` joins on `profile.seatKey`). That mismatch silently reported
 * every profile as `unknown`.
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
      if (snap) out.set(snap.seatKey.toLowerCase(), snap);
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
  const seatKey = seatKeyOf(acct);
  const snap = seatKey
    ? loadSnapshots().get(seatKey.toLowerCase())
    : undefined;
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
  const active = currentSeatKey()?.toLowerCase();
  // Listed in CYCLE order, not alphabetically — `list` is how you check the
  // sequence `next` will walk, so it must show that sequence.
  for (const p of orderedProfiles(profiles)) {
    const mark = p.seatKey && p.seatKey.toLowerCase() === active ? "*" : " ";
    const stored = securityOrNull(readProfileArgv(p.name)) !== null;
    const state = stored ? "" : "  (no stored credentials — re-run `add`)";
    const pos = p.order === undefined ? "  -" : String(p.order + 1).padStart(3);
    console.log(
      `${mark}${pos}  ${p.name.padEnd(8)} ${p.email}${orgSuffix(p)}${state}`,
    );
  }
}

/**
 * Org name in parentheses. Always shown, not only on collision: two profiles
 * on one address are indistinguishable without it, and a display that changes
 * shape depending on what else is registered is harder to read, not easier.
 */
function orgSuffix(p: Profile): string {
  return p.label ? `  (${p.label})` : "";
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
  const creds = securityOrNull(readClaudeCredsArgv(CLAUDE_ACCOUNT));
  if (creds === null) {
    fail(
      `no \`${KEYCHAIN.claudeService}\` item for account ` +
        `\`${CLAUDE_ACCOUNT}\` in the login keychain — ` +
        `run \`claude\` and log in first`,
    );
  }
  const acct = currentAccount();
  if (!acct || typeof acct["emailAddress"] !== "string") {
    fail("~/.claude.json has no oauthAccount.emailAddress — log in first");
  }
  const email = acct["emailAddress"] as string;
  const seatKey = seatKeyOf(acct);
  if (!seatKey) {
    fail(
      "~/.claude.json oauthAccount is missing accountUuid/organizationUuid — " +
        "log in first",
    );
  }
  const label =
    typeof acct["organizationName"] === "string"
      ? (acct["organizationName"] as string)
      : undefined;

  const record = JSON.stringify({ credentials: creds, oauthAccount: acct });
  const parsed = validateStoredProfile(JSON.parse(record));
  // Refuse to bottle a mismatched pair. The live Keychain item is shared by
  // every running `claude`, so a concurrent session's token refresh can land
  // under this account's identity; storing that makes the profile permanently
  // unusable and the failure surfaces much later as a billing error.
  const bad = seatIncoherence(parsed);
  if (bad) {
    fail(
      `refusing to store ${name}: ${bad}.\n` +
        `Quit every other running \`claude\`, re-run \`claude /login\` as ` +
        `${email}, pick the right organization, then \`add ${name}\` again.`,
    );
  }
  security(writeProfileArgv(name, record));

  const { profiles, displaced } = mergeProfile(readRegistry(), {
    name,
    email,
    seatKey,
    ...(label ? { label } : {}),
  });
  writeRegistry(profiles);

  console.log(`stored profile ${name} → ${email}${label ? ` (${label})` : ""}`);
  if (displaced) {
    console.log(`replaced ${displaced.name} — same seat, renamed`);
  }
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
  // A profile stored before this guard existed can still hold mismatched
  // halves. Switching to it authenticates as the wrong plan, which the CLI
  // reports as a credit-balance error rather than as an auth problem — so say
  // it here, where the cause is still visible.
  const incoherent = seatIncoherence(record);
  if (incoherent) {
    fail(
      `profile ${name} is incoherent: ${incoherent}.\n` +
        `Switching to it would authenticate as the wrong plan (the CLI reports ` +
        `that as "Credit balance is too low"). Repair it: quit every other ` +
        `running \`claude\`, \`claude /login\` as ` +
        `${record.oauthAccount["emailAddress"]}, select the ` +
        `${JSON.stringify(record.oauthAccount["organizationName"] ?? "")} ` +
        `organization, then \`add ${name}\`.`,
    );
  }

  // Snapshot the outgoing login first. Without this, switching away from an
  // account that was never `add`ed loses it permanently — the Keychain item is
  // about to be overwritten and OAuth blobs cannot be re-derived.
  //
  // Matched by SEAT, not email or org. Matching by either component would
  // write the outgoing account's credentials into a DIFFERENT seat's stored
  // profile whenever the two share that component — silently corrupting the
  // profile it overwrote.
  const outgoingSeat = currentSeatKey();
  const outgoingCreds = securityOrNull(readClaudeCredsArgv(CLAUDE_ACCOUNT));
  const outgoingAcct = currentAccount();
  if (outgoingSeat && outgoingCreds && outgoingAcct) {
    const known = readRegistry().find(
      (p) => p.seatKey?.toLowerCase() === outgoingSeat.toLowerCase(),
    );
    if (known) {
      const snapshot = {
        credentials: outgoingCreds,
        oauthAccount: outgoingAcct,
      };
      // This write is where corruption is actually minted: if another live
      // `claude` refreshed the shared credentials item since this account was
      // selected, the pair on disk is already mismatched. Overwriting a good
      // stored profile with it destroys a working credential, so skip instead
      // — the outgoing account keeps whatever was last known good.
      const stale = seatIncoherence(snapshot);
      if (stale) {
        console.error(
          `warning: not re-capturing ${known.name} — ${stale}. ` +
            `Another running \`claude\` likely refreshed the shared ` +
            `credentials item; ${known.name} keeps its previous record.`,
        );
      } else {
        security(writeProfileArgv(known.name, JSON.stringify(snapshot)));
      }
    }
  }

  // Both halves, or neither: the Keychain write is the one that can fail on a
  // locked keychain, so it goes first. If it throws, ~/.claude.json is
  // untouched and the previous account is still coherent.
  security(writeClaudeCredsArgv(CLAUDE_ACCOUNT, record.credentials));
  writeOauthAccount(record.oauthAccount);

  console.log(`switched to ${name} → ${record.oauthAccount["emailAddress"]}`);
  console.log("restart `claude` to pick it up (credentials load at startup)");
}

/**
 * Forget a profile: its stored credentials AND its registry entry.
 *
 * Deleting the Keychain record is irreversible — an OAuth blob cannot be
 * re-derived, so recovering the account means `claude /login` + `add` again.
 * That is why removing the ACTIVE profile warns: the live credentials item is
 * a separate entry and stays intact, so nothing breaks right now, but `use`
 * re-captures the outgoing account only when it is still registered. Without
 * its entry, switching away drops that seat's credentials for good.
 */
function cmdRemove(name: string): void {
  const { profiles, removed } = removeProfile(readRegistry(), name);
  const storedName = removed?.name ?? name;
  const hadRecord = securityOrNull(readProfileArgv(storedName)) !== null;
  if (!removed && !hadRecord) {
    fail(`no profile ${JSON.stringify(name)} — nothing to remove`);
  }

  if (hadRecord) security(deleteProfileArgv(storedName));
  if (removed) writeRegistry(profiles);

  console.log(
    `removed ${storedName}${removed?.email ? ` → ${removed.email}` : ""}` +
      `${hadRecord ? "" : " (registry entry only — no stored credentials)"}`,
  );
  const active = currentSeatKey()?.toLowerCase();
  if (removed?.seatKey && active && removed.seatKey.toLowerCase() === active) {
    console.log(
      "warning: that was the ACTIVE account. You stay logged in, but it is no " +
        "longer registered — switching away will not preserve its credentials. " +
        "Re-run `add` to keep it.",
    );
  }
}

/**
 * Drop every registered profile that has no stored credentials.
 *
 * These are dead weight by construction: `next` already skips them because
 * they cannot be switched to, so they only pad `list` and `order`. Nothing is
 * destroyed — there is no credential left to destroy, which is precisely what
 * qualifies an entry for pruning.
 */
function cmdPrune(dryRun: boolean): void {
  const profiles = readRegistry();
  const dead = profiles.filter(
    (p) => securityOrNull(readProfileArgv(p.name)) === null,
  );
  if (dead.length === 0) {
    console.log("nothing to prune — every profile has stored credentials");
    return;
  }
  for (const p of dead) {
    console.log(`${dryRun ? "would prune" : "pruned"}  ${p.name}  ${p.email}`);
  }
  if (dryRun) {
    console.log(`# --dry-run: ${dead.length} kept`);
    return;
  }
  const names = new Set(dead.map((p) => p.name));
  writeRegistry(profiles.filter((p) => !names.has(p.name)));
  console.log(`pruned ${dead.length} profile(s) with no stored credentials`);
}

/**
 * Forget EVERY stored login and start over.
 *
 * Deliberately narrow: it drains the `stark-cc-token` Keychain service and
 * deletes the registry. It does NOT touch the live `Claude Code-credentials`
 * item or `~/.claude.json`, so you stay logged in as whoever you are right now
 * and can `add` that account back immediately — a reset that logged you out
 * would leave no account from which to rebuild.
 *
 * The drain loops `deleteAnyProfileArgv` instead of walking registry names, so
 * ORPHANED records — stored credentials whose registry entry was lost — go too.
 * Walking names would leave those behind invisibly, which is the exact state a
 * "start over" is meant to clear.
 *
 * Usage snapshots are KEPT unless `--snapshots`: they are per-seat headroom
 * readings that cannot be regenerated retroactively, and they stay valid for
 * any seat you re-`add`. Losing them re-ranks every profile as `unknown`.
 *
 * Previews unless `--yes`. OAuth blobs cannot be re-derived — every account
 * dropped here needs a fresh `claude /login`.
 */
function cmdReset(confirmed: boolean, snapshots: boolean): void {
  const profiles = readRegistry();
  const registryExists = existsSync(REGISTRY);
  const snapFiles = snapshots ? listSnapshotFiles() : [];

  if (profiles.length === 0 && !registryExists && snapFiles.length === 0) {
    // Probe once: a drained registry can still hide orphaned records.
    if (securityOrNull(deleteAnyProfileArgv()) === null) {
      console.log("nothing stored — already clean");
      return;
    }
    console.log("registry is empty but orphaned credential records exist");
  }

  const verb = confirmed ? "deleted" : "would delete";
  for (const p of profiles) {
    console.log(`${verb}  ${p.name.padEnd(8)} ${p.email}`);
  }
  for (const f of snapFiles) {
    console.log(`${verb}  snapshot  ${f}`);
  }

  if (!confirmed) {
    console.log("");
    console.log(
      `# preview only — ${profiles.length} profile(s)` +
        `${snapshots ? ` + ${snapFiles.length} snapshot(s)` : ""} would be ` +
        `forgotten IRREVERSIBLY (OAuth blobs cannot be re-derived).`,
    );
    console.log(
      "# Re-run with --yes to do it. You stay logged in as the current " +
        "account, so `add <name>` can register it again straight away.",
    );
    if (!snapshots) {
      console.log(
        "# Usage snapshots are kept — pass --snapshots to clear those too.",
      );
    }
    return;
  }

  // Drain the service one item at a time; `security` deletes a single match per
  // call and exits non-zero once none are left. Bounded so a `security` that
  // keeps succeeding cannot spin forever.
  let drained = 0;
  const LIMIT = 500;
  while (drained < LIMIT && securityOrNull(deleteAnyProfileArgv()) !== null) {
    drained++;
  }
  if (drained >= LIMIT) {
    fail(
      `stopped after deleting ${LIMIT} credential records — ` +
        `\`security\` never reported the service empty. Re-run to continue.`,
    );
  }

  if (registryExists) rmSync(REGISTRY, { force: true });
  for (const f of snapFiles) {
    rmSync(path.join(SNAPSHOT_DIR, f), { force: true });
  }

  const orphans = drained - profiles.length;
  console.log(
    `reset: ${drained} credential record(s) deleted` +
      `${orphans > 0 ? ` (${orphans} orphaned, not in the registry)` : ""}, ` +
      `registry cleared` +
      `${snapshots ? `, ${snapFiles.length} snapshot(s) removed` : ""}`,
  );
  console.log(
    "You are still logged in as the current account — run `add <name>` to " +
      "register it, then `claude /login` + `add` for each of the others.",
  );
}

/** Snapshot filenames currently on disk, or `[]` if the dir is unreadable. */
function listSnapshotFiles(): string[] {
  try {
    return readdirSync(SNAPSHOT_DIR).filter((n) => n.startsWith(SNAPSHOT_PREFIX));
  } catch {
    return [];
  }
}

function cmdLimits(): void {
  const profiles = readRegistry();
  if (profiles.length === 0) {
    console.log("no profiles registered — run `cc_account.ts add <name>`");
    return;
  }
  const active = currentSeatKey()?.toLowerCase();
  const ranked = rankProfiles(profiles, loadSnapshots(), nowSec());
  for (const { profile, projection } of ranked) {
    const mark =
      profile.seatKey && profile.seatKey.toLowerCase() === active ? "*" : " ";
    console.log(
      `${mark} ${profile.name.padEnd(8)} ${describeProjection(projection)}`,
    );
  }
  console.log("");
  console.log(
    "reset = window provably rolled · floor = live window, usage only rises",
  );
}

/**
 * Walk the rotation cycle: the profile AFTER the active one, wrapping.
 *
 * This is a fixed sequence, not a headroom ranking — you asked for a
 * predictable round-robin, and predictability is the point: you always know
 * which account comes next without reading percentages. `--best` still exposes
 * the ranked pick (provably-reset > lowest floor > unknown) when you want the
 * emptiest window instead of the next one in line.
 *
 * Profiles without stored credentials are skipped: they cannot be switched to,
 * so stopping on one would dead-end the cycle.
 *
 * Switches by default — `--dry-run` to preview the pick instead.
 */
function cmdNext(apply: boolean, best: boolean): void {
  const profiles = readRegistry();
  const active = currentSeatKey();
  const hasCreds = (p: Profile) =>
    securityOrNull(readProfileArgv(p.name)) !== null;

  let target: Profile | null;
  let why: string;
  if (best) {
    const ranked = rankProfiles(profiles, loadSnapshots(), nowSec(), {
      exclude: active ? [active] : [],
    }).filter((r) => hasCreds(r.profile));
    target = ranked[0]?.profile ?? null;
    why = ranked[0] ? describeProjection(ranked[0].projection) : "";
  } else {
    target = nextInCycle(profiles, active, hasCreds);
    why = "next in rotation";
  }

  if (!target) {
    fail("no candidate profile — register one with `add <name>`");
  }
  if (target.seatKey && active && target.seatKey.toLowerCase() === active.toLowerCase()) {
    console.log(`${target.name} is the only switchable profile — already active`);
    return;
  }
  if (!apply) {
    console.log(
      `${target.name}  ${target.email}${orgSuffix(target)}  ${why}`,
    );
    console.log("# --dry-run: not switched");
    return;
  }
  cmdUse(target.name);
}

/**
 * Show or set the rotation order.
 *
 * `order` with no names prints the current cycle; with names it places them in
 * that sequence. Unlisted profiles keep their place after the listed ones, so a
 * partial reorder never drops an account out of the cycle.
 */
function cmdOrder(names: string[]): void {
  const profiles = readRegistry();
  if (profiles.length === 0) {
    console.log("no profiles registered — run `cc_account.ts add <name>`");
    return;
  }
  if (names.length === 0) {
    for (const [i, p] of orderedProfiles(profiles).entries()) {
      const placed = p.order === undefined ? " (unplaced)" : "";
      console.log(`${String(i + 1).padStart(3)}  ${p.name}${placed}`);
    }
    return;
  }
  const known = new Set(profiles.map((p) => p.name.toLowerCase()));
  const unknown = names.filter((n) => !known.has(n.toLowerCase()));
  if (unknown.length > 0) {
    fail(`unknown profile(s): ${unknown.join(", ")}`);
  }
  writeRegistry(applyOrder(profiles, names));
  console.log(`rotation order set (${names.length} placed)`);
  for (const [i, p] of orderedProfiles(readRegistry()).entries()) {
    console.log(`${String(i + 1).padStart(3)}  ${p.name}`);
  }
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
  remove <name>     forget profile <name> (credentials + registry entry)
  prune             forget every profile with no stored credentials
                    ( --dry-run = list them only )
  reset             forget EVERY stored login and start over
                    ( previews unless --yes · --snapshots also clears headroom )
  limits            headroom for every profile, best target first
  next              switch to the next profile in the rotation
                    ( --dry-run = preview only · --best = emptiest instead )
  order [names...]  show the rotation cycle, or set it
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
    case "remove":
    case "rm":
      if (!rest[0]) fail("remove requires a profile name");
      return cmdRemove(rest[0]);
    case "prune":
      return cmdPrune(rest.includes("--dry-run"));
    case "reset": {
      const { confirmed, snapshots, unknown } = parseResetFlags(rest);
      if (unknown.length > 0) {
        fail(
          `reset: unknown flag(s) ${unknown.join(", ")} — ` +
            `accepts --yes, --dry-run, --snapshots`,
        );
      }
      return cmdReset(confirmed, snapshots);
    }
    case "limits":
      return cmdLimits();
    case "next": {
      const { apply, best } = parseNextFlags(rest);
      return cmdNext(apply, best);
    }
    case "order":
      return cmdOrder(rest.filter((a) => !a.startsWith("-")));
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
