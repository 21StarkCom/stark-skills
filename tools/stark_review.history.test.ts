// Phase 6 — Task 6-3: Python ↔ TS history-file parity.
//
// The TS writer (`writeRoundHistory`) MUST produce output field-for-field
// equal to what Python's `multi_review.save_round_history()` emits, so the
// two pipelines can write to the same `round-N.json` location without
// confusing downstream consumers.
//
// We hold a sanitized snapshot at tools/fixtures/history/python-round-1.json
// representing the shared envelope contract. This test reconstructs an
// equivalent `RoundHistoryInput`, calls the TS writer, and deep-equals the
// reread bytes — except `timestamp`, which is excluded from equality but
// MUST still be present and ISO-parseable.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  HISTORY_SCHEMA_VERSION,
  writeRoundHistory,
  type RoundHistoryInput,
} from "./stark_review.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "history", "python-round-1.json");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("history parity: TS writer matches sanitized Python fixture (envelope)", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.equal(
    fixture.schema_version,
    HISTORY_SCHEMA_VERSION,
    `fixture schema_version (${fixture.schema_version}) must equal TS HISTORY_SCHEMA_VERSION (${HISTORY_SCHEMA_VERSION}) — refresh one or the other deliberately`,
  );

  const home = tmpDir("hist-parity-");
  // Reconstruct the input the dispatcher would pass for the same round.
  const input: RoundHistoryInput = {
    home,
    repo: fixture.repo,
    pr: fixture.pr,
    round: fixture.round,
    mode: fixture.mode,
    domain_agents: fixture.domain_agents,
    results: fixture.results.map((r: {
      agent: "claude" | "codex" | "gemini";
      model: string | null;
      domain: string;
      duration_s: number;
      error: string | null;
      api_key_fallback: boolean;
      findings: unknown[];
    }) => ({
      agent: r.agent,
      model: r.model,
      domain: r.domain,
      duration_s: r.duration_s,
      error: r.error,
      api_key_fallback: r.api_key_fallback,
      findings: r.findings.map((f) => ({ ...(f as Record<string, unknown>) })) as RoundHistoryInput["results"][number]["findings"],
    })),
  };

  const filePath = writeRoundHistory(input);
  const got = JSON.parse(fs.readFileSync(filePath, "utf8"));

  // Timestamp: present + ISO-parseable, but value is excluded from equality.
  assert.equal(typeof got.timestamp, "string", "timestamp must be present");
  const ts = Date.parse(got.timestamp);
  assert.ok(Number.isFinite(ts), `timestamp must be ISO-parseable (got ${got.timestamp})`);

  // Strip timestamps from both sides, then deep-equal everything else.
  const strip = (o: Record<string, unknown>): Record<string, unknown> => {
    const { timestamp: _t, ...rest } = o;
    return rest;
  };
  assert.deepStrictEqual(
    strip(got),
    strip(fixture),
    "TS history envelope drifted from sanitized Python fixture — see tools/fixtures/history/README.md",
  );
});
