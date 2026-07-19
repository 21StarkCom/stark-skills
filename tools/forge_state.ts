// `tools/forge_state.ts` — the HOST (disk) layer for the `/stark-forge`
// pipeline orchestrator. All persistence lives here; the pure state machine
// (`forge_state_lib.ts`) stays disk-free and imports NOTHING from this file.
//
// Phase 3 delivers the persistence half (state.json read/write/prune, latest
// pointer, resume-candidate discovery). Phase 5 adds the CLI subcommands to
// this same file.
//
// HARD CONSTRAINTS (spec §5, plan §2.5):
//   - State lives under `stateRoot()/history/forge/<slug>/<run-id>/state.json`,
//     never in the repo. State location comes ONLY from `stateRoot()`.
//   - State files are written mode 0600.
//   - The three history helpers (`writeJsonAtomic`, `updateLatestPointer`,
//     `pruneRunDirs`) are CONSUMED from `stark_review_doc_lib.ts`, never
//     reimplemented.
//   - Retention is `history_keep_runs` from `getForgePipelineConfig()`.
//   - Runs are repository-bound: discovery filters to the current repo identity
//     and never surfaces another repo's run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./asset_root_lib.ts";
import { getForgePipelineConfig } from "./stark_config_lib.ts";
import {
  pruneRunDirs,
  updateLatestPointer,
  writeJsonAtomic,
} from "./stark_review_doc_lib.ts";
import {
  ForgeStateError,
  mergePointsFor,
  sanitizeSlug,
} from "./forge_state_lib.ts";
import type {
  MergePoint,
  RepoIdentity,
  RunState,
  Stage,
  StageRecord,
  StageStatus,
} from "./forge_state_lib.ts";

// ---------------------------------------------------------------------------
// Disk-boundary safety — every path segment derived from a slug or run-id is
// validated HERE, at the one seam where untrusted names touch the filesystem,
// so no caller can traverse out of `stateRoot()/history/forge`.
// ---------------------------------------------------------------------------

/**
 * Reject any slug that is not already a canonical sanitized kebab segment.
 * `sanitizeSlug` is the single owner of the safe-segment rule (no `/`, no `..`,
 * no leading dot); a slug that survives it unchanged is provably safe. Callers
 * must sanitize at run-creation time (`initializeRun`), so a mismatch here means
 * an unsanitized/hostile value reached the disk layer — fail closed.
 */
function assertSafeSlug(slug: string): string {
  if (typeof slug !== "string" || sanitizeSlug(slug) !== slug) {
    throw new ForgeStateError(
      "unsafe_slug",
      `forge: refusing unsafe slug '${slug}' (must be a canonical sanitized segment)`,
    );
  }
  return slug;
}

/**
 * Reject any run-id that is not a safe single path segment. Run-ids are
 * host-minted (`<timestamp>-<rand>`), so anything with a separator, `..`, a
 * leading dot, or a NUL is hostile — fail closed rather than traverse.
 */
function assertSafeRunId(runId: string): string {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("\0") ||
    runId.startsWith(".") ||
    runId.includes("..")
  ) {
    throw new ForgeStateError(
      "unsafe_run_id",
      `forge: refusing unsafe run id '${runId}'`,
    );
  }
  return runId;
}

// ---------------------------------------------------------------------------
// Path layout
// ---------------------------------------------------------------------------

/** `stateRoot()/history/forge` — the forge history root (resolved per-call so a
 * test's `STARK_STATE_ROOT` override always takes effect). */
export function forgeHistoryRoot(): string {
  return path.join(stateRoot(), "history", "forge");
}

/** The per-slug directory holding all of a slug's run dirs + `latest` pointer.
 * Enforces slug safety at the disk boundary. */
export function slugDir(slug: string): string {
  return path.join(forgeHistoryRoot(), assertSafeSlug(slug));
}

/** The `state.json` path for a specific run. Enforces slug + run-id safety. */
function stateFile(slug: string, runId: string): string {
  return path.join(slugDir(slug), assertSafeRunId(runId), "state.json");
}

// ---------------------------------------------------------------------------
// RunState validation — shared by loadState (reports corruption) and
// listResumeCandidates (skips corrupt entries). A parseable-but-corrupt state
// (e.g. `repo: {}`) must never crash discovery of every other valid run.
// ---------------------------------------------------------------------------

// The closed enums the persisted schema must conform to. Defined here (the
// host validator's concern) rather than exported from the pure lib to honor
// this step's scope discipline (`forge_state_lib.ts` = sanitizeSlug only).
const VALID_STAGES = new Set<Stage>([
  "write-spec",
  "review-spec",
  "red-team-spec",
  "spec-to-plan",
  "review-plan",
  "red-team-plan",
  "plan-to-tasks",
  "copilot",
]);
const VALID_STATUSES = new Set<StageStatus>([
  "pending",
  "running",
  "halted",
  "done",
  "failed",
]);
const VALID_INPUT_KINDS = new Set(["intent", "spec-path", "plan-path"]);
const VALID_MODES = new Set(["in-session", "driver"]);
const VALID_ARTIFACT_KINDS = new Set(["spec", "plan", "impl"]);
const VALID_ATTEMPT_OUTCOMES = new Set(["halted", "failed", "crashed"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}
/** PR / issue / task identifiers are always integers on disk — a finite
 * fractional value (e.g. `12.5`) is a corrupt identifier, not a valid one. */
function isIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n));
}

function isRepoIdentity(v: unknown): v is RepoIdentity {
  return isObj(v) && isStr(v.host) && isStr(v.owner) && isStr(v.name);
}

function isRunInput(v: unknown): boolean {
  return isObj(v) && isStr(v.kind) && VALID_INPUT_KINDS.has(v.kind) && isStr(v.value);
}

/** Optional-scalar + optional-issue_numbers validation for a StageArtifacts. */
function isStageArtifacts(v: unknown): boolean {
  if (!isObj(v)) return false;
  for (const f of ["spec_path", "plan_path", "plan_slug"] as const) {
    if (v[f] !== undefined && typeof v[f] !== "string") return false;
  }
  if (v.issue_numbers !== undefined && !isIntArray(v.issue_numbers)) {
    return false;
  }
  return true;
}

function isGate(v: unknown): boolean {
  return v === null || (isObj(v) && isStr(v.reason) && isStr(v.detail));
}

function isMergeRecord(v: unknown): boolean {
  return (
    isObj(v) &&
    typeof v.pr === "number" &&
    Number.isInteger(v.pr) &&
    typeof v.merged_by_forge === "boolean"
  );
}

function isAttempt(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.started_at) &&
    isStrOrNull(v.ended_at) &&
    isStr(v.outcome) &&
    VALID_ATTEMPT_OUTCOMES.has(v.outcome)
  );
}

function isStageRecord(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.stage) &&
    VALID_STAGES.has(v.stage as Stage) &&
    isStr(v.status) &&
    VALID_STATUSES.has(v.status as StageStatus) &&
    isIntArray(v.prs) &&
    isIntArray(v.fold_prs) &&
    Array.isArray(v.merges) &&
    v.merges.every(isMergeRecord) &&
    isStageArtifacts(v.artifacts) &&
    isGate(v.gate) &&
    isStrOrNull(v.started_at) &&
    isStrOrNull(v.ended_at) &&
    Array.isArray(v.attempts) &&
    v.attempts.every(isAttempt)
  );
}

function isMergePoint(v: unknown): boolean {
  return (
    isObj(v) &&
    isStr(v.after_stage) &&
    VALID_STAGES.has(v.after_stage as Stage) &&
    isStr(v.artifact) &&
    VALID_ARTIFACT_KINDS.has(v.artifact)
  );
}

function isArtifactPrs(v: unknown): boolean {
  if (!isObj(v)) return false;
  for (const k of ["spec", "plan", "impl"] as const) {
    if (v[k] !== undefined && !isIntArray(v[k])) return false;
  }
  return true;
}

/**
 * Complete structural validation of a decoded state.json against the persisted
 * RunState schema. A parseable-but-corrupt state — missing required fields,
 * invalid stage/status/input/mode enums, malformed stage/merge/attempt records,
 * or a chain that disagrees with the stage list — must be rejected so `loadState`
 * never hands resume/state-machine code an object that will crash or make an
 * invalid decision. Validates EVERY field the schema declares, not just the ones
 * the disk layer itself dereferences.
 */
export function isValidRunState(v: unknown): v is RunState {
  if (!isObj(v)) return false;
  const s = v;

  // Top-level scalars + enums.
  if (!isStr(s.slug) || !isStr(s.run_id)) return false;
  if (!isRunInput(s.input)) return false;
  if (!isStageArtifacts(s.initial_artifacts)) return false;
  if (!isStr(s.mode) || !VALID_MODES.has(s.mode)) return false;
  if (!isRepoIdentity(s.repo)) return false;
  if (!isStr(s.default_branch)) return false;
  if (!isStr(s.created_at) || !isStr(s.updated_at)) return false;
  if (s.abandoned_at !== undefined && !isStrOrNull(s.abandoned_at)) return false;
  if (!isArtifactPrs(s.artifact_prs)) return false;

  // Chain: non-empty array of valid, in-run stages.
  if (!Array.isArray(s.chain) || s.chain.length === 0) return false;
  if (!s.chain.every((st) => isStr(st) && VALID_STAGES.has(st as Stage))) {
    return false;
  }

  // merge_points: not merely valid enums, but EXACTLY the mapping the chain
  // derives. A persisted merge_points that is a strict subset of
  // `mergePointsFor(chain)` (e.g. an empty array for a write-spec→review-spec
  // chain) would silently bypass a required merge gate — reject it as corrupt.
  if (!Array.isArray(s.merge_points)) return false;
  const chain = s.chain as Stage[];
  if (!s.merge_points.every(isMergePoint)) return false;
  const expected = mergePointsFor(chain);
  const key = (mp: MergePoint) => `${mp.after_stage}:${mp.artifact}`;
  const got = (s.merge_points as MergePoint[]).map(key);
  const want = expected.map(key);
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    return false;
  }

  // stages: one valid record per chain entry, IN chain order (the invariant
  // `initializeRun` establishes). A stages/chain mismatch is corruption.
  if (!Array.isArray(s.stages) || !s.stages.every(isStageRecord)) return false;
  if (s.stages.length !== chain.length) return false;
  for (let i = 0; i < chain.length; i++) {
    if ((s.stages[i] as StageRecord).stage !== chain[i]) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// persistState — write state.json (0600), refresh latest pointer, prune
// ---------------------------------------------------------------------------

/**
 * Durably persist a run's state. Writes `state.json` atomically (tmp+rename via
 * `writeJsonAtomic` — a failed write never leaves a partial/corrupt file),
 * chmods it to 0600, points the per-slug `latest` at this run, then applies
 * `history_keep_runs` retention. The current run's dir is created if absent.
 */
export function persistState(state: RunState): void {
  // `stateFile` enforces slug + run-id safety at the disk boundary; derive the
  // run dir from it so persistState can never write outside the history root.
  const file = stateFile(state.slug, state.run_id);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic: stringify happens inside writeJsonAtomic before the rename, so a
  // serialization failure throws BEFORE any rename — the prior state.json (if
  // any) is untouched and no partial file is left in place.
  writeJsonAtomic(file, state);
  fs.chmodSync(file, 0o600);
  const dirForSlug = slugDir(state.slug);
  // Prune BEFORE repointing `latest`. Retention keeps the lexicographically-
  // newest run-ids, but a RESUMED older run (e.g. run A persisted after newer
  // B/C with retention full) is lexicographically oldest and would be pruned —
  // the very run we just wrote. Restore it so the run we're about to point
  // `latest` at always survives, then repoint AFTER pruning so `latest` can
  // never reference a just-deleted run and dangle.
  const keep = getForgePipelineConfig().history_keep_runs;
  const pruned = pruneRunDirs(dirForSlug, keep);
  if (pruned.includes(state.run_id)) {
    // A RESUMED run older than the `keep` lexicographically-newest was just
    // deleted by retention — the very run we must preserve. Recreate it, then
    // evict the oldest OTHER retained run so the cap stays EXACTLY
    // `history_keep_runs` (recreating alone would leave keep + 1 dirs).
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(file, state);
    fs.chmodSync(file, 0o600);
    const others = fs
      .readdirSync(dirForSlug, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          e.name !== "latest" &&
          e.name !== "latest.txt" &&
          e.name !== state.run_id,
      )
      .map((e) => e.name)
      .sort(); // ascending: [0] is the oldest non-current retained run
    // After recreate there are `keep` newest others + the current run = keep+1.
    // Drop oldest others until the total (others + current) is `keep`.
    for (let i = 0; others.length - i + 1 > keep; i++) {
      fs.rmSync(path.join(dirForSlug, others[i]), {
        recursive: true,
        force: true,
      });
    }
  }
  updateLatestPointer(dirForSlug, state.run_id);
}

// ---------------------------------------------------------------------------
// resolveLatest / loadState
// ---------------------------------------------------------------------------

/**
 * Resolve the run-id the per-slug `latest` pointer references. Reads the
 * `latest` symlink, falling back to the `latest.txt` file
 * (`updateLatestPointer`'s no-symlink fallback). Throws when no pointer exists.
 */
export function resolveLatest(slug: string): string {
  const dir = slugDir(slug);
  const link = path.join(dir, "latest");
  try {
    const target = fs.readlinkSync(link);
    // The pointer stores the bare run-id (relative); take the last segment and
    // validate it — a tampered pointer must not resolve to a traversal target.
    return assertSafeRunId(path.basename(target));
  } catch (e) {
    if (e instanceof ForgeStateError) throw e;
    /* not a symlink / absent — try the text fallback */
  }
  const txt = path.join(dir, "latest.txt");
  if (fs.existsSync(txt)) {
    const runId = fs.readFileSync(txt, "utf8").trim();
    if (runId) return assertSafeRunId(path.basename(runId));
  }
  throw new Error(`forge: no 'latest' pointer for slug '${slug}' under ${dir}`);
}

/**
 * Load a run's state. With `runId`, loads that exact run; without, resolves the
 * per-slug `latest` pointer first. Throws when the state file is missing or
 * unparseable.
 */
export function loadState(slug: string, runId?: string): RunState {
  const id = runId ?? resolveLatest(slug);
  const file = stateFile(slug, id);
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ForgeStateError(
      "corrupt_state",
      `forge: unparseable state.json for slug '${slug}' run '${id}'`,
    );
  }
  if (!isValidRunState(parsed)) {
    throw new ForgeStateError(
      "corrupt_state",
      `forge: corrupt state.json for slug '${slug}' run '${id}' (failed structural validation)`,
    );
  }
  // The self-described identity MUST match the filesystem location it was read
  // from. A misplaced/relocated state file (slug/run_id disagreeing with its
  // path) would otherwise redirect the next persistState into a DIFFERENT run
  // directory (persistState derives its target from state.slug/state.run_id) —
  // reject it as corrupt rather than silently cross-writing runs.
  if (parsed.slug !== slug || parsed.run_id !== id) {
    throw new ForgeStateError(
      "corrupt_state",
      `forge: state.json identity ('${parsed.slug}'/'${parsed.run_id}') does not match its location ('${slug}'/'${id}').`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Repo identity (runs are repository-bound)
// ---------------------------------------------------------------------------

/**
 * Parse a `git remote get-url origin` value into a canonical `{host, owner,
 * name}`. Handles the three forms git emits — `git@host:owner/name(.git)`,
 * `https://host/owner/name(.git)`, `ssh://git@host/owner/name(.git)`. Returns
 * null on anything it can't confidently canonicalize.
 */
export function parseRemoteUrl(url: string): RepoIdentity | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host: string;
  let ownerPath: string;
  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/); // git@github.com:owner/name.git
  if (scp) {
    host = scp[1];
    ownerPath = scp[2];
  } else {
    const m = trimmed.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i); // https|ssh://...
    if (!m) return null;
    host = m[1];
    ownerPath = m[2];
  }
  ownerPath = ownerPath.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = ownerPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!host || !owner || !name) return null;
  return { host: host.toLowerCase(), owner, name };
}

/**
 * Resolve the current checkout's repo identity from `git remote get-url
 * origin`. Returns null when git/remote is unavailable — discovery then fails
 * closed (surfaces no candidates) since it cannot prove ownership.
 */
export function resolveCurrentRepo(cwd?: string): RepoIdentity | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseRemoteUrl(out);
  } catch {
    return null;
  }
}

/** Case-insensitive identity match on all three fields. */
function sameRepo(a: RepoIdentity, b: RepoIdentity): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// listResumeCandidates — scan + validate + repair + filter to current repo
// ---------------------------------------------------------------------------

/**
 * Enumerate all persisted runs across every slug for the CURRENT repo identity,
 * in deterministic order (newest run-id first, slug as tiebreak). Validates each
 * run dir (parseable `state.json` whose `slug`/`run_id` match its location) and
 * repairs a stale/missing per-slug `latest` pointer — the interruption where a
 * crash landed between the state-file write and the pointer swap — by pointing
 * it at the newest surviving run. Never surfaces another repo's run: with no
 * resolvable current repo (`repo` unresolved), returns `[]` (fail closed).
 *
 * `repo` is injectable for tests; production callers pass nothing and the
 * current checkout's identity is resolved from git.
 */
export function listResumeCandidates(repo?: RepoIdentity): RunState[] {
  const current = repo ?? resolveCurrentRepo();
  if (!current) return [];

  const root = forgeHistoryRoot();
  if (!fs.existsSync(root)) return [];

  const candidates: RunState[] = [];
  const slugs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const slug of slugs) {
    // A stray noncanonical directory (e.g. `.bad`, `foo/..`) fails the disk-
    // boundary slug check — `slugDir` throws `unsafe_slug`. Skip it rather than
    // let one hostile entry abort discovery of every valid run beside it.
    // The slug-dir resolution AND its enumeration share one error boundary: an
    // unreadable directory (bad perms) or one removed between the root scan and
    // this read must skip that slug, never abort discovery of every valid run
    // beside it.
    let dir: string;
    let runIds: string[];
    try {
      dir = slugDir(slug);
      runIds = fs
        .readdirSync(dir, { withFileTypes: true })
        // real run dirs only — skip the `latest` symlink + `latest.txt` pointer.
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.isSymbolicLink() &&
            e.name !== "latest" &&
            e.name !== "latest.txt",
        )
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }

    // Pointer recovery is scoped to the CURRENT repo's runs only. Slugs are not
    // repo-partitioned on disk, so the same slug can hold runs from two repos;
    // recovering the pointer to the newest run of ANY repo would let a newer
    // FOREIGN run become `latest`, and a subsequent slug-only load would then
    // resolve the wrong repository's run. Only current-repo runs steer the
    // pointer (and only current-repo runs are candidates).
    const validCurrentRepo: string[] = [];
    for (const runId of runIds) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(stateFile(slug, runId), "utf8"));
      } catch {
        continue; // missing/partial/unparseable/unsafe name → not a candidate
      }
      // Runtime-validate BEFORE dereferencing repo/slug/run_id — a parseable
      // but corrupt state (e.g. `repo: {}`) must be skipped, never crash the
      // enumeration of every OTHER valid run for this slug.
      if (!isValidRunState(parsed)) continue;
      const state = parsed;
      if (state.slug !== slug || state.run_id !== runId) continue;
      if (!sameRepo(state.repo, current)) continue; // foreign repo — ignore
      validCurrentRepo.push(runId);
      candidates.push(state);
    }

    // Recover a stale/missing latest pointer: repoint it at the newest
    // current-repo run whenever the pointer does not resolve EXACTLY to it. A
    // stale pointer that still resolves to an older-but-valid run (crash after
    // writing a newer run's state.json but before the pointer swap) must be
    // repaired too — checking mere membership would leave it stale.
    if (validCurrentRepo.length > 0) {
      const newest = validCurrentRepo[validCurrentRepo.length - 1];
      let current_ptr: string | null = null;
      try {
        current_ptr = resolveLatest(slug);
      } catch {
        current_ptr = null;
      }
      if (current_ptr !== newest) updateLatestPointer(dir, newest);
    }
  }

  // Deterministic: newest run-id first (timestamp-prefixed == chronological),
  // slug as a stable tiebreak.
  candidates.sort((a, b) => {
    if (a.run_id !== b.run_id) return a.run_id < b.run_id ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  return candidates;
}
