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
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stateRoot } from "./asset_root_lib.ts";
import { getForgePipelineConfig } from "./stark_config_lib.ts";
import {
  pruneRunDirs,
  updateLatestPointer,
  writeJsonAtomic,
} from "./stark_review_doc_lib.ts";
import {
  abandonRun,
  encodeIntent,
  ForgeStateError,
  initializeRun,
  isRenderableArg,
  mergePointsFor,
  parsePlanSlug,
  recordOutput,
  resolveChain,
  resumeTarget,
  sanitizeSlug,
  selectResumeRun,
  transition,
} from "./forge_state_lib.ts";
import type {
  Gate,
  InitialArtifacts,
  MergePoint,
  MergeRecord,
  PrReader,
  RepoIdentity,
  ResolvedRun,
  ResumeTarget,
  RunInput,
  RunState,
  Stage,
  StageArtifacts,
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

// ===========================================================================
// Phase 5 — CLI: argv bridge (resolve), state-mutating subcommands, summary,
// resume-target, driver-block renderer.
//
// The pure lib (`forge_state_lib.ts`) owns the state machine, chain/merge-point
// resolution, threading, and reconciliation; this half is the operator/skill
// surface. Every mutating subcommand wraps the corresponding pure-lib function
// and persists the returned `RunState` via `persistState`. No LLM calls; the
// only privileged operations are read-only `gh pr view` queries (injectable for
// tests via `STARK_FORGE_FAKE_PR`).
// ===========================================================================

type InputKind = "intent" | "spec-path" | "plan-path";

/** Live PR metadata forge reads read-only — merge state + branch shape. */
type PrMeta = {
  state: "open" | "merged" | "closed";
  baseRefName: string;
  headRefName: string;
};

// ---------------------------------------------------------------------------
// PR readers — the sole external observation, injectable for zero-network tests
// ---------------------------------------------------------------------------

/**
 * Test seam: when `STARK_FORGE_FAKE_PR` holds a JSON map `{"<pr>": PrMeta}`,
 * every PR read resolves from it instead of shelling out to `gh` — so the full
 * CLI (record-output seed verification, transition→done gate, summary, resume
 * reconciliation) is exercised subprocess-level with no GitHub access.
 */
function loadFakePrs(): Record<string, PrMeta> | null {
  const raw = process.env.STARK_FORGE_FAKE_PR;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, PrMeta>;
  } catch {
    throw new Error("STARK_FORGE_FAKE_PR is not valid JSON");
  }
}

/** Query one PR's metadata, scoped to the recorded repo (read-only). */
function readPrMeta(repo: RepoIdentity, pr: number): PrMeta {
  const fake = loadFakePrs();
  if (fake) {
    const m = fake[String(pr)];
    if (!m) throw new Error(`STARK_FORGE_FAKE_PR has no entry for PR #${pr}`);
    return m;
  }
  const out = execFileSync(
    "gh",
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      `${repo.owner}/${repo.name}`,
      "--json",
      "state,mergedAt,baseRefName,headRefName",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const j = JSON.parse(out) as {
    state: string;
    mergedAt: string | null;
    baseRefName: string;
    headRefName: string;
  };
  const state: PrMeta["state"] = j.mergedAt
    ? "merged"
    : j.state === "CLOSED"
      ? "closed"
      : "open";
  return { state, baseRefName: j.baseRefName, headRefName: j.headRefName };
}

/** The `PrReader` the pure lib consumes — merge state only. */
function makePrReader(repo: RepoIdentity): PrReader {
  return (pr: number) => readPrMeta(repo, pr).state;
}

// ---------------------------------------------------------------------------
// Host git helpers (read-only) — default branch + run-id allocation
// ---------------------------------------------------------------------------

/**
 * Resolve the checkout's default branch from `git symbolic-ref
 * refs/remotes/origin/HEAD` (e.g. `refs/remotes/origin/main` → `main`). Returns
 * null when unresolvable so `init` can fail-fast before any state write.
 */
export function resolveDefaultBranch(cwd?: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd: cwd ?? process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const branch = out.trim().replace(/^refs\/remotes\/origin\//, "");
    return branch || null;
  } catch {
    return null;
  }
}

/** Host-mint a unique, path-safe run-id (`YYYYMMDD-HHMMSS-<rand>`). The pure
 * lib takes no clock; run-id allocation is the host's job (spec §5). */
export function allocateRunId(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const ts =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

/**
 * The recorded Phase-0 feasibility verdict, as a durable source constant rather
 * than an ambient capability probe.
 *
 * The Phase-0 spike (spec `open-questions`, the blocking feasibility gate)
 * concluded **in-session works** for this harness: a SKILL.md is instructions the
 * running agent follows inline, so a stage skill's `AskUserQuestion` gates are the
 * orchestrating agent's own tool calls (they reach the operator natively), control
 * returns to the parent holding the stage's outputs, and the three terminal
 * outcomes (success / operator-halt / stage-error) are distinguishable and mapped
 * to `done` / `halted` / `failed` before stopping. The one honest limitation —
 * no mid-flight cancellation of a nested skill — scopes the merge deadline to
 * check-on-return + crash-recovery; it does NOT change the mode.
 *
 * `STARK_FORGE_DRIVER=1` forces `driver` for an operator who prefers to drive the
 * chain by hand (or for a harness where nested invocation is unavailable) — the
 * override can only make forge MORE conservative, never assert an unproven
 * capability. Driver mode is fully built and tested either way, so neither branch
 * leaves the operator worse off.
 *
 * This is only the DEFAULT that `resolve` suggests. `init` requires an explicit
 * `--mode` (§7) and records it durably; nothing downstream re-consults the
 * environment, so a retry can never recompute a different mode.
 */
export const PHASE0_MODE_VERDICT: "in-session" | "driver" = "in-session";

export function resolveExecutionMode(): "in-session" | "driver" {
  return process.env.STARK_FORGE_DRIVER === "1" ? "driver" : PHASE0_MODE_VERDICT;
}

/** The two canonical pipelines `resolveChain` can ever produce: the six-stage
 * chain (no red-team) and the eight-stage chain (`--red-team`). Every legal
 * `--chain` is a CONTIGUOUS slice of exactly one of these — an in-order
 * subsequence is NOT enough (it would admit impossible chains like
 * `write-spec,copilot` or `review-spec,review-plan` that skip required stages
 * or leave state unthreadable). */
const SIX_STAGE_CHAIN: readonly Stage[] = [
  "write-spec",
  "review-spec",
  "spec-to-plan",
  "review-plan",
  "plan-to-tasks",
  "copilot",
];
const EIGHT_STAGE_CHAIN: readonly Stage[] = [
  "write-spec",
  "review-spec",
  "red-team-spec",
  "spec-to-plan",
  "review-plan",
  "red-team-plan",
  "plan-to-tasks",
  "copilot",
];

/** Whether `chain` is a contiguous subarray of `canonical` (order preserved,
 * no gaps). */
function isContiguousSlice(chain: string[], canonical: readonly Stage[]): boolean {
  if (chain.length === 0 || chain.length > canonical.length) return false;
  for (let start = 0; start + chain.length <= canonical.length; start++) {
    let match = true;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i] !== canonical[start + i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/** Validate that `chain` is a non-empty CONTIGUOUS slice of either canonical
 * pipeline — anything else (invalid token, non-contiguous subsequence, wrong
 * order) is a corrupt chain, refused before any write. */
function validateChain(chain: string[]): Stage[] {
  if (chain.length === 0) {
    throw new ForgeStateError("bad_args", "--chain is empty");
  }
  for (const s of chain) {
    if (!VALID_STAGES.has(s as Stage)) {
      throw new ForgeStateError("bad_args", `--chain has invalid stage '${s}'`);
    }
  }
  if (
    isContiguousSlice(chain, SIX_STAGE_CHAIN) ||
    isContiguousSlice(chain, EIGHT_STAGE_CHAIN)
  ) {
    return chain as Stage[];
  }
  throw new ForgeStateError(
    "bad_args",
    `--chain is not a contiguous slice of the canonical (or --red-team) pipeline: ${chain.join(",")}`,
  );
}

/** Validate a closed-enum flag value; throws `bad_args` on anything outside. */
function reqEnum<T extends string>(
  value: string,
  valid: ReadonlySet<string>,
  flag: string,
): T {
  if (!valid.has(value)) {
    throw new ForgeStateError("bad_args", `--${flag} '${value}' is not a valid value`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// T1 — `resolve`: the SKILL.md → library bridge (argv validation + resolution)
// ---------------------------------------------------------------------------

type ForgeArgs = {
  positional: string | null;
  redTeam: boolean;
  from: Stage | null;
  until: Stage | null;
  resume: boolean;
  resumeSlug: string | null;
  dryRun: boolean;
  json: boolean;
};

const STAGE_TOKENS: ReadonlySet<string> = VALID_STAGES as ReadonlySet<string>;

/** Parse raw `/stark-forge` argv into structured flags. `--resume`'s optional
 * slug is the token immediately after it (when not flag-shaped); any other bare
 * token is the positional. Throws `bad_args` on a malformed invocation. */
function parseForgeArgs(argv: string[]): ForgeArgs {
  const a: ForgeArgs = {
    positional: null,
    redTeam: false,
    from: null,
    until: null,
    resume: false,
    resumeSlug: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new ForgeStateError("bad_args", `${tok} requires a value`);
      }
      return v;
    };
    const asStage = (flag: string, v: string): Stage => {
      if (!STAGE_TOKENS.has(v)) {
        throw new ForgeStateError(
          "stage_not_in_chain",
          `${flag} names '${v}', which is not a valid stage token.`,
        );
      }
      return v as Stage;
    };
    switch (tok) {
      case "--red-team":
        a.redTeam = true;
        break;
      case "--from":
        a.from = asStage("--from", next());
        break;
      case "--until":
        a.until = asStage("--until", next());
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--resume": {
        a.resume = true;
        const peek = argv[i + 1];
        if (peek !== undefined && !peek.startsWith("-")) {
          a.resumeSlug = peek;
          i++;
        }
        break;
      }
      default:
        if (tok.startsWith("-")) {
          throw new ForgeStateError("bad_args", `unknown flag: ${tok}`);
        }
        if (a.positional !== null) {
          throw new ForgeStateError(
            "bad_args",
            `unexpected extra positional: ${tok}`,
          );
        }
        a.positional = tok;
    }
  }
  return a;
}

/** The auto-detected entry stage for an input kind (overridden by `--from`). */
function entryStageFor(kind: InputKind): Stage {
  switch (kind) {
    case "spec-path":
      return "review-spec";
    case "plan-path":
      return "review-plan";
    case "intent":
      return "write-spec";
  }
}

/** Classify the positional: an existing `docs/specs/*-spec.md` →`spec-path`, an
 * existing `docs/plans/*-plan.md` → `plan-path`, else free-text `intent`
 * (fail-toward-authoring for a non-existent path). */
function classifyInput(positional: string): InputKind {
  if (/(^|\/)docs\/specs\/.*-spec\.md$/.test(positional) && existsOnDisk(positional)) {
    return "spec-path";
  }
  if (/(^|\/)docs\/plans\/.*-plan\.md$/.test(positional) && existsOnDisk(positional)) {
    return "plan-path";
  }
  return "intent";
}

function existsOnDisk(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Whether the entry stage's required seed inputs are derivable from the input
 * kind (§4 import contract). */
function entryInputsAvailable(entry: Stage, kind: InputKind): boolean {
  const seed = {
    spec_path: kind === "spec-path",
    plan_path: kind === "plan-path",
    plan_slug: kind === "plan-path",
  };
  switch (entry) {
    case "write-spec":
      return kind === "intent";
    case "review-spec":
    case "red-team-spec":
    case "spec-to-plan":
      return seed.spec_path;
    case "review-plan":
    case "red-team-plan":
      return seed.plan_path;
    case "plan-to-tasks":
      return seed.plan_path && seed.plan_slug;
    case "copilot":
      return seed.plan_slug;
  }
}

export type ValidateResult =
  | { ok: true; resolved: ResolvedRun }
  | { ok: true; resume: { slug: string | null } }
  | { ok: false; error: { code: string; message: string } };

/**
 * Validate a raw `/stark-forge` argv and, on valid non-resume args, resolve the
 * full run descriptor. Every spec §1 invalid-combination row returns
 * `{ok:false, error:{code}}` with the exact `error.code` — the caller
 * (`resolve`) exits non-zero and writes NO state. A valid `--resume` returns the
 * resume arm (the SKILL routes it to `resume-target`). Repo identity /
 * default-branch are resolved best-effort here (init re-resolves fail-fast), so
 * `--dry-run` never depends on git.
 */
export function validateArgs(argv: string[]): ValidateResult {
  let a: ForgeArgs;
  try {
    a = parseForgeArgs(argv);
  } catch (e) {
    if (e instanceof ForgeStateError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    throw e;
  }

  const fail = (code: string, message: string): ValidateResult => ({
    ok: false,
    error: { code, message },
  });

  // --- resume-combination rows (§1) ---
  if (a.resume) {
    if (a.positional !== null) {
      return fail(
        "resume_with_positional",
        "--resume targets a stored run; a positional would start a new one.",
      );
    }
    if (a.from !== null || a.until !== null) {
      return fail(
        "resume_with_slice",
        "--resume replays the stored chain; --from/--until cannot re-slice it.",
      );
    }
    if (a.redTeam) {
      return fail(
        "resume_with_red_team",
        "Red-team membership is fixed in the stored chain; --resume cannot change it.",
      );
    }
    return { ok: true, resume: { slug: a.resumeSlug } };
  }

  // --- non-resume: input required ---
  if (a.positional === null) {
    return fail("missing_input", "Nothing to run: no positional and no --resume.");
  }
  const positional = a.positional;
  const kind = classifyInput(positional);

  // An existing artifact whose path is not a clean renderable token cannot be
  // threaded bare into the entry command — refuse at classification (§2).
  if (kind !== "intent" && !isRenderableArg(positional)) {
    return fail(
      "input_path_unsafe",
      `Artifact path '${positional}' is not a clean renderable token (whitespace/quote/backslash/leading '-').`,
    );
  }

  // A free-text intent must survive the write-spec transport (a single
  // double-quoted line — no multiline/control-character escape). Validating it
  // HERE fails fast with the §9 `intent_unencodable` envelope; without this, a
  // control-character intent slips through resolve and later makes an
  // unrenderable run (and `--dry-run --json` throws in `renderStageCommandSymbolic`,
  // bypassing the required error envelope).
  if (kind === "intent") {
    try {
      encodeIntent(positional);
    } catch (e) {
      if (e instanceof ForgeStateError) {
        return { ok: false, error: { code: e.code, message: e.message } };
      }
      throw e;
    }
  }

  const entry = a.from ?? entryStageFor(kind);

  // write-spec consumes free-text intent, not an artifact path.
  if (a.from === "write-spec" && kind !== "intent") {
    return fail(
      "from_needs_intent",
      "--from write-spec requires a free-text intent, not an existing artifact path.",
    );
  }

  // --- import contract: seed initial_artifacts for path-based starts ---
  const initial_artifacts: InitialArtifacts = {};
  if (kind === "spec-path") {
    initial_artifacts.spec_path = positional;
  } else if (kind === "plan-path") {
    initial_artifacts.plan_path = positional;
    const slug = parsePlanSlug(positional);
    if (slug === null) {
      return fail(
        "plan_slug_unresolved",
        `Plan filename '${positional}' does not match docs/plans/YYYY-MM-DD-<slug>-plan.md; cannot import plan_slug.`,
      );
    }
    initial_artifacts.plan_slug = slug;
  }

  if (!entryInputsAvailable(entry, kind)) {
    return fail(
      "entry_input_unavailable",
      `Entry stage '${entry}' requires inputs not derivable from a '${kind}' start.`,
    );
  }

  // --- chain resolution (throws empty_chain / stage_not_in_chain) ---
  let chain: Stage[];
  try {
    chain = resolveChain({
      inputKind: kind,
      redTeam: a.redTeam,
      from: a.from ?? undefined,
      until: a.until ?? undefined,
    });
  } catch (e) {
    if (e instanceof ForgeStateError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    throw e;
  }

  const mergePoints = mergePointsFor(chain);
  const slug = sanitizeSlug(positional);
  const input: RunInput = { kind, value: positional };
  const repo = resolveCurrentRepo() ?? { host: "", owner: "", name: "" };
  const default_branch = resolveDefaultBranch() ?? "";

  return {
    ok: true,
    resolved: {
      chain,
      mergePoints,
      slug,
      input,
      initial_artifacts,
      repo,
      default_branch,
    },
  };
}

// ---------------------------------------------------------------------------
// T1 — symbolic renderer + dry-run / error summary envelopes
// ---------------------------------------------------------------------------

const RED_TEAM_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "red-team-spec",
  "red-team-plan",
]);

function chainHasRedTeam(chain: Stage[]): boolean {
  return chain.some((s) => RED_TEAM_STAGES.has(s));
}

/**
 * Render a stage's command for `--dry-run`, emitting explicit producer
 * references (`<write-spec.spec_path>`, `<spec-to-plan.plan_slug>`) for inputs
 * not yet produced — NEVER fabricating a stage-owned value. Imported
 * initial-artifact values (path-based starts) are emitted bare (already
 * validated renderable at classification). The strict executable
 * `renderStageCommand` is used only against real recorded state.
 */
export function renderStageCommandSymbolic(
  stage: Stage,
  initial: InitialArtifacts,
  inputValue: string,
): string {
  const sym = (
    field: "spec_path" | "plan_path" | "plan_slug",
  ): string => {
    const imported = initial[field];
    if (imported !== undefined) return imported;
    const producer = field === "spec_path" ? "write-spec" : "spec-to-plan";
    return `<${producer}.${field}>`;
  };
  switch (stage) {
    case "write-spec":
      return `/stark-write-spec ${encodeIntent(inputValue)}`;
    case "review-spec":
      return `/stark-review-spec ${sym("spec_path")}`;
    case "red-team-spec":
      return `/stark-red-team-spec ${sym("spec_path")} --fold`;
    case "spec-to-plan":
      return `/stark-spec-to-plan ${sym("spec_path")}`;
    case "review-plan":
      return `/stark-review-plan ${sym("plan_path")}`;
    case "red-team-plan":
      return `/stark-red-team-plan ${sym("plan_path")} --fold`;
    case "plan-to-tasks":
      return `/stark-plan-to-tasks ${sym("plan_path")} --plan-slug ${sym("plan_slug")}`;
    case "copilot":
      return `/stark-copilot --plan-slug ${sym("plan_slug")}`;
  }
}

/** The §9 summary envelope shape (superset — dry-run adds `commands`). */
export type SummaryObject = {
  slug: string | null;
  run_id: string | null;
  red_team: boolean;
  status:
    | "completed"
    | "halted"
    | "failed"
    | "running"
    | "pending"
    | "abandoned"
    | "dry_run"
    | "error";
  chain: Stage[];
  merge_points: MergePoint[];
  merged_prs: { artifact: "spec" | "plan" | "impl"; pr: number }[];
  open_fold_prs: { stage: Stage; pr: number }[];
  stages: {
    stage: Stage;
    status: StageStatus;
    prs: number[];
    fold_prs: number[];
    artifacts: StageArtifacts;
    gate: Gate | null;
  }[];
  resume_target: Stage | null;
  error: { code: string; message: string } | null;
  commands?: { stage: Stage; command: string }[];
};

/** The §9 `dry_run` preview — resolved chain + merge points + symbolic
 * per-stage commands; nothing persisted. */
export function buildDryRunSummary(resolved: ResolvedRun): SummaryObject {
  return {
    slug: null,
    run_id: null,
    red_team: chainHasRedTeam(resolved.chain),
    status: "dry_run",
    chain: resolved.chain,
    merge_points: resolved.mergePoints,
    merged_prs: [],
    open_fold_prs: [],
    stages: [],
    resume_target: null,
    error: null,
    commands: resolved.chain.map((stage) => ({
      stage,
      command: renderStageCommandSymbolic(
        stage,
        resolved.initial_artifacts,
        resolved.input.value,
      ),
    })),
  };
}

/** The §9 `error` envelope for a fail-fast validation exit (no run yet). */
export function buildErrorSummary(error: {
  code: string;
  message: string;
}): SummaryObject {
  return {
    slug: null,
    run_id: null,
    red_team: false,
    status: "error",
    chain: [],
    merge_points: [],
    merged_prs: [],
    open_fold_prs: [],
    stages: [],
    resume_target: null,
    error,
  };
}

// ---------------------------------------------------------------------------
// T3 — buildSummary (initialized runs) + status derivation
// ---------------------------------------------------------------------------

function deriveStatus(state: RunState): SummaryObject["status"] {
  if (state.abandoned_at) return "abandoned";
  if (state.stages.every((s) => s.status === "done")) return "completed";
  if (state.stages.some((s) => s.status === "failed")) return "failed";
  if (state.stages.some((s) => s.status === "halted")) return "halted";
  if (state.stages.some((s) => s.status === "running")) return "running";
  return "pending";
}

/**
 * Build the §9 final summary for an initialized run. `red_team` is DERIVED from
 * the stored chain; `merged_prs` carries only `merged_by_forge:true` entries in
 * merge-point order; `open_fold_prs` is `fold_prs` filtered through the injected
 * reader (a fold PR the operator resolved drops out).
 */
export function buildSummary(state: RunState, readPr: PrReader): SummaryObject {
  const status = deriveStatus(state);

  const merged_prs: SummaryObject["merged_prs"] = [];
  for (const mp of state.merge_points) {
    const rec = state.stages.find((s) => s.stage === mp.after_stage);
    if (!rec) continue;
    for (const m of rec.merges) {
      if (m.merged_by_forge) merged_prs.push({ artifact: mp.artifact, pr: m.pr });
    }
  }

  const open_fold_prs: SummaryObject["open_fold_prs"] = [];
  for (const rec of state.stages) {
    for (const pr of rec.fold_prs) {
      if (readPr(pr) === "open") open_fold_prs.push({ stage: rec.stage, pr });
    }
  }

  const frontier = state.stages.find((s) => s.status !== "done");
  const resume_target =
    status === "completed" || state.abandoned_at
      ? null
      : (frontier?.stage ?? null);

  // §9: error set on a failed stage (the run-stopping failure).
  const failed = state.stages.find((s) => s.status === "failed");
  const error =
    failed && failed.gate
      ? { code: failed.gate.reason, message: failed.gate.detail }
      : null;

  return {
    slug: state.slug,
    run_id: state.run_id,
    red_team: chainHasRedTeam(state.chain),
    status,
    chain: state.chain,
    merge_points: state.merge_points,
    merged_prs,
    open_fold_prs,
    stages: state.stages.map((r) => ({
      stage: r.stage,
      status: r.status,
      prs: r.prs,
      fold_prs: r.fold_prs,
      artifacts: r.artifacts,
      gate: r.gate,
    })),
    resume_target,
    error,
  };
}

// ---------------------------------------------------------------------------
// T5 — driver-mode command-block renderer (pure string builder)
// ---------------------------------------------------------------------------

/** The §4 completion-channel `record-output` template a driver stage prints —
 * named `<REPORTED: …>` slots the operator fills, annotated per channel. */
function recordOutputTemplate(state: RunState, stage: Stage): string[] {
  const base = `forge_state.ts record-output --slug ${state.slug} --run-id ${state.run_id} --stage ${stage}`;
  switch (stage) {
    case "write-spec":
      return [
        "#   (§4: write-spec receipt spec_path + write_spec_land spec PR)",
        `${base} --artifact-spec-path <REPORTED: spec_path> --prs <REPORTED: spec_pr> --at <NOW>`,
      ];
    case "review-spec":
    case "red-team-spec": {
      const fold = stage === "red-team-spec" ? " --fold-prs <REPORTED: fold_pr>" : "";
      return [
        "#   (§4: adopted/opened spec PR number" +
          (stage === "red-team-spec" ? " + fold PR" : "") +
          ")",
        `${base} --prs <REPORTED: spec_pr>${fold} --at <NOW>`,
      ];
    }
    case "spec-to-plan":
      return [
        "#   (§4: spec-to-plan reported plan_path + plan_slug + plan PR)",
        `${base} --artifact-plan-path <REPORTED: plan_path> --artifact-plan-slug <REPORTED: plan_slug> --prs <REPORTED: plan_pr> --at <NOW>`,
      ];
    case "review-plan":
    case "red-team-plan": {
      const fold = stage === "red-team-plan" ? " --fold-prs <REPORTED: fold_pr>" : "";
      return [
        "#   (§4: adopted/opened plan PR number" +
          (stage === "red-team-plan" ? " + fold PR" : "") +
          ")",
        `${base} --prs <REPORTED: plan_pr>${fold} --at <NOW>`,
      ];
    }
    case "plan-to-tasks":
      return [
        "#   (§4: created issue numbers — the completion marker, no PR)",
        `${base} --artifact-issue-numbers <REPORTED: issue_numbers> --at <NOW>`,
      ];
    case "copilot":
      return [
        "#   (§4: all implementation PR numbers copilot opened)",
        `${base} --prs <REPORTED: impl_prs> --at <NOW>`,
      ];
  }
}

/**
 * Render the driver-mode command block for a resume target (T5) — a PURE STRING
 * BUILDER. Built FROM the descriptor's `command` + `requires_base_sync` fields
 * ONLY (never calling `renderStageCommand`/`requiresBaseSync`), so the pure lib
 * stays the single command/routing owner. `reinvoke`/`advance`/`merge_only`
 * blocks open with the compare-and-set re-entry into `running`; a
 * `requires_base_sync` target then prints the base-sync prelude (reading the
 * host-recorded `state.default_branch`, never guessing `main`) + its
 * `base_sync_failed` fallback; a merge-point target inserts the fold-check +
 * per-PR `/stark-gh:pr-merge` (annotated with the `merge_timeout_s` operator
 * deadline — NO shell timeout-wrapper) + `--merges` recording. A `merge_only`
 * target omits the stage command AND renders CONCRETE state — the recorded
 * remaining artifact PR numbers (already-merged excluded) and recorded fold PRs
 * — instead of `<REPORTED: …>` placeholders, since nothing is re-reported when
 * only the merge is retried. Same-artifact stages carry no base-sync lines.
 */
export function renderDriverBlock(state: RunState, target: ResumeTarget): string {
  const stage = target.target_stage;
  const rec = state.stages.find((s) => s.stage === stage);
  const cur = rec ? rec.status : "pending";
  const slug = state.slug;
  const runId = state.run_id;
  // Every rendered `gh` query is scoped to the run's RECORDED repo, so an
  // operator pasting the block from another checkout cannot query the wrong
  // repository (runs are repo-bound — plan §2.5).
  const repoRef = `${state.repo.owner}/${state.repo.name}`;
  const t = `forge_state.ts transition --slug ${slug} --run-id ${runId} --stage ${stage}`;

  if (target.action === "complete") {
    return `# Run '${runId}' (slug '${slug}') complete — all stages done.\n`;
  }
  if (target.action === "abandon") {
    return (
      `# Stage '${stage}' is a documented dead end (${rec?.gate?.reason ?? "?"}).\n` +
      `# No in-run continuation. Run:\n` +
      `forge_state.ts abandon --slug ${slug} --run-id ${runId} --at <NOW>\n`
    );
  }

  const mp = state.merge_points.find((m) => m.after_stage === stage);
  const isMerge = mp !== undefined;
  const lines: string[] = [];
  lines.push(`## Driver step: stage '${stage}' (action: ${target.action})`);

  // 1. compare-and-set re-entry into running.
  lines.push("# 1. Enter running (compare-and-set re-entry):");
  lines.push(`${t} --from ${cur} --to running --at <NOW>`);

  // 2. base sync — only for new-artifact stages (lib-owned routing).
  if (target.requires_base_sync) {
    lines.push("# 2. Base sync (new-artifact stage — recorded default branch):");
    lines.push(`git switch ${state.default_branch}`);
    lines.push("git pull --ff-only");
    lines.push("#   On sync failure, report (re-entry re-runs this prelude):");
    lines.push(
      `${t} --from running --to failed --gate-reason base_sync_failed --gate-detail "<detail>" --at <NOW>`,
    );
  }

  // 3. stage command (omitted for merge_only — execution already completed).
  if (target.action !== "merge_only") {
    lines.push("# 3. Run the stage command:");
    lines.push(target.command ?? "# (no command)");
    lines.push("# 4. Report the stage's reported outputs (fill the slots):");
    lines.push(...recordOutputTemplate(state, stage));
  }

  // 5. merge-point handling.
  if (isMerge) {
    const cfg = getForgePipelineConfig();
    if (target.action === "merge_only") {
      // merge_only retries ONLY the merge — the stage already ran and RECORDED
      // its PRs (checkpoint present), so render CONCRETE remaining artifact PR
      // numbers, concrete fold-PR checks, and per-PR merge/record commands
      // (Finding 1). No `<REPORTED: …>` placeholders: nothing is re-reported on
      // a merge_only retry. Already-merged PRs (recorded in `merges`) are excluded.
      const registry = state.artifact_prs[mp!.artifact] ?? [];
      const mergedPrs = new Set((rec?.merges ?? []).map((m) => m.pr));
      const remaining = registry.filter((pr) => !mergedPrs.has(pr));
      const foldPrs = rec?.fold_prs ?? [];
      lines.push(
        `# 5. Merge the remaining ${mp!.artifact} PR(s) — operator deadline ${cfg.merge_timeout_s}s (NO shell timeout-wrapper):`,
      );
      if (foldPrs.length > 0) {
        lines.push(
          `#   Fold PR(s) recorded for this artifact: ${foldPrs.map((p) => `#${p}`).join(", ")}.`,
        );
        lines.push(
          "#   Re-check each fold PR's LIVE state FIRST — never merge an artifact past an open fold:",
        );
        for (const pr of foldPrs) {
          lines.push(
            `gh pr view ${pr} --repo ${repoRef} --json number,state --jq '.number,.state'`,
          );
        }
        lines.push("#   If ANY is still OPEN, halt instead of merging:");
        lines.push(
          `${t} --from running --to halted --gate-reason fold_pr_open --gate-detail "<open fold pr>" --at <NOW>`,
        );
      } else {
        lines.push("#   No fold PRs recorded for this artifact.");
      }
      if (remaining.length === 0) {
        lines.push(
          "#   All recorded artifact PRs are already merged — no merge command; report the outcome below.",
        );
      } else {
        lines.push(
          `#   Merge each remaining artifact PR (${remaining.map((p) => `#${p}`).join(", ")} — already-merged excluded):`,
        );
        for (const pr of remaining) lines.push(`/stark-gh:pr-merge --pr ${pr}`);
        lines.push(`#   On deadline expiry (${cfg.merge_timeout_s}s), report:`);
        lines.push(
          `${t} --from running --to halted --gate-reason merge_timeout --gate-detail "<pr>" --at <NOW>`,
        );
        lines.push("#   Record each merge as it lands:");
        for (const pr of remaining) {
          lines.push(
            `forge_state.ts record-output --slug ${slug} --run-id ${runId} --stage ${stage} --merges ${pr}:true --at <NOW>`,
          );
        }
      }
    } else {
      // advance / reinvoke into a merge point: the stage command (§3 above) runs
      // FIRST and reports its PR(s), so the merge slots are filled from the
      // stage's reported outputs — symbolic `<REPORTED: …>` placeholders.
      lines.push(
        `# 5. Merge the ${mp!.artifact} PR(s) when green — operator deadline ${cfg.merge_timeout_s}s (NO shell timeout-wrapper):`,
      );
      lines.push(
        "#   Re-check each fold PR's LIVE state FIRST — never merge an artifact past an open fold.",
      );
      lines.push(
        `#   (fold PR numbers come from this stage's reported fold output — §4 fold_prs):`,
      );
      lines.push(
        `gh pr view <REPORTED: fold_pr> --repo ${repoRef} --json number,state --jq '.number,.state'`,
      );
      lines.push("#   If ANY is still OPEN, halt instead of merging:");
      lines.push(
        `${t} --from running --to halted --gate-reason fold_pr_open --gate-detail "<fold pr>" --at <NOW>`,
      );
      lines.push(`#   Otherwise, for each artifact PR <REPORTED: ${mp!.artifact}_pr>:`);
      lines.push(`/stark-gh:pr-merge --pr <REPORTED: ${mp!.artifact}_pr>`);
      lines.push(`#   On deadline expiry (${cfg.merge_timeout_s}s), report:`);
      lines.push(
        `${t} --from running --to halted --gate-reason merge_timeout --gate-detail "<pr>" --at <NOW>`,
      );
      lines.push("#   Record each merge as it lands:");
      lines.push(
        `forge_state.ts record-output --slug ${slug} --run-id ${runId} --stage ${stage} --merges <REPORTED: ${mp!.artifact}_pr>:true --at <NOW>`,
      );
    }
  }

  // final. report the terminal outcome (reader-validated on --to done).
  lines.push(`# ${isMerge ? 6 : 5}. Report the outcome:`);
  lines.push(`${t} --from running --to done --at <NOW>`);
  lines.push("#   (or --to failed --gate-reason <reason> --gate-detail <detail> on failure)");
  return lines.join("\n") + "\n";
}

// ===========================================================================
// CLI subcommand handlers
// ===========================================================================

const out = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
};
const narrate = (msg: string): void => {
  process.stderr.write(msg + "\n");
};

/**
 * The exact flag allowlist per state-mutating subcommand. Anything outside a
 * subcommand's set — a typo, a stale flag, or the explicitly-forbidden
 * `--issue-creation-complete` — is rejected `bad_args` BEFORE any state write,
 * so a malformed invocation can never persist a field `loadState` then rejects
 * as corrupt (or silently drop an intended one).
 */
const SUBCOMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  init: new Set([
    "slug", "run-id", "chain", "created-at", "input-kind", "input-value",
    "mode", "initial-spec-path", "initial-plan-path", "initial-plan-slug",
  ]),
  "record-output": new Set([
    "slug", "run-id", "stage", "at", "prs", "fold-prs", "merges",
    "artifact-spec-path", "artifact-plan-path", "artifact-plan-slug",
    "artifact-issue-numbers",
  ]),
  transition: new Set([
    "slug", "run-id", "stage", "to", "from", "at", "prs", "fold-prs",
    "artifact-spec-path", "artifact-plan-path", "artifact-plan-slug",
    "artifact-issue-numbers", "gate-reason", "gate-detail",
  ]),
  get: new Set(["slug", "run-id"]),
  abandon: new Set(["slug", "run-id", "at"]),
  summary: new Set(["slug", "run-id"]),
  "resume-target": new Set(["slug"]),
  "driver-block": new Set(["slug"]),
};

/**
 * Parse `--flag value` options from a mutating subcommand's argv. EVERY option
 * in this CLI is value-bearing, so parsing is strict — a malformed invocation
 * must fail `bad_args` BEFORE any state write, never proceed on a silently-
 * dropped or boolean-defaulted flag:
 *   - a bare positional token (anything not starting with `--`) is rejected —
 *     no subcommand takes positionals;
 *   - a flag outside `allowed` (a typo, a stale flag, or the explicitly-
 *     forbidden `--issue-creation-complete`) is rejected;
 *   - a duplicate flag is rejected (ambiguous last-wins is not silently taken);
 *   - a flag lacking its value (EOL or another `--flag` next) is rejected —
 *     there are no boolean flags here, so `--prs --at ...` is malformed.
 */
function parseOpts(
  argv: string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      throw new ForgeStateError(
        "bad_args",
        `unexpected positional argument '${tok}' (all options are '--flag value')`,
      );
    }
    const key = tok.slice(2);
    if (key === "") {
      throw new ForgeStateError("bad_args", `malformed flag '${tok}'`);
    }
    if (!allowed.has(key)) {
      throw new ForgeStateError("bad_args", `unknown flag --${key} for this subcommand`);
    }
    if (m.has(key)) {
      throw new ForgeStateError("bad_args", `duplicate flag --${key}`);
    }
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith("--")) {
      throw new ForgeStateError("bad_args", `--${key} requires a value`);
    }
    m.set(key, nxt);
    i++;
  }
  return m;
}

function reqStr(opts: Map<string, string>, key: string): string {
  const v = opts.get(key);
  if (v === undefined) {
    throw new ForgeStateError("bad_args", `--${key} is required`);
  }
  return v;
}
function optStr(opts: Map<string, string>, key: string): string | undefined {
  return opts.get(key);
}
function csvInts(v: string | undefined): number[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) {
        throw new ForgeStateError("bad_args", `not an integer: '${s}'`);
      }
      return n;
    });
}
function parseMerges(v: string | undefined): MergeRecord[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const parts = pair.split(":");
      const [prStr, flag] = parts;
      const pr = Number(prStr);
      if (!Number.isInteger(pr)) {
        throw new ForgeStateError("bad_args", `merge pr not an integer: '${prStr}'`);
      }
      // The boolean suffix is required and strictly `true|false` — a malformed
      // suffix (`10`, `10:`, `10:yes`) must not silently mean `false` and
      // misattribute `merged_by_forge`.
      if (parts.length !== 2 || (flag !== "true" && flag !== "false")) {
        throw new ForgeStateError(
          "bad_args",
          `merge flag must be '<pr>:true' or '<pr>:false', got '${pair}'.`,
        );
      }
      return { pr, merged_by_forge: flag === "true" };
    });
}

/**
 * Every merge PR must belong to the merge-point artifact's canonical registry —
 * either already recorded in `artifact_prs` or seeded by the same call's `prs`.
 * A stage that is NOT a merge point accepts no merges. This blocks unrelated
 * merge records and incorrect `merged_by_forge` attribution before persistence.
 */
function verifyMergePrs(
  state: RunState,
  stage: Stage,
  merges: MergeRecord[],
  incomingPrs: number[],
): void {
  if (merges.length === 0) return;
  const mp = state.merge_points.find((m) => m.after_stage === stage);
  if (!mp) {
    throw new ForgeStateError(
      "merge_pr_unverified",
      `stage '${stage}' is not a merge point — it records no merges.`,
    );
  }
  const registry = new Set([
    ...(state.artifact_prs[mp.artifact] ?? []),
    ...incomingPrs,
  ]);
  for (const m of merges) {
    if (!registry.has(m.pr)) {
      throw new ForgeStateError(
        "merge_pr_unverified",
        `merge PR #${m.pr} is not in the '${mp.artifact}' artifact registry for stage '${stage}'.`,
      );
    }
  }
}

/** Assemble the `Partial<StageArtifacts>` a record-output / transition carries. */
function artifactsFromOpts(
  opts: Map<string, string>,
): Partial<StageArtifacts> | undefined {
  const a: Partial<StageArtifacts> = {};
  const sp = optStr(opts, "artifact-spec-path");
  const pp = optStr(opts, "artifact-plan-path");
  const ps = optStr(opts, "artifact-plan-slug");
  const inums = optStr(opts, "artifact-issue-numbers");
  if (sp !== undefined) a.spec_path = sp;
  if (pp !== undefined) a.plan_path = pp;
  if (ps !== undefined) a.plan_slug = ps;
  if (inums !== undefined) a.issue_numbers = csvInts(inums);
  return Object.keys(a).length > 0 ? a : undefined;
}

/**
 * Host-side PR seed verification — the ONE preflight for every PR-writing path
 * (record-output AND transition, whose `--prs` delegate to `recordOutput`).
 * Before a NEW PR enters `artifact_prs`, require base = recorded default branch
 * and a head branch matching the stage's expected shape (never `red-team-fold/*`,
 * which is a never-merged fold PR). A mismatch is refused `artifact_pr_unverified`
 * BEFORE persistence, so a stale/malformed payload naming an unrelated same-repo
 * PR can never enter the registry that drives merging.
 */
function verifySeedPrs(
  state: RunState,
  stage: Stage,
  prs: number[],
  readMeta: (pr: number) => PrMeta,
): void {
  if (prs.length === 0) return;
  const artifact = stageArtifactForVerify(stage);
  if (artifact === null) return; // plan-to-tasks: no PR
  const existing = state.artifact_prs[artifact] ?? [];
  for (const pr of prs) {
    if (existing.includes(pr)) continue; // not a new seed — already verified
    const meta = readMeta(pr);
    if (meta.baseRefName !== state.default_branch) {
      throw new ForgeStateError(
        "artifact_pr_unverified",
        `PR #${pr} base '${meta.baseRefName}' != recorded default branch '${state.default_branch}'.`,
      );
    }
    // The head branch must match one of the artifact's authoritative opener
    // shapes (see `headBranchMatchesArtifact`). A generic `<stage>/<slug>`
    // equality is wrong: the review stages open `review-{spec,plan}/<basename>`
    // in a path-based start, spec-to-plan opens `spec-to-plan/<stem>-<ts>`
    // (a timestamp suffix — never equal to the run slug), and copilot opens
    // one-or-more `copilot/<task-slug>` branches, so the branch slug is NOT
    // forge's `state.slug`. Enforcing the per-artifact opener contract blocks a
    // same-repo, correct-base but unrelated PR (including a never-merged
    // `red-team-fold/*` fold branch) from seeding the merge registry.
    if (!headBranchMatchesStage(state, stage, meta.headRefName)) {
      throw new ForgeStateError(
        "artifact_pr_unverified",
        `PR #${pr} head '${meta.headRefName}' does not match the documented opener branch shape for stage '${stage}' (artifact '${artifact}').`,
      );
    }
  }
}

/**
 * Read a threaded artifact doc path from recorded state (host mirror of the
 * lib's private `resolveThreadedField`): the producing stage's reported
 * `artifacts`, falling back to the run-level `initial_artifacts` seeded at init
 * for a path-based start. Returns undefined when neither source holds it.
 */
function threadedDocPath(
  state: RunState,
  field: "spec_path" | "plan_path",
): string | undefined {
  const producer: Stage = field === "spec_path" ? "write-spec" : "spec-to-plan";
  const rec = state.stages.find((s) => s.stage === producer);
  const fromStage = rec?.artifacts[field];
  if (fromStage !== undefined) return fromStage;
  return state.initial_artifacts[field];
}

/** Basename of a doc path with its extension stripped (`.../<stem>.md` → `<stem>`). */
function docStem(path: string | undefined): string | null {
  if (path === undefined) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The authoritative head-branch matcher, per artifact — STATE-AWARE (Finding 2).
 * A broad prefix (`spec-to-plan/`, `copilot/`, `write-spec/`) is NOT enough: a
 * correct-base PR from a *different* forge run carries the same prefix, so it
 * would seed this run's merge registry. So each opener's branch identity is
 * bound to the current run/artifact wherever forge can DERIVE it:
 *   - `spec` → `write-spec` opens `write-spec/<slug>` — bound EXACTLY to
 *     `state.slug` (the run's own slug per the spec §7 branch table). A
 *     path-based start makes `review-spec` the opener with
 *     `review-spec/<spec-doc-basename>` — bound EXACTLY to the recorded/imported
 *     `spec_path` basename. `red-team-spec` only ADOPTS.
 *   - `plan` → `spec-to-plan` opens `spec-to-plan/<spec-stem>-<timestamp>` — the
 *     stem is the SPEC doc basename (the skill derives it from the threaded
 *     spec path), so it is bound by the `spec-to-plan/<spec-stem>-` PREFIX (the
 *     timestamp alone is undervivable). A path-based start makes `review-plan`
 *     the opener with `review-plan/<plan-doc-basename>` — bound EXACTLY to the
 *     recorded/imported `plan_path` basename. `red-team-plan` only ADOPTS.
 *   - `impl` → `copilot` opens `copilot/<task-slug>` branches; the task slug is
 *     derived from plan-to-tasks issue titles, which forge NEVER records, so the
 *     opener-shape prefix is the tightest available bind (documented residual —
 *     a same-prefix foreign copilot PR is not distinguishable at this scope).
 * A never-merged `red-team-fold/*` branch matches NONE — fold PRs live in
 * `fold_prs`, never `artifact_prs`.
 */
function headBranchMatchesStage(
  state: RunState,
  stage: Stage,
  head: string,
): boolean {
  switch (stage) {
    // --- spec artifact -----------------------------------------------------
    case "write-spec":
      // write-spec seeds its PR before `spec_path` is threadable, so the
      // slug-bound opener is the only accepted shape (a foreign `write-spec/*`
      // carrying a different slug is refused).
      return head === `write-spec/${state.slug}`;
    case "review-spec": {
      // Opener only in a spec-path start; otherwise it adopts write-spec's PR
      // (which short-circuits before this matcher as an existing registry
      // entry). Bound EXACTLY to the recorded/imported spec doc basename.
      const stem = docStem(threadedDocPath(state, "spec_path"));
      return stem !== null && head === `review-spec/${stem}`;
    }

    // --- plan artifact -----------------------------------------------------
    case "spec-to-plan": {
      // Opens `spec-to-plan/<spec-stem>-<timestamp>`; the timestamp is not
      // derivable, so the stem-bound prefix is the tightest available bind.
      const specStem = docStem(threadedDocPath(state, "spec_path"));
      if (specStem !== null) return head.startsWith(`spec-to-plan/${specStem}-`);
      // spec_path not yet threadable (the opener records it in the same call
      // that seeds the PR) → fall back to the opener shape.
      return head.startsWith("spec-to-plan/");
    }
    case "review-plan": {
      // Opener only in a plan-path start; bound EXACTLY to the recorded/
      // imported plan doc basename. Critically it must NOT fall through to a
      // `spec-to-plan/` prefix: in a plan-path run spec_path is absent, and the
      // old artifact-keyed fallback accepted ANY correct-base `spec-to-plan/*`
      // PR — including one from an unrelated run — into this run's registry.
      const planStem = docStem(threadedDocPath(state, "plan_path"));
      return planStem !== null && head === `review-plan/${planStem}`;
    }

    // --- impl artifact -----------------------------------------------------
    case "copilot":
      // `copilot/<task-slug>`; the task slug comes from plan-to-tasks issue
      // titles, which forge never records, so the opener-shape prefix is the
      // tightest available bind (documented residual).
      return head.startsWith("copilot/");

    // --- adopt-only stages -------------------------------------------------
    case "red-team-spec":
    case "red-team-plan":
      // These NEVER open an artifact PR — they adopt the existing one (which
      // short-circuits as an existing registry entry). A new PR reported by a
      // red-team stage matches nothing and is refused. In particular a
      // never-merged `red-team-fold/*` branch belongs in `fold_prs`, never in
      // `artifact_prs`.
      return false;

    case "plan-to-tasks":
      return false; // no PR at all (caller already returned on null artifact)
  }
}

/** Which artifact a stage's PR belongs to (host copy for seed verification —
 * mirrors the lib's `stageArtifact`). */
function stageArtifactForVerify(stage: Stage): "spec" | "plan" | "impl" | null {
  switch (stage) {
    case "write-spec":
    case "review-spec":
    case "red-team-spec":
      return "spec";
    case "spec-to-plan":
    case "review-plan":
    case "red-team-plan":
      return "plan";
    case "copilot":
      return "impl";
    case "plan-to-tasks":
      return null;
  }
}

// --- resolve -----------------------------------------------------------------

function cmdResolve(argv: string[]): number {
  const wantJson = argv.includes("--json");
  const res = validateArgs(argv);
  if (!res.ok) {
    narrate(`forge: ${res.error.code}: ${res.error.message}`);
    if (wantJson) out(buildErrorSummary(res.error));
    return 1;
  }
  if ("resume" in res) {
    narrate(`forge: resume requested (slug ${res.resume.slug ?? "<latest>"})`);
    out({ action: "resume", slug: res.resume.slug });
    return 0;
  }
  const resolved = res.resolved;
  if (argv.includes("--dry-run")) {
    narrate(
      `forge: dry-run — resolved ${resolved.chain.length}-stage chain for slug '${resolved.slug}' (nothing persisted).`,
    );
    out(buildDryRunSummary(resolved));
    return 0;
  }
  // Resolved-init descriptor the SKILL feeds straight into `init`, carrying a
  // host-allocated run_id so the subsequent `init` is retry-idempotent.
  const runId = allocateRunId();
  narrate(`forge: resolved run '${runId}' (slug '${resolved.slug}').`);
  out({
    action: "init",
    slug: resolved.slug,
    run_id: runId,
    chain: resolved.chain,
    merge_points: resolved.mergePoints,
    input_kind: resolved.input.kind,
    input_value: resolved.input.value,
    initial_artifacts: resolved.initial_artifacts,
    // Mode comes from the single host-owned feasibility verdict — never a bare
    // "in-session" default. Fails closed to driver when the Phase-0 spike did
    // not prove nested invocation.
    mode: resolveExecutionMode(),
  });
  return 0;
}

// --- init --------------------------------------------------------------------

/** The descriptor fields that define run identity for idempotency. */
function initDescriptor(state: RunState): unknown {
  return {
    slug: state.slug,
    run_id: state.run_id,
    chain: state.chain,
    input: state.input,
    initial_artifacts: state.initial_artifacts,
    mode: state.mode,
  };
}

function cmdInit(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS.init);
  const slug = reqStr(opts, "slug");
  const runId = reqStr(opts, "run-id");
  const chain = validateChain(
    reqStr(opts, "chain")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const createdAt = reqStr(opts, "created-at");
  const inputKind = reqEnum<InputKind>(
    reqStr(opts, "input-kind"),
    VALID_INPUT_KINDS,
    "input-kind",
  );
  const inputValue = reqStr(opts, "input-value");
  // Mode is a DURABLE Phase-0 feasibility verdict, decided ONCE by `resolve`
  // (the single authority that reads the nested-invocation marker) and threaded
  // forward verbatim as `--mode`. `init` RECORDS that verdict — it never
  // re-consults the environment (Finding 4): re-reading a caller-set env var
  // here made the mode non-durable and retry-UNSTABLE — an identical
  // `(slug, run_id)` retried in a process without the marker would recompute
  // `driver`, differ from the persisted `in-session`, and trip `init_conflict`.
  // An unknown value is rejected; an absent flag fails closed to `driver`.
  // §7 lists `--mode <in-session|driver>` among `init`'s REQUIRED arguments, so
  // it is required here rather than silently defaulting: an omitted flag used to
  // fail closed to `driver`, which would durably record a mode the caller never
  // chose and quietly strand an in-session run in driver mode.
  const requestedMode = reqStr(opts, "mode");
  reqEnum(requestedMode, VALID_MODES, "mode");
  const mode = requestedMode as "in-session" | "driver";

  const initial_artifacts: InitialArtifacts = {};
  const sp = optStr(opts, "initial-spec-path");
  const pp = optStr(opts, "initial-plan-path");
  const ps = optStr(opts, "initial-plan-slug");
  if (sp !== undefined) initial_artifacts.spec_path = sp;
  if (pp !== undefined) initial_artifacts.plan_path = pp;
  if (ps !== undefined) initial_artifacts.plan_slug = ps;

  // Arg-combination validation (§7): input kind ↔ initial-artifact args.
  if (inputKind === "intent" && (sp || pp || ps)) {
    narrate("forge: init_args_invalid: an intent start seeds no initial artifacts.");
    return 1;
  }
  if (inputKind === "spec-path" && (!sp || pp || ps)) {
    narrate("forge: init_args_invalid: a spec-path start requires only --initial-spec-path.");
    return 1;
  }
  if (inputKind === "plan-path" && (!pp || !ps || sp)) {
    narrate("forge: init_args_invalid: a plan-path start requires --initial-plan-path and --initial-plan-slug.");
    return 1;
  }

  const desired: ResolvedRun = {
    chain,
    mergePoints: mergePointsFor(chain),
    slug,
    input: { kind: inputKind, value: inputValue },
    initial_artifacts,
    // repo/default_branch filled below (fail-fast, no state write on failure).
    repo: { host: "", owner: "", name: "" },
    default_branch: "",
  };

  // Resolve the CURRENT checkout's identity FIRST — before any idempotency
  // decision (Finding 3). Fail-fast, no state write on an unresolved/missing
  // remote. `loadState` keys only on (slug, run_id) across the GLOBAL history,
  // so a foreign repository's run could otherwise be returned as an "identical
  // retry" (repo/default_branch were excluded from the descriptor comparison).
  const repo = resolveCurrentRepo();
  if (!repo) {
    narrate("forge: repo_unresolved: cannot resolve `git remote get-url origin`.");
    return 1;
  }
  const defaultBranch = resolveDefaultBranch();
  if (!defaultBranch) {
    narrate("forge: default_branch_unresolved: cannot resolve origin/HEAD.");
    return 1;
  }
  desired.repo = repo;
  desired.default_branch = defaultBranch;

  // Retry-idempotent: an existing (slug, run_id) with an identical descriptor
  // returns unchanged (no second run dir, `latest` unmoved); a differing one is
  // rejected `init_conflict` — no write.
  let existing: RunState | null = null;
  try {
    existing = loadState(slug, runId);
  } catch (e) {
    // Only a CONFIRMED not-found (no state file yet) means "run absent" —
    // create-if-absent then proceeds. A corrupt/unreadable existing state
    // (`corrupt_state`, permission error, any other I/O failure) must PROPAGATE
    // without writing: overwriting it would destroy recovery evidence and
    // violate create-if-absent. `main`'s catch renders the coded error, exit 1.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      existing = null;
    } else {
      throw e;
    }
  }
  if (existing) {
    // A run with this (slug, run_id) that belongs to a DIFFERENT repository or
    // default branch is NOT this checkout's retry — refuse without writing
    // rather than adopt a foreign run (Finding 3).
    if (
      existing.repo.host !== repo.host ||
      existing.repo.owner !== repo.owner ||
      existing.repo.name !== repo.name ||
      existing.default_branch !== defaultBranch
    ) {
      narrate(
        `forge: repo_mismatch: run '${runId}' exists for a different repository/default branch ` +
          `(${existing.repo.owner}/${existing.repo.name}@${existing.default_branch}).`,
      );
      return 1;
    }
    const candidate = initializeRun(desired, { runId, at: createdAt, mode });
    // Compare the identity-defining descriptor (ignore timestamps; repo +
    // default_branch already matched above).
    if (
      JSON.stringify(initDescriptor(existing)) ===
      JSON.stringify(initDescriptor(candidate))
    ) {
      narrate(`forge: init retry — run '${runId}' already exists, returning unchanged.`);
      out(existing);
      return 0;
    }
    narrate(`forge: init_conflict: run '${runId}' exists with a differing descriptor.`);
    return 1;
  }

  const state = initializeRun(desired, { runId, at: createdAt, mode });
  persistState(state);
  narrate(`forge: initialized run '${runId}' (slug '${slug}').`);
  out(state);
  return 0;
}

// --- record-output -----------------------------------------------------------

function cmdRecordOutput(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS["record-output"]);
  const slug = reqStr(opts, "slug");
  const runId = optStr(opts, "run-id");
  const stage = reqEnum<Stage>(reqStr(opts, "stage"), VALID_STAGES, "stage");
  const at = reqStr(opts, "at");
  const prs = csvInts(optStr(opts, "prs"));
  const foldPrs = csvInts(optStr(opts, "fold-prs"));
  const merges = parseMerges(optStr(opts, "merges"));
  const artifacts = artifactsFromOpts(opts);

  const state = loadState(slug, runId);
  // Seed verification (host preflight) — before the mutation touches the registry.
  verifySeedPrs(state, stage, prs, (pr) => readPrMeta(state.repo, pr));
  // Each merge PR must belong to the merge-point artifact registry (or be seeded
  // by this same call's `--prs`) — no unrelated merge records.
  verifyMergePrs(state, stage, merges, prs);

  const next = recordOutput(state, {
    stage,
    prs: prs.length ? prs : undefined,
    foldPrs: foldPrs.length ? foldPrs : undefined,
    merges: merges.length ? merges : undefined,
    artifacts,
    at,
  });
  persistState(next);
  out(next);
  return 0;
}

// --- transition --------------------------------------------------------------

function cmdTransition(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS.transition);
  const slug = reqStr(opts, "slug");
  const runId = optStr(opts, "run-id");
  const stage = reqEnum<Stage>(reqStr(opts, "stage"), VALID_STAGES, "stage");
  const to = reqEnum<StageStatus>(reqStr(opts, "to"), VALID_STATUSES, "to");
  const at = reqStr(opts, "at");
  const fromRaw = optStr(opts, "from");
  const from =
    fromRaw !== undefined
      ? reqEnum<StageStatus>(fromRaw, VALID_STATUSES, "from")
      : undefined;
  const prs = csvInts(optStr(opts, "prs"));
  const foldPrs = csvInts(optStr(opts, "fold-prs"));
  const artifacts = artifactsFromOpts(opts);
  const gateReason = optStr(opts, "gate-reason");
  const gateDetail = optStr(opts, "gate-detail");
  const gate: Gate | undefined = gateReason
    ? { reason: gateReason, detail: gateDetail ?? "" }
    : undefined;

  const state = loadState(slug, runId);
  const readPr = makePrReader(state.repo);
  // Seed verification guards the delegated `--prs` path too.
  verifySeedPrs(state, stage, prs, (pr) => readPrMeta(state.repo, pr));

  const next = transition(
    state,
    {
      stage,
      expectedStatus: from,
      to,
      prs: prs.length ? prs : undefined,
      foldPrs: foldPrs.length ? foldPrs : undefined,
      gate,
      artifacts,
      at,
    },
    readPr,
  );
  persistState(next);
  // Spec §7: transition "prints the updated stage record" — NOT the full run
  // object (Finding 5). The same contract holds on a replay-safe CAS no-op,
  // which reprints the (unchanged) selected stage record.
  const rec = next.stages.find((s) => s.stage === stage);
  out(rec);
  return 0;
}

// --- get / abandon / summary -------------------------------------------------

function cmdGet(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS.get);
  const state = loadState(reqStr(opts, "slug"), optStr(opts, "run-id"));
  out(state);
  return 0;
}

function cmdAbandon(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS.abandon);
  const slug = reqStr(opts, "slug");
  const runId = optStr(opts, "run-id");
  const at = reqStr(opts, "at");
  const state = loadState(slug, runId);
  const next = abandonRun(state, at);
  persistState(next);
  narrate(`forge: run '${next.run_id}' abandoned (${next.abandoned_at}).`);
  out(next);
  return 0;
}

function cmdSummary(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS.summary);
  const state = loadState(reqStr(opts, "slug"), optStr(opts, "run-id"));
  out(buildSummary(state, makePrReader(state.repo)));
  return 0;
}

// --- resume-target / driver-block (shared run selection + reconcile-persist) --

/**
 * Select + reconcile the resume run: no-arg picks the latest resumable run for
 * the current repo (`selectResumeRun` over `listResumeCandidates`); `--slug`
 * loads that slug's latest. Fails closed (no write) if the loaded run's `repo`
 * differs from the current checkout. Persists reconciled state BEFORE returning
 * so a subsequent resume never repeats reconciliation or loses a merge record.
 */
function selectAndReconcile(
  slug: string | undefined,
): { state: RunState; target: ResumeTarget } | { error: string } {
  const current = resolveCurrentRepo();
  if (!current) return { error: "repo_unresolved: cannot resolve current repo." };

  let state: RunState;
  if (slug) {
    state = loadState(slug);
  } else {
    const picked = selectResumeRun(listResumeCandidates(current));
    if (!picked) return { error: "no_resumable_run: no non-done, non-abandoned run." };
    state = picked;
  }

  if (!sameRepoIdentity(state.repo, current)) {
    return {
      error: `repo_mismatch: run repo '${state.repo.owner}/${state.repo.name}' != current checkout.`,
    };
  }

  const readPr = makePrReader(state.repo);
  const { state: reconciled, target } = resumeTarget(state, readPr);
  if (target.reconciled) persistState(reconciled);
  return { state: reconciled, target };
}

/** Case-insensitive identity compare (host copy — `sameRepo` is module-private
 * above but scoped to discovery). */
function sameRepoIdentity(a: RepoIdentity, b: RepoIdentity): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function cmdResumeTarget(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS["resume-target"]);
  const r = selectAndReconcile(optStr(opts, "slug"));
  if ("error" in r) {
    narrate(`forge: ${r.error}`);
    return 1;
  }
  narrate(
    `forge: resume target stage '${r.target.target_stage}' (action ${r.target.action}, reconciled ${r.target.reconciled}).`,
  );
  out(r.target);
  return 0;
}

function cmdDriverBlock(argv: string[]): number {
  const opts = parseOpts(argv, SUBCOMMAND_FLAGS["driver-block"]);
  const r = selectAndReconcile(optStr(opts, "slug"));
  if ("error" in r) {
    narrate(`forge: ${r.error}`);
    return 1;
  }
  narrate(
    `forge: driver block for stage '${r.target.target_stage}' (action ${r.target.action}).`,
  );
  process.stdout.write(renderDriverBlock(r.state, r.target));
  return 0;
}

// --- help + main -------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`usage: forge_state.ts <subcommand> [options]

The /stark-forge pipeline state manager (no LLM, no git mutation — only
read-only \`gh pr view\` queries). See docs/specs/2026-07-19-stark-forge-spec.md
§7 for the full subcommand/flag contract.

subcommands:
  resolve <forge argv...>   Validate raw /stark-forge argv; on valid args print
                            a resolved-init descriptor (or, with --dry-run, the
                            §9 dry_run summary). Fails fast on every §1 invalid
                            combination with the exact error.code.
  init                      Create the initial state.json (retry-idempotent).
  record-output             Record a running stage's PRs/fold PRs/merges/artifacts.
  transition                Apply one legal status transition.
  get                       Print the full run object.
  abandon                   Mark the run terminally abandoned.
  summary                   Print the §9 final-summary object.
  resume-target             Reconcile + print the next resume action descriptor.
  driver-block              Print the driver-mode command block for the target.

  -h, --help                show this help message and exit
`);
}

export function main(argv: string[]): number {
  const sub = argv[0];
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    printHelp();
    return 0;
  }
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case "resolve":
        return cmdResolve(rest);
      case "init":
        return cmdInit(rest);
      case "record-output":
        return cmdRecordOutput(rest);
      case "transition":
        return cmdTransition(rest);
      case "get":
        return cmdGet(rest);
      case "abandon":
        return cmdAbandon(rest);
      case "summary":
        return cmdSummary(rest);
      case "resume-target":
        return cmdResumeTarget(rest);
      case "driver-block":
        return cmdDriverBlock(rest);
      default:
        narrate(`forge: unknown subcommand '${sub}' (try --help)`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ForgeStateError) {
      narrate(`forge: ${e.code}: ${e.message}`);
    } else {
      narrate(`forge: ${(e as Error).message}`);
    }
    return 1;
  }
}

// Run `main` only when executed as the entry point — never on import (tests
// import the pure helpers), so importing this module is side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
