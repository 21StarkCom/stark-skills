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

import { spawnBounded } from "./bounded_spawn_lib.ts";

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
test("forwarding handlers exist only while a child is in flight", HANG_GUARD, async () => {
  const before = process.listenerCount("SIGINT");
  const running = spawnBounded(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { timeoutMs: 20_000 });
  assert.equal(process.listenerCount("SIGINT"), before + 1, "no forwarding handler while a child is live");
  const overlapping = spawnBounded(process.execPath, ["-e", ""], { timeoutMs: 20_000 });
  assert.equal(process.listenerCount("SIGINT"), before + 1, "a second child must share the one handler");
  await overlapping;
  assert.equal(process.listenerCount("SIGINT"), before + 1, "the handler was dropped with a child still live");
  await running;
  assert.equal(process.listenerCount("SIGINT"), before, "the handler outlived the last child");
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
