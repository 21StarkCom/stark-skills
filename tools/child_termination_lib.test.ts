// `explainTermination` is where the ordering and the size cap live. Both are
// invisible to the spawn-backed tests in `findings_review_post.test.ts` and
// `review_post_lib.test.ts` — a chatty child only reveals them past the caller's
// 400-char slice — so pin them directly, with no subprocess.

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";

import { explainTermination, TERMINATION_STDERR_TAIL } from "./child_termination_lib.ts";

describe("explainTermination", () => {
  test("a child that exited normally keeps its stderr verbatim", () => {
    assert.equal(explainTermination("gh", { status: 1 }, "gh: not found\n", 1024), "gh: not found\n");
  });

  // fetchPrContext reports `${stderr.slice(0, 400)}`. A cause appended after a
  // talkative child's stderr is truncated away — the original defect, relocated.
  test("the cause survives the caller's 400-char slice", () => {
    const noisy = "gh: rate limit warning. ".repeat(100);
    const msg = explainTermination(
      "gh",
      { status: null, signal: "SIGTERM", error: Object.assign(new Error("x"), { code: "ENOBUFS" }) },
      noisy,
      4242,
    );
    assert.match(msg.slice(0, 400), /exceeded maxBuffer \(4242 bytes\)/, `cause lost in slice: ${msg.slice(0, 400)}`);
  });

  // An ENOBUFS on the *stderr* stream would otherwise build a fresh maxBuffer
  // sized string that the caller discards one line later.
  test("the child's stderr is capped, not carried at maxBuffer size", () => {
    const huge = "e".repeat(TERMINATION_STDERR_TAIL * 4);
    const msg = explainTermination("gh", { status: null, signal: "SIGKILL" }, huge, 1024);
    assert.ok(msg.length < TERMINATION_STDERR_TAIL + 200, `uncapped stderr: ${msg.length} chars`);
    assert.match(msg, /killed by signal SIGKILL/);
  });

  test("a spawn failure with no stderr still names the error", () => {
    const msg = explainTermination(
      "gh",
      { status: null, signal: null, error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }) },
      "",
      1024,
    );
    assert.match(msg, /produced no stderr and was terminated: spawnSync gh ENOENT/);
  });

  // review_post_lib's async `spawn` has no maxBuffer to report (STARK-6112).
  test("a caller with no buffer cap omits maxBuffer and gets no 'undefined bytes'", () => {
    const msg = explainTermination("gh", { status: null, signal: "SIGTERM" }, "");
    assert.equal(msg, "gh produced no stderr and was terminated: killed by signal SIGTERM");
    assert.doesNotMatch(
      explainTermination("gh", { status: null, error: Object.assign(new Error("x"), { code: "ENOBUFS" }) }, ""),
      /undefined/,
    );
  });
});
