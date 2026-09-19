/**
 * bounded_spawn_lib.test.ts — the process-group half of the `gh` bound
 * (STARK-6131). The timeout/ENOBUFS/no-descendant behaviour is pinned through
 * the two real callers (`review_post_lib.test.ts`, `findings_review_post.test.ts`);
 * what lives here is what only this file owns: the signal forwarding that pays
 * back `detached`, and the handler lifecycle around it.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { releaseGroup, spawnBounded, trackGroup } from "./bounded_spawn_lib.ts";

/** A never-settling call must FAIL the suite, not stall the required check. */
const HANG_GUARD = { timeout: 30_000 };

const LIB_URL = pathToFileURL(nodePath.join(import.meta.dirname, "bounded_spawn_lib.ts")).href;

async function waitFor(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return cond();
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid a child wrote to `file`, once it has; `null` if it never does. */
async function pidFrom(file: string): Promise<number | null> {
  const read = (): number => (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : NaN);
  return (await waitFor(() => read() > 1)) ? read() : null;
}

/** `finally` cleanup: a red run must not leave a `sleep 30` behind. */
function reap(file: string): void {
  const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) : NaN;
  if (pid > 1 && isAlive(pid)) process.kill(pid, "SIGKILL");
  fs.rmSync(file, { force: true });
}

/**
 * A terminal's Ctrl-C goes to the FOREGROUND process group — which a detached
 * `gh` has left. So the faithful simulation signals the tool's pid ALONE: the
 * child and grandchild die only if the tool forwards. (Signalling the tool's
 * group would prove nothing; the child is, by design, not in it.)
 */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  test(`${sig} to the tool alone still terminates an in-flight child and its descendants`, HANG_GUARD, async () => {
    const pidFile = nodePath.join(os.tmpdir(), `bounded-spawn-fwd-${sig}-${process.pid}-${Date.now()}`);
    // The grandchild runs in the FOREGROUND: a non-interactive shell starts `&`
    // jobs with SIGINT ignored, so a backgrounded one would survive a real
    // terminal Ctrl-C too and prove nothing about forwarding.
    const sh = `printf '%s ' $$ > '${pidFile}'; sh -c 'echo $$ >> "$0"; exec sleep 30' '${pidFile}'`;
    const driver = spawn(process.execPath, [
      "--no-warnings",
      "-e",
      `import(${JSON.stringify(LIB_URL)}).then((m) => m.spawnBounded("/bin/sh", ["-c", ${JSON.stringify(sh)}], { timeoutMs: 25000 }))`,
    ], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((res) => driver.once("exit", (_c, s) => res(s)));
    let pids: number[] = [];
    try {
      assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).length === 2),
        "the child never reported its pids");
      pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      assert.ok(pids.every((p) => Number.isInteger(p) && p > 1), `bad pids: ${pids}`);
      assert.ok(pids.every(isAlive), "child/grandchild died before the signal — the test would pass vacuously");

      process.kill(driver.pid!, sig);

      // Re-raised, so the tool dies BY the signal, exactly as before `detached`.
      assert.equal(await exited, sig, "the tool did not die by the forwarded signal");
      assert.ok(await waitFor(() => !pids.some(isAlive)), `${sig} did not reach the detached group: ${pids.filter(isAlive)} alive`);
    } finally {
      driver.kill("SIGKILL");
      for (const p of pids) if (isAlive(p)) process.kill(p, "SIGKILL");
      fs.rmSync(pidFile, { force: true });
    }
  });
}

// A SIGINT listener replaces Node's default exit, so one left behind after the
// last child settles would make an idle tool ignore Ctrl-C.
//
// The long-lived child is ended BY the test, not by a short sleep racing the
// overlapping child's startup: test files run in parallel, and on a loaded
// runner a 300 ms head start is not an ordering guarantee.
test("forwarding handlers exist only while a child is in flight", HANG_GUARD, async () => {
  const pidFile = nodePath.join(os.tmpdir(), `bounded-spawn-life-${process.pid}-${Date.now()}`);
  const before = process.listenerCount("SIGINT");
  try {
    const running = spawnBounded("/bin/sh", ["-c", `echo $$ > '${pidFile}'; exec sleep 30`], { timeoutMs: 20_000 });
    assert.equal(process.listenerCount("SIGINT"), before + 1, "no forwarding handler while a child is live");
    const overlapping = spawnBounded(process.execPath, ["-e", ""], { timeoutMs: 20_000 });
    assert.equal(process.listenerCount("SIGINT"), before + 1, "a second child must share the one handler");
    await overlapping;
    assert.equal(process.listenerCount("SIGINT"), before + 1, "the handler was dropped with a child still live");
    const pid = await pidFrom(pidFile);
    assert.ok(pid !== null, "the long-lived child never reported its pid");
    process.kill(pid, "SIGKILL");
    await running;
    assert.equal(process.listenerCount("SIGINT"), before, "the handler outlived the last child");
  } finally {
    reap(pidFile);
  }
});

// A tool with its OWN SIGINT handler already received the delivery we are
// forwarding, and our listener displaced no default exit. Re-raising handed it
// one Ctrl-C twice (measured: its handler fired 2x). In-process on purpose: with
// a listener of our own installed the signal cannot kill the test runner.
test("an embedding tool's own handler gets one SIGINT once, and the child still gets it", HANG_GUARD, async () => {
  let fired = 0;
  const own = () => { fired += 1; };
  process.on("SIGINT", own);
  try {
    const running = spawnBounded("/bin/sh", ["-c", "exec sleep 30"], { timeoutMs: 20_000 });
    process.kill(process.pid, "SIGINT");
    const r = await running;
    assert.equal(r.signal, "SIGINT", "the signal was not forwarded to the detached group");
    // A re-raised duplicate is delivered asynchronously; give it room to land.
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(fired, 1, "the tool's own handler received one SIGINT more than once");
  } finally {
    process.removeListener("SIGINT", own);
  }
});

// The other half of the same defect: `forward` used to uninstall itself on the
// first signal, so a child that IGNORED it (and a tool that handled it) left
// the group deaf to every later Ctrl-C.
test("forwarding stays armed after a signal the tool and the child both survive", HANG_GUARD, async () => {
  const readyFile = nodePath.join(os.tmpdir(), `bounded-spawn-armed-${process.pid}-${Date.now()}`);
  let fired = 0;
  const own = () => { fired += 1; };
  process.on("SIGINT", own);
  try {
    const armed = process.listenerCount("SIGINT") + 1;
    // The trap is installed BEFORE the ready file exists, and `sleep` inherits it.
    const running = spawnBounded("/bin/sh", ["-c", `trap '' INT; echo $$ > '${readyFile}'; exec sleep 30`], { timeoutMs: 20_000 });
    const pid = await pidFrom(readyFile);
    assert.ok(pid !== null, "the child never reported ready");
    process.kill(process.pid, "SIGINT");
    assert.ok(await waitFor(() => fired >= 1), "the tool's own handler never saw the signal");
    assert.equal(process.listenerCount("SIGINT"), armed, "forwarding was disarmed with a child still live");
    process.kill(pid, "SIGKILL");
    await running;
    assert.equal(process.listenerCount("SIGINT"), armed - 1, "the handler outlived the last child");
  } finally {
    process.removeListener("SIGINT", own);
    reap(readyFile);
  }
});

// `spawnBounded` is exported, so it is a door of its own: `setTimeout` fires an
// unvalidated 0 after ~1 ms and kills the call it was meant to bound.
for (const bad of [0, NaN, 3_000_000_000]) {
  test(`an unusable timeoutMs is refused before spawning: ${String(bad)}`, HANG_GUARD, async () => {
    const before = process.listenerCount("SIGINT");
    await assert.rejects(spawnBounded(process.execPath, ["-e", ""], { timeoutMs: bad }), /spawnBounded timeoutMs must be/);
    assert.equal(process.listenerCount("SIGINT"), before, "a refused call must not have spawned or tracked anything");
  });
}

// STARK-6135: `trackGroup` is exported for jury's seats. `process.kill(-0)` is
// this process's OWN group and `-1` is every process the user owns, so a bad id
// must never be tracked — a forwarded Ctrl-C would land on strangers.
for (const bad of [0, 1, -5, 1.5, NaN]) {
  test(`trackGroup refuses an unsignallable group id: ${String(bad)}`, () => {
    const before = process.listenerCount("SIGINT");
    trackGroup(bad);
    assert.equal(process.listenerCount("SIGINT"), before, "a refused id must install nothing");
    releaseGroup(bad);
    assert.equal(process.listenerCount("SIGINT"), before);
  });
}

test("trackGroup/releaseGroup pair installs and removes the handlers, release is idempotent", () => {
  const before = process.listenerCount("SIGINT");
  // Never signalled here, so any id above 1 will do.
  trackGroup(2_000_000_001);
  assert.equal(process.listenerCount("SIGINT"), before + 1);
  releaseGroup(2_000_000_001);
  releaseGroup(2_000_000_001);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("a timeout leaves no handler behind either", HANG_GUARD, async () => {
  const before = process.listenerCount("SIGTERM");
  const r = await spawnBounded("/bin/sh", ["-c", "sleep 30"], { timeoutMs: 300 });
  assert.equal(r.status, null);
  assert.equal((r.error as NodeJS.ErrnoException).code, "ETIMEDOUT");
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test("a spawn failure rejects and leaves no handler behind", HANG_GUARD, async () => {
  const before = process.listenerCount("SIGINT");
  await assert.rejects(spawnBounded("/nonexistent/stark-6131-no-such-binary", []), { code: "ENOENT" });
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("maxBuffer kills the whole group, not only the writer", HANG_GUARD, async () => {
  const pidFile = nodePath.join(os.tmpdir(), `bounded-spawn-buf-${process.pid}-${Date.now()}`);
  try {
    const r = await spawnBounded("/bin/sh", [
      "-c",
      `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; while :; do printf '%01024d' 0; done`,
    ], { maxBuffer: 64 * 1024, timeoutMs: 20_000 });
    assert.equal(r.status, null);
    assert.equal((r.error as NodeJS.ErrnoException).code, "ENOBUFS");
    const gpid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(gpid > 1);
    const gone = await waitFor(() => !isAlive(gpid));
    if (!gone) process.kill(gpid, "SIGKILL");
    assert.ok(gone, "the grandchild survived the maxBuffer kill");
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});
