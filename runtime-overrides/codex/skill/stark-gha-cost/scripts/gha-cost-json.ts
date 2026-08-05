#!/usr/bin/env -S node --experimental-strip-types

/** Pure JSON summarizers used by the GHA cost shell probes. */

interface Job {
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
}

interface UsageItem {
  netAmount?: number | null;
  product?: string | null;
  sku?: string | null;
  repositoryName?: string | null;
}

export interface JobSummary {
  jobs: number;
  actualMinutes: number;
  roundedMinutes: number;
  linuxEquivalentMinutes: number;
  byRunner: Record<string, number>;
}

function runnerClass(labels: string[]): { name: string; multiplier: number } {
  const normalized = labels.map((v) => v.toLowerCase());
  if (normalized.some((v) => v === "self-hosted")) return { name: "self-hosted", multiplier: 0 };
  if (normalized.some((v) => v.includes("macos"))) return { name: "macos", multiplier: 10 };
  if (normalized.some((v) => v.includes("windows"))) return { name: "windows", multiplier: 2 };
  if (normalized.some((v) => v.includes("ubuntu") || v.includes("linux"))) {
    return { name: "linux", multiplier: 1 };
  }
  return { name: "unknown", multiplier: 1 };
}

export function summarizeJobs(input: unknown): JobSummary {
  const pages = Array.isArray(input) ? input : [input];
  const jobs: Job[] = pages.flatMap((page) => {
    if (!page || typeof page !== "object") return [];
    const value = (page as { jobs?: unknown }).jobs;
    return Array.isArray(value) ? (value as Job[]) : [];
  });
  const out: JobSummary = {
    jobs: jobs.length,
    actualMinutes: 0,
    roundedMinutes: 0,
    linuxEquivalentMinutes: 0,
    byRunner: {},
  };
  for (const job of jobs) {
    const started = Date.parse(String(job.started_at ?? ""));
    const completed = Date.parse(String(job.completed_at ?? ""));
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) continue;
    const minutes = (completed - started) / 60_000;
    const rounded = Math.ceil(minutes);
    const runner = runnerClass(job.labels ?? []);
    out.actualMinutes += minutes;
    out.roundedMinutes += rounded;
    out.linuxEquivalentMinutes += rounded * runner.multiplier;
    out.byRunner[runner.name] = (out.byRunner[runner.name] ?? 0) + 1;
  }
  return out;
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

export function renderBilling(input: unknown): string {
  const items =
    input && typeof input === "object" && Array.isArray((input as { usageItems?: unknown }).usageItems)
      ? ((input as { usageItems: UsageItem[] }).usageItems ?? [])
      : [];
  if (items.length === 0) return "  no usageItems (wrong scope/period, or nothing billed)";

  let total = 0;
  const byProduct = new Map<string, number>();
  const bySku = new Map<string, number>();
  const byRepo = new Map<string, number>();
  for (const item of items) {
    const net = Number(item.netAmount ?? 0) || 0;
    const product = item.product || "?";
    const sku = item.sku || "?";
    total += net;
    add(byProduct, product, net);
    add(bySku, `${product} / ${sku}`, net);
    if (product.toLowerCase() === "actions") add(byRepo, item.repositoryName || "(none)", net);
  }

  const ranked = (m: Map<string, number>, limit?: number) =>
    [...m.entries()].filter(([, v]) => Math.abs(v) > 0.005).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const lines = [`  TOTAL net $${total.toFixed(2)}  (${items.length} line items)`, "  -- by product --"];
  for (const [name, value] of ranked(byProduct)) lines.push(`    ${value.toFixed(2).padStart(9)}  ${name}`);
  lines.push("  -- top SKUs --");
  for (const [name, value] of ranked(bySku, 12)) lines.push(`    ${value.toFixed(2).padStart(9)}  ${name}`);
  lines.push("  -- Actions $ by repo (the cost driver lives here) --");
  for (const [name, value] of ranked(byRepo, 15)) lines.push(`    ${value.toFixed(2).padStart(9)}  ${name}`);
  return lines.join("\n");
}

async function readStdin(): Promise<unknown> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const input = await readStdin();
  if (mode === "jobs") {
    const s = summarizeJobs(input);
    const runnerBits = Object.entries(s.byRunner).sort().map(([k, v]) => `${k}=${v}`).join(",");
    process.stdout.write(
      `jobs=${s.jobs} actual_min=${s.actualMinutes.toFixed(1)} ` +
        `rounded_min=${s.roundedMinutes} linux_equiv_min=${s.linuxEquivalentMinutes} ` +
        `runners=${runnerBits || "none"}\n`,
    );
    return;
  }
  if (mode === "billing") {
    process.stdout.write(renderBilling(input) + "\n");
    return;
  }
  throw new Error("usage: gha-cost-json.ts jobs|billing");
}

if (process.argv[1]?.endsWith("gha-cost-json.ts")) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  });
}
