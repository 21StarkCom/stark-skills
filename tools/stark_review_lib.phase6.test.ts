// Phase 6 — Task 6-1 additions to the stark_review_lib unit suite.
//
// The bulk of the lib contract (selectDomains modes, agent precedence,
// loadTrustedConfig precedence/safety, prompt resolution order, severity
// threshold ordering, findingId stability) is covered in
// stark_review_lib.phase2.test.ts. Phase 6 fills the remaining gaps:
//   - buildMarker format is the source of truth used for both POST body and
//     marker GET — pin it here so renames/format-drift fail loudly.
//   - --quick with empty quick_domains: assert the exact error message text.
//   - run-hash determinism + change-on-pr_head_sha-change + cost/runtime
//     exclusion (computeRunHash lives in stark_review.ts but its contract is
//     part of the lib surface).
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildMarker, selectDomains } from "./stark_review_lib.ts";
import { computeRunHash } from "./stark_review.ts";
import type { ResolvedConfig } from "./stark_review_lib.ts";

function bareConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    quick_domains: [],
    default_agent: "codex",
    domain_agents: {},
    severity_overrides: {},
    fix_threshold: "medium",
    runtime: {
      lock_ttl_minutes: 30,
      subagent_env_allowlist: [],
      max_concurrent_agents: 3,
      temp_dir_prefix: "stark-env",
      large_pr_file_threshold: 40,
      large_pr_line_threshold: 3000,
      large_pr_timeout_s: 1800,
    },
    test_command: null,
    untrusted_fix_loop: false,
    history_retention_days: 90,
    lock_ttl_minutes: 30,
    ...over,
  };
}

test("buildMarker format is the canonical source of truth for POST + GET", () => {
  const m = buildMarker(2, "codex", "abcdef0123456789");
  assert.equal(m, "<!-- stark-review:round=2:agent=codex:run=abcdef0123456789 -->");
  // Round 1 / claude / different hash differs only at the templated slots.
  const m2 = buildMarker(1, "claude", "h");
  assert.equal(m2, "<!-- stark-review:round=1:agent=claude:run=h -->");
});

test("selectDomains --quick with empty quick_domains: error message names the flag", () => {
  const cfg = bareConfig({ quick_domains: [] });
  assert.throws(
    () => selectDomains({ mode: "quick", config: cfg, promptRoot: "/nonexistent" }),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /quick/);
      assert.match(msg, /quick_domains/);
      return true;
    },
  );
});

test("computeRunHash: deterministic for fixed input", () => {
  const a = computeRunHash({
    pr_head_sha: "abc",
    domains: ["security", "architecture"],
    agents_resolved: { security: "codex", architecture: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  const b = computeRunHash({
    pr_head_sha: "abc",
    domains: ["security", "architecture"],
    agents_resolved: { security: "codex", architecture: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  assert.equal(a, b);
});

test("computeRunHash: changes when pr_head_sha changes", () => {
  const base = {
    domains: ["security"],
    agents_resolved: { security: "codex" as const },
    severity_overrides: {},
    fix_threshold: "medium" as const,
  };
  const a = computeRunHash({ pr_head_sha: "sha-A", ...base });
  const b = computeRunHash({ pr_head_sha: "sha-B", ...base });
  assert.notEqual(a, b);
});

test("computeRunHash: insensitive to domain order (sorted internally)", () => {
  const a = computeRunHash({
    pr_head_sha: "x",
    domains: ["security", "architecture", "behavior"],
    agents_resolved: { security: "codex", architecture: "codex", behavior: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  const b = computeRunHash({
    pr_head_sha: "x",
    domains: ["behavior", "architecture", "security"],
    agents_resolved: { architecture: "codex", behavior: "codex", security: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  assert.equal(a, b);
});

test("computeRunHash: changes when severity_overrides change", () => {
  const base = {
    pr_head_sha: "x",
    domains: ["security"],
    agents_resolved: { security: "codex" as const },
    fix_threshold: "medium" as const,
  };
  const a = computeRunHash({ ...base, severity_overrides: {} });
  const b = computeRunHash({ ...base, severity_overrides: { security: "critical" } });
  assert.notEqual(a, b);
});

test("computeRunHash: excludes cost/runtime/observability fields (negative test)", () => {
  // Acceptance: pass two inputs with DIFFERING extra cost/runtime/observability
  // values (cast through `unknown` so the static RunHashInput type doesn't
  // reject them), and assert the hashes are identical. This would fail if
  // computeRunHash ever started serializing extra fields into the digest.
  const base = {
    pr_head_sha: "abc",
    domains: ["security"],
    agents_resolved: { security: "codex" as const },
    severity_overrides: {},
    fix_threshold: "medium" as const,
  };
  const withCheapRuntime = {
    ...base,
    cost: { tokens: 1234, usd: 0.01 },
    runtime: { duration_ms: 100, max_concurrent_agents: 1 },
    observability: { trace_id: "trace-A", round_started_at: "2026-05-09T00:00:00Z" },
  };
  const withExpensiveRuntime = {
    ...base,
    cost: { tokens: 9_999_999, usd: 42.0 },
    runtime: { duration_ms: 9_000_000, max_concurrent_agents: 32 },
    observability: { trace_id: "trace-B", round_started_at: "2099-12-31T23:59:59Z" },
  };
  const a = computeRunHash(withCheapRuntime as unknown as Parameters<typeof computeRunHash>[0]);
  const b = computeRunHash(withExpensiveRuntime as unknown as Parameters<typeof computeRunHash>[0]);
  assert.equal(
    a, b,
    "computeRunHash must ignore cost/runtime/observability extras; hashes differ",
  );
  // Sanity: hashes still match the canonical (no-extras) baseline.
  assert.equal(a, computeRunHash(base));
});
