// Tests for `tools/jury_dispatch.ts`.
//
// Command shape is ASSERTED against the REAL builders and never executed — no
// vendor CLI runs, nothing bills. Execution paths run through injected fake
// runners, except the two that only a real process can prove: write-then-close
// stdin, and a timeout that kills a whole process GROUP (both use `node -e`
// scripts, not a vendor CLI).

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TIMEOUT_SEC,
  DispatchError,
  LENGTH_FLOOR_FAIL,
  LENGTH_FLOOR_WARN,
  REAL_BUILDERS,
  assertPromptOnStdin,
  assertSurvivors,
  buildSeatCommand,
  checkLength,
  classifySeat,
  computeCost,
  detectTruncation,
  dispatchPanel,
  dispatchSeat,
  extractUsage,
  killProcessGroup,
  ladderFor,
  realRunner,
  resolveTimeoutMs,
  type DispatchDeps,
  type JuryMode,
  type RunOutcome,
  type RunRequest,
  type SeatBuilder,
  type SeatCommand,
  type SeatResult,
  type SeatRunner,
} from "./jury_dispatch.ts";
import type { Panel, PanelSeat, SeatId } from "./jury_panel.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROMPT = "SKILL BODY\n\n=== BEGIN DOCUMENT ===\nthe post\n=== END DOCUMENT ===\n";
const SOURCE = "x".repeat(1000);

function seat(id: SeatId, model: string, effort: string | null = null): PanelSeat {
  return { seat: id, model, effort };
}

const CLAUDE_SEAT = seat("claude", "claude-opus-5", "max");
const CODEX_SEAT = seat("codex", "gpt-5.5-pro", "xhigh");
const GEMINI_SEAT = seat("gemini", "gemini-3.1-pro-preview", null);

function panelOf(...seats: PanelSeat[]): Panel {
  return { seats };
}

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jury-dispatch-${tag}-`));
}

/** A runner that answers from a per-seat script. Records every request. */
function fakeRunner(
  replies: Partial<Record<SeatId, Partial<RunOutcome>>>,
  log?: RunRequest[],
): SeatRunner {
  return async (req) => {
    log?.push(req);
    const reply = replies[req.seat] ?? {};
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      notFound: false,
      stdinClosed: true,
      kill: null,
      ...reply,
    };
  };
}

/** Deps that keep every seat off the real filesystem and off the real builders
 *  where the test does not care about argv. */
function fakeDeps(runner: SeatRunner, extra: DispatchDeps = {}): DispatchDeps {
  const scratches: string[] = [];
  // Shaped enough to satisfy buildSeatCommand's codex guard — a fake that drops
  // `--skip-git-repo-check` fails that seat at BUILD time, which is a real
  // (and separately tested) refusal, not the execution path these deps exist for.
  const builder: SeatBuilder = (prompt, model, ctx) => ({
    cmd: "fake",
    args: [
      "exec",
      "--skip-git-repo-check",
      "--model",
      model ?? "?",
      ...(ctx?.effort ? ["--effort", ctx.effort] : []),
    ],
    stdin: prompt,
    env: {},
  });
  return {
    runner,
    builders: { claude: builder, codex: builder, gemini: builder },
    mkScratch: (s) => {
      const dir = `/tmp/fake-scratch-${s}-${scratches.length}`;
      scratches.push(dir);
      return dir;
    },
    cleanupScratch: () => {},
    config: {},
    rates: { "claude-opus-5": { input_per_1m_usd: 5, output_per_1m_usd: 25 } },
    ...extra,
  };
}

function dispatchOpts(runner: SeatRunner, mode: JuryMode = "rewrite", extra: DispatchDeps = {}) {
  return {
    prompt: PROMPT,
    source: SOURCE,
    mode,
    timeoutMs: 5_000,
    deps: fakeDeps(runner, extra),
  };
}

// ---------------------------------------------------------------------------
// Command construction — asserted against the REAL builders, never executed
// ---------------------------------------------------------------------------

test("claude seat: isolation flags + effort in the built command", () => {
  const scratch = "/tmp/scratch-claude";
  const cmd = buildSeatCommand(CLAUDE_SEAT, PROMPT, scratch);

  assert.equal(cmd.cmd, "claude");
  // Prompt on stdin, not argv.
  assert.deepEqual(cmd.args.slice(0, 2), ["-p", "-"]);
  assert.equal(cmd.stdin, PROMPT);
  assert.equal(cmd.args.includes(PROMPT), false);

  // Effort in the CLI's documented form.
  const effortAt = cmd.args.indexOf("--effort");
  assert.notEqual(effortAt, -1);
  assert.equal(cmd.args[effortAt + 1], "max");

  // Tool lockdown: `--tools ""` disables the whole built-in set.
  const toolsAt = cmd.args.indexOf("--tools");
  assert.notEqual(toolsAt, -1);
  assert.equal(cmd.args[toolsAt + 1], "");

  // Model pinned to the seat, and the empty scratch cwd is the workspace.
  const modelAt = cmd.args.indexOf("--model");
  assert.equal(cmd.args[modelAt + 1], "claude-opus-5");
  assert.equal(cmd.cwd, scratch);
});

test("codex seat: -s read-only, --skip-git-repo-check and the effort override", () => {
  const cmd = buildSeatCommand(CODEX_SEAT, PROMPT, "/tmp/scratch-codex");

  assert.equal(cmd.cmd, "codex");
  assert.equal(cmd.args[0], "exec");
  // The sandbox flag the jury adds (it is not part of the builder today).
  const sandboxAt = cmd.args.indexOf("-s");
  assert.notEqual(sandboxAt, -1);
  assert.equal(cmd.args[sandboxAt + 1], "read-only");
  assert.ok(sandboxAt > 0, "-s must come after the `exec` subcommand");
  // The builder's own flag — without it codex refuses to start in the scratch cwd.
  assert.ok(cmd.args.includes("--skip-git-repo-check"));
  // Effort is a -c override, not a flag (codex-cli 0.128.0+ removed the flag).
  assert.ok(cmd.args.includes(`model_reasoning_effort="xhigh"`));
  assert.equal(cmd.args.includes("--reasoning-effort"), false);
  // Model + stdin.
  const modelAt = cmd.args.indexOf("-m");
  assert.equal(cmd.args[modelAt + 1], "gpt-5.5-pro");
  assert.equal(cmd.stdin, PROMPT);
  assert.equal(cmd.cwd, "/tmp/scratch-codex");
});

test("codex seat: a builder that drops --skip-git-repo-check is a loud error", () => {
  const stripped: SeatBuilder = (prompt, model) => ({
    cmd: "codex",
    args: ["exec", "--json", "-m", model ?? ""],
    stdin: prompt,
    env: {},
  });
  assert.throws(
    () =>
      buildSeatCommand(CODEX_SEAT, PROMPT, "/tmp/s", {
        ...REAL_BUILDERS,
        codex: stripped,
      }),
    /--skip-git-repo-check/,
  );
});

test("codex seat: an existing sandbox flag is not duplicated", () => {
  const sandboxed: SeatBuilder = (prompt, model) => ({
    cmd: "codex",
    args: ["exec", "-s", "workspace-write", "--skip-git-repo-check", "-m", model ?? ""],
    stdin: prompt,
    env: {},
  });
  const cmd = buildSeatCommand(CODEX_SEAT, PROMPT, "/tmp/s", {
    ...REAL_BUILDERS,
    codex: sandboxed,
  });
  assert.equal(cmd.args.filter((a) => a === "-s").length, 1);
});

test("gemini seat: built through the real builder, no effort knob, isolated home", () => {
  const scratch = tmpDir("gemini");
  const prevProject = process.env.STARK_GEMINI_VERTEX_PROJECT;
  // Pin the project so the builder never shells out to `gcloud` in a test.
  process.env.STARK_GEMINI_VERTEX_PROJECT = "jury-test-project";
  try {
    const cmd = buildSeatCommand(GEMINI_SEAT, PROMPT, scratch);
    assert.equal(cmd.cmd, "gemini");
    assert.deepEqual(cmd.args, ["-o", "json", "-m", "gemini-3.1-pro-preview", "-p", "-"]);
    assert.equal(cmd.stdin, PROMPT);
    // No reasoning-effort knob exists for gemini — nothing may be smuggled in.
    assert.equal(cmd.args.some((a) => a.includes("effort")), false);
    // The builder registered its own isolated home under the scratch cwd.
    assert.equal(cmd.cwd, scratch);
    assert.ok(cmd.env.GEMINI_CLI_HOME?.startsWith(scratch));
  } finally {
    if (prevProject === undefined) delete process.env.STARK_GEMINI_VERTEX_PROJECT;
    else process.env.STARK_GEMINI_VERTEX_PROJECT = prevProject;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the payload is byte-identical across seats and travels on stdin", () => {
  const scratch = tmpDir("identical");
  const prevProject = process.env.STARK_GEMINI_VERTEX_PROJECT;
  process.env.STARK_GEMINI_VERTEX_PROJECT = "jury-test-project";
  try {
    const built = [CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT].map((s) =>
      buildSeatCommand(s, PROMPT, path.join(scratch, s.seat)),
    );
    for (const cmd of built) {
      assert.equal(cmd.stdin, PROMPT);
      assert.equal(cmd.args.some((a) => a.includes("/dev/null")), false);
    }
  } finally {
    if (prevProject === undefined) delete process.env.STARK_GEMINI_VERTEX_PROJECT;
    else process.env.STARK_GEMINI_VERTEX_PROJECT = prevProject;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("assertPromptOnStdin rejects an empty prompt and a /dev/null in argv", () => {
  const base: SeatCommand = {
    seat: "claude",
    model: "claude-opus-5",
    effort: "max",
    cmd: "claude",
    args: ["-p", "-"],
    stdin: PROMPT,
    env: {},
    cwd: "/tmp/s",
  };
  assert.doesNotThrow(() => assertPromptOnStdin(base));
  // What a literal `</dev/null` delivers through these builders: nothing.
  assert.throws(() => assertPromptOnStdin({ ...base, stdin: "" }), /empty stdin prompt/);
  assert.throws(() => assertPromptOnStdin({ ...base, stdin: "   \n" }), /empty stdin prompt/);
  assert.throws(
    () => assertPromptOnStdin({ ...base, args: ["-p", "-", "</dev/null"] }),
    /travels on stdin/,
  );
});

test("a seat whose builder yields an empty prompt fails that seat, not the run", async () => {
  const emptyPrompt: SeatBuilder = () => ({ cmd: "claude", args: [], stdin: "", env: {} });
  const result = await dispatchSeat(CLAUDE_SEAT, {
    ...dispatchOpts(fakeRunner({})),
    deps: fakeDeps(fakeRunner({}), {
      builders: { ...REAL_BUILDERS, claude: emptyPrompt },
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "spawn_failed");
  assert.match(result.failure?.detail ?? "", /empty stdin prompt/);
});

// ---------------------------------------------------------------------------
// Parallel fan-out
// ---------------------------------------------------------------------------

test("seats dispatch in parallel, not one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const runner: SeatRunner = async (req) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => release.push(resolve));
    inFlight -= 1;
    return {
      code: 0, signal: null, stdout: `out-${req.seat}`, stderr: "",
      timedOut: false, notFound: false, stdinClosed: true, kill: null,
    };
  };

  const pending = dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(runner, "calibration"),
  });
  // Every seat must be in flight before any of them is allowed to finish. The
  // wait is BOUNDED: a seat that fails before reaching the runner would
  // otherwise spin here forever, and a hung test is a worse signal than a red one.
  for (let i = 0; i < 1_000 && release.length < 3; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  try {
    assert.equal(release.length, 3, "all three seats must reach the runner");
    assert.equal(peak, 3);
  } finally {
    for (const r of release) r();
  }

  const result = await pending;
  assert.equal(result.seats.length, 3);
  assert.deepEqual(result.seats.map((s) => s.seat), ["claude", "codex", "gemini"]);
  assert.equal(result.ladder, "complete");
});

test("every seat receives the identical prompt on stdin, with the run timeout", async () => {
  const log: RunRequest[] = [];
  await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(fakeRunner({ claude: { stdout: "a" }, codex: { stdout: "b" }, gemini: { stdout: "c" } })),
  });
  assert.equal(log.length, 0); // sanity: the shared log is per-runner
  const seen: RunRequest[] = [];
  await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(fakeRunner({ claude: { stdout: "a" }, codex: { stdout: "b" }, gemini: { stdout: "c" } }, seen)),
  });
  assert.equal(seen.length, 3);
  for (const req of seen) {
    assert.equal(req.stdin, PROMPT);
    assert.equal(req.timeoutMs, 5_000);
  }
});

test("onSeat fires per seat as it settles, so the caller can persist immediately", async () => {
  const settled: string[] = [];
  await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT),
    ...dispatchOpts(fakeRunner({ claude: { stdout: "a" }, codex: { stdout: "b" } })),
    onSeat: (r: SeatResult) => settled.push(r.seat),
  });
  assert.equal(settled.length, 2);
  assert.deepEqual([...settled].sort(), ["claude", "codex"]);
});

test("the scratch cwd is cleaned up even when the seat fails", async () => {
  const made: string[] = [];
  const removed: string[] = [];
  await dispatchSeat(CLAUDE_SEAT, {
    ...dispatchOpts(fakeRunner({ claude: { code: 1, stderr: "boom" } })),
    deps: fakeDeps(fakeRunner({ claude: { code: 1, stderr: "boom" } }), {
      mkScratch: (s) => {
        const dir = `/tmp/scratch-${s}`;
        made.push(dir);
        return dir;
      },
      cleanupScratch: (d) => removed.push(d),
    }),
  });
  assert.deepEqual(made, removed);
});

// ---------------------------------------------------------------------------
// Timeout → process-group kill → no-survivor check
// ---------------------------------------------------------------------------

test("killProcessGroup: SIGTERM alone is enough when the group exits", async () => {
  const calls: Array<[number, string | number]> = [];
  let alive = true;
  const report = await killProcessGroup(4242, {
    kill: (pid, sig) => {
      calls.push([pid, sig]);
      if (sig === "SIGTERM") alive = false;
      if (sig === 0 && !alive) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    },
    sleep: async () => {},
  });
  assert.equal(report.attempted, true);
  assert.deepEqual(report.signals, ["SIGTERM"]);
  assert.equal(report.survivors, false);
  // The GROUP is signalled, never the bare pid — a bare kill leaves the CLI's
  // own children running.
  assert.deepEqual(calls[0], [-4242, "SIGTERM"]);
});

test("killProcessGroup: escalates to SIGKILL and confirms no survivor", async () => {
  const signals: string[] = [];
  let alive = true;
  const report = await killProcessGroup(999, {
    kill: (_pid, sig) => {
      if (sig === 0) {
        if (alive) return;
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      signals.push(String(sig));
      if (sig === "SIGKILL") alive = false;
    },
    sleep: async () => {},
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(report.survivors, false);
});

test("killProcessGroup: a group that outlives SIGKILL is reported as a survivor", async () => {
  const report = await killProcessGroup(777, {
    kill: () => {}, // never throws → the probe always says "alive"
    sleep: async () => {},
    survivorChecks: 3,
  });
  assert.equal(report.survivors, true);
  assert.match(report.detail, /survived SIGKILL/);
});

test("killProcessGroup: EPERM on the probe counts as a survivor, never as gone", async () => {
  const report = await killProcessGroup(555, {
    kill: (_pid, sig) => {
      if (sig !== 0) return;
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    },
    sleep: async () => {},
    survivorChecks: 2,
  });
  assert.equal(report.survivors, true);
});

test("killProcessGroup: refuses to signal a bogus pgid", async () => {
  for (const pgid of [0, 1, -3, Number.NaN]) {
    const calls: number[] = [];
    const report = await killProcessGroup(pgid, {
      kill: (pid) => { calls.push(pid); },
      sleep: async () => {},
    });
    assert.equal(report.attempted, false, `pgid ${pgid} must not be signalled`);
    assert.equal(calls.length, 0);
  }
});

test("a timed-out seat is FAILED and carries its kill report", async () => {
  const runner = fakeRunner({
    claude: {
      code: null,
      signal: "SIGKILL",
      stdout: "partial",
      timedOut: true,
      kill: { attempted: true, signals: ["SIGTERM", "SIGKILL"], survivors: false, detail: "group exited on SIGKILL" },
    },
  });
  const result = await dispatchSeat(CLAUDE_SEAT, dispatchOpts(runner));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "timeout");
  assert.equal(result.timed_out, true);
  assert.match(result.failure?.detail ?? "", /SIGTERM→SIGKILL/);
  assert.equal(result.kill?.survivors, false);
});

test("a surviving process group is recorded as a warning on the seat", async () => {
  const runner = fakeRunner({
    claude: {
      timedOut: true,
      code: null,
      kill: { attempted: true, signals: ["SIGTERM", "SIGKILL"], survivors: true, detail: "process group 5 survived SIGKILL after 10 checks" },
    },
  });
  const result = await dispatchSeat(CLAUDE_SEAT, dispatchOpts(runner));
  assert.equal(result.status, "failed");
  assert.ok(result.warnings.some((w) => /survived the kill/.test(w)));
});

test("realRunner: writes the prompt then CLOSES stdin (the child sees EOF)", async () => {
  const dir = tmpDir("stdin");
  try {
    const outcome = await realRunner({
      seat: "claude",
      cmd: process.execPath,
      // Reads stdin to EOF — it only exits if the pipe is actually closed.
      args: ["-e", "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+b))"],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      stdin: "hello-jury",
      timeoutMs: 10_000,
    });
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout, "GOT:hello-jury");
    assert.equal(outcome.stdinClosed, true);
    assert.equal(outcome.timedOut, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("realRunner: a hung child times out and its whole process GROUP dies", async () => {
  const dir = tmpDir("timeout");
  const marker = path.join(dir, "child.pid");
  try {
    const outcome = await realRunner({
      seat: "codex",
      cmd: process.execPath,
      args: [
        "-e",
        // Spawn a grandchild in the same group, then hang. A bare child.kill()
        // would leave the grandchild running; the group kill must take both.
        `const {spawn}=require('node:child_process');` +
          `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);` +
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));` +
          `process.stdout.write('up');setInterval(()=>{},1000);`,
      ],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      stdin: "prompt",
      timeoutMs: 700,
    });

    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.kill?.attempted, true);
    assert.equal(outcome.kill?.survivors, false, "the group must not outlive the kill");

    const grandchild = Number(fs.readFileSync(marker, "utf8"));
    assert.ok(Number.isInteger(grandchild) && grandchild > 1);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        gone = true;
      }
    }
    assert.equal(gone, true, "the grandchild survived the process-group kill");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("realRunner: a missing binary is a spawn failure, never a hang", async () => {
  const dir = tmpDir("notfound");
  try {
    const outcome = await realRunner({
      seat: "gemini",
      cmd: path.join(dir, "definitely-not-a-binary"),
      args: [],
      env: { PATH: dir },
      cwd: dir,
      stdin: "prompt",
      timeoutMs: 5_000,
    });
    assert.equal(outcome.notFound, true);
    assert.equal(outcome.timedOut, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Timeout resolution
// ---------------------------------------------------------------------------

test("resolveTimeoutMs: 30 minutes by default, config override honoured", () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_SEC * 1000);
  assert.equal(DEFAULT_TIMEOUT_SEC, 1800);
  assert.equal(resolveTimeoutMs({ jury: { timeout_sec: 60 } }), 60_000);
  // Nonsense overrides fall back rather than producing an instant-kill run.
  for (const bad of [0, -5, "600", null, Number.NaN]) {
    assert.equal(
      resolveTimeoutMs({ jury: { timeout_sec: bad } }),
      DEFAULT_TIMEOUT_SEC * 1000,
      `override ${JSON.stringify(bad)} must be ignored`,
    );
  }
  assert.equal(resolveTimeoutMs({ jury: "nope" }), DEFAULT_TIMEOUT_SEC * 1000);
});

// ---------------------------------------------------------------------------
// Per-seat capture: usage + cost
// ---------------------------------------------------------------------------

test("claude usage: tokens and vendor cost off the result envelope", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "the candidate",
    total_cost_usd: 1.2345,
    usage: { input_tokens: 12_000, output_tokens: 3_000 },
  });
  const usage = extractUsage("claude", "claude-opus-5", stdout);
  assert.equal(usage.input_tokens, 12_000);
  assert.equal(usage.output_tokens, 3_000);
  assert.equal(usage.cost_usd, 1.2345);
  assert.equal(usage.usage_source, "claude:input_tokens/output_tokens");
  assert.equal(usage.cost_source, "claude:total_cost_usd");
});

test("codex usage: the LAST JSONL usage event wins, cost computed from rates", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    JSON.stringify({ type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000_000, output_tokens: 2_000_000 } }),
  ].join("\n");
  const rates = { "gpt-5.5-pro": { input_per_1m_usd: 25, output_per_1m_usd: 100 } };
  const usage = extractUsage("codex", "gpt-5.5-pro", stdout, rates);
  assert.equal(usage.input_tokens, 1_000_000);
  assert.equal(usage.output_tokens, 2_000_000);
  assert.equal(usage.cost_usd, 25 + 200);
  assert.equal(usage.cost_source, "rates:gpt-5.5-pro");
});

test("gemini usage: usageMetadata token names are recognized", () => {
  const stdout = JSON.stringify({
    response: "the candidate",
    stats: { usageMetadata: { promptTokenCount: 2_000, candidatesTokenCount: 500 } },
  });
  const rates = { "gemini-3.1-pro-preview": { input_per_1m_usd: 2, output_per_1m_usd: 12 } };
  const usage = extractUsage("gemini", "gemini-3.1-pro-preview", stdout, rates);
  assert.equal(usage.input_tokens, 2_000);
  assert.equal(usage.output_tokens, 500);
  assert.equal(usage.usage_source, "gemini:promptTokenCount/candidatesTokenCount");
  assert.ok(usage.cost_usd !== null && Math.abs(usage.cost_usd - 0.01) < 1e-9);
});

test("a CLI that reports no usage stores NULLS, never an estimate", () => {
  for (const stdout of ["just prose, no JSON at all", "", JSON.stringify({ response: "hi" })]) {
    const usage = extractUsage("gemini", "gemini-3.1-pro-preview", stdout);
    assert.equal(usage.input_tokens, null);
    assert.equal(usage.output_tokens, null);
    assert.equal(usage.cost_usd, null);
    assert.equal(usage.usage_source, null);
    assert.equal(usage.cost_source, null);
  }
});

test("computeCost: null for an unpriced model, arithmetic for a priced one", () => {
  const rates = { "claude-opus-5": { input_per_1m_usd: 5, output_per_1m_usd: 25 } };
  assert.equal(computeCost("no-such-model", 1000, 1000, rates), null);
  assert.equal(computeCost("claude-opus-5", null, null, rates), null);
  assert.equal(computeCost("claude-opus-5", 1_000_000, 1_000_000, rates), 30);
  // A half-reported usage still costs what it costs; the missing half is 0.
  assert.equal(computeCost("claude-opus-5", 1_000_000, null, rates), 5);
});

test("latency and exit code ride on every seat result", async () => {
  let clock = 1000;
  const runner: SeatRunner = async () => {
    clock += 4_321;
    return {
      code: 0, signal: null, stdout: "a".repeat(600), stderr: "",
      timedOut: false, notFound: false, stdinClosed: true, kill: null,
    };
  };
  const result = await dispatchSeat(CLAUDE_SEAT, {
    ...dispatchOpts(runner),
    deps: fakeDeps(runner, { now: () => clock }),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.latency_ms, 4_321);
  assert.equal(result.exit_code, 0);
  assert.equal(result.effort, "max");
});

test("a gemini seat records effort n/a, not an empty string", async () => {
  const runner = fakeRunner({ gemini: { stdout: "x".repeat(600) } });
  const result = await dispatchSeat(GEMINI_SEAT, dispatchOpts(runner));
  assert.equal(result.effort, "n/a");
});

// ---------------------------------------------------------------------------
// Truncation + length floor
// ---------------------------------------------------------------------------

test("detectTruncation: each vendor's own limit signal", () => {
  assert.equal(detectTruncation(JSON.stringify({ stop_reason: "max_tokens" })).truncated, true);
  assert.equal(
    detectTruncation(JSON.stringify({ type: "turn.completed", finish_reason: "length" })).truncated,
    true,
  );
  assert.equal(
    detectTruncation(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS" }] })).truncated,
    true,
  );
  assert.equal(detectTruncation(JSON.stringify({ truncated: true })).truncated, true);
  // A clean finish is not a truncation.
  assert.equal(detectTruncation(JSON.stringify({ stop_reason: "end_turn" })).truncated, false);
  assert.equal(detectTruncation(JSON.stringify({ finishReason: "STOP" })).truncated, false);
  assert.equal(detectTruncation("plain prose, no envelope").truncated, false);
  assert.equal(detectTruncation("").truncated, false);
});

test("detectTruncation: names the signal that fired", () => {
  const hit = detectTruncation(JSON.stringify({ nested: { finishReason: "MAX_TOKENS" } }));
  assert.equal(hit.signal, "finishReason=MAX_TOKENS");
});

test("checkLength: 15% floor fails, 40% warns, boundaries are exclusive", () => {
  const src = "x".repeat(1000);
  assert.equal(checkLength(src, "x".repeat(149), "rewrite").status, "failed");
  // Exactly at the floor is not BELOW it.
  assert.equal(checkLength(src, "x".repeat(150), "rewrite").status, "warning");
  assert.equal(checkLength(src, "x".repeat(399), "rewrite").status, "warning");
  assert.equal(checkLength(src, "x".repeat(400), "rewrite").status, "ok");
  assert.equal(checkLength(src, "x".repeat(1200), "rewrite").status, "ok");
  assert.equal(LENGTH_FLOOR_FAIL, 0.15);
  assert.equal(LENGTH_FLOOR_WARN, 0.4);
  assert.equal(checkLength(src, "x".repeat(200), "rewrite").ratio, 0.2);
});

test("checkLength: calibration mode is exempt — a scorecard is legitimately short", () => {
  const check = checkLength("x".repeat(2000), "Hook 3/3 …", "calibration");
  assert.equal(check.status, "ok");
  assert.ok(check.ratio !== null && check.ratio < LENGTH_FLOOR_FAIL);
});

test("checkLength: an empty source is unmeasurable, not a failure", () => {
  const check = checkLength("", "anything", "rewrite");
  assert.equal(check.status, "ok");
  assert.equal(check.ratio, null);
});

test("a truncated candidate is FAILED even with a zero exit code", async () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "x".repeat(900),
    stop_reason: "max_tokens",
  });
  const result = await dispatchSeat(CLAUDE_SEAT, dispatchOpts(fakeRunner({ claude: { stdout } })));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "truncated");
  assert.equal(result.truncated, true);
  assert.match(result.failure?.detail ?? "", /stop_reason=max_tokens/);
});

test("a candidate below the length floor is FAILED; below the warning line it travels", async () => {
  const short = await dispatchSeat(
    CLAUDE_SEAT,
    dispatchOpts(fakeRunner({ claude: { stdout: "x".repeat(100) } })),
  );
  assert.equal(short.status, "failed");
  assert.equal(short.failure?.reason, "too_short");
  assert.ok(short.length_ratio !== null && short.length_ratio < LENGTH_FLOOR_FAIL);

  const warned = await dispatchSeat(
    CLAUDE_SEAT,
    dispatchOpts(fakeRunner({ claude: { stdout: "x".repeat(300) } })),
  );
  assert.equal(warned.status, "ok");
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0] ?? "", /below the 40% warning line/);
});

test("empty output is FAILED even on a zero exit", async () => {
  for (const stdout of ["", "   \n  "]) {
    const result = await dispatchSeat(CLAUDE_SEAT, dispatchOpts(fakeRunner({ claude: { stdout } })));
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.reason, "empty_output");
  }
});

test("a non-zero exit is FAILED and carries the stderr tail", async () => {
  const result = await dispatchSeat(
    CLAUDE_SEAT,
    dispatchOpts(fakeRunner({ claude: { code: 2, stderr: "model overloaded" } })),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "exit_nonzero");
  assert.match(result.failure?.detail ?? "", /model overloaded/);
});

test("a claude is_error envelope is a CLI error, never a candidate", async () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Credit balance is too low",
  });
  const result = await dispatchSeat(CLAUDE_SEAT, dispatchOpts(fakeRunner({ claude: { stdout } })));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "cli_error");
  assert.match(result.failure?.detail ?? "", /Credit balance is too low/);
});

test("vendor framing is unwrapped into the candidate text", async () => {
  const body = "y".repeat(800);
  const claude = await dispatchSeat(
    CLAUDE_SEAT,
    dispatchOpts(fakeRunner({ claude: { stdout: JSON.stringify({ type: "result", result: body }) } })),
  );
  assert.equal(claude.output, body);

  const gemini = await dispatchSeat(
    GEMINI_SEAT,
    dispatchOpts(fakeRunner({ gemini: { stdout: JSON.stringify({ response: body }) } })),
  );
  assert.equal(gemini.output, body);

  const codexStdout = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: body },
  });
  const codex = await dispatchSeat(
    CODEX_SEAT,
    dispatchOpts(fakeRunner({ codex: { stdout: codexStdout } })),
  );
  assert.equal(codex.output, body);
  assert.equal(codex.raw_stdout, codexStdout);
});

// ---------------------------------------------------------------------------
// The failure ladder, call-level half
// ---------------------------------------------------------------------------

test("ladder: every seat failing errors loudly and names every failure", async () => {
  const result = await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(
      fakeRunner({
        claude: { code: 1, stderr: "auth" },
        codex: { timedOut: true, code: null },
        gemini: { stdout: "" },
      }),
    ),
  });
  assert.equal(result.ladder, "all-failed");
  assert.equal(result.survivors.length, 0);
  assert.equal(result.failures.length, 3);

  // dispatchPanel itself does NOT throw — the caller persists the evidence
  // first, then raises.
  assert.throws(
    () => assertSurvivors(result),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.failures.length, 3);
      for (const seatId of ["claude", "codex", "gemini"]) {
        assert.match(err.message, new RegExp(seatId));
      }
      assert.match(err.message, /exit_nonzero/);
      assert.match(err.message, /timeout/);
      assert.match(err.message, /empty_output/);
      return true;
    },
  );
});

test("ladder: exactly one survivor short-circuits the merge", async () => {
  const result = await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(
      fakeRunner({
        claude: { stdout: "x".repeat(900) },
        codex: { code: 1, stderr: "nope" },
        gemini: { stdout: "" },
      }),
    ),
  });
  assert.equal(result.ladder, "single");
  assert.equal(result.survivors.length, 1);
  assert.equal(result.survivors[0]?.seat, "claude");
  assert.doesNotThrow(() => assertSurvivors(result));
});

test("ladder: partial failure is recorded, not fatal", async () => {
  const result = await dispatchPanel({
    panel: panelOf(CLAUDE_SEAT, CODEX_SEAT, GEMINI_SEAT),
    ...dispatchOpts(
      fakeRunner({
        claude: { stdout: "x".repeat(900) },
        codex: { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(900) } }) },
        gemini: { timedOut: true, code: null },
      }),
    ),
  });
  assert.equal(result.ladder, "partial");
  assert.equal(result.survivors.length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.seat, "gemini");
  assert.equal(result.failures[0]?.failure?.reason, "timeout");
  // The failed seat is still in `seats` — the manifest records what happened.
  assert.equal(result.seats.length, 3);
});

test("ladderFor: a healthy panel is complete; a one-seat panel is single", () => {
  const ok = (id: SeatId): SeatResult => ({ seat: id, status: "ok" } as SeatResult);
  const bad = (id: SeatId): SeatResult => ({ seat: id, status: "failed" } as SeatResult);
  assert.equal(ladderFor([ok("claude"), ok("codex"), ok("gemini")]), "complete");
  assert.equal(ladderFor([ok("claude")]), "single");
  assert.equal(ladderFor([ok("claude"), ok("codex")]), "complete");
  assert.equal(ladderFor([ok("claude"), ok("codex"), bad("gemini")]), "partial");
  assert.equal(ladderFor([bad("claude"), bad("codex")]), "all-failed");
  assert.equal(ladderFor([]), "all-failed");
});

test("classifySeat is pure over a run outcome (no spawn, no fs)", () => {
  const command: SeatCommand = {
    seat: "codex",
    model: "gpt-5.5-pro",
    effort: "xhigh",
    cmd: "codex",
    args: ["exec", "-s", "read-only"],
    stdin: PROMPT,
    env: {},
    cwd: "/tmp/s",
  };
  const outcome: RunOutcome = {
    code: 0,
    signal: null,
    stdout: "z".repeat(900),
    stderr: "",
    timedOut: false,
    notFound: false,
    stdinClosed: true,
    kill: null,
  };
  const result = classifySeat(CODEX_SEAT, command, outcome, 1234, {
    source: SOURCE,
    mode: "rewrite",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.latency_ms, 1234);
  assert.deepEqual(result.command.args, ["exec", "-s", "read-only"]);
});

test("no seat is spawned by the command-construction tests", () => {
  // Guard against a future refactor that makes buildSeatCommand execute:
  // the builders return data, and `spawn` is only ever reached via realRunner.
  assert.equal(typeof spawn, "function");
  const cmd = buildSeatCommand(CLAUDE_SEAT, PROMPT, "/tmp/never-spawned");
  assert.equal(fs.existsSync("/tmp/never-spawned"), false);
  assert.equal(cmd.cmd, "claude");
});
