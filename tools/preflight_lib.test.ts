// Tests for `tools/preflight_lib.ts` — pure-logic only.
//
// Network-touching checks (`check_github_app`) and binary-dependent
// checks (`check_cli_*`, `check_keychain_*`, `check_working_dir`) are
// exercised by the live diff against the Python implementation, not
// here. This file covers:
//
//   - `aggregateOverall` — the critical-vs-non-critical fail/warn rules
//   - `runPreflight` — registry iteration + --skip-check override
//   - `checkCostHardStop` — file existence
//   - `checkStaleLocks` — picks up isLockStale results
//   - `checkDeprecatedConfig` — automation.model_pins detector
//   - `resolveOpenaiApiKey` — direct + file+label pair, missing both
//   - `renderTable` — output shape sanity

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateOverall,
  checkCostHardStop,
  checkDeprecatedConfig,
  checkStaleLocks,
  renderTable,
  resolveOpenaiApiKey,
  runPreflight,
  type CheckDefinition,
  type CheckStatus,
  type PreFlightResult,
} from "./preflight_lib.ts";

// ---------------------------------------------------------------------------
// withScratchHome — point HOME at a temp dir so on-disk side effects don't
// leak into the real `~/.claude/code-review/` between tests.
// ---------------------------------------------------------------------------

async function withScratchHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = scratch;
  try {
    return await fn(scratch);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// aggregateOverall
// ---------------------------------------------------------------------------

const FAKE_REGISTRY = [
  { name: "critical_a", critical: true },
  { name: "critical_b", critical: true },
  { name: "noncritical_a", critical: false },
  { name: "noncritical_b", critical: false },
];

test("aggregateOverall: all pass → ready / full", () => {
  const result = aggregateOverall(
    [
      { name: "critical_a", status: "pass" },
      { name: "critical_b", status: "pass" },
      { name: "noncritical_a", status: "pass" },
      { name: "noncritical_b", status: "pass" },
    ],
    FAKE_REGISTRY,
  );
  assert.deepEqual(result, { overall: "ready", recommendedMode: "full" });
});

test("aggregateOverall: noncritical fail → degraded / single-agent", () => {
  const result = aggregateOverall(
    [
      { name: "critical_a", status: "pass" },
      { name: "noncritical_a", status: "fail" },
    ],
    FAKE_REGISTRY,
  );
  assert.deepEqual(result, {
    overall: "degraded",
    recommendedMode: "single-agent",
  });
});

test("aggregateOverall: any warn → degraded", () => {
  const result = aggregateOverall(
    [
      { name: "critical_a", status: "pass" },
      { name: "noncritical_a", status: "warn" },
    ],
    FAKE_REGISTRY,
  );
  assert.equal(result.overall, "degraded");
  assert.equal(result.recommendedMode, "single-agent");
});

test("aggregateOverall: critical fail trumps any warn → blocked / abort", () => {
  const result = aggregateOverall(
    [
      { name: "critical_a", status: "fail" },
      { name: "noncritical_a", status: "warn" },
    ],
    FAKE_REGISTRY,
  );
  assert.deepEqual(result, { overall: "blocked", recommendedMode: "abort" });
});

test("aggregateOverall: skip status doesn't degrade", () => {
  const result = aggregateOverall(
    [
      { name: "critical_a", status: "pass" },
      { name: "noncritical_a", status: "skip" },
    ],
    FAKE_REGISTRY,
  );
  assert.equal(result.overall, "ready");
});

test("aggregateOverall: unknown name treated as non-critical (defensive)", () => {
  const result = aggregateOverall(
    [
      { name: "unknown_check", status: "fail" }, // not in registry
    ],
    FAKE_REGISTRY,
  );
  // Not in critical set → escalates to degraded, not blocked.
  assert.equal(result.overall, "degraded");
});

// ---------------------------------------------------------------------------
// runPreflight — registry iteration + skip
// ---------------------------------------------------------------------------

function fakeCheck(
  name: string,
  status: CheckStatus,
  message: string = "ok",
): CheckDefinition {
  return { name, fn: () => [status, message], critical: false };
}

test("runPreflight: iterates registry in order, records each result", async () => {
  await withScratchHome(async () => {
    const result = await runPreflight({
      workflow: "test",
      registry: [
        fakeCheck("a", "pass", "msg_a"),
        fakeCheck("b", "warn", "msg_b"),
        fakeCheck("c", "pass", "msg_c"),
      ],
    });
    assert.equal(result.workflow, "test");
    assert.equal(result.checks.length, 3);
    assert.deepEqual(
      result.checks.map((c) => [c.name, c.status, c.message]),
      [
        ["a", "pass", "msg_a"],
        ["b", "warn", "msg_b"],
        ["c", "pass", "msg_c"],
      ],
    );
    assert.equal(result.overall, "degraded");
    assert.equal(result.recommended_mode, "single-agent");
  });
});

test("runPreflight: --skip-check produces a skip result with the override message", async () => {
  await withScratchHome(async () => {
    const result = await runPreflight({
      workflow: "test",
      skip: new Set(["b"]),
      registry: [
        fakeCheck("a", "pass"),
        fakeCheck("b", "fail", "should-not-run"),
        fakeCheck("c", "pass"),
      ],
    });
    const b = result.checks.find((c) => c.name === "b")!;
    assert.equal(b.status, "skip");
    assert.equal(b.message, "skipped via --skip-check");
    assert.equal(b.duration_s, 0);
    // The skipped fail didn't escalate.
    assert.equal(result.overall, "ready");
  });
});

test("runPreflight: async check functions are awaited", async () => {
  await withScratchHome(async () => {
    const result = await runPreflight({
      workflow: "test",
      registry: [
        {
          name: "async_check",
          critical: false,
          fn: async () =>
            new Promise<[CheckStatus, string]>((res) =>
              setImmediate(() => res(["pass", "from async"])),
            ),
        },
      ],
    });
    assert.equal(result.checks[0]!.status, "pass");
    assert.equal(result.checks[0]!.message, "from async");
  });
});

test("runPreflight: critical check fail → overall=blocked, exit-1 territory", async () => {
  await withScratchHome(async () => {
    const result = await runPreflight({
      workflow: "test",
      registry: [
        { name: "crit", critical: true, fn: () => ["fail", "boom"] },
        { name: "noncrit", critical: false, fn: () => ["pass", "ok"] },
      ],
    });
    assert.equal(result.overall, "blocked");
    assert.equal(result.recommended_mode, "abort");
  });
});

// ---------------------------------------------------------------------------
// checkCostHardStop
// ---------------------------------------------------------------------------

test("checkCostHardStop: returns pass when sentinel file is absent", async () => {
  await withScratchHome(() => {
    const [status, msg] = checkCostHardStop();
    assert.equal(status, "pass");
    assert.equal(msg, "no hard stop");
  });
});

test("checkCostHardStop: returns fail when sentinel file exists", async () => {
  await withScratchHome((home) => {
    const file = path.join(home, ".claude", "code-review", "cost-hard-stop");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    const [status, msg] = checkCostHardStop();
    assert.equal(status, "fail");
    assert.match(msg, /cost hard-stop active/);
  });
});

// ---------------------------------------------------------------------------
// checkStaleLocks
// ---------------------------------------------------------------------------

test("checkStaleLocks: returns pass when no .lock files exist", async () => {
  await withScratchHome((home) => {
    fs.mkdirSync(path.join(home, ".claude", "code-review"), { recursive: true });
    const [status, msg] = checkStaleLocks();
    assert.equal(status, "pass");
    assert.equal(msg, "no stale locks");
  });
});

test("checkStaleLocks: malformed lock contents are detected as stale", async () => {
  await withScratchHome((home) => {
    const dir = path.join(home, ".claude", "code-review");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.lock"), "not-json{");
    const [status, msg] = checkStaleLocks();
    assert.equal(status, "warn");
    assert.match(msg, /stale lock files/);
    assert.match(msg, /stale\.lock/);
  });
});

// ---------------------------------------------------------------------------
// checkDeprecatedConfig
// ---------------------------------------------------------------------------

test("checkDeprecatedConfig: returns pass when no automation block exists", async () => {
  await withScratchHome((home) => {
    fs.mkdirSync(path.join(home, ".claude", "code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "code-review", "config.json"),
      JSON.stringify({}),
    );
    const [status] = checkDeprecatedConfig();
    assert.equal(status, "pass");
  });
});

test("checkDeprecatedConfig: warns when automation.model_pins is present", async () => {
  await withScratchHome((home) => {
    fs.mkdirSync(path.join(home, ".claude", "code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "code-review", "config.json"),
      JSON.stringify({ automation: { model_pins: { foo: "bar" } } }),
    );
    const [status, msg] = checkDeprecatedConfig();
    assert.equal(status, "warn");
    assert.match(msg, /model_pins/);
  });
});

// ---------------------------------------------------------------------------
// resolveOpenaiApiKey
// ---------------------------------------------------------------------------

test("resolveOpenaiApiKey: returns null when neither direct nor file+label is set", () => {
  assert.equal(resolveOpenaiApiKey({}), null);
});

test("resolveOpenaiApiKey: returns OPENAI_API_KEY directly when present", () => {
  assert.equal(
    resolveOpenaiApiKey({ OPENAI_API_KEY: "sk-direct" }),
    "sk-direct",
  );
});

test("resolveOpenaiApiKey: file+label parses simple `key=value` lines", async () => {
  await withScratchHome((home) => {
    const file = path.join(home, "creds");
    fs.writeFileSync(
      file,
      `# comment line\n  alpha = sk-aaa  \nbeta=sk-bbb\n=ignored\nlabel=sk-target\n`,
    );
    assert.equal(
      resolveOpenaiApiKey({
        OPENAI_API_KEY_FILE: file,
        OPENAI_API_KEY_LABEL: "label",
      }),
      "sk-target",
    );
    assert.equal(
      resolveOpenaiApiKey({
        OPENAI_API_KEY_FILE: file,
        OPENAI_API_KEY_LABEL: "beta",
      }),
      "sk-bbb",
    );
  });
});

test("resolveOpenaiApiKey: missing file returns null without throwing", () => {
  assert.equal(
    resolveOpenaiApiKey({
      OPENAI_API_KEY_FILE: "/nonexistent/path",
      OPENAI_API_KEY_LABEL: "x",
    }),
    null,
  );
});

test("resolveOpenaiApiKey: file present but label absent returns null", async () => {
  await withScratchHome((home) => {
    const file = path.join(home, "creds");
    fs.writeFileSync(file, "alpha=value\n");
    assert.equal(
      resolveOpenaiApiKey({
        OPENAI_API_KEY_FILE: file,
        OPENAI_API_KEY_LABEL: "missing-label",
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// renderTable — output shape sanity
// ---------------------------------------------------------------------------

test("renderTable: includes workflow, overall label, every check, and recommended mode", () => {
  const result: PreFlightResult = {
    workflow: "stark-review",
    overall: "degraded",
    recommended_mode: "single-agent",
    timestamp: "2026-05-18T19:00:00Z",
    checks: [
      { name: "check_a", status: "pass", message: "ok", duration_s: 0.012 },
      { name: "check_b", status: "warn", message: "uh oh", duration_s: 0.05 },
    ],
  };
  const out = renderTable(result);
  assert.match(out, /Preflight: stark-review {2}\[DEGRADED\]/);
  assert.match(out, /check_a/);
  assert.match(out, /check_b/);
  assert.match(out, /Recommended mode: single-agent/);
  // Duration formatting: 3 decimals, parentheses.
  assert.match(out, /\(0\.012s\)/);
  assert.match(out, /\(0\.050s\)/);
});
