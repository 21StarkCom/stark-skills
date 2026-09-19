import { after, before, test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isPlainObject,
  parseCodexJsonl,
  parseGeminiJson,
  shouldFallbackToApiKey,
  VALID_AGENTS,
  run,
} from "./agent_dispatch_lib.ts";

const TOOLS_DIR = import.meta.dirname;

// --- parseCodexJsonl -------------------------------------------------------

describe("parseCodexJsonl", () => {
  test("passes through non-JSONL output unchanged", () => {
    assert.equal(parseCodexJsonl("plain text"), "plain text");
  });

  test("extracts agent_message events", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"other"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"world"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "hello\nworld");
  });

  test("extracts legacy message+content events", () => {
    const raw = '{"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}';
    assert.equal(parseCodexJsonl(raw), "hi");
  });

  test("skips malformed JSON lines", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
      'not json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "a\nb");
  });
});

// --- parseGeminiJson -------------------------------------------------------

describe("parseGeminiJson", () => {
  test("unwraps single response envelope", () => {
    assert.equal(parseGeminiJson('{"response":"hello"}'), "hello");
  });

  test("joins array of response envelopes", () => {
    assert.equal(parseGeminiJson('[{"response":"a"},{"response":"b"}]'), "a\nb");
  });

  test("passes through non-envelope output", () => {
    assert.equal(parseGeminiJson("plain text"), "plain text");
  });
});

// --- isPlainObject ---------------------------------------------------------

describe("isPlainObject", () => {
  test("true for plain objects", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
  });
  test("false for arrays, null, primitives", () => {
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("s"), false);
    assert.equal(isPlainObject(1), false);
  });
});

// --- shouldFallbackToApiKey -----------------------------------------------

describe("shouldFallbackToApiKey", () => {
  test("matches known ADC failure patterns", () => {
    assert.equal(shouldFallbackToApiKey("UNAUTHENTICATED"), true);
    assert.equal(shouldFallbackToApiKey("DefaultCredentialsError: ..."), true);
    assert.equal(shouldFallbackToApiKey("got 403 from server"), true);
  });
  test("returns false for unrelated stderr", () => {
    assert.equal(shouldFallbackToApiKey("connection refused"), false);
  });
});

// --- VALID_AGENTS sanity --------------------------------------------------

describe("VALID_AGENTS", () => {
  test("contains exactly the three known agents", () => {
    assert.deepEqual([...VALID_AGENTS].sort(), ["claude", "codex", "gemini"]);
  });
});

// --- run(): the timeout reaches the whole tree (STARK-6147) -----------------
//
// Every test here runs against BOTH trees: the canonical `tools/` and the Codex
// package surface (`tools/` with `runtime-overrides/codex/tools/` copied over
// it, which is how Bifrost composes it) — the mirror carries its own copy of
// `run()`, and a fix applied to one copy only is the drift this pins.

type RunFn = typeof run;

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-dispatch-${tag}-`));
}

/** A composed, importable copy of one runtime's tool tree. */
function composeTree(runtime: "claude" | "codex"): { root: string; url: string } {
  const root = tmpDir(`tree-${runtime}`);
  const toolDir = path.join(root, "tools");
  fs.mkdirSync(toolDir);
  const sources = [TOOLS_DIR, ...(runtime === "codex" ? [path.join(TOOLS_DIR, "..", "runtime-overrides/codex/tools")] : [])];
  for (const source of sources) {
    for (const name of fs.readdirSync(source)) {
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) fs.copyFileSync(path.join(source, name), path.join(toolDir, name));
    }
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return { root, url: pathToFileURL(path.join(toolDir, "agent_dispatch_lib.ts")).href };
}

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

function readPids(file: string): number[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\s+/).filter((s) => s !== "").map(Number);
}

/**
 * `finally` cleanup, read from the FILE rather than from a variable the test
 * only fills on success: the child is detached into its own session, so when a
 * run goes red nothing else can reach it, and it would sit on a `sleep 30`.
 */
function reapPids(file: string): void {
  for (const p of readPids(file)) {
    if (!Number.isInteger(p) || p <= 1) continue;
    try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
  }
}

for (const runtime of ["claude", "codex"] as const) {
  describe(`run() process-tree bound [${runtime}]`, () => {
    let tree: { root: string; url: string };
    let runFn: RunFn;
    before(async () => {
      tree = composeTree(runtime);
      runFn = ((await import(tree.url)) as { run: RunFn }).run;
    });
    after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

    // Three descendants, each a different way to outlive a direct-child kill:
    // a backgrounded sleeper holding stdout, a foreground grandchild, and one
    // that IGNORES SIGTERM with its stdio closed — the leader dies on SIGTERM
    // and the pipes close, so only the settle-time group SIGKILL reaches it.
    test("a timed-out child takes every descendant with it", { timeout: 30_000 }, async () => {
      const dir = tmpDir("tree-kill");
      const pidFile = path.join(dir, "pids");
      const sh = `echo $$ > '${pidFile}'; sleep 30 & echo $! >> '${pidFile}'; ` +
        `(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! >> '${pidFile}'; ` +
        `echo up; sh -c 'echo $$ >> "$0"; exec sleep 30' '${pidFile}'`;
      try {
        const started = Date.now();
        const res = await runFn("sh", ["-c", sh], { timeoutSec: 1 });
        assert.equal(res.timedOut, true);
        assert.match(res.stdout, /up/);
        assert.ok(Date.now() - started < 25_000, "run() did not settle");
        const pids = readPids(pidFile);
        assert.equal(pids.length, 4, `expected 4 pids, got: ${pids}`);
        assert.ok(pids.every((p) => Number.isInteger(p) && p > 1), `bad pids: ${pids}`);
        assert.ok(await waitFor(() => !pids.some(isAlive)), `survived the timeout: ${pids.filter(isAlive)}`);
      } finally {
        reapPids(pidFile);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression: run() resolved only once child "close" fired, and "close"
    // needs every stdio pipe to end. The group kill now takes an ordinary
    // descendant down, so the one that can still hold stdout past the kill is
    // one that ESCAPED the group (`setsid`). run() does not claim to reach it —
    // it must still settle, and the test reaps it.
    test("a timed-out child whose ESCAPED descendant holds stdout still settles", { timeout: 30_000 }, async () => {
      const dir = tmpDir("escaped");
      const pidFile = path.join(dir, "pid");
      const sh = `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", $ARGV[0]); print F $$; close F; sleep 30' '${pidFile}' & ` +
        `echo up; sleep 30`;
      try {
        const started = Date.now();
        const res = await runFn("sh", ["-c", sh], { timeoutSec: 1 });
        const elapsed = Date.now() - started;
        assert.equal(res.timedOut, true);
        assert.match(res.stdout, /up/);
        assert.ok(elapsed < 25_000, `run() took ${elapsed}ms — the last-resort settle did not fire`);
        assert.ok(elapsed > 6_000, `settled in ${elapsed}ms — the escaped descendant never held stdout, so the last resort went untested`);
      } finally {
        reapPids(pidFile);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // A terminal's Ctrl-C goes to the FOREGROUND process group, which a detached
    // child has left — so the faithful simulation signals the tool's pid ALONE.
    // The grandchild runs in the FOREGROUND of its shell: a non-interactive
    // shell starts `&` jobs with SIGINT ignored. The signal waits for the ARMED
    // marker, not only the pids: the child writes its pids concurrently from
    // the fork, possibly before `trackGroup` ran, and a signal landing there
    // kills the tool by DEFAULT disposition — "died by the signal" would pass
    // vacuously while the child is orphaned (the race STARK-6135's review
    // found). The marker is written after `run()` has returned its promise —
    // the executor, `trackGroup` included, runs synchronously — and carries the
    // listener count, so armed + died-by-signal can only be a real re-raise.
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      test(`${sig} to the tool alone terminates an in-flight child and its descendants`, { timeout: 30_000 }, async () => {
        const dir = tmpDir(`fwd-${sig}`);
        const pidFile = path.join(dir, "pids");
        const armedFile = path.join(dir, "armed");
        const sh = `printf '%s ' $$ > '${pidFile}'; sh -c 'echo $$ >> "$0"; exec sleep 30' '${pidFile}'`;
        const driver = spawn(process.execPath, [
          "--no-warnings",
          "-e",
          `import(${JSON.stringify(tree.url)}).then((m) => { m.run("/bin/sh", ["-c", ${JSON.stringify(sh)}], { timeoutSec: 25 }); ` +
            `require("node:fs").writeFileSync(${JSON.stringify(armedFile)}, String(process.listenerCount(${JSON.stringify(sig)}))); })`,
        ], { stdio: "ignore" });
        const exited = new Promise<NodeJS.Signals | null>((res) => driver.once("exit", (_c, s) => res(s)));
        try {
          assert.ok(await waitFor(() => readPids(pidFile).length === 2 && fs.existsSync(armedFile), 15_000),
            "the child never reported its pids, or the tool never got past spawning it");
          const pids = readPids(pidFile);
          assert.ok(pids.every((p) => Number.isInteger(p) && p > 1), `bad pids: ${pids}`);
          assert.ok(pids.every(isAlive), "child/grandchild died before the signal — the test would pass vacuously");
          assert.equal(fs.readFileSync(armedFile, "utf8"), "1", `no ${sig} forwarding handler armed with a child in flight`);

          process.kill(driver.pid!, sig);

          assert.equal(await exited, sig, "the tool did not die by the forwarded signal");
          assert.ok(await waitFor(() => !pids.some(isAlive)), `${sig} did not reach the detached child: ${pids.filter(isAlive)} alive`);
        } finally {
          driver.kill("SIGKILL");
          reapPids(pidFile);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    // A SIGINT listener replaces Node's default exit, so one left behind after
    // the last child settles would make an idle tool ignore Ctrl-C. The
    // long-lived child is ended BY the test, never by a timeout racing it.
    test("forwarding handlers exist only while a child is in flight", { timeout: 30_000 }, async () => {
      const dir = tmpDir("fwd-life");
      const pidFile = path.join(dir, "pid");
      const base = process.listenerCount("SIGINT");
      try {
        const running = runFn("/bin/sh", ["-c", `echo $$ > '${pidFile}'; exec sleep 30`], { timeoutSec: 20 });
        assert.equal(process.listenerCount("SIGINT"), base + 1, "no forwarding handler while a child is live");
        await runFn(process.execPath, ["-e", ""], { timeoutSec: 20 });
        assert.equal(process.listenerCount("SIGINT"), base + 1, "the handler was dropped with a child still live");
        assert.ok(await waitFor(() => readPids(pidFile).length === 1), "the long-lived child never reported its pid");
        process.kill(readPids(pidFile)[0]!, "SIGKILL");
        assert.equal((await running).timedOut, false);
        assert.equal(process.listenerCount("SIGINT"), base, "the handler outlived the last child");

        const hung = await runFn("/bin/sh", ["-c", "exec sleep 30"], { timeoutSec: 1 });
        assert.equal(hung.timedOut, true);
        assert.equal(process.listenerCount("SIGINT"), base, "the kill ladder left a handler behind");

        const missing = await runFn(path.join(dir, "no-such-binary"), [], { timeoutSec: 5 });
        assert.equal(missing.notFound, true);
        assert.equal(process.listenerCount("SIGINT"), base, "a spawn failure left a handler behind");
      } finally {
        reapPids(pidFile);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
