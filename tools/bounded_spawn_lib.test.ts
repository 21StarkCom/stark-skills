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

import { makeGroupKiller, spawnBounded } from "./bounded_spawn_lib.ts";

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
 *
 * The signal waits for the tool's ARMED marker, not only for the child's pids
 * (STARK-6135). "The child reported its pids" does NOT mean forwarding is
 * armed: the child runs concurrently from the fork, so under load it writes
 * both pids while the tool is still descheduled between `spawn()` returning and
 * `trackGroup`. A signal landing there kills the tool by DEFAULT disposition —
 * it still "dies by the signal", so that assertion passed vacuously — and
 * orphans the child, failing the test against correct code. Measured under a
 * parallel suite: 2 of 40 runs orphaned the child, both with the handler not
 * yet armed. The marker is written only after `spawnBounded` has returned (its
 * executor, `trackGroup` included, runs synchronously) and carries the listener
 * count, so "armed" + "died by the signal" can only be a genuine re-raise.
 */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  test(`${sig} to the tool alone still terminates an in-flight child and its descendants`, HANG_GUARD, async () => {
    const pidFile = nodePath.join(os.tmpdir(), `bounded-spawn-fwd-${sig}-${process.pid}-${Date.now()}`);
    const armedFile = `${pidFile}.armed`;
    // The grandchild runs in the FOREGROUND: a non-interactive shell starts `&`
    // jobs with SIGINT ignored, so a backgrounded one would survive a real
    // terminal Ctrl-C too and prove nothing about forwarding.
    const sh = `printf '%s ' $$ > '${pidFile}'; sh -c 'echo $$ >> "$0"; exec sleep 30' '${pidFile}'`;
    const driver = spawn(process.execPath, [
      "--no-warnings",
      "-e",
      `import(${JSON.stringify(LIB_URL)}).then((m) => { m.spawnBounded("/bin/sh", ["-c", ${JSON.stringify(sh)}], { timeoutMs: 25000 }); ` +
        `require("node:fs").writeFileSync(${JSON.stringify(armedFile)}, String(process.listenerCount(${JSON.stringify(sig)}))); })`,
    ], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((res) => driver.once("exit", (_c, s) => res(s)));
    let pids: number[] = [];
    try {
      assert.ok(await waitFor(() => fs.existsSync(armedFile) && fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).length === 2),
        "the child never reported its pids, or the tool never got past spawning it");
      pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      assert.ok(pids.every((p) => Number.isInteger(p) && p > 1), `bad pids: ${pids}`);
      assert.ok(pids.every(isAlive), "child/grandchild died before the signal — the test would pass vacuously");
      assert.equal(fs.readFileSync(armedFile, "utf8"), "1", `no ${sig} forwarding handler armed with a child in flight`);

      process.kill(driver.pid!, sig);

      // Armed (above) AND dead by the signal: only the re-raise does both, so
      // the tool dies BY the signal exactly as before `detached`.
      assert.equal(await exited, sig, "the tool did not die by the forwarded signal");
      assert.ok(await waitFor(() => !pids.some(isAlive)), `${sig} did not reach the detached group: ${pids.filter(isAlive)} alive`);
    } finally {
      driver.kill("SIGKILL");
      for (const p of pids) if (isAlive(p)) process.kill(p, "SIGKILL");
      fs.rmSync(pidFile, { force: true });
      fs.rmSync(armedFile, { force: true });
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

// STARK-6135: jury's seats claim a group through the same door. `process.kill(-0)`
// is this process's OWN group and `-1` is every process the user owns, so a bad
// id must never be tracked — a forwarded Ctrl-C would land on strangers.
for (const bad of [undefined, 0, 1, -5, 1.5, NaN]) {
  test(`makeGroupKiller refuses an unsignallable group id: ${String(bad)}`, () => {
    const before = process.listenerCount("SIGINT");
    const killer = makeGroupKiller(bad);
    assert.equal(process.listenerCount("SIGINT"), before, "a refused id must install nothing");
    assert.equal(killer("SIGTERM"), false, "a refused id must never be signalled");
    assert.equal(killer.gone, false, "nothing was probed, so nothing is known to be gone");
    killer.release();
    assert.equal(process.listenerCount("SIGINT"), before);
  });
}

test("a claim installs the handlers and its release removes them, idempotently", () => {
  const before = process.listenerCount("SIGINT");
  // Never signalled here, so any id above 1 will do.
  const killer = makeGroupKiller(2_000_000_001);
  assert.equal(process.listenerCount("SIGINT"), before + 1);
  killer.release();
  killer.release();
  assert.equal(process.listenerCount("SIGINT"), before);
});

// STARK-6377 / STARK-6735. A claim is keyed by CALL, never by id. Once the latch
// lets an id go the kernel may hand it to a concurrent call's child, which
// claims it again — and a first call that released BY ID on settling would
// delete the SECOND call's claim and leave a live agent deaf to Ctrl-C. The id
// here is above any real pid_max, so the group never exists: every signal draws
// ESRCH, and claiming it twice stands in for the recycle with no pid counter to
// race.
test("a latched call's settle does not release a later call that recycled its group id", () => {
  const before = process.listenerCount("SIGINT");
  const recycled = 2_000_000_002;
  const first = makeGroupKiller(recycled);
  assert.equal(first(0), false, "a group that does not exist accepted a probe");
  assert.equal(first.gone, true, "ESRCH did not latch");
  assert.equal(process.listenerCount("SIGINT"), before, "ESRCH did not drop the claim from the forwarding set");
  const second = makeGroupKiller(recycled); // a second call's child was handed the id
  try {
    first.release(); // …and only now does the first call settle
    assert.equal(process.listenerCount("SIGINT"), before + 1, "the first call's settle released the second call's claim");
    assert.equal(second.gone, false, "one call's latch leaked into another call's claim on the same id");
  } finally {
    second.release();
  }
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("a killer that never latched still releases exactly once at settle", () => {
  const before = process.listenerCount("SIGINT");
  const id = 2_000_000_003;
  const killer = makeGroupKiller(id);
  killer.release();
  assert.equal(process.listenerCount("SIGINT"), before, "the settle-time release did not end the claim");
  const later = makeGroupKiller(id);
  try {
    killer.release();
    assert.equal(process.listenerCount("SIGINT"), before + 1, "a second release from the same call reached another call's claim");
  } finally {
    later.release();
  }
});

// STARK-6735. `forward` used to signal every tracked id through a bare kill that
// swallowed ESRCH and untracked nothing — so a group that emptied AFTER the
// leader's exit probe (an in-group descendant outliving it) was re-signalled on
// every Ctrl-C an embedding tool's own handler survived, at an id free for
// reuse. It now shares the per-call latch. The extra listener is what makes this
// safe to run: with another handler present `forward` neither re-raises nor
// uninstalls, so the signal is delivered to the test process's handlers only.
test("a forwarded signal latches a reclaimed group: it is signalled once, not once per Ctrl-C", () => {
  const id = 2_000_000_004; // above any pid_max: every signal draws ESRCH
  const own = (): void => { /* the embedding tool's own handler */ };
  process.on("SIGHUP", own);
  const real = process.kill;
  let attempts = 0;
  process.kill = ((pid: number, signal?: string | number): true => {
    if (pid === -id) attempts += 1;
    return real.call(process, pid, signal);
  }) as typeof process.kill;
  const killer = makeGroupKiller(id);
  try {
    process.emit("SIGHUP", "SIGHUP"); // Node passes the name, as a real delivery does
    assert.equal(attempts, 1, "the forwarded signal never reached the claimed group");
    assert.equal(killer.gone, true, "forward heard ESRCH and did not latch the call's killer");
    process.emit("SIGHUP", "SIGHUP"); // Node passes the name, as a real delivery does
    assert.equal(attempts, 1, "a second Ctrl-C re-signalled an id the kernel had reported gone");
    assert.equal(killer("SIGKILL"), false, "the call's own ladder signalled after forward had latched");
    assert.equal(attempts, 1);
  } finally {
    process.kill = real;
    killer.release();
    process.removeListener("SIGHUP", own);
  }
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

// STARK-6245. `forward` does not settle with the call — so a group the kernel
// has already reclaimed has to leave the forwarding set the moment the latch
// trips, or the recycled-id signal the latch exists to stop is simply delivered
// by the other door.
test("a group the kernel has reclaimed is untracked while the call is still open", HANG_GUARD, async () => {
  const pidFile = nodePath.join(os.tmpdir(), `bounded-spawn-reclaimed-${process.pid}-${Date.now()}`);
  const before = process.listenerCount("SIGINT");
  // The descendant `setsid`s OUT of the group and keeps stdout, so `close`
  // never comes: the call stays open with the group provably empty — the exact
  // window the latch exists for. The leader waits for the pid file, which perl
  // writes only AFTER setsid, so "the group is empty when the leader exits" is
  // an ordering guarantee here rather than a race.
  const sh =
    `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", $ARGV[0]); print F $$; close F; sleep 20' '${pidFile}' & ` +
    `while [ ! -s '${pidFile}' ]; do sleep 0.05; done; exit 0`;
  // The bound is a safety net, not the mechanism: the descendant is killed by
  // hand below so the call closes in milliseconds instead of at the timeout.
  let settled = false;
  const running = spawnBounded("/bin/sh", ["-c", sh], { timeoutMs: 20_000 })
    .then((r) => { settled = true; return r; });
  // Every assertion sits INSIDE the try (STARK-6735): the descendant is in its
  // own session, so if one failed out here nothing else could ever reap it.
  try {
    assert.equal(process.listenerCount("SIGINT"), before + 1, "no forwarding handler while the child is live");
    const escaped = await pidFrom(pidFile);
    assert.ok(escaped !== null, "the escaped descendant never reported its pid");
    assert.ok(
      await waitFor(() => process.listenerCount("SIGINT") === before),
      "a group the kernel reported gone stayed in the forwarding set",
    );
    // What makes that drop mean the latch and not the settle: `claim()` releases
    // the group on EVERY settle path, so a drop observed after the call finished
    // would pin nothing at all.
    assert.equal(settled, false, "the call settled first — the drop proves nothing about the latch");
    // Let go of stdout so `close` can finally come.
    process.kill(escaped, "SIGKILL");
    await running;
    assert.equal(process.listenerCount("SIGINT"), before);
  } finally {
    reap(pidFile);
  }
});
