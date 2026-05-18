// Smoke tests for the stark_session CLI module. We exercise the `main`
// entry function directly with stubbed argv to avoid spawning a child node
// process and to keep stdout capture cheap. Actual collector behavior is
// covered by stark_session_lib.test.ts.

import { strict as assert } from "node:assert";
import test from "node:test";

import { main } from "./stark_session.ts";

function captureStdout(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as any) = (chunk: any) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = orig as any;
      return buf;
    },
  };
}

function captureStderr(): { restore: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr.write as any) = (chunk: any) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  return {
    restore: () => {
      process.stderr.write = orig as any;
      return buf;
    },
  };
}

test("main: prints usage with exit 0 on --help", async () => {
  const cap = captureStdout();
  const code = await main(["--help"]);
  const out = cap.restore();
  assert.equal(code, 0);
  assert.match(out, /stark-session CLI/);
});

test("main: exits 1 with usage when no subcommand given", async () => {
  const cap = captureStdout();
  const code = await main([]);
  cap.restore();
  assert.equal(code, 1);
});

test("main: exits 1 on unknown subcommand", async () => {
  const out = captureStdout();
  const err = captureStderr();
  const code = await main(["fnord"]);
  out.restore();
  const errMsg = err.restore();
  assert.equal(code, 1);
  assert.match(errMsg, /unknown subcommand/);
});
