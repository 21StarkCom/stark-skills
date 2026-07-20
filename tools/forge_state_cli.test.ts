// Tests for the Phase 5 CLI half of `tools/forge_state.ts` — the argv bridge
// (`resolve`), the state-mutating subcommands (`init`/`record-output`/
// `transition`/`get`/`abandon`/`summary`), `resume-target`, and the
// `driver-block` renderer.
//
// Run: node --experimental-strip-types --test tools/forge_state_cli.test.ts
//
// Named spec tests covered here:
//   #9  — every §1 invalid combination fails-fast with its error.code, writes
//         no state; resolve --dry-run from all three input kinds renders the §9
//         dry_run object with symbolic producer refs and creates no run dir.
//   #19 — --json summary shape matches §9 for completed/halted/failed runs.
//   #21 — driver mode emits exact command blocks and advances only on reported
//         transitions (base-sync only on new-artifact stages, non-`main`
//         default, no shell timeout wrapper).
//   + resume-target persists reconciliation before printing (+ repo-mismatch
//     fail-closed), init retry-idempotency + init_conflict, seed-time refusal of
//     an unrelated PR through BOTH record-output and transition, and a --help
//     smoke.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSummary, persistState } from "./forge_state.ts";
import type {
  PrReader,
  RepoIdentity,
  RunState,
  Stage,
  StageRecord,
} from "./forge_state_lib.ts";
import { mergePointsFor } from "./forge_state_lib.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = path.join(HERE, "forge_state.ts");
const REPO_ROOT = path.resolve(HERE, "..");

const REPO: RepoIdentity = {
  host: "github.com",
  owner: "21StarkCom",
  name: "stark-skills",
};

type CliResult = { status: number; stdout: string; stderr: string };

/** Run the real forge_state.ts CLI as a subprocess. cwd defaults to the repo
 * root so `resolveCurrentRepo`/`resolveDefaultBranch` resolve stark-skills. */
function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stateRoot?: string } = {},
): CliResult {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(opts.stateRoot ? { STARK_STATE_ROOT: opts.stateRoot } : {}),
        ...(opts.env ?? {}),
      },
    },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmpStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-cli-"));
}

/** True when the forge history root under `stateRoot` holds no run dirs. */
function noRunDirs(stateRoot: string): boolean {
  const root = path.join(stateRoot, "history", "forge");
  if (!fs.existsSync(root)) return true;
  const slugs = fs.readdirSync(root);
  for (const s of slugs) {
    const entries = fs
      .readdirSync(path.join(root, s), { withFileTypes: true })
      .filter((e) => e.isDirectory());
    if (entries.length > 0) return false;
  }
  return slugs.length === 0;
}

function stageRec(stage: Stage, over: Partial<StageRecord> = {}): StageRecord {
  return {
    stage,
    status: "pending",
    prs: [],
    merges: [],
    fold_prs: [],
    artifacts: {},
    gate: null,
    started_at: null,
    ended_at: null,
    attempts: [],
    ...over,
  };
}

function makeState(over: Partial<RunState> & { chain: Stage[] }): RunState {
  const chain = over.chain;
  return {
    slug: over.slug ?? "walk",
    run_id: over.run_id ?? "20260720-000000-aaa",
    input: over.input ?? { kind: "intent", value: "make a thing" },
    initial_artifacts: over.initial_artifacts ?? {},
    mode: over.mode ?? "driver",
    chain,
    merge_points: over.merge_points ?? mergePointsFor(chain),
    artifact_prs: over.artifact_prs ?? {},
    repo: over.repo ?? REPO,
    default_branch: over.default_branch ?? "main",
    created_at: over.created_at ?? "2026-07-20T00:00:00Z",
    updated_at: over.updated_at ?? "2026-07-20T00:00:00Z",
    abandoned_at: over.abandoned_at ?? null,
    stages: over.stages ?? chain.map((s) => stageRec(s)),
  };
}

/** Persist a fixture under a controlled STARK_STATE_ROOT — never the operator's
 * real forge history (`stateRoot()` reads the ambient env at call time). */
function persistFixture(stateRoot: string, state: RunState): void {
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(state);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }
}

// ===========================================================================
// #9 — CLI validation: every invalid combination fails-fast, writes no state
// ===========================================================================

test("#9 every §1 invalid combination fails-fast with its error.code and writes no state", () => {
  const stateRoot = tmpStateRoot();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forge-scratch-"));
  // On-disk artifacts used by the file-dependent rows.
  fs.mkdirSync(path.join(scratch, "docs", "specs"), { recursive: true });
  fs.mkdirSync(path.join(scratch, "docs", "plans"), { recursive: true });
  const goodSpec = "docs/specs/2026-07-20-demo-spec.md";
  fs.writeFileSync(path.join(scratch, goodSpec), "# spec");
  const spacedSpec = "docs/specs/2026-07-20-bad name-spec.md";
  fs.writeFileSync(path.join(scratch, spacedSpec), "# spec");
  const badPlan = "docs/plans/nodate-plan.md"; // matches classify, fails parsePlanSlug
  fs.writeFileSync(path.join(scratch, badPlan), "# plan");

  type Row = { args: string[]; code: string; cwd?: string };
  const rows: Row[] = [
    { args: ["resolve", "some intent", "--resume"], code: "resume_with_positional" },
    { args: ["resolve", "--resume", "--from", "review-spec"], code: "resume_with_slice" },
    { args: ["resolve", "--resume", "--red-team"], code: "resume_with_red_team" },
    // empty_chain: spec-path start sliced from spec-to-plan back to review-spec.
    {
      args: ["resolve", goodSpec, "--from", "spec-to-plan", "--until", "review-spec"],
      code: "empty_chain",
      cwd: scratch,
    },
    // stage_not_in_chain: --until red-team-spec without --red-team.
    { args: ["resolve", "an intent", "--until", "red-team-spec"], code: "stage_not_in_chain" },
    { args: ["resolve", goodSpec, "--from", "write-spec"], code: "from_needs_intent", cwd: scratch },
    { args: ["resolve"], code: "missing_input" },
    { args: ["resolve", spacedSpec], code: "input_path_unsafe", cwd: scratch },
    { args: ["resolve", badPlan], code: "plan_slug_unresolved", cwd: scratch },
    { args: ["resolve", "an intent", "--from", "review-plan"], code: "entry_input_unavailable" },
  ];

  for (const row of rows) {
    const r = runCli([...row.args, "--json"], { stateRoot, cwd: row.cwd });
    assert.notEqual(r.status, 0, `${row.code}: expected non-zero exit`);
    const obj = JSON.parse(r.stdout);
    assert.equal(obj.status, "error", `${row.code}: status`);
    assert.equal(obj.error.code, row.code, `${row.code}: error.code`);
    assert.equal(obj.slug, null);
    assert.equal(obj.run_id, null);
    // Narration on stderr, nothing but the single JSON object on stdout.
    assert.ok(r.stderr.includes(row.code), `${row.code}: narration on stderr`);
    assert.equal(JSON.parse(r.stdout) && typeof obj, "object");
    assert.ok(noRunDirs(stateRoot), `${row.code}: no run dir written`);
  }

  // Non-JSON error: narration on stderr, nothing on stdout.
  const nr = runCli(["resolve", "x", "--resume"], { stateRoot });
  assert.notEqual(nr.status, 0);
  assert.equal(nr.stdout.trim(), "");
  assert.ok(nr.stderr.includes("resume_with_positional"));

  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("#9 resolve --dry-run from all three input kinds renders the §9 dry_run object with symbolic refs and creates no run dir", () => {
  const stateRoot = tmpStateRoot();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "forge-scratch-"));
  fs.mkdirSync(path.join(scratch, "docs", "specs"), { recursive: true });
  fs.mkdirSync(path.join(scratch, "docs", "plans"), { recursive: true });
  const specPath = "docs/specs/2026-07-20-demo-spec.md";
  const planPath = "docs/plans/2026-07-20-demo-plan.md";
  fs.writeFileSync(path.join(scratch, specPath), "# spec");
  fs.writeFileSync(path.join(scratch, planPath), "# plan");

  // intent → symbolic producer refs for everything downstream of write-spec.
  const ir = runCli(["resolve", "author a widget", "--dry-run", "--json"], { stateRoot });
  assert.equal(ir.status, 0);
  const io = JSON.parse(ir.stdout);
  assert.equal(io.status, "dry_run");
  assert.equal(io.slug, null);
  assert.equal(io.run_id, null);
  assert.deepEqual(io.chain, [
    "write-spec",
    "review-spec",
    "spec-to-plan",
    "review-plan",
    "plan-to-tasks",
    "copilot",
  ]);
  const iCmd = Object.fromEntries(io.commands.map((c: { stage: string; command: string }) => [c.stage, c.command]));
  assert.equal(iCmd["write-spec"], '/stark-write-spec "author a widget"');
  assert.equal(iCmd["review-spec"], "/stark-review-spec <write-spec.spec_path>");
  assert.equal(iCmd["copilot"], "/stark-copilot --plan-slug <spec-to-plan.plan_slug>");
  assert.ok(noRunDirs(stateRoot), "dry_run intent: no run dir");

  // spec-path → imported spec_path emitted bare; plan_path still symbolic.
  const sr = runCli(["resolve", specPath, "--dry-run", "--json"], { stateRoot, cwd: scratch });
  assert.equal(sr.status, 0);
  const so = JSON.parse(sr.stdout);
  assert.equal(so.status, "dry_run");
  assert.equal(so.chain[0], "review-spec");
  const sCmd = Object.fromEntries(so.commands.map((c: { stage: string; command: string }) => [c.stage, c.command]));
  assert.equal(sCmd["review-spec"], `/stark-review-spec ${specPath}`);
  assert.equal(sCmd["review-plan"], "/stark-review-plan <spec-to-plan.plan_path>");
  assert.ok(noRunDirs(stateRoot), "dry_run spec: no run dir");

  // plan-path → imported plan_path + resolved plan_slug both bare.
  const pr = runCli(["resolve", planPath, "--dry-run", "--json"], { stateRoot, cwd: scratch });
  assert.equal(pr.status, 0);
  const po = JSON.parse(pr.stdout);
  assert.equal(po.status, "dry_run");
  assert.equal(po.chain[0], "review-plan");
  const pCmd = Object.fromEntries(po.commands.map((c: { stage: string; command: string }) => [c.stage, c.command]));
  assert.equal(pCmd["review-plan"], `/stark-review-plan ${planPath}`);
  assert.equal(pCmd["plan-to-tasks"], `/stark-plan-to-tasks ${planPath} --plan-slug demo`);
  assert.equal(pCmd["copilot"], "/stark-copilot --plan-slug demo");
  assert.ok(noRunDirs(stateRoot), "dry_run plan: no run dir");

  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ===========================================================================
// T2 — state-mutating subcommands (subprocess-level)
// ===========================================================================

const INIT_ARGS = [
  "init",
  "--slug",
  "idem",
  "--run-id",
  "20260720-010000-bbb",
  "--chain",
  "write-spec,review-spec",
  "--created-at",
  "2026-07-20T00:00:00Z",
  "--input-kind",
  "intent",
  "--input-value",
  "make a thing",
  "--mode",
  "in-session",
];

test("init is retry-idempotent (identical descriptor → same run, latest unmoved) and rejects a differing descriptor with init_conflict", () => {
  const stateRoot = tmpStateRoot();

  const first = runCli(INIT_ARGS, { stateRoot });
  assert.equal(first.status, 0, first.stderr);
  const s1 = JSON.parse(first.stdout);
  assert.equal(s1.run_id, "20260720-010000-bbb");
  assert.equal(s1.repo.name, "stark-skills");

  const slugDir = path.join(stateRoot, "history", "forge", "idem");
  const runDirsAfterFirst = fs
    .readdirSync(slugDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Retry with the identical descriptor: no second run dir, latest unmoved.
  const retry = runCli(INIT_ARGS, { stateRoot });
  assert.equal(retry.status, 0, retry.stderr);
  assert.ok(retry.stderr.includes("already exists"));
  const runDirsAfterRetry = fs
    .readdirSync(slugDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.deepEqual(runDirsAfterRetry.sort(), runDirsAfterFirst.sort());

  // Differing descriptor (different chain) → init_conflict, no write.
  const conflict = runCli(
    INIT_ARGS.map((a) => (a === "write-spec,review-spec" ? "write-spec" : a)),
    { stateRoot },
  );
  assert.equal(conflict.status, 1);
  assert.ok(conflict.stderr.includes("init_conflict"));

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("record-output + transition map flags to fields, persist state, and CAS retry is a no-op", () => {
  const stateRoot = tmpStateRoot();
  runCli(INIT_ARGS, { stateRoot });
  const slug = "idem";
  const rid = "20260720-010000-bbb";
  const base = ["--slug", slug, "--run-id", rid];

  // pending → running.
  const t1 = runCli(
    ["transition", ...base, "--stage", "write-spec", "--from", "pending", "--to", "running", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(t1.status, 0, t1.stderr);
  // §7: transition prints the updated STAGE RECORD, not the full run object.
  const t1rec = JSON.parse(t1.stdout);
  assert.equal(t1rec.stage, "write-spec");
  assert.equal(t1rec.status, "running");
  assert.equal(t1rec.stages, undefined, "transition emits a StageRecord, not a RunState");

  // Stale compare-and-set RETRY: the operator's pending→running transition landed
  // but its ack was lost, so the retry re-issues the SAME move WITH the stale
  // `--from pending`. Current status is already `running`, so the replay-safe
  // no-op reprint fires and the CAS guard is satisfied vacuously — exit 0, and
  // state.json (timestamps AND attempts) is byte-for-byte unchanged. Re-issuing
  // WITHOUT `--from` would only prove running→running idempotency; the `--from
  // pending` here proves the stale-CAS retry specifically.
  const stateFilePath = path.join(stateRoot, "history", "forge", slug, rid, "state.json");
  const beforeRetry = fs.readFileSync(stateFilePath, "utf8");
  const t1b = runCli(
    ["transition", ...base, "--stage", "write-spec", "--from", "pending", "--to", "running", "--at", "2026-07-20T02:00:00Z"],
    { stateRoot },
  );
  assert.equal(t1b.status, 0, t1b.stderr);
  const t1brec = JSON.parse(t1b.stdout);
  assert.equal(t1brec.stage, "write-spec");
  assert.equal(t1brec.status, "running");
  assert.equal(t1brec.stages, undefined, "CAS no-op reprints the StageRecord, not the RunState");
  const afterRetry = fs.readFileSync(stateFilePath, "utf8");
  assert.equal(afterRetry, beforeRetry, "stale CAS retry persisted NO change (byte-identical state.json)");
  const reread = JSON.parse(afterRetry) as RunState;
  assert.equal(reread.stages[0].started_at, "2026-07-20T01:00:00Z", "started_at unchanged by the stale retry");
  assert.deepEqual(reread.stages[0].attempts, [], "no attempt appended by the stale retry");

  // record-output: spec_path artifact (write-once scalar), issue-numbers CSV union.
  const ro = runCli(
    [
      "record-output",
      ...base,
      "--stage",
      "write-spec",
      "--artifact-spec-path",
      "docs/specs/2026-07-20-idem-spec.md",
      "--at",
      "2026-07-20T03:00:00Z",
    ],
    { stateRoot },
  );
  assert.equal(ro.status, 0, ro.stderr);
  assert.equal(JSON.parse(ro.stdout).stages[0].artifacts.spec_path, "docs/specs/2026-07-20-idem-spec.md");

  // The write persisted — a fresh `get` sees it on disk.
  const g = runCli(["get", ...base], { stateRoot });
  assert.equal(JSON.parse(g.stdout).stages[0].artifacts.spec_path, "docs/specs/2026-07-20-idem-spec.md");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("seed-time refusal of an unrelated PR (artifact_pr_unverified) through BOTH record-output --prs and transition --prs", () => {
  const stateRoot = tmpStateRoot();
  runCli(INIT_ARGS, { stateRoot });
  const base = ["--slug", "idem", "--run-id", "20260720-010000-bbb"];
  runCli(
    ["transition", ...base, "--stage", "write-spec", "--from", "pending", "--to", "running", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );

  // PR #99 has the WRONG base (not the recorded default branch `main`).
  const fake = JSON.stringify({
    "99": { state: "open", baseRefName: "some-feature", headRefName: "write-spec/idem" },
  });

  const viaRecord = runCli(
    ["record-output", ...base, "--stage", "write-spec", "--prs", "99", "--at", "2026-07-20T04:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: fake } },
  );
  assert.equal(viaRecord.status, 1);
  assert.ok(viaRecord.stderr.includes("artifact_pr_unverified"), viaRecord.stderr);

  const viaTransition = runCli(
    ["transition", ...base, "--stage", "write-spec", "--to", "done", "--prs", "99", "--at", "2026-07-20T04:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: fake } },
  );
  assert.equal(viaTransition.status, 1);
  assert.ok(viaTransition.stderr.includes("artifact_pr_unverified"), viaTransition.stderr);

  // Neither path persisted a PR into the registry.
  const g = runCli(["get", ...base], { stateRoot });
  assert.deepEqual(JSON.parse(g.stdout).artifact_prs, {});

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("forge_state.ts --help exits clean", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("usage: forge_state.ts"));
});

// --- Finding 2: execution mode sourced from the host feasibility verdict -----

test("resolve suggests the recorded Phase-0 verdict; init REQUIRES --mode and records it verbatim", () => {
  // `resolve` suggests the durable Phase-0 verdict (in-session — the spike
  // proved nested invocation in this harness), NOT an ambient capability probe.
  const rDefault = runCli(["resolve", "author a widget"]);
  assert.equal(rDefault.status, 0, rDefault.stderr);
  assert.equal(JSON.parse(rDefault.stdout).mode, "in-session");

  // The override can only make forge MORE conservative — never assert an
  // unproven capability.
  const rForced = runCli(["resolve", "author a widget"], { env: { STARK_FORGE_DRIVER: "1" } });
  assert.equal(JSON.parse(rForced.stdout).mode, "driver");

  const stateRoot = tmpStateRoot();
  const initArgs = (over: string[]) => [
    "init", "--slug", "m", "--run-id", "20260720-090000-mmm",
    "--chain", "write-spec", "--created-at", "2026-07-20T00:00:00Z",
    "--input-kind", "intent", "--input-value", "x", ...over,
  ];
  // init RECORDS the resolve-produced verdict threaded as `--mode`; it never
  // re-reads the environment, so the mode is durable and retry-stable.
  const iInSession = runCli(initArgs(["--mode", "in-session"]), { stateRoot });
  assert.equal(iInSession.status, 0, iInSession.stderr);
  assert.equal(JSON.parse(iInSession.stdout).mode, "in-session", "--mode in-session recorded verbatim");

  // §7 lists --mode among init's REQUIRED args: an omitted flag is an error,
  // never a silent default that durably records a mode nobody chose.
  const stateRoot2 = tmpStateRoot();
  const iMissing = runCli(initArgs([]), { stateRoot: stateRoot2, env: { STARK_FORGE_DRIVER: "1" } });
  assert.notEqual(iMissing.status, 0, "omitted --mode must fail, not default");
  assert.match(`${iMissing.stdout}${iMissing.stderr}`, /mode/i);

  // An unknown value is rejected outright.
  const stateRoot3 = tmpStateRoot();
  const iBad = runCli(initArgs(["--mode", "hybrid"]), { stateRoot: stateRoot3 });
  assert.notEqual(iBad.status, 0, "unknown --mode must be rejected");

  const stateRoot4 = tmpStateRoot();
  const iDriver = runCli(initArgs(["--mode", "driver"]), { stateRoot: stateRoot4 });
  assert.equal(JSON.parse(iDriver.stdout).mode, "driver", "explicit driver recorded verbatim");

  for (const s of [stateRoot, stateRoot2, stateRoot3, stateRoot4]) fs.rmSync(s, { recursive: true, force: true });
});

test("init mode is retry-stable across processes: an in-session run retried WITHOUT the env marker is an idempotent no-op, not init_conflict (Finding 4)", () => {
  const stateRoot = tmpStateRoot();
  const initArgs = [
    "init", "--slug", "xproc", "--run-id", "20260720-093000-xpc",
    "--chain", "write-spec", "--created-at", "2026-07-20T00:00:00Z",
    "--input-kind", "intent", "--input-value", "x", "--mode", "in-session",
  ];
  // Process 1: resolve proved in-session; init records the durable verdict.
  const first = runCli(initArgs, { stateRoot, env: { STARK_FORGE_INSESSION_OK: "1" } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).mode, "in-session");

  // Process 2 (retry after a lost ack): the SAME descriptor, but the marker is
  // gone from this process's environment. The mode must NOT be recomputed —
  // identical descriptor → returns the existing run unchanged, no init_conflict.
  const runDir = path.join(stateRoot, "history", "forge", "xproc", "20260720-093000-xpc");
  const before = fs.readFileSync(path.join(runDir, "state.json"), "utf8");
  const retry = runCli(initArgs, { stateRoot }); // no STARK_FORGE_INSESSION_OK
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).mode, "in-session", "retry sees the persisted verdict, not a re-derivation");
  assert.ok(retry.stderr.includes("already exists"), retry.stderr);
  const after = fs.readFileSync(path.join(runDir, "state.json"), "utf8");
  assert.equal(after, before, "retry persisted no change");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// --- Finding 3: wrong-head rejection for a non-write-spec registry opener -----

test("seed verification rejects a wrong-head PR at spec-to-plan through BOTH record-output and transition", () => {
  const stateRoot = tmpStateRoot();
  const slug = "headshape";
  const rid = "20260720-100000-hhh";
  // A run already through spec (registry seeded) sitting at spec-to-plan running.
  const state = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "spec-to-plan"],
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [10] }),
      stageRec("spec-to-plan", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
    ],
  });
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(state);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }
  const base = ["--slug", slug, "--run-id", rid];

  // PR #55: correct base (main), but head is an UNRELATED branch — not
  // `spec-to-plan/<slug>`. Must be refused as a plan-registry seed.
  const fake = JSON.stringify({
    "55": { state: "open", baseRefName: "main", headRefName: "some-random-branch" },
  });
  const viaRecord = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "55", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: fake } },
  );
  assert.equal(viaRecord.status, 1);
  assert.ok(viaRecord.stderr.includes("artifact_pr_unverified"), viaRecord.stderr);

  const viaTransition = runCli(
    ["transition", ...base, "--stage", "spec-to-plan", "--to", "done", "--prs", "55", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: fake } },
  );
  assert.equal(viaTransition.status, 1);
  assert.ok(viaTransition.stderr.includes("artifact_pr_unverified"), viaTransition.stderr);

  // A spec-artifact head (`write-spec/...`) is the WRONG opener for the plan
  // registry — even with a correct base it must be refused, since a generic
  // `<stage>/<slug>` matcher would have wrongly accepted a `spec-to-plan/`-less
  // but stage-shaped branch.
  const wrongArtifact = JSON.stringify({
    "58": { state: "open", baseRefName: "main", headRefName: "write-spec/some-spec" },
  });
  const wa = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "58", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: wrongArtifact } },
  );
  assert.equal(wa.status, 1);
  assert.ok(wa.stderr.includes("artifact_pr_unverified"), wa.stderr);

  // A never-merged `red-team-fold/*` branch must never seed the plan registry.
  const foldBranch = JSON.stringify({
    "59": { state: "open", baseRefName: "main", headRefName: "red-team-fold/2026-07-19-x-plan-20260719-120000" },
  });
  const fb = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "59", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: foldBranch } },
  );
  assert.equal(fb.status, 1);
  assert.ok(fb.stderr.includes("artifact_pr_unverified"), fb.stderr);

  // The REAL spec-to-plan opener branch shape carries a timestamp suffix
  // (`spec-to-plan/<stem>-<timestamp>`), NOT the run slug — the authoritative
  // matcher accepts it by prefix.
  const okFake = JSON.stringify({
    "56": { state: "open", baseRefName: "main", headRefName: "spec-to-plan/my-feature-20260719-120000" },
  });
  const ok = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "56", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: okFake } },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).artifact_prs.plan, [56]);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// Finding 2: the matcher is STATE-AWARE — a same-prefix but UNRELATED PR (a
// correct-base PR opened by a DIFFERENT forge run) is refused, because the
// opener's branch identity is bound to THIS run/artifact wherever derivable.
test("seed verification refuses a same-prefix PR from a foreign forge run (Finding 2) through BOTH record-output and transition", () => {
  const stateRoot = tmpStateRoot();
  const slug = "alpha";
  const rid = "20260720-120000-al1";
  // Run 'alpha' whose spec doc stem is `2026-07-19-alpha-spec`, sitting at
  // spec-to-plan running (spec artifact already merged/registered).
  const state = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "spec-to-plan"],
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", {
        status: "done",
        prs: [10],
        artifacts: { spec_path: "docs/specs/2026-07-19-alpha-spec.md" },
      }),
      stageRec("spec-to-plan", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
    ],
  });
  persistFixture(stateRoot, state);
  const base = ["--slug", slug, "--run-id", rid];

  // PR #77: correct base (main) AND the right `spec-to-plan/` prefix, but its
  // stem is a DIFFERENT run's spec (`beta`) — a foreign run's plan PR. Refused.
  const foreign = JSON.stringify({
    "77": { state: "open", baseRefName: "main", headRefName: "spec-to-plan/2026-07-19-beta-spec-20260719-120000" },
  });
  const viaRecord = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "77", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: foreign } },
  );
  assert.equal(viaRecord.status, 1);
  assert.ok(viaRecord.stderr.includes("artifact_pr_unverified"), viaRecord.stderr);

  const viaTransition = runCli(
    ["transition", ...base, "--stage", "spec-to-plan", "--to", "done", "--prs", "77", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: foreign } },
  );
  assert.equal(viaTransition.status, 1);
  assert.ok(viaTransition.stderr.includes("artifact_pr_unverified"), viaTransition.stderr);

  // Nothing persisted into the plan registry.
  const g = runCli(["get", ...base], { stateRoot });
  assert.equal(JSON.parse(g.stdout).artifact_prs.plan, undefined);

  // THIS run's own spec-to-plan branch (bound to its spec stem) IS accepted.
  const own = JSON.stringify({
    "78": { state: "open", baseRefName: "main", headRefName: "spec-to-plan/2026-07-19-alpha-spec-20260720-010000" },
  });
  const ok = runCli(
    ["record-output", ...base, "--stage", "spec-to-plan", "--prs", "78", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: own } },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).stages.find((s: StageRecord) => s.stage === "spec-to-plan")!.prs, [78]);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// Finding 2 (spec artifact): the write-spec opener is bound EXACTLY to the run
// slug — a foreign `write-spec/<other-slug>` with a correct base is refused.
test("seed verification binds the write-spec opener to the run slug (Finding 2)", () => {
  const stateRoot = tmpStateRoot();
  const slug = "alpha";
  const rid = "20260720-121500-al2";
  const state = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "review-spec"],
    stages: [
      stageRec("write-spec", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
      stageRec("review-spec"),
    ],
  });
  persistFixture(stateRoot, state);
  const base = ["--slug", slug, "--run-id", rid];

  const foreign = JSON.stringify({
    "80": { state: "open", baseRefName: "main", headRefName: "write-spec/beta" },
  });
  const bad = runCli(
    ["record-output", ...base, "--stage", "write-spec", "--prs", "80", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: foreign } },
  );
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("artifact_pr_unverified"), bad.stderr);

  const own = JSON.stringify({
    "81": { state: "open", baseRefName: "main", headRefName: "write-spec/alpha" },
  });
  const ok = runCli(
    ["record-output", ...base, "--stage", "write-spec", "--prs", "81", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: own } },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).artifact_prs.spec, [81]);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// Finding 3: `init` resolves the CURRENT checkout identity first and refuses a
// global-history run that belongs to a DIFFERENT repository — never returns a
// foreign run as an "identical retry", never overwrites it.
test("init refuses a foreign-repository run with the same (slug, run_id) — repo_mismatch, no write (Finding 3)", () => {
  const stateRoot = tmpStateRoot();
  const slug = "frepo";
  const rid = "20260720-130000-fr1";
  // A pre-existing run recorded for a DIFFERENT repo, but otherwise an identical
  // descriptor to the init below (same slug/run-id/chain/input).
  const foreignRun = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec"],
    input: { kind: "intent", value: "x" },
    repo: { host: "github.com", owner: "other-org", name: "other-repo" },
    default_branch: "main",
    mode: "driver",
  });
  persistFixture(stateRoot, foreignRun);
  const stateFile = path.join(stateRoot, "history", "forge", slug, rid, "state.json");
  const before = fs.readFileSync(stateFile, "utf8");

  // init runs in the real stark-skills checkout (21StarkCom/stark-skills).
  const r = runCli(
    [
      "init", "--slug", slug, "--run-id", rid, "--chain", "write-spec",
      "--created-at", "2026-07-20T00:00:00Z", "--input-kind", "intent",
      "--input-value", "x", "--mode", "driver",
    ],
    { stateRoot },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes("repo_mismatch"), r.stderr);
  // The foreign run's state.json is untouched.
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "foreign run not overwritten");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// A path-based start where review-plan is the PR OPENER: its real branch shape
// is `review-plan/<doc-basename>`, which the authoritative matcher accepts for
// the plan artifact (a `<stage>/<slug>` matcher would have rejected it).
test("seed verification accepts the review stage's real opener branch on a path-based start", () => {
  const stateRoot = tmpStateRoot();
  const slug = "pathrp";
  const rid = "20260720-101500-rpp";
  const state = makeState({
    slug,
    run_id: rid,
    chain: ["review-plan", "plan-to-tasks", "copilot"],
    initial_artifacts: { plan_path: "docs/plans/2026-07-19-thing-plan.md", plan_slug: "thing" },
    stages: [
      stageRec("review-plan", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
      stageRec("plan-to-tasks"),
      stageRec("copilot"),
    ],
  });
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(state);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }
  const okFake = JSON.stringify({
    "70": { state: "open", baseRefName: "main", headRefName: "review-plan/2026-07-19-thing-plan" },
  });
  const ok = runCli(
    ["record-output", "--slug", slug, "--run-id", rid, "--stage", "review-plan", "--prs", "70", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot, env: { STARK_FORGE_FAKE_PR: okFake } },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).artifact_prs.plan, [70]);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// --- Finding 7: strict --merges boolean + registry-membership -----------------

test("--merges rejects a malformed boolean suffix and an unrelated merge PR", () => {
  const stateRoot = tmpStateRoot();
  const slug = "mrg";
  const rid = "20260720-110000-nnn";
  const state = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "review-spec"],
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [10] }),
      stageRec("review-spec", { status: "running", prs: [10], started_at: "2026-07-20T00:00:00Z" }),
    ],
  });
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(state);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }
  const base = ["--slug", slug, "--run-id", rid];

  // Malformed boolean suffix (`10:yes`) must not silently be false.
  const bad = runCli(
    ["record-output", ...base, "--stage", "review-spec", "--merges", "10:yes", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes("bad_args"), bad.stderr);

  // An unrelated merge PR (#77 not in the spec registry) is refused.
  const unrelated = runCli(
    ["record-output", ...base, "--stage", "review-spec", "--merges", "77:true", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(unrelated.status, 1);
  assert.ok(unrelated.stderr.includes("merge_pr_unverified"), unrelated.stderr);

  // A registered merge PR (#10) is accepted.
  const ok = runCli(
    ["record-output", ...base, "--stage", "review-spec", "--merges", "10:true", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(ok.status, 0, ok.stderr);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// --- Finding 6: strict flag allowlist + closed-enum validation ----------------

test("unknown/forbidden flags and invalid enum casts are rejected before any write", () => {
  const stateRoot = tmpStateRoot();
  const okInit = [
    "init", "--slug", "strict", "--run-id", "20260720-120000-ppp",
    "--chain", "write-spec,review-spec", "--created-at", "2026-07-20T00:00:00Z",
    "--input-kind", "intent", "--input-value", "x", "--mode", "driver",
  ];

  // The explicitly-forbidden flag on record-output.
  runCli(okInit, { stateRoot });
  const forbidden = runCli(
    ["record-output", "--slug", "strict", "--run-id", "20260720-120000-ppp", "--stage", "write-spec", "--issue-creation-complete", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(forbidden.status, 1);
  assert.ok(forbidden.stderr.includes("issue-creation-complete"), forbidden.stderr);

  // Invalid input-kind enum → bad_args, no write.
  const stateRoot2 = tmpStateRoot();
  const badKind = runCli(
    okInit.map((a) => (a === "intent" ? "spec-pathh" : a)),
    { stateRoot: stateRoot2 },
  );
  assert.equal(badKind.status, 1);
  assert.ok(badKind.stderr.includes("bad_args"), badKind.stderr);
  assert.ok(noRunDirs(stateRoot2), "invalid enum wrote no state");

  // Non-canonical chain (reversed order) → bad_args.
  const stateRoot3 = tmpStateRoot();
  const badChain = runCli(
    okInit.map((a) => (a === "write-spec,review-spec" ? "review-spec,write-spec" : a)),
    { stateRoot: stateRoot3 },
  );
  assert.equal(badChain.status, 1);
  assert.ok(badChain.stderr.includes("bad_args"), badChain.stderr);

  for (const s of [stateRoot, stateRoot2, stateRoot3]) fs.rmSync(s, { recursive: true, force: true });
});

// --- Wing round 3: --chain must be a CONTIGUOUS canonical slice ---------------

test("init rejects non-contiguous chains that resolveChain can never produce", () => {
  // Each is an in-order subsequence of the canonical order but NOT a contiguous
  // slice of either canonical pipeline — it skips required stages / is
  // unthreadable, and must be refused bad_args before any write.
  const nonContiguous = [
    "write-spec,copilot",
    "review-spec,review-plan",
    "write-spec,spec-to-plan", // skips review-spec
    "write-spec,review-spec,red-team-spec,plan-to-tasks", // 8-stage but drops spec-to-plan/review-plan
  ];
  for (const chain of nonContiguous) {
    const stateRoot = tmpStateRoot();
    const r = runCli(
      [
        "init", "--slug", "cc", "--run-id", "20260720-140000-ccc",
        "--chain", chain, "--created-at", "2026-07-20T00:00:00Z",
        "--input-kind", "intent", "--input-value", "x", "--mode", "driver",
      ],
      { stateRoot },
    );
    assert.equal(r.status, 1, `chain '${chain}' should be rejected`);
    assert.ok(r.stderr.includes("bad_args"), r.stderr);
    assert.ok(noRunDirs(stateRoot), `chain '${chain}' wrote no state`);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("init accepts contiguous slices of both the six- and eight-stage pipelines", () => {
  const contiguous = [
    "write-spec,review-spec", // six-stage prefix
    "spec-to-plan,review-plan,plan-to-tasks,copilot", // six-stage suffix
    "review-spec,red-team-spec,spec-to-plan", // eight-stage interior slice
  ];
  const rid = "20260720-150000-ddd";
  for (const chain of contiguous) {
    const stateRoot = tmpStateRoot();
    // init does NOT validate the intent/first-stage relationship, so a contiguous
    // slice succeeds outright — exit 0, initialized state on stdout, and the EXACT
    // chain persisted. Asserting the success (not merely the absence of a chain
    // rejection) closes the hole where an unrelated failure would slip through.
    const r = runCli(
      [
        "init", "--slug", "cok", "--run-id", rid,
        "--chain", chain, "--created-at", "2026-07-20T00:00:00Z",
        "--input-kind", "intent", "--input-value", "x", "--mode", "driver",
      ],
      { stateRoot },
    );
    const expectedChain = chain.split(",");
    assert.equal(r.status, 0, `chain '${chain}' should be accepted: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout).chain, expectedChain, `chain '${chain}' on stdout`);
    // The exact chain is persisted on disk, in order.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(stateRoot, "history", "forge", "cok", rid, "state.json"), "utf8"),
    ) as RunState;
    assert.deepEqual(onDisk.chain, expectedChain, `chain '${chain}' persisted`);
    assert.deepEqual(onDisk.stages.map((s) => s.stage), expectedChain, `stages track chain '${chain}'`);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// --- Wing round 3: strict parseOpts (positionals / missing values / dups) -----

test("mutating subcommands reject bare positionals, missing values, and duplicate flags", () => {
  const stateRoot = tmpStateRoot();
  // Seed a valid run so the subcommands reach parseOpts.
  runCli(
    [
      "init", "--slug", "strictp", "--run-id", "20260720-160000-eee",
      "--chain", "write-spec,review-spec", "--created-at", "2026-07-20T00:00:00Z",
      "--input-kind", "intent", "--input-value", "x", "--mode", "driver",
    ],
    { stateRoot },
  );
  const base = ["--slug", "strictp", "--run-id", "20260720-160000-eee"];

  // (a) a stray bare positional before the flags.
  const stray = runCli(
    ["init", "stray", "--slug", "s", "--run-id", "r", "--chain", "write-spec",
     "--created-at", "2026-07-20T00:00:00Z", "--input-kind", "intent", "--input-value", "x", "--mode", "driver"],
    { stateRoot },
  );
  assert.equal(stray.status, 1);
  assert.ok(stray.stderr.includes("bad_args"), stray.stderr);

  // (b) an allowed option lacking its value (another --flag follows).
  const missingVal = runCli(
    ["record-output", ...base, "--stage", "write-spec", "--prs", "--at", "2026-07-20T01:00:00Z"],
    { stateRoot },
  );
  assert.equal(missingVal.status, 1);
  assert.ok(missingVal.stderr.includes("bad_args"), missingVal.stderr);
  assert.ok(missingVal.stderr.includes("requires a value"), missingVal.stderr);

  // (c) a trailing option with no value at all.
  const trailing = runCli(
    ["get", ...base, "--run-id"],
    { stateRoot },
  );
  assert.equal(trailing.status, 1);
  assert.ok(trailing.stderr.includes("bad_args"), trailing.stderr);

  // (d) a duplicate flag.
  const dup = runCli(
    ["get", "--slug", "strictp", "--slug", "strictp"],
    { stateRoot },
  );
  assert.equal(dup.status, 1);
  assert.ok(dup.stderr.includes("bad_args"), dup.stderr);
  assert.ok(dup.stderr.includes("duplicate"), dup.stderr);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// --- Finding 4: init never overwrites a corrupt existing state ----------------

test("init refuses to overwrite a corrupt existing state (propagates, no write)", () => {
  const stateRoot = tmpStateRoot();
  const runId = "20260720-130000-qqq";
  const dir = path.join(stateRoot, "history", "forge", "corrupt", runId);
  fs.mkdirSync(dir, { recursive: true });
  // A parseable-but-corrupt state.json (empty object fails structural validation).
  fs.writeFileSync(path.join(dir, "state.json"), "{}");

  const r = runCli(
    [
      "init", "--slug", "corrupt", "--run-id", runId,
      "--chain", "write-spec", "--created-at", "2026-07-20T00:00:00Z",
      "--input-kind", "intent", "--input-value", "x", "--mode", "driver",
    ],
    { stateRoot },
  );
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("corrupt_state"), r.stderr);
  // The corrupt evidence is preserved, not overwritten.
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), "{}");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// --- Finding 5: control-character intent is refused with intent_unencodable ---

test("a control-character intent is refused intent_unencodable via the error envelope", () => {
  const stateRoot = tmpStateRoot();
  const r = runCli(["resolve", "line one\nline two", "--json"], { stateRoot });
  assert.equal(r.status, 1);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.status, "error");
  assert.equal(obj.error.code, "intent_unencodable");
  assert.ok(noRunDirs(stateRoot), "no run dir written");
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// ===========================================================================
// #19 — --json summary shape matches §9 for completed/halted/failed runs
// ===========================================================================

test("#19 --json summary shape matches §9 for completed, halted, and failed runs", () => {
  const readAllMerged: PrReader = () => "merged";

  // Completed run: write-spec → review-spec, spec PR 10 forge-merged.
  const completed = makeState({
    slug: "done-run",
    chain: ["write-spec", "review-spec"],
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", {
        status: "done",
        prs: [10],
        artifacts: { spec_path: "docs/specs/2026-07-20-done-run-spec.md" },
      }),
      stageRec("review-spec", {
        status: "done",
        prs: [10],
        merges: [{ pr: 10, merged_by_forge: true }],
      }),
    ],
  });
  const cs = buildSummary(completed, readAllMerged);
  assert.equal(cs.status, "completed");
  assert.equal(cs.resume_target, null);
  assert.equal(cs.red_team, false); // derived from chain (no red-team stage)
  assert.deepEqual(cs.merged_prs, [{ artifact: "spec", pr: 10 }]);
  assert.equal(cs.stages.length, 2);
  assert.deepEqual(Object.keys(cs.stages[0]).sort(), ["artifacts", "fold_prs", "gate", "prs", "status", "stage"].sort());
  assert.equal(cs.error, null);

  // red_team derived TRUE from a chain carrying a red-team stage.
  const rtChain: Stage[] = ["write-spec", "review-spec", "red-team-spec"];
  const rt = makeState({
    slug: "rt",
    chain: rtChain,
    artifact_prs: { spec: [11] },
    stages: rtChain.map((s) => stageRec(s, { status: "done" })),
  });
  assert.equal(buildSummary(rt, readAllMerged).red_team, true);

  // Halted merge-point run with a still-open fold PR.
  const halted = makeState({
    slug: "halt-run",
    chain: ["write-spec", "review-spec", "red-team-spec"],
    artifact_prs: { spec: [20] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [20] }),
      stageRec("review-spec", { status: "done", prs: [20] }),
      stageRec("red-team-spec", {
        status: "halted",
        prs: [20],
        fold_prs: [77],
        gate: { reason: "fold_pr_open", detail: "fold PR #77 open" },
      }),
    ],
  });
  const openFold: PrReader = (pr) => (pr === 77 ? "open" : "merged");
  const hs = buildSummary(halted, openFold);
  assert.equal(hs.status, "halted");
  assert.equal(hs.resume_target, "red-team-spec");
  assert.deepEqual(hs.open_fold_prs, [{ stage: "red-team-spec", pr: 77 }]);

  // A fold PR the operator resolved drops out of open_fold_prs.
  assert.deepEqual(buildSummary(halted, () => "merged").open_fold_prs, []);

  // Failed run: error carries the failed stage's gate.
  const failed = makeState({
    slug: "fail-run",
    chain: ["write-spec", "review-spec"],
    stages: [
      stageRec("write-spec", { status: "done" }),
      stageRec("review-spec", {
        status: "failed",
        gate: { reason: "coverage_gap", detail: "security domain never ran" },
      }),
    ],
  });
  const fs2 = buildSummary(failed, readAllMerged);
  assert.equal(fs2.status, "failed");
  assert.equal(fs2.resume_target, "review-spec");
  assert.deepEqual(fs2.error, { code: "coverage_gap", message: "security domain never ran" });
});

test("#19 summary CLI subprocess: persisted completed/halted/failed runs load, inject the PR reader, and print the §9 object; abandon has its own subprocess coverage", () => {
  const stateRoot = tmpStateRoot();

  // --- completed: write-spec → review-spec, spec PR 10 forge-merged ---
  const completed = makeState({
    slug: "cli-done",
    run_id: "20260720-190000-c01",
    chain: ["write-spec", "review-spec"],
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", {
        status: "done",
        prs: [10],
        artifacts: { spec_path: "docs/specs/2026-07-20-cli-done-spec.md" },
      }),
      stageRec("review-spec", {
        status: "done",
        prs: [10],
        merges: [{ pr: 10, merged_by_forge: true }],
      }),
    ],
  });
  persistFixture(stateRoot, completed);
  const dr = runCli(["summary", "--slug", "cli-done", "--run-id", completed.run_id], { stateRoot });
  assert.equal(dr.status, 0, dr.stderr);
  const dobj = JSON.parse(dr.stdout);
  assert.equal(dobj.status, "completed");
  assert.equal(dobj.red_team, false);
  assert.equal(dobj.resume_target, null);
  assert.equal(dobj.error, null);
  assert.deepEqual(dobj.merged_prs, [{ artifact: "spec", pr: 10 }]);
  assert.equal(dobj.stages.length, 2);
  assert.deepEqual(
    Object.keys(dobj.stages[0]).sort(),
    ["artifacts", "fold_prs", "gate", "prs", "status", "stage"].sort(),
  );

  // --- halted merge-point run with a still-open fold PR (reader injected) ---
  const halted = makeState({
    slug: "cli-halt",
    run_id: "20260720-190000-h01",
    chain: ["write-spec", "review-spec", "red-team-spec"],
    artifact_prs: { spec: [20] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [20] }),
      stageRec("review-spec", { status: "done", prs: [20] }),
      stageRec("red-team-spec", {
        status: "halted",
        prs: [20],
        fold_prs: [77],
        gate: { reason: "fold_pr_open", detail: "fold PR #77 open" },
      }),
    ],
  });
  persistFixture(stateRoot, halted);
  // PR-reader injection: fold PR #77 read as OPEN via STARK_FORGE_FAKE_PR.
  const openFold = JSON.stringify({
    "77": { state: "open", baseRefName: "main", headRefName: "red-team-fold/x" },
  });
  const hr = runCli(["summary", "--slug", "cli-halt", "--run-id", halted.run_id], {
    stateRoot,
    env: { STARK_FORGE_FAKE_PR: openFold },
  });
  assert.equal(hr.status, 0, hr.stderr);
  const hobj = JSON.parse(hr.stdout);
  assert.equal(hobj.status, "halted");
  assert.equal(hobj.red_team, true); // derived from the red-team stage in the chain
  assert.equal(hobj.resume_target, "red-team-spec");
  assert.deepEqual(hobj.open_fold_prs, [{ stage: "red-team-spec", pr: 77 }]);

  // The reader drops a resolved fold PR: #77 read as merged → empty open list.
  const mergedFold = JSON.stringify({
    "77": { state: "merged", baseRefName: "main", headRefName: "red-team-fold/x" },
  });
  const hr2 = runCli(["summary", "--slug", "cli-halt", "--run-id", halted.run_id], {
    stateRoot,
    env: { STARK_FORGE_FAKE_PR: mergedFold },
  });
  assert.deepEqual(JSON.parse(hr2.stdout).open_fold_prs, []);

  // --- failed run: error envelope carries the failed stage's gate ---
  const failed = makeState({
    slug: "cli-fail",
    run_id: "20260720-190000-f01",
    chain: ["write-spec", "review-spec"],
    stages: [
      stageRec("write-spec", { status: "done" }),
      stageRec("review-spec", {
        status: "failed",
        gate: { reason: "coverage_gap", detail: "security domain never ran" },
      }),
    ],
  });
  persistFixture(stateRoot, failed);
  const frr = runCli(["summary", "--slug", "cli-fail", "--run-id", failed.run_id], { stateRoot });
  assert.equal(frr.status, 0, frr.stderr);
  const fobj = JSON.parse(frr.stdout);
  assert.equal(fobj.status, "failed");
  assert.equal(fobj.resume_target, "review-spec");
  assert.deepEqual(fobj.error, { code: "coverage_gap", message: "security domain never ran" });

  // --- abandon: subprocess marks the run terminally abandoned, persists it, and
  // a subsequent summary reports `abandoned` with a null resume target ---
  const active = makeState({
    slug: "cli-aband",
    run_id: "20260720-190000-a01",
    chain: ["write-spec", "review-spec"],
    stages: [
      stageRec("write-spec", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
      stageRec("review-spec"),
    ],
  });
  persistFixture(stateRoot, active);
  const ab = runCli(
    ["abandon", "--slug", "cli-aband", "--run-id", active.run_id, "--at", "2026-07-20T20:00:00Z"],
    { stateRoot },
  );
  assert.equal(ab.status, 0, ab.stderr);
  assert.equal(JSON.parse(ab.stdout).abandoned_at, "2026-07-20T20:00:00Z");
  // Persisted on disk.
  const abFile = path.join(stateRoot, "history", "forge", "cli-aband", active.run_id, "state.json");
  assert.equal((JSON.parse(fs.readFileSync(abFile, "utf8")) as RunState).abandoned_at, "2026-07-20T20:00:00Z");
  // Summary reflects the abandoned terminal status.
  const as = runCli(["summary", "--slug", "cli-aband", "--run-id", active.run_id], { stateRoot });
  const asobj = JSON.parse(as.stdout);
  assert.equal(asobj.status, "abandoned");
  assert.equal(asobj.resume_target, null);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// ===========================================================================
// resume-target persists reconciliation before printing (+ repo-mismatch)
// ===========================================================================

test("resume-target persists reconciliation before printing (one crashed attempt, second call is a no-op reprint)", () => {
  const stateRoot = tmpStateRoot();
  // Crashed merge-point stage: review-spec running with a checkpoint (prs:[123]),
  // registry seeded, PR still open at resume → merge_pending / merge_only.
  const crashed = makeState({
    slug: "crash",
    run_id: "20260720-020000-ccc",
    chain: ["write-spec", "review-spec"],
    artifact_prs: { spec: [123] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [123] }),
      stageRec("review-spec", {
        status: "running",
        prs: [123],
        started_at: "2026-07-20T00:00:00Z",
      }),
    ],
  });
  // Persist ONLY inside the controlled STARK_STATE_ROOT block below — persisting
  // before the env is redirected would write fixture data into the operator's
  // real forge history (`stateRoot()` reads the ambient env at call time).
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(crashed);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }

  const fake = JSON.stringify({ "123": { state: "open", baseRefName: "main", headRefName: "write-spec/crash" } });

  const first = runCli(["resume-target", "--slug", "crash"], {
    stateRoot,
    env: { STARK_FORGE_FAKE_PR: fake },
  });
  assert.equal(first.status, 0, first.stderr);
  const t1 = JSON.parse(first.stdout);
  assert.equal(t1.reconciled, true);
  assert.equal(t1.action, "merge_only");
  assert.equal(t1.target_stage, "review-spec");

  // On disk, the crashed stage is resolved to halted with exactly ONE crashed attempt.
  const stateFile = path.join(stateRoot, "history", "forge", "crash", "20260720-020000-ccc", "state.json");
  const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  const rev = onDisk.stages[1];
  assert.equal(rev.status, "halted");
  assert.equal(rev.attempts.filter((a) => a.outcome === "crashed").length, 1);

  // Second call: no running stage → no re-reconciliation, still ONE crashed attempt.
  const second = runCli(["resume-target", "--slug", "crash"], {
    stateRoot,
    env: { STARK_FORGE_FAKE_PR: fake },
  });
  assert.equal(second.status, 0, second.stderr);
  const t2 = JSON.parse(second.stdout);
  assert.equal(t2.reconciled, false);
  assert.equal(t2.action, "merge_only");
  const onDisk2 = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  assert.equal(onDisk2.stages[1].attempts.filter((a) => a.outcome === "crashed").length, 1);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("resume-target refuses a run whose repo differs from the current checkout (fail-closed, no write)", () => {
  const stateRoot = tmpStateRoot();
  const foreign = makeState({
    slug: "foreign",
    chain: ["write-spec", "review-spec"],
    repo: { host: "github.com", owner: "someone-else", name: "other-repo" },
    stages: [stageRec("write-spec", { status: "running", started_at: "2026-07-20T00:00:00Z" }), stageRec("review-spec")],
  });
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(foreign);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }

  const before = fs.readFileSync(
    path.join(stateRoot, "history", "forge", "foreign", foreign.run_id, "state.json"),
    "utf8",
  );
  const r = runCli(["resume-target", "--slug", "foreign"], { stateRoot });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("repo_mismatch"), r.stderr);
  const after = fs.readFileSync(
    path.join(stateRoot, "history", "forge", "foreign", foreign.run_id, "state.json"),
    "utf8",
  );
  assert.equal(before, after, "no write on repo-mismatch refusal");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

// ===========================================================================
// #21 — driver mode: exact command blocks, advance only on reported transitions
// ===========================================================================

test("#21 driver-block base-sync only on new-artifact stages, non-`main` default, no shell timeout wrapper; full walkthrough advances every stage", () => {
  const stateRoot = tmpStateRoot();
  const slug = "walk";
  const rid = "20260720-030000-ddd";
  const chain: Stage[] = [
    "write-spec",
    "review-spec",
    "spec-to-plan",
    "review-plan",
    "plan-to-tasks",
    "copilot",
  ];
  const initial = makeState({
    slug,
    run_id: rid,
    chain,
    mode: "driver",
    default_branch: "trunk", // NON-`main`, asserted below
  });
  const prev = process.env.STARK_STATE_ROOT;
  process.env.STARK_STATE_ROOT = stateRoot;
  try {
    persistState(initial);
  } finally {
    if (prev === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prev;
  }

  // Fake PRs: spec #10, plan #20, impl #30 — all merged, correct base/head shape.
  // The spec-to-plan head is bound to the SPEC doc stem (Finding 2): the skill
  // opens `spec-to-plan/<spec-basename>-<timestamp>`, and the spec is recorded as
  // docs/specs/2026-07-20-walk-spec.md below → stem `2026-07-20-walk-spec`.
  const fake = JSON.stringify({
    "10": { state: "merged", baseRefName: "trunk", headRefName: "write-spec/walk" },
    "20": { state: "merged", baseRefName: "trunk", headRefName: "spec-to-plan/2026-07-20-walk-spec-20260720-031500" },
    "30": { state: "merged", baseRefName: "trunk", headRefName: "copilot/walk" },
  });
  const env = { STARK_FORGE_FAKE_PR: fake };
  const base = ["--slug", slug, "--run-id", rid];
  const noTimeoutWrapper = (block: string) =>
    assert.ok(!/timeout\s+\d/.test(block), "no shell `timeout <N>` wrapper");

  // Helper: fetch the driver-block for the current resume target.
  const block = (): string => {
    const r = runCli(["driver-block", "--slug", slug], { stateRoot, env });
    assert.equal(r.status, 0, r.stderr);
    noTimeoutWrapper(r.stdout);
    return r.stdout;
  };
  const tr = (...extra: string[]) => {
    const r = runCli(["transition", ...base, ...extra], { stateRoot, env });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const rec = (...extra: string[]) => {
    const r = runCli(["record-output", ...base, ...extra], { stateRoot, env });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  // --- write-spec: advance, NO base-sync (same-session author), stage command ---
  let b = block();
  assert.ok(b.includes("(action: advance)"));
  assert.ok(!b.includes("git switch"), "write-spec carries no base-sync");
  assert.ok(b.includes("/stark-write-spec"));
  tr("--stage", "write-spec", "--from", "pending", "--to", "running", "--at", "2026-07-20T01:00:00Z");
  rec("--stage", "write-spec", "--artifact-spec-path", "docs/specs/2026-07-20-walk-spec.md", "--prs", "10", "--at", "2026-07-20T01:01:00Z");
  tr("--stage", "write-spec", "--from", "running", "--to", "done", "--at", "2026-07-20T01:02:00Z");

  // --- review-spec: merge point (spec), NO base-sync, fold-check + pr-merge lines ---
  b = block();
  assert.ok(!b.includes("git switch"), "review-spec (same-artifact) carries no base-sync");
  assert.ok(b.includes("/stark-gh:pr-merge"), "merge point emits pr-merge");
  assert.ok(b.includes("fold PR"));
  assert.ok(b.includes("--merges"));
  tr("--stage", "review-spec", "--from", "pending", "--to", "running", "--at", "2026-07-20T02:00:00Z");
  rec("--stage", "review-spec", "--prs", "10", "--merges", "10:true", "--at", "2026-07-20T02:01:00Z");
  tr("--stage", "review-spec", "--from", "running", "--to", "done", "--at", "2026-07-20T02:02:00Z");

  // --- spec-to-plan: advance, base-sync REQUIRED, reads recorded `trunk` ---
  b = block();
  assert.ok(b.includes("git switch trunk"), "spec-to-plan base-sync uses recorded default branch");
  assert.ok(b.includes("git pull --ff-only"));
  assert.ok(b.includes("base_sync_failed"));
  tr("--stage", "spec-to-plan", "--from", "pending", "--to", "running", "--at", "2026-07-20T03:00:00Z");
  rec("--stage", "spec-to-plan", "--artifact-plan-path", "docs/plans/2026-07-20-walk-plan.md", "--artifact-plan-slug", "walk", "--prs", "20", "--at", "2026-07-20T03:01:00Z");
  tr("--stage", "spec-to-plan", "--from", "running", "--to", "done", "--at", "2026-07-20T03:02:00Z");

  // --- review-plan: merge point (plan), NO base-sync ---
  b = block();
  assert.ok(!b.includes("git switch"), "review-plan (same-artifact) carries no base-sync");
  assert.ok(b.includes("/stark-gh:pr-merge"));
  tr("--stage", "review-plan", "--from", "pending", "--to", "running", "--at", "2026-07-20T04:00:00Z");
  rec("--stage", "review-plan", "--prs", "20", "--merges", "20:true", "--at", "2026-07-20T04:01:00Z");
  tr("--stage", "review-plan", "--from", "running", "--to", "done", "--at", "2026-07-20T04:02:00Z");

  // --- plan-to-tasks: advance, base-sync REQUIRED, issue_numbers marker, no merge ---
  b = block();
  assert.ok(b.includes("git switch trunk"), "plan-to-tasks base-sync");
  assert.ok(b.includes("issue_numbers"));
  assert.ok(!b.includes("/stark-gh:pr-merge"), "plan-to-tasks has no PR merge");
  tr("--stage", "plan-to-tasks", "--from", "pending", "--to", "running", "--at", "2026-07-20T05:00:00Z");
  rec("--stage", "plan-to-tasks", "--artifact-issue-numbers", "101,102", "--at", "2026-07-20T05:01:00Z");
  tr("--stage", "plan-to-tasks", "--from", "running", "--to", "done", "--at", "2026-07-20T05:02:00Z");

  // --- copilot: merge point (impl) AND base-sync REQUIRED ---
  b = block();
  assert.ok(b.includes("git switch trunk"), "copilot base-sync");
  assert.ok(b.includes("/stark-gh:pr-merge"));
  tr("--stage", "copilot", "--from", "pending", "--to", "running", "--at", "2026-07-20T06:00:00Z");
  rec("--stage", "copilot", "--prs", "30", "--merges", "30:true", "--at", "2026-07-20T06:01:00Z");
  tr("--stage", "copilot", "--from", "running", "--to", "done", "--at", "2026-07-20T06:02:00Z");

  // --- run complete: driver-block reports completion, summary agrees ---
  const doneBlock = runCli(["driver-block", "--slug", slug], { stateRoot, env });
  assert.equal(doneBlock.status, 0, doneBlock.stderr);
  assert.ok(doneBlock.stdout.includes("complete"), doneBlock.stdout);

  const summ = runCli(["summary", ...base], { stateRoot, env });
  const so = JSON.parse(summ.stdout);
  assert.equal(so.status, "completed");
  assert.deepEqual(
    so.merged_prs,
    [
      { artifact: "spec", pr: 10 },
      { artifact: "plan", pr: 20 },
      { artifact: "impl", pr: 30 },
    ],
    "merged_prs in merge order, only forge-merged",
  );

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("#21 driver-block reconciles a checkpoint-PRESENT merge-point crash to merge_only: persists reconciliation, opens with the halted→running CAS re-entry, keeps the pr-merge lines, and OMITS the stage command", () => {
  const stateRoot = tmpStateRoot();
  const slug = "dmerge";
  const rid = "20260720-070000-mo1";
  // review-spec is a merge point (spec). It crashed WITH its PR checkpoint
  // recorded (prs:[123]); the PR is still open at resume → execution completed,
  // only the merge remains → halted(merge_pending) / merge_only.
  const crashed = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "review-spec"],
    artifact_prs: { spec: [123] },
    stages: [
      stageRec("write-spec", { status: "done", prs: [123] }),
      stageRec("review-spec", { status: "running", prs: [123], started_at: "2026-07-20T00:00:00Z" }),
    ],
  });
  persistFixture(stateRoot, crashed);
  const fake = JSON.stringify({
    "123": { state: "open", baseRefName: "main", headRefName: "write-spec/dmerge" },
  });
  const env = { STARK_FORGE_FAKE_PR: fake };

  const r = runCli(["driver-block", "--slug", slug], { stateRoot, env });
  assert.equal(r.status, 0, r.stderr);
  const block = r.stdout;
  assert.ok(/action: merge_only/.test(block), block);
  // CAS re-entry opens the block from the reconciled `halted` status.
  assert.ok(
    block.includes(`transition --slug ${slug} --run-id ${rid} --stage review-spec --from halted --to running`),
    block,
  );
  // merge_only OMITS the stage command entirely.
  assert.ok(!block.includes("Run the stage command"), "merge_only omits the stage-command section");
  assert.ok(!block.includes("/stark-review-spec"), "merge_only prints no stage command");
  // The merge lines remain — and are CONCRETE (Finding 1): the recorded PR #123,
  // never a `<REPORTED: …>` placeholder (nothing is re-reported on a merge_only
  // retry — the PR is already in state).
  assert.ok(block.includes("/stark-gh:pr-merge --pr 123"), "merge_only renders the concrete pr-merge line");
  assert.ok(
    block.includes(`record-output --slug ${slug} --run-id ${rid} --stage review-spec --merges 123:true`),
    "merge_only renders the concrete --merges recording",
  );
  assert.ok(!block.includes("<REPORTED:"), "merge_only never emits a <REPORTED: …> placeholder");
  assert.ok(!/timeout\s+\d/.test(block), "no shell `timeout <N>` wrapper");

  // Reconciliation persisted BEFORE printing: review-spec is halted with exactly
  // ONE crashed attempt.
  const stateFile = path.join(stateRoot, "history", "forge", slug, rid, "state.json");
  const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  assert.equal(onDisk.stages[1].status, "halted");
  assert.equal(onDisk.stages[1].attempts.filter((a) => a.outcome === "crashed").length, 1);

  // Second call: no running stage → no re-reconciliation, still ONE crashed attempt.
  const r2 = runCli(["driver-block", "--slug", slug], { stateRoot, env });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(/action: merge_only/.test(r2.stdout), r2.stdout);
  const onDisk2 = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  assert.equal(onDisk2.stages[1].attempts.filter((a) => a.outcome === "crashed").length, 1);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("#21 driver-block reconciles a checkpoint-ABSENT crash to reinvoke: persists reconciliation, opens with the failed→running CAS re-entry, and carries the base-sync prelude (recorded non-`main` default) with the stage command", () => {
  const stateRoot = tmpStateRoot();
  const slug = "dreinv";
  const rid = "20260720-080000-re1";
  // spec-to-plan is a new-artifact, non-merge stage. It crashed BEFORE recording
  // any output (no artifacts, no PR) → checkpoint absent → failed(reconciled_
  // after_crash) / reinvoke.
  const crashed = makeState({
    slug,
    run_id: rid,
    chain: ["write-spec", "review-spec", "spec-to-plan"],
    default_branch: "trunk", // NON-`main`, asserted in the base-sync line below
    artifact_prs: { spec: [10] },
    stages: [
      stageRec("write-spec", {
        status: "done",
        prs: [10],
        artifacts: { spec_path: "docs/specs/2026-07-20-dreinv-spec.md" },
      }),
      stageRec("review-spec", { status: "done", prs: [10] }),
      stageRec("spec-to-plan", { status: "running", started_at: "2026-07-20T00:00:00Z" }),
    ],
  });
  persistFixture(stateRoot, crashed);
  // Empty fake map → zero-network; the checkpoint-absent path reads no PR.
  const env = { STARK_FORGE_FAKE_PR: "{}" };

  const r = runCli(["driver-block", "--slug", slug], { stateRoot, env });
  assert.equal(r.status, 0, r.stderr);
  const block = r.stdout;
  assert.ok(/action: reinvoke/.test(block), block);
  // CAS re-entry opens the block from the reconciled `failed` status.
  assert.ok(
    block.includes(`transition --slug ${slug} --run-id ${rid} --stage spec-to-plan --from failed --to running`),
    block,
  );
  // Base-sync prelude for a new-artifact stage, reading the recorded default branch.
  assert.ok(block.includes("git switch trunk"), "reinvoke base-sync uses recorded default branch");
  assert.ok(block.includes("git pull --ff-only"), block);
  assert.ok(block.includes("base_sync_failed"), block);
  // reinvoke KEEPS the stage command.
  assert.ok(block.includes("Run the stage command"), "reinvoke prints the stage-command section");
  assert.ok(block.includes("/stark-spec-to-plan"), "reinvoke prints the stage command");
  assert.ok(!block.includes("/stark-gh:pr-merge"), "spec-to-plan is no merge point");
  assert.ok(!/timeout\s+\d/.test(block), "no shell `timeout <N>` wrapper");

  // Reconciliation persisted: spec-to-plan is failed with exactly ONE crashed attempt.
  const stateFile = path.join(stateRoot, "history", "forge", slug, rid, "state.json");
  const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  assert.equal(onDisk.stages[2].status, "failed");
  assert.equal(onDisk.stages[2].attempts.filter((a) => a.outcome === "crashed").length, 1);

  // Second call is a no-op reprint: still ONE crashed attempt.
  const r2 = runCli(["driver-block", "--slug", slug], { stateRoot, env });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(/action: reinvoke/.test(r2.stdout), r2.stdout);
  const onDisk2 = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RunState;
  assert.equal(onDisk2.stages[2].attempts.filter((a) => a.outcome === "crashed").length, 1);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});
