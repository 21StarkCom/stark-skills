// Per-repo merge defaults, read from the same `.stark-gh.json` the ticket
// policy lives in (lib/ticket.ts owns that file's other half).
//
// Why this exists: several merge flags describe a FACT about the target repo,
// not a choice about one run. A repo with no CI on pull requests has no
// required checks to wait for, so `/stark-gh:pr-merge` stops with
// `no_required_checks` after the 300s grace (gh_watch_runs.ts) — naming
// `--allow-no-required-checks` as the remedy — and the operator must retype
// that flag on every single merge, forever, for a fact that never changes.
// Stating it once, in the repo it is true of, is what this replaces.
//
// NOTE what the motivation is NOT. It is not a silent hang: since 2026-07-29
// a persistently vacuous rollup goes terminal with an explicit named remedy,
// and a non-draft PR is refused up front. The cost here is repetition, not
// data loss — which is exactly why the SECRET waivers are read from the base
// branch only (below) rather than treated as ordinary conveniences.
//
// # Trust boundary: config comes from the BASE, never the working tree
//
// These settings waive gates that police the very diff being merged. Reading
// them from the checked-out branch would let a PR authorize itself: a branch
// that commits `{"merge":{"allowSecretCommit":true}}` next to a live token
// would turn off the scan that would have caught it, and the token would land
// on main. So the file is read from the merge BASE ref — content that is
// already on the trunk, reviewed by whatever process guards it. A branch may
// propose a change to these settings; it cannot benefit from it until merged.
//
// Shape (all keys optional):
//
//   { "merge": { "allowNoRequiredChecks": true, "noWatch": true } }
//
// Precedence: config supplies DEFAULTS; the command line wins. Every flag here
// is a boolean that only ever turns something ON, so "CLI wins" reduces to a
// logical OR — and a config could therefore never be turned back off for one
// run, which stranded merges behind settings nobody typed. `--ignore-repo-config`
// is that escape hatch: it drops the file entirely for this run, which is also
// the only way past a config that is committed-and-broken.

import { KNOWN_TOP_LEVEL_KEYS, REPO_CONFIG_BASENAME } from "./ticket.ts";

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
  // than silently reverting to the built-in defaults. `--ignore-repo-config`
  // is the deliberate way past it, so one bad commit cannot wedge a repo.
  error: string | null;
}

const BOOL_KEYS = [
  "allowNoRequiredChecks",
  "allowSecretToLlm",
  "allowSecretCommit",
  "noWatch",
] as const;

// One week. A watcher's timeout is its only guaranteed exit: it holds a lock
// that blocks every later merge of the same PR, so an unbounded value (a
// milliseconds-for-hours mix-up, say) strands the PR behind a process that must
// be found and killed by hand.
export const MAX_WATCH_TIMEOUT_HOURS = 168;

// Reads the `merge` block of `<ref>:.stark-gh.json`. A missing file, or a file
// with no `merge` key, yields the built-in defaults and is not an error: most
// repos never need this.
//
// `readAtRef` returns the file's content at the base ref, or null when it does
// not exist there. Injecting it keeps this module pure and testable, and keeps
// the trust boundary in one place.
export function loadMergeDefaults(
  read: () => string | null,
  // How to name the source in an error. The merge path reads a git ref; pr-open
  // validates the working-tree copy. Hardcoding "the merge base" sent operators
  // to inspect a ref that was fine when the real problem was a local file mode.
  sourceLabel = REPO_CONFIG_BASENAME,
): MergeDefaultsLoad {
  const clean = { defaults: { ...DEFAULT_MERGE_DEFAULTS }, warning: null, error: null };
  const fatal = (msg: string): MergeDefaultsLoad => ({
    defaults: { ...DEFAULT_MERGE_DEFAULTS },
    warning: null,
    error: `${REPO_CONFIG_BASENAME}: ${msg}`,
  });

  // Read failures are reported as read failures. Folding them into the JSON
  // catch below sent operators to inspect the syntax of a file whose syntax was
  // never the problem — and, for EACCES, one they cannot open at all.
  let text: string | null;
  try {
    text = read();
  } catch (err) {
    return fatal(`could not be read (${sourceLabel}): ${(err as Error).message}`);
  }
  if (text === null) return clean;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fatal(`not valid JSON (${(err as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fatal("must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const warnings: string[] = [];
  // A misspelled or miscased top-level key is the failure this whole feature
  // exists to remove, wearing a correct-looking config file: `{"Merge":{…}}`
  // would otherwise be silently inert and the operator would watch the merge
  // fail for reasons the file appears to have already handled.
  const unknownTop = Object.keys(o).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknownTop.length) {
    const nearMiss = unknownTop.find((k) => k.toLowerCase().replace(/s$/, "") === "merge");
    if (nearMiss) {
      return fatal(`unknown top-level key "${nearMiss}" — did you mean "merge"?`);
    }
    warnings.push(`ignoring unknown top-level key(s) ${unknownTop.join(", ")}`);
  }

  if (o.merge === undefined) {
    return {
      defaults: { ...DEFAULT_MERGE_DEFAULTS },
      warning: warnings.length ? `${REPO_CONFIG_BASENAME}: ${warnings.join("; ")}` : null,
      error: null,
    };
  }
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
    if (v > MAX_WATCH_TIMEOUT_HOURS) {
      return fatal(
        `merge.watchTimeoutHours must be at most ${MAX_WATCH_TIMEOUT_HOURS} (one week); got ${v} — hours, not milliseconds`,
      );
    }
    defaults.watchTimeoutHours = v;
  }

  // A misspelling INSIDE the block is the same failure as one at the top level:
  // the file looks correct, the setting does nothing, and the operator watches
  // the merge fail for a reason the config appears to have handled. So a key
  // that is a near-miss of a real one is fatal; only a genuinely foreign key
  // (a future version's, say) degrades to a warning.
  const known = new Set<string>([...BOOL_KEYS, "watchTimeoutHours"]);
  const canon = (k: string) => k.toLowerCase().replace(/s$/, "");
  const knownCanon = new Map([...known].map((k) => [canon(k), k]));
  const unknown = Object.keys(m).filter((k) => !known.has(k));
  for (const k of unknown) {
    const hit = knownCanon.get(canon(k));
    if (hit) return fatal(`unknown merge key "${k}" — did you mean "${hit}"?`);
  }
  if (unknown.length) warnings.push(`ignoring unknown merge key(s) ${unknown.join(", ")}`);
  return {
    defaults,
    warning: warnings.length ? `${REPO_CONFIG_BASENAME}: ${warnings.join("; ")}` : null,
    error: null,
  };
}

export interface WaiverNote {
  flag: string;
  fromConfig: boolean;
}

// Every setting this run is operating under, and where each came from.
//
// ALL of them, not just the allow* trio: a config-supplied `noWatch` skips the
// wait for CI to go green, which is as consequential as any waiver and was
// previously the one setting nothing printed. A waiver nobody can see is a
// waiver nobody reviews.
export function describeSource(
  defaults: MergeDefaults,
  cli: {
    allowNoRequiredChecks: boolean;
    allowSecretToLlm: boolean;
    allowSecretCommit: boolean;
    noWatch: boolean;
    watchTimeoutExplicit: boolean;
  },
): WaiverNote[] {
  const out: WaiverNote[] = [];
  const note = (flag: string, fromCli: boolean, fromCfg: boolean) => {
    if (!fromCli && !fromCfg) return;
    out.push({ flag, fromConfig: !fromCli });
  };
  note("--allow-no-required-checks", cli.allowNoRequiredChecks, defaults.allowNoRequiredChecks);
  note("--allow-secret-to-llm", cli.allowSecretToLlm, defaults.allowSecretToLlm);
  note("--allow-secret-commit", cli.allowSecretCommit, defaults.allowSecretCommit);
  note("--no-watch", cli.noWatch, defaults.noWatch);
  // Only when it is actually the value in force. Announcing a config timeout an
  // explicit --watch-timeout already overrode tells the operator a number that
  // is not the one being used, on the very line they read to find out.
  if (defaults.watchTimeoutHours !== null && !cli.watchTimeoutExplicit) {
    out.push({ flag: `--watch-timeout ${defaults.watchTimeoutHours}`, fromConfig: true });
  }
  return out;
}

export function renderWaiver(n: WaiverNote): string {
  return `${n.flag}: ${n.fromConfig ? REPO_CONFIG_BASENAME : "command line"}`;
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
    watchTimeoutExplicit: boolean;
  },
>(args: T, defaults: MergeDefaults): T {
  return {
    ...args,
    allowNoRequiredChecks: args.allowNoRequiredChecks || defaults.allowNoRequiredChecks,
    allowSecretToLlm: args.allowSecretToLlm || defaults.allowSecretToLlm,
    allowSecretCommit: args.allowSecretCommit || defaults.allowSecretCommit,
    noWatch: args.noWatch || defaults.noWatch,
    watchTimeoutHours:
      args.watchTimeoutExplicit || defaults.watchTimeoutHours === null
        ? args.watchTimeoutHours
        : defaults.watchTimeoutHours,
  };
}
