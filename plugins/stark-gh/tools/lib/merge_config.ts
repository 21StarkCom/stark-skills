// Per-repo merge defaults, read from the same `.stark-gh.json` the ticket
// policy lives in (lib/ticket.ts owns that file's other half).
//
// Why this exists: several merge flags describe a FACT about the target repo,
// not a choice about one run. `workplan-tools` deliberately has no CI on pull
// requests, so `/stark-gh:pr-merge` there spawns a watcher, observes no
// required checks, and waits out its 6-hour timeout — merging nothing, erroring
// nothing, and explaining nothing. The only fix was for whoever ran the merge to
// remember `--allow-no-required-checks` every single time. A rule an operator
// has to remember is a rule that gets missed; a repo-local file states the fact
// once, next to the repo it is true of.
//
// Shape (all keys optional):
//
//   { "merge": { "allowNoRequiredChecks": true, "noWatch": true } }
//
// Precedence: config supplies DEFAULTS; the command line wins. Every flag here
// is a boolean that only ever turns something ON, so "CLI wins" reduces to a
// logical OR — with the deliberate consequence that a config cannot be
// overridden back to off from the command line. If that is ever needed, the
// answer is an explicit `--no-<flag>`, not making the file authoritative.
//
// The secret waivers are settable here by explicit decision (2026-08-10), so a
// repo whose committed fixtures trip the scanner every run can say so once.
// They are reported on every run regardless of where they came from — see
// describeSource — because a waiver nobody can see is a waiver nobody reviews.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_CONFIG_BASENAME } from "./ticket.ts";

export interface MergeDefaults {
  allowNoRequiredChecks: boolean;
  allowSecretToLlm: boolean;
  allowSecretCommit: boolean;
  noWatch: boolean;
  watchTimeoutHours: number | null;
}

export const DEFAULT_MERGE_DEFAULTS: MergeDefaults = {
  allowNoRequiredChecks: false,
  allowSecretToLlm: false,
  allowSecretCommit: false,
  noWatch: false,
  watchTimeoutHours: null,
};

export interface MergeDefaultsLoad {
  defaults: MergeDefaults;
  warning: string | null;
  // Fatal: the file is PRESENT but its `merge` block is unusable. Same rule the
  // ticket policy follows — a config that was opted into fails CLOSED rather
  // than silently reverting to the built-in defaults, because the silent revert
  // is indistinguishable from the bug this feature exists to remove.
  error: string | null;
}

const BOOL_KEYS = [
  "allowNoRequiredChecks",
  "allowSecretToLlm",
  "allowSecretCommit",
  "noWatch",
] as const;

// Reads the `merge` block of <repoRoot>/.stark-gh.json. A missing file, or a
// file with no `merge` key, yields the built-in defaults and is not an error:
// most repos never need this.
export function loadMergeDefaults(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  exists: (p: string) => boolean = fs.existsSync,
): MergeDefaultsLoad {
  const cfgPath = path.join(repoRoot, REPO_CONFIG_BASENAME);
  const clean = { defaults: { ...DEFAULT_MERGE_DEFAULTS }, warning: null, error: null };
  if (!exists(cfgPath)) return clean;

  const fatal = (msg: string): MergeDefaultsLoad => ({
    defaults: { ...DEFAULT_MERGE_DEFAULTS },
    warning: null,
    error: `${REPO_CONFIG_BASENAME}: ${msg}`,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(cfgPath));
  } catch (err) {
    return fatal(`not valid JSON (${(err as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fatal("must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.merge === undefined) return clean;
  if (typeof o.merge !== "object" || o.merge === null || Array.isArray(o.merge)) {
    return fatal("merge must be a JSON object");
  }
  const m = o.merge as Record<string, unknown>;

  const defaults: MergeDefaults = { ...DEFAULT_MERGE_DEFAULTS };
  for (const k of BOOL_KEYS) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== "boolean") return fatal(`merge.${k} must be a boolean`);
    defaults[k] = m[k] as boolean;
  }
  if (m.watchTimeoutHours !== undefined) {
    const v = m.watchTimeoutHours;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return fatal("merge.watchTimeoutHours must be a positive number of hours");
    }
    defaults.watchTimeoutHours = v;
  }

  const known = new Set<string>([...BOOL_KEYS, "watchTimeoutHours"]);
  const unknown = Object.keys(m).filter((k) => !known.has(k));
  const warning = unknown.length
    ? `${REPO_CONFIG_BASENAME}: ignoring unknown merge key(s) ${unknown.join(", ")}`
    : null;
  return { defaults, warning, error: null };
}

// Which waivers this run is operating under, and where each came from. Printed
// by preflight so a config-supplied waiver is as visible as a typed one — the
// point of moving them into a file was to stop them being FORGOTTEN, not to
// stop them being seen.
export function describeSource(
  defaults: MergeDefaults,
  cli: { allowNoRequiredChecks: boolean; allowSecretToLlm: boolean; allowSecretCommit: boolean },
): string[] {
  const out: string[] = [];
  const note = (flag: string, fromCli: boolean, fromCfg: boolean) => {
    if (!fromCli && !fromCfg) return;
    out.push(`${flag}: ${fromCli ? "command line" : `${REPO_CONFIG_BASENAME}`}`);
  };
  note("--allow-no-required-checks", cli.allowNoRequiredChecks, defaults.allowNoRequiredChecks);
  note("--allow-secret-to-llm", cli.allowSecretToLlm, defaults.allowSecretToLlm);
  note("--allow-secret-commit", cli.allowSecretCommit, defaults.allowSecretCommit);
  return out;
}

// Config supplies defaults; the command line wins. Booleans only turn things on,
// so this is an OR — see the precedence note at the top of the file.
export function applyMergeDefaults<
  T extends {
    allowNoRequiredChecks: boolean;
    allowSecretToLlm: boolean;
    allowSecretCommit: boolean;
    noWatch: boolean;
    watchTimeoutHours: number;
  },
>(args: T, defaults: MergeDefaults, watchTimeoutWasExplicit: boolean): T {
  return {
    ...args,
    allowNoRequiredChecks: args.allowNoRequiredChecks || defaults.allowNoRequiredChecks,
    allowSecretToLlm: args.allowSecretToLlm || defaults.allowSecretToLlm,
    allowSecretCommit: args.allowSecretCommit || defaults.allowSecretCommit,
    noWatch: args.noWatch || defaults.noWatch,
    watchTimeoutHours:
      watchTimeoutWasExplicit || defaults.watchTimeoutHours === null
        ? args.watchTimeoutHours
        : defaults.watchTimeoutHours,
  };
}
