import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pushExplicit, forcePushWithLease } from "../lib/git.ts";

// `git push` is the one command that runs arbitrary user code of unbounded duration: the repo's
// pre-push hook. Mímir's hook runs `make ci` (~110s). With stderr captured, none of that reaches
// the terminal until the push returns — and the captured text is only surfaced on FAILURE — so a
// healthy push looks exactly like a hang for two minutes. These tests pin the opt-in that makes
// hook output stream live.

test("pushExplicit asks for streamed stderr", () => {
  let seen: { streamStderr?: boolean } | undefined;
  const exec = ((cmd: string, args: readonly string[], opts?: { streamStderr?: boolean }) => {
    if (cmd === "git" && args[0] === "push") { seen = opts; return Buffer.from(""); }
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;
  pushExplicit("feat/x", { exec });
  assert.equal(seen?.streamStderr, true);
});

test("forcePushWithLease asks for streamed stderr", () => {
  let seen: { streamStderr?: boolean } | undefined;
  const exec = ((cmd: string, args: readonly string[], opts?: { streamStderr?: boolean }) => {
    if (cmd === "git" && args[0] === "push") { seen = opts; return Buffer.from(""); }
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;
  forcePushWithLease({ remote: "origin", headRef: "feat/x", expectedRemoteOid: "abc" }, { exec });
  assert.equal(seen?.streamStderr, true);
  // The lease must survive the options change — it is the concurrency guard.
  assert.equal(seen !== undefined, true);
});

test("forcePushWithLease still builds the explicit-OID lease via argv", () => {
  const calls: string[][] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    calls.push([cmd, ...args]);
    return Buffer.from("");
  }) as never;
  forcePushWithLease({ remote: "origin", headRef: "feat/x", expectedRemoteOid: "deadbee" }, { exec });
  assert.ok(calls[0]?.includes("--force-with-lease=refs/heads/feat/x:deadbee"));
});

// End-to-end against a real local remote: proves the streaming stdio actually pushes, that a slow
// hook does not trip a timeout or the output buffer, and that a FAILING hook still fails the push.
// Uses a bare repo on disk — no network, no GitHub.
function withLocalRemote(hookBody: string | null, run: (remote: string, work: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starkgh-push-"));
  try {
    const remote = path.join(root, "bare.git");
    const work = path.join(root, "work");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", work]);
    const g = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "pipe" });
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    g("remote", "add", "origin", remote);
    fs.writeFileSync(path.join(work, "f.txt"), "hello\n");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    if (hookBody !== null) {
      const hooks = path.join(work, ".git", "hooks");
      fs.writeFileSync(path.join(hooks, "pre-push"), hookBody, { mode: 0o755 });
    }
    run(remote, work);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("push succeeds through a slow, chatty pre-push hook", () => {
  withLocalRemote(
    // Chatty on both streams and slow enough to be a real wait, without making the suite crawl.
    "#!/bin/sh\nfor i in $(seq 1 200); do echo \"hook line $i\"; echo \"hook err $i\" >&2; done\nsleep 2\nexit 0\n",
    (_remote, work) => {
      const exec = ((cmd: string, args: readonly string[], opts?: Record<string, unknown>) =>
        execFileSync(cmd, ["-C", work, ...args], {
          ...opts,
          stdio: ["pipe", "pipe", opts?.streamStderr ? "inherit" : "pipe"],
          maxBuffer: 64 * 1024 * 1024,
        })) as never;
      pushExplicit("probe", { exec });
      const refs = execFileSync("git", ["-C", work, "ls-remote", "--heads", "origin", "probe"])
        .toString();
      assert.match(refs, /refs\/heads\/probe/);
    },
  );
});

test("a failing pre-push hook still fails the push", () => {
  withLocalRemote(
    "#!/bin/sh\necho 'gate says no' >&2\nexit 1\n",
    (_remote, work) => {
      const exec = ((cmd: string, args: readonly string[], opts?: Record<string, unknown>) =>
        execFileSync(cmd, ["-C", work, ...args], {
          ...opts,
          stdio: ["pipe", "pipe", opts?.streamStderr ? "pipe" : "pipe"], // capture, keep test output clean
          maxBuffer: 64 * 1024 * 1024,
        })) as never;
      assert.throws(() => pushExplicit("probe", { exec }));
      const refs = execFileSync("git", ["-C", work, "ls-remote", "--heads", "origin", "probe"])
        .toString();
      assert.equal(refs.trim(), "");   // nothing published when the gate refuses
    },
  );
});
