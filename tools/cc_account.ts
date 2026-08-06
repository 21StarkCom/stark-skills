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
  classifyNextOutcome,
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
  type CredentialState,
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

/** `security` exit status for "the item does not exist". */
const ERR_ITEM_NOT_FOUND = 44;

/**
 * Probe a stored profile, distinguishing "not there" from "could not look".
 *
 * `securityOrNull` collapses both into null, which is fine where the caller
 * only needs a value, but not where the ANSWER drives a remedy: telling an
 * operator with a locked keychain that their profiles have no credentials
 * points them at `add <name>`, which overwrites the intact record with the
 * currently-logged-in seat's token.
 */
function probeProfile(name: string): CredentialState {
  return readProfileRecord(name).state;
}

/**
 * Read a stored profile, distinguishing "not there" from "could not look".
 *
 * Every command that asks "does this profile have credentials?" goes through
 * here. The two-state `securityOrNull` shape is what made a locked keychain
 * look identical to an empty one, and the remedy for those two is opposite:
 * `add` for absent, unlock-and-retry for unreadable. Wiring the tri-state into
 * `next` alone left `prune` (which rewrites the registry), `list` and `use`
 * (which print the destructive remedy) reading the old way, so the commands
 * contradicted each other for identical state.
 */
function readProfileRecord(
  name: string,
): { state: CredentialState; raw: string | null } {
  try {
    return { state: "present", raw: security(readProfileArgv(name)) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      state: status === ERR_ITEM_NOT_FOUND ? "absent" : "unreadable",
      raw: null,
    };
  }
}

/**
 * Probe including coherence — the state `next` needs.
 *
 * A profile whose two halves contradict each other reads fine but `use`
 * refuses it, so treating it as switchable dead-ends the rotation forever:
 * the picker is deterministic, so it selects the same broken profile on every
 * run and never reaches the healthy ones behind it.
 */
function probeProfileForSwitch(name: string): CredentialState {
  const { state, raw } = readProfileRecord(name);
  if (state !== "present" || raw === null) return state;
  try {
    return seatIncoherence(validateStoredProfile(JSON.parse(raw)))
      ? "incoherent"
      : "present";
  } catch {
    // Corrupt/unparseable is not switchable either, and `use` reports the
    // specific parse error far better than this probe could.
    return "incoherent";
  }
}

/** Shared refusal for a keychain that could not be read. Never says `add`. */
function failUnreadable(names: readonly string[]): never {
  return fail(
    `cannot read the keychain for: ${names.join(", ")}\n` +
      "Unlock the login keychain and retry. Do NOT run `add` to 'fix' this — " +
      "it would overwrite stored credentials that cannot be re-derived.",
  );
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
    // Tri-state: "could not read" must NOT print the `add` remedy, which
    // overwrites the very blob that is probably still intact.
    const probed = probeProfile(p.name);
    const state =
      probed === "present"
        ? ""
        : probed === "absent"
          ? "  (no stored credentials — re-run `add`)"
          : "  (credentials unreadable — unlock the keychain; do NOT `add`)";
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
  const probed = readProfileRecord(name);
  // `next` refuses on an unreadable keychain and tells the operator not to
  // run `add`; naming the target directly is the natural next command, so it
  // must not hand back the destructive remedy `next` just withheld.
  if (probed.state === "unreadable") failUnreadable([name]);
  const raw = probed.raw;
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
  // Refuse rather than guess: reporting "no stored credentials" for a record
  // we could not read drops the registry entry while leaving the blob behind,
  // orphaned where neither `remove` nor `prune` can ever reach it again.
  const removeProbe = probeProfile(storedName);
  if (removeProbe === "unreadable") failUnreadable([storedName]);
  const hadRecord = removeProbe === "present";
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
  const probed = profiles.map((p) => ({ p, state: probeProfile(p.name) }));
  // Refuse outright rather than prune a partial picture. `prune` is the only
  // command that rewrites the registry on the strength of "this profile has no
  // credentials", so reading a locked keychain as "all absent" emptied the
  // whole registry — names, seat keys and the hand-set order cycle — while the
  // Keychain records survived with nothing left to enumerate them by name.
  const unreadable = probed.filter((x) => x.state === "unreadable");
  if (unreadable.length > 0) failUnreadable(unreadable.map((x) => x.p.name));
  const dead = probed.filter((x) => x.state === "absent").map((x) => x.p);
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
/**
 * Warn about registered profiles whose stored record is gone.
 *
 * Without this the rotation collapses silently: with one good profile left and
 * nine emptied by a partial `reset` or a few `remove`s, `next` reported a clean
 * "already active" every time and never named the nine. The operator learns the
 * rotation is gone when the 5h window closes and there is nothing to switch to.
 */
function reportStale(stale: readonly string[]): void {
  if (stale.length === 0) return;
  // Deliberately does NOT prescribe `prune`. A credential-less entry is often
  // an intentional placeholder — CLAUDE.md tells the operator to keep them,
  // because they hold their rotation slot while a pruned one rejoins at the
  // end of the cycle. Printing the one remedy that costs the slot, on every
  // single run, trains the reader to ignore a channel that also has to carry
  // genuinely-broken profiles.
  process.stderr.write(
    `cc_account: note: skipped ${stale.join(", ")} — no stored credentials ` +
      "(re-`add` while logged in as each to restore; harmless if a placeholder)\n",
  );
}

/** Profiles skipped because they could not be read or are internally inconsistent. */
function reportUnusable(names: readonly string[]): void {
  if (names.length === 0) return;
  process.stderr.write(
    `cc_account: warning: skipped ${names.join(", ")} — unreadable or ` +
      "internally inconsistent; `list` and `use <name>` report which\n",
  );
}

function cmdNext(apply: boolean, best: boolean): void {
  const profiles = readRegistry();
  const active = currentSeatKey();

  // One sweep for the DECISION: the picker and the dead-end classification now
  // read the same snapshot, where before they swept independently and a
  // keychain locking between them produced "nothing to switch to" — the one
  // message naming neither a remedy nor a profile — on a full registry.
  //
  // Not the only keychain read in this command, and the comment used to claim
  // otherwise: `readRegistry()` above backfills a missing `seatKey` from the
  // stored record, through the two-state reader. A legacy entry probed while
  // the keychain is locked therefore keeps no seatKey and compares unequal to
  // the live seat. Legacy entries are the only ones affected, and the backfill
  // rewrites them once they can be read.
  const credentials = new Map<string, CredentialState>(
    profiles.map((p) => [p.name, probeProfileForSwitch(p.name)]),
  );

  let why = "next in rotation";
  const outcome = classifyNextOutcome({
    profiles,
    active,
    credentials,
    pick: (candidates) => {
      if (!best) return nextInCycle(candidates, active);
      const ranked = rankProfiles(candidates, loadSnapshots(), nowSec(), {
        exclude: active ? [active] : [],
      });
      why = ranked[0] ? describeProjection(ranked[0].projection) : "";
      return ranked[0]?.profile ?? null;
    },
    // Only `--best` filters the active seat out (via rankProfiles' exclude),
    // so only `--best` is unanswerable without knowing it. Cycle mode has a
    // documented answer and is the sole route back from a lost login.
    pickerExcludesActive: best,
  });

  switch (outcome.kind) {
    case "empty":
      fail("no candidate profile — register one with `add <name>`");
    // falls through — `fail` never returns
    case "unreadable":
      // Deliberately NOT "re-run `add`": the records may be perfectly intact
      // and `add` would overwrite them with the current login's token.
      fail(
        "cannot read the keychain for: " +
          outcome.names.join(", ") +
          "\nUnlock the login keychain and retry. Do NOT run `add` to " +
          "'fix' this — it would overwrite the stored credentials, which " +
          "cannot be re-derived.",
      );
    case "no-credentials":
      fail(
        "no profile has stored credentials — re-run `add <name>` for one of: " +
          outcome.names.join(", ") +
          "\n(`add` captures the CURRENT login, so log in as that account first.)",
      );
    case "unknown-active":
      // Without the live seat we cannot tell "switch" from "switch to the one
      // already in use", and the headroom picker excludes nothing in this
      // state — so it would return the live account and report a successful
      // switch. Refusing is the only answer that cannot be wrong.
      fail(
        "cannot determine the active seat from ~/.claude.json — refusing to " +
          "switch.\nRun `show` to inspect it; `claude /login` rewrites it.",
      );
    case "all-incoherent":
      fail(
        "every profile's stored halves contradict each other: " +
          outcome.names.join(", ") +
          "\nQuit every other `claude`, `/login` as each, pick the right " +
          "organization, then re-`add` it.",
      );
    case "none":
      fail("no candidate profile — nothing to switch to");
    default:
      break;
  }

  if (outcome.kind === "switch" || outcome.kind === "already-active") {
    reportStale(outcome.stale);
    reportUnusable(outcome.unreadable);
  }

  if (outcome.kind === "already-active") {
    // Not an error: nothing to do is a clean outcome, and a caller branching
    // on `rc` must not get a different answer depending on the mode it asked
    // for. Both modes reach this one line, naming the same profile.
    // "the only" would be a lie when several profiles share the active seat —
    // `list` marks them all, and the operator reads the singular as evidence
    // that a registry entry was lost.
    console.log(
      `${outcome.target.name} is already active — nothing to switch to`,
    );
    return;
  }

  const target = outcome.target;
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
  // A help request anywhere wins, before any per-command flag parse. The
  // unknown-flag guards below are hard errors, so without this `next --help`
  // answered a request for the usage text with exit 1 — and this CLI's own
  // convention (and the repo's) is that every tool honors `--help`.
  if (rest.some((a) => a === "-h" || a === "--help" || a === "help")) {
    process.stdout.write(USAGE);
    return;
  }
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
    case "prune": {
      // Same guard as `next` and `reset`, and for the same reason: `prune`
      // writes the registry by default, so `--dry-rn` silently dropped every
      // credential-less entry — including the placeholders kept on purpose to
      // hold their rotation slot.
      const unknown = rest.filter((a) => a !== "--dry-run");
      if (unknown.length > 0) {
        fail(
          `prune: unknown flag(s) ${unknown.join(", ")} — accepts --dry-run`,
        );
      }
      return cmdPrune(rest.includes("--dry-run"));
    }
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
      const { apply, best, unknown } = parseNextFlags(rest);
      // Hard error, never ignore: this command's default ACTS, so a typo'd
      // `--dry-run` silently performed a live swap.
      if (unknown.length > 0) {
        fail(
          `unknown flag(s) for next: ${unknown.join(", ")} — ` +
            "expected --dry-run, --apply or --best",
        );
      }
      return cmdNext(apply, best);
    }
    case "order": {
      // Was `rest.filter((a) => !a.startsWith("-"))`, which SWALLOWED flags:
      // `order --dry-run T0 T1` discarded the flag and rewrote the cycle,
      // dropping the `order` of every profile the operator did not list.
      const unknown = rest.filter((a) => a.startsWith("-"));
      if (unknown.length > 0) {
        fail(
          `order: unknown flag(s) ${unknown.join(", ")} — ` +
            "order takes profile names only (no flags)",
        );
      }
      return cmdOrder(rest);
    }
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
