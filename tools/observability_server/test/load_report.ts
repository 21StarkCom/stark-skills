#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 8 Task 1 — load report renderer.
 *
 * Reads the JSON produced by `load.ts` and writes a human-readable
 * table to stdout. Reusable as a library (`renderReport`) so the
 * harness can print inline without re-reading the file.
 */

import fs from "node:fs";
import path from "node:path";

export interface ReportShape {
  spec: {
    subagents: number;
    duration_s: number;
    emit_rate_bps: number;
    ws_subscribers: number;
    rotation_bytes: number;
  };
  run_id: string;
  duration_ms: number;
  ws_events_received_per_subscriber: number[];
  chunks_emitted_by_writer: number;
  chunks_indexed: number;
  rotations_observed: number;
  ssfb_samples: number;
  uds_probes: number;
  history_query_count: number;
  memory_growth_bytes_per_hour: number;
  percentiles: {
    ws_e2e_ms_p50: number | null;
    ws_e2e_ms_p95: number | null;
    ssfb_ms_p50: number | null;
    ssfb_ms_p95: number | null;
    uds_rtt_ms_p50: number | null;
    uds_rtt_ms_p95: number | null;
    commit_ms_p50: number | null;
    commit_ms_p95: number | null;
  };
  assertions: Array<{
    name: string;
    target: string;
    observed: string;
    ok: boolean;
  }>;
  status: "pass" | "fail";
}

export function renderReport(r: ReportShape): string {
  const lines: string[] = [];
  lines.push(`=== Phase 8 Load Report ===`);
  lines.push(`run_id:           ${r.run_id}`);
  lines.push(
    `spec:             ${r.spec.subagents} subagents × ${r.spec.duration_s}s @ ${r.spec.emit_rate_bps} bps, ws=${r.spec.ws_subscribers}, rot=${r.spec.rotation_bytes}B`,
  );
  lines.push(``);
  lines.push(`-- counters --`);
  lines.push(`ws events / subscriber:  ${r.ws_events_received_per_subscriber.join(", ")}`);
  lines.push(`chunks indexed:          ${r.chunks_indexed}`);
  lines.push(`rotations observed:      ${r.rotations_observed}`);
  lines.push(`ssfb samples:            ${r.ssfb_samples}`);
  lines.push(`uds probes:              ${r.uds_probes}`);
  lines.push(`history queries:         ${r.history_query_count}`);
  lines.push(`memory growth:           ${fmtMbPerH(r.memory_growth_bytes_per_hour)}`);
  lines.push(``);
  lines.push(`-- percentiles --`);
  lines.push(`ws end-to-end:  p50=${fmtMs(r.percentiles.ws_e2e_ms_p50)}  p95=${fmtMs(r.percentiles.ws_e2e_ms_p95)}`);
  lines.push(`sse first byte: p50=${fmtMs(r.percentiles.ssfb_ms_p50)}  p95=${fmtMs(r.percentiles.ssfb_ms_p95)}`);
  lines.push(`uds rtt:        p50=${fmtMs(r.percentiles.uds_rtt_ms_p50)}  p95=${fmtMs(r.percentiles.uds_rtt_ms_p95)}`);
  lines.push(`sqlite commit:  p50=${fmtMs(r.percentiles.commit_ms_p50)}  p95=${fmtMs(r.percentiles.commit_ms_p95)}`);
  lines.push(``);
  lines.push(`-- assertions --`);
  for (const a of r.assertions) {
    const mark = a.ok ? "PASS" : "FAIL";
    lines.push(`  [${mark}] ${a.name.padEnd(40)} target=${a.target.padEnd(12)} observed=${a.observed}`);
  }
  lines.push(``);
  lines.push(`status: ${r.status.toUpperCase()}`);
  return lines.join("\n");
}

function fmtMs(v: number | null): string {
  if (v === null) return "  n/a";
  return `${v.toFixed(2).padStart(7)} ms`;
}

function fmtMbPerH(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB/h`;
}

function main(): void {
  const args = process.argv.slice(2);
  const reportPath = args[0] ?? path.join(import.meta.dirname, "load-report.json");
  if (!fs.existsSync(reportPath)) {
    process.stderr.write(`load_report: ${reportPath} not found\n`);
    process.exit(2);
  }
  const r = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ReportShape;
  process.stdout.write(renderReport(r) + "\n");
  process.exit(r.status === "pass" ? 0 : 1);
}

const isEntry =
  import.meta.url ===
  (process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : "");
if (isEntry) main();
