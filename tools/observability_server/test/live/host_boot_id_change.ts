#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 8 Task 6 — host_boot_id change simulator.
 *
 * Reads `hostinfo/host.json`, replaces `host_boot_id` with a fresh value,
 * atomically renames the file back into place, then polls the API for up
 * to 60 s waiting for the inflight run referenced by `live-run.json` to
 * transition to `crashed_reason: "host_boot_changed"`. Asserts the
 * `ended_at` value matches the ISO-8601 millisecond regex. Re-runs the
 * sweep a few more times to confirm idempotency.
 *
 * Wing round-3 fix: the launchd-managed hostinfo ticker
 * (`com.aryeh.observability.hostinfo`) rewrites `host.json` every 5 s on
 * a real install, so a one-shot edit is overwritten before the
 * container's natural 30 s sweeper observes it. Two mitigations,
 * applied together for redundancy:
 *
 *   1. Re-stamp `host_boot_id` to the same fresh value on every poll
 *      iteration. Whatever the ticker last wrote is replaced before the
 *      next sweep runs.
 *   2. After each re-stamp, POST
 *      `/internal/retention/sweep-now` against the retention listener
 *      (loopback, prune-token authed via `curl -K` semantics — TS
 *      builds the auth header in-process rather than passing through
 *      argv) so the modified snapshot is consumed deterministically
 *      inside the same loop iteration. The endpoint is the same one
 *      `dispatcher_and_daemon_sigkill.sh` uses for sweeper idempotency
 *      verification, so the host-boot-id test exercises the same code
 *      path as the SIGKILL test rather than racing the timer.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST_JSON =
  process.env.OBSERVABILITY_HOSTINFO_PATH ??
  path.join(os.homedir(), ".claude", "code-review", "observability", "hostinfo", "host.json");
const LIVE_RUN_JSON =
  process.env.LIVE_RUN_JSON ??
  path.join(os.homedir(), ".claude", "code-review", "observability", "test", "live-run.json");
const COOKIE_FILE =
  process.env.COOKIE_FILE ??
  path.join(os.homedir(), ".claude", "code-review", "observability", "session.cookie");
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:7700";
const RETENTION_BASE = process.env.RETENTION_BASE ?? "http://127.0.0.1:7701";
const KEYCHAIN_PRUNE_SERVICE =
  process.env.STARK_OBS_PRUNE_KEYCHAIN_SERVICE ?? "stark-observability-prune-token";
const ISO_MS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const POLL_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

interface HostJson {
  host_boot_id: string;
  /** Canonical freshness field — matches `tools/observability_hostinfo.ts`. */
  wall_clock?: string;
  [k: string]: unknown;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function readCookies(cookieFile: string): string {
  const raw = fs.readFileSync(cookieFile, "utf8");
  // Netscape cookie jar format → header line. Lines starting with "#"
  // are comments. Tab-separated fields; the value is column 7.
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const name = cols[5];
    const value = cols[6];
    if (name && value) parts.push(`${name}=${value}`);
  }
  return parts.join("; ");
}

/**
 * Read the prune-listener Bearer token straight from the macOS Keychain.
 * Mirrors the shell pattern `security find-generic-password -s
 * stark-observability-prune-token -w` used by
 * `dispatcher_and_daemon_sigkill.sh`. Returns `null` if the service is
 * absent (`security` exits non-zero) — caller falls back to
 * `OBSERVABILITY_PRUNE_TOKEN` env if set; otherwise sweep-now is skipped
 * and the test relies on rewriting until the natural sweeper observes
 * the boot-id change.
 */
function loadPruneToken(): string | null {
  if (process.env.OBSERVABILITY_PRUNE_TOKEN && process.env.OBSERVABILITY_PRUNE_TOKEN.length > 0) {
    return process.env.OBSERVABILITY_PRUNE_TOKEN;
  }
  const out = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_PRUNE_SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (out.status !== 0) return null;
  const tok = (out.stdout ?? "").trim();
  return tok.length > 0 ? tok : null;
}

function writeBootId(target: string, current: HostJson, newBootId: string): void {
  // Preserve every field the launchd ticker emits; only rewrite the boot
  // id + refresh `wall_clock` so the sweeper accepts the snapshot as
  // fresh. Writing `written_at` here would leave the sweeper's
  // `loadHostInfo` freshness check pointed at whatever stale `wall_clock`
  // the previous ticker tick wrote, and the snapshot would be ignored.
  const next: HostJson = {
    ...current,
    host_boot_id: newBootId,
    wall_clock: new Date().toISOString(),
  };
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

async function fetchRun(runId: string, cookie: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`, {
    headers: { cookie },
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

async function triggerSweepNow(token: string | null): Promise<void> {
  if (token === null) return;
  try {
    await fetch(`${RETENTION_BASE}/internal/retention/sweep-now`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // Sweep-now is best-effort; we'll retry on the next poll loop iteration.
  }
}

async function main(): Promise<void> {
  const live = readJson<{ run_id: string }>(LIVE_RUN_JSON);
  const cookie = readCookies(COOKIE_FILE);
  const host = readJson<HostJson>(HOST_JSON);
  const pruneToken = loadPruneToken();
  if (pruneToken === null) {
    process.stderr.write(
      `[task-6] WARN: ${KEYCHAIN_PRUNE_SERVICE} not in Keychain and OBSERVABILITY_PRUNE_TOKEN unset — sweep-now disabled; relying on natural sweeper + boot-id re-stamp loop.\n`,
    );
  }
  const newBootId = crypto.randomBytes(16).toString("hex");
  process.stdout.write(`[task-6] old host_boot_id=${host.host_boot_id} → new=${newBootId}\n`);

  // Initial write, then enter the re-stamp + sweep-now polling loop.
  writeBootId(HOST_JSON, host, newBootId);
  await triggerSweepNow(pruneToken);

  const deadline = Date.now() + POLL_DEADLINE_MS;
  let crashed: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    // Re-stamp BEFORE checking status — the launchd hostinfo ticker
    // runs every 5 s and would otherwise overwrite our edit with the
    // real boot_id before the sweeper observes the change.
    try {
      const latest = readJson<HostJson>(HOST_JSON);
      if (latest.host_boot_id !== newBootId) {
        writeBootId(HOST_JSON, latest, newBootId);
      }
    } catch {
      // host.json may briefly be missing during atomic rename — try again next tick
    }
    await triggerSweepNow(pruneToken);
    const resp = await fetchRun(live.run_id, cookie);
    if (resp !== null) {
      const run = (resp as { run?: { status?: string } }).run;
      if (run?.status === "crashed") {
        crashed = resp;
        break;
      }
    }
  }
  if (crashed === null) {
    process.stderr.write(`FAIL — run ${live.run_id} did not transition to crashed within 60 s\n`);
    process.exit(1);
  }
  const run = (crashed as { run: { ended_at: string; crashed_reason: string } }).run;
  if (run.crashed_reason !== "host_boot_changed") {
    process.stderr.write(
      `FAIL — crashed_reason='${run.crashed_reason}' expected 'host_boot_changed'\n`,
    );
    process.exit(1);
  }
  if (!ISO_MS_RE.test(run.ended_at)) {
    process.stderr.write(`FAIL — ended_at='${run.ended_at}' does not match ISO ms regex\n`);
    process.exit(1);
  }
  // Idempotency — sweeper must not re-write ended_at on subsequent ticks.
  const baselineEndedAt = run.ended_at;
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    await triggerSweepNow(pruneToken);
    const r = await fetchRun(live.run_id, cookie);
    const ea = (r as { run: { ended_at: string } } | null)?.run.ended_at;
    if (ea !== baselineEndedAt) {
      process.stderr.write(
        `FAIL — sweeper re-wrote ended_at on tick ${i + 1} (was=${baselineEndedAt} now=${ea})\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write(
    `PASS — run=${live.run_id} crashed_reason=host_boot_changed ended_at=${baselineEndedAt}\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const isEntry =
  import.meta.url ===
  (process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`host_boot_id_change: ${(err as Error).message}\n`);
    process.exit(2);
  });
}
