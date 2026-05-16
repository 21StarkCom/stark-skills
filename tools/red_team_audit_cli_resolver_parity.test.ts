// Phase-0 resolver parity gate (TS half).
//
// The Python half lives at `scripts/test_red_team_audit_cli.py::test_resolver_parity_*`
// and exercises the same fixture matrix in-process. This TS half shells out
// to `scripts/red_team_audit_cli.py resolve-db` and asserts byte-equal
// `db_path` field across every documented input combination. Phase 1 ports
// inherit this matrix unchanged.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(path.join(path.dirname(import.meta.url.replace("file://", "")), ".."));
const CLI = path.join(ROOT, "scripts", "red_team_audit_cli.py");
const ENV_VAR = "STARK_RED_TEAM_DB";

interface ResolverEnvelope {
  db_path: string;
  source: "default" | "env" | "config" | "cli";
  expected_version: number;
}

function runResolveDb(opts: { cliDb?: string; env?: Record<string, string> }): ResolverEnvelope {
  const args = ["resolve-db"];
  if (opts.cliDb) {
    args.push("--db", opts.cliDb);
  }
  // Build the env: start from the host env so PATH / HOME survive, then
  // null out the override (so a host-set STARK_RED_TEAM_DB doesn't leak)
  // and apply per-fixture overrides.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env[ENV_VAR];
  Object.assign(env, opts.env ?? {});
  const proc = spawnSync("python3", [CLI, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(proc.status, 0, `resolve-db failed: ${proc.stderr}`);
  // Exactly one JSON envelope on stdout (the Phase-0 stdout discipline).
  return JSON.parse(proc.stdout) as ResolverEnvelope;
}

// ── Fixtures ──────────────────────────────────────────────────────────
//
// Mirror of the RESOLVER_FIXTURES table in scripts/test_red_team_audit_cli.py.
// Config-source parity is exercised in-process only on the Python side because
// the config path is host-global; the TS half covers default + env + cli +
// precedence between them, which is what crosses the language boundary.

interface ParityFixture {
  desc: string;
  cliDb?: string;
  env?: Record<string, string>;
  expectedSource: ResolverEnvelope["source"];
}

const PARITY_FIXTURES: ParityFixture[] = [
  { desc: "default", expectedSource: "default" },
  { desc: "cli_override", cliDb: "/tmp/fixture-cli.db", expectedSource: "cli" },
  {
    desc: "env_override",
    env: { [ENV_VAR]: "/tmp/fixture-env.db" },
    expectedSource: "env",
  },
  {
    desc: "cli_beats_env",
    cliDb: "/tmp/fixture-cli.db",
    env: { [ENV_VAR]: "/tmp/fixture-env.db" },
    expectedSource: "cli",
  },
];

// ── Tests ─────────────────────────────────────────────────────────────

for (const fixture of PARITY_FIXTURES) {
  test(`resolver parity (TS shell-out): ${fixture.desc}`, () => {
    const envelope = runResolveDb({ cliDb: fixture.cliDb, env: fixture.env });
    assert.equal(envelope.source, fixture.expectedSource);
    assert.equal(envelope.expected_version, 1);
    // db_path is always an absolute, canonicalized path.
    assert.equal(path.isAbsolute(envelope.db_path), true,
                 `expected absolute path, got: ${envelope.db_path}`);
    // Re-running with the same inputs must return byte-equal output.
    const again = runResolveDb({ cliDb: fixture.cliDb, env: fixture.env });
    assert.deepEqual(again, envelope, "resolver output must be deterministic");
  });
}

test("resolver parity (TS shell-out): stdout is exactly one JSON envelope", () => {
  const proc = spawnSync("python3", [CLI, "resolve-db"], {
    encoding: "utf8",
    env: { ...process.env, [ENV_VAR]: "/tmp/single.db" } as NodeJS.ProcessEnv,
  });
  assert.equal(proc.status, 0, proc.stderr);
  const trimmed = proc.stdout.trim();
  // No newlines inside the envelope; exactly one parse.
  const parsed = JSON.parse(trimmed);
  assert.equal(typeof parsed.db_path, "string");
  // Re-stringify with the same separators the CLI uses and confirm there's
  // no leading/trailing garbage.
  const restringified = JSON.stringify(parsed, Object.keys(parsed).sort());
  // The CLI uses sort_keys=True + no spaces, so the re-stringified form
  // (with sorted keys + no spaces) must equal the trimmed stdout.
  assert.equal(restringified, trimmed,
               "stdout must contain exactly one canonical JSON envelope");
});

test("resolver parity (TS shell-out): cli --db is canonicalized", () => {
  // Python's Path.resolve() follows symlinks (so /var/folders/... -> the
  // /private/var/folders/... realpath on macOS). The TS half mirrors that
  // by composing fs.realpathSync over the parent dir + appending the
  // basename. This is what every cross-language consumer of the resolver
  // contract has to do, so the test documents the recipe.
  const tmp = os.tmpdir();
  const rel = path.join(tmp, "..", path.basename(tmp), "x.db");
  const expected = path.join(fs.realpathSync(path.dirname(rel)), path.basename(rel));
  const envelope = runResolveDb({ cliDb: rel });
  assert.equal(envelope.source, "cli");
  assert.equal(envelope.db_path, expected);
});
