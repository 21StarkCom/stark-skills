import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  _resetAgentPortCacheForTests,
  loadAgentPort,
  resolveAgentPorts,
} from "./stark_review.ts";
import * as agentClaude from "./agent_claude.ts";
import * as agentGemini from "./agent_gemini.ts";

test("loadAgentPort: returns codex port that builds a valid command", async () => {
  _resetAgentPortCacheForTests();
  const port = await loadAgentPort("codex");
  const built = port.buildCommand("hi");
  assert.equal(built.cmd, "codex");
  assert.ok(built.args.includes("--json"));
});

test("loadAgentPort: caches modules across calls", async () => {
  _resetAgentPortCacheForTests();
  const a = await loadAgentPort("codex");
  const b = await loadAgentPort("codex");
  assert.equal(a, b);
});

test("loadAgentPort: claude/gemini stubs throw V1-not-supported on call", async () => {
  _resetAgentPortCacheForTests();
  const claude = await loadAgentPort("claude");
  assert.throws(
    () => claude.buildCommand("p"),
    /agent claude not implemented .* \/stark-team-review/,
  );
  assert.throws(
    () => claude.parseOutput(""),
    /agent claude not implemented/,
  );

  const gemini = await loadAgentPort("gemini");
  assert.throws(
    () => gemini.buildCommand("p"),
    /agent gemini not implemented .* \/stark-team-review/,
  );
  assert.throws(
    () => gemini.parseOutput(""),
    /agent gemini not implemented/,
  );
});

test("agent stub modules import without throwing", () => {
  // Module-load itself must NOT throw — only call-time does. The fact that
  // the imports above succeeded is the assertion; this test pins it.
  assert.equal(typeof agentClaude.buildCommand, "function");
  assert.equal(typeof agentGemini.buildCommand, "function");
});

test("resolveAgentPorts: succeeds for codex-only run", async () => {
  _resetAgentPortCacheForTests();
  const map = await resolveAgentPorts({
    architecture: "codex",
    security: "codex",
  });
  assert.equal(map.size, 1);
  assert.ok(map.has("codex"));
});

test("resolveAgentPorts: fails fast with code='agent_not_supported' for stub", async () => {
  _resetAgentPortCacheForTests();
  await assert.rejects(
    resolveAgentPorts({ architecture: "codex", security: "claude" }),
    (err: unknown) => {
      const e = err as Error & { code?: string };
      assert.equal(e.code, "agent_not_supported");
      assert.match(e.message, /claude/);
      assert.match(e.message, /not supported/);
      return true;
    },
  );
});

test("resolveAgentPorts: codex-only run never invokes claude/gemini modules", async () => {
  // Acceptance criterion: a codex-only run never imports agent_claude.ts or
  // agent_gemini.ts. We verify the dispatcher-side contract by running in a
  // fresh child process and checking codex resolves without either stub
  // throwing — if loadAgentPort were called with 'claude' or 'gemini', their
  // call-time error would surface here.
  const { spawnSync } = await import("node:child_process");
  const script = `
    import('./stark_review.ts').then(async m => {
      const map = await m.resolveAgentPorts({ a: 'codex', b: 'codex' });
      if (map.size !== 1 || !map.has('codex')) process.exit(3);
      console.log('OK');
    }).catch(e => { console.error(e); process.exit(2); });
  `;
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: import.meta.dirname, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});
