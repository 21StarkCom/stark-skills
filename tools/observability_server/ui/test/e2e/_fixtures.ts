/**
 * Playwright fixtures: spin up a fresh bootstrap code per test, open
 * the UI at the canonical bootstrap URL, AND drive a real
 * `observability_emit_harness.ts` run in the background so the tree
 * has live data + a deterministic `chunk_truncated` record before any
 * assertion runs (plan §1.5.3, Phase 5 Verification).
 *
 * The harness is invoked via `node --experimental-strip-types` (the
 * project standard); it prints `RUN_ID=<id>` as its first line and
 * fires a synthetic `chunk_truncated` event 5 s later via the
 * daemon's existing undecodable-base64 path. The fixture polls
 * `GET /api/runs/:id` until at least one sub-agent and one truncation
 * are visible, then yields. The harness child is SIGTERMed on
 * teardown.
 */
import { test as base, expect } from "@playwright/test";
import {
  ChildProcessByStdio,
  execFileSync,
  spawn,
} from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type HarnessProc = ChildProcessByStdio<null, Readable, Readable>;

interface FixtureCtx {
  bootstrapCode: string;
  harnessRunId: string;
  harnessSubagentId: string;
}

const HARNESS_REL = "../../../../observability_emit_harness.ts";
const HARNESS_DURATION_S = 60;
const HARNESS_TRUNCATE_AFTER_S = 5;
const READY_TIMEOUT_MS = 30_000;
const TEARDOWN_GRACE_MS = 2_000;

const fixtureState: { runId: string | null; subagentId: string | null } = {
  runId: null,
  subagentId: null,
};

export const test = base.extend<FixtureCtx>({
  bootstrapCode: async ({ baseURL }, use) => {
    const token = readBootstrapToken();
    const resp = await fetch(`${baseURL}/api/auth/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      throw new Error(`bootstrap failed: HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { code: string };
    await use(body.code);
  },

  harnessRunId: async ({ baseURL }, use) => {
    const harnessPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      HARNESS_REL,
    );
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        harnessPath,
        "--duration-s",
        String(HARNESS_DURATION_S),
        "--subagents",
        "1",
        "--print-run-id",
        "--truncate-after-s",
        String(HARNESS_TRUNCATE_AFTER_S),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    ) as HarnessProc;

    let resolvedRunId: string | null = null;
    const runIdPromise = new Promise<string>((resolve, reject) => {
      let acc = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        acc += chunk;
        let nl: number;
        while ((nl = acc.indexOf("\n")) !== -1) {
          const line = acc.slice(0, nl);
          acc = acc.slice(nl + 1);
          const m = /^RUN_ID=([0-9a-f-]+)$/.exec(line.trim());
          if (m && m[1] !== undefined) {
            resolvedRunId = m[1];
            resolve(m[1]);
          }
        }
      });
      child.on("exit", (code) => {
        if (resolvedRunId === null) {
          reject(new Error(`harness exited (${code}) before printing RUN_ID`));
        }
      });
      child.on("error", reject);
    });

    const runId = await Promise.race([
      runIdPromise,
      delay(READY_TIMEOUT_MS).then(() => {
        throw new Error("harness never printed RUN_ID within timeout");
      }),
    ]);

    const headers = readBearerHeaders();
    const apiUrl = `${baseURL}/api/runs/${runId}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let saId: string | null = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(apiUrl, { headers });
        if (r.ok) {
          const j = (await r.json()) as {
            subagents?: Array<{ subagent_id: string }>;
          };
          if (j.subagents && j.subagents.length > 0) {
            const cand = j.subagents[0]!.subagent_id;
            const truncR = await fetch(
              `${baseURL}/api/runs/${runId}/subagents/${cand}`,
              { headers },
            );
            if (truncR.ok) {
              const tj = (await truncR.json()) as {
                truncations?: Array<unknown>;
              };
              if (tj.truncations && tj.truncations.length > 0) {
                saId = cand;
                break;
              }
            }
          }
        }
      } catch {
        // server may not be ready; retry
      }
      await delay(500);
    }
    if (saId === null) {
      teardownHarness(child);
      throw new Error(
        `harness ${runId} did not produce a truncation within timeout`,
      );
    }
    fixtureState.runId = runId;
    fixtureState.subagentId = saId;

    try {
      await use(runId);
    } finally {
      teardownHarness(child);
    }
  },

  harnessSubagentId: async ({ harnessRunId }, use) => {
    if (
      fixtureState.subagentId === null ||
      fixtureState.runId !== harnessRunId
    ) {
      throw new Error("harnessRunId fixture did not populate subagent id");
    }
    await use(fixtureState.subagentId);
  },
});

function readBootstrapToken(): string {
  try {
    const out = execFileSync(
      "docker",
      ["exec", "stark-observability", "cat", "/data/bootstrap_token"],
      { encoding: "utf8" },
    );
    return out.trim();
  } catch (e) {
    throw new Error(
      `Unable to read /data/bootstrap_token from the container — ` +
        `is the stack up? ${(e as Error).message}`,
    );
  }
}

function readBearerHeaders(): Record<string, string> {
  // Readiness poll is server-side only (Node fetch in the test runner,
  // not the browser). The bootstrap token is accepted as a one-shot
  // Bearer here purely so the fixture can verify SQLite state before
  // letting Playwright drive the UI; the UI itself still goes through
  // the cookie exchange flow.
  return { Authorization: `Bearer ${readBootstrapToken()}` };
}

function teardownHarness(child: HarnessProc): void {
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, TEARDOWN_GRACE_MS);
  child.on("exit", () => clearTimeout(killTimer));
}

export { expect };
