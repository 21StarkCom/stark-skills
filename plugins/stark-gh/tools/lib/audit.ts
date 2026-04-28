import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { auditDir as runtimeAuditDir, ensureRuntimeDirs } from "./runtime.ts";

// Append-only audit log for secret-override usage. Spec: every use of
// --allow-secret-commit or --allow-secret-to-llm appends one record so the
// override is durable beyond the transient plan-file (which is unlinked on
// success). One JSON record per line.

export interface SecretOverrideAuditEntry {
  timestamp: string;
  stage: "preflight" | "post-stage";
  allowSecretCommit: boolean;
  allowSecretToLlm: boolean;
  branch: string;
  repoNameWithOwner: string;
  hits: { category: string; location?: string }[];
}

function auditDir(): string {
  if (process.env.CODEX_SANDBOX) return path.join(os.tmpdir(), "stark-gh", "audit");
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "audit");
}

export function auditPath(): string {
  return path.join(auditDir(), "secrets-allowed.jsonl");
}

export function appendSecretOverride(entry: SecretOverrideAuditEntry): void {
  const dir = auditDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = auditPath();
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(fp, 0o600);
  } catch {
    // best-effort
  }
}

// pr-merge override audit. Distinct from pr-open's secret-override audit:
// this records every override-flag invocation per /stark-gh:pr-merge run
// (--force, --allow-secret-commit, --allow-secret-to-llm) regardless of
// whether the override actually bypassed a gate. runId is generated before
// any auditable gate so the line is logged once per run.

export interface PrMergeOverrideEntry {
  timestamp: string;
  runId: string;
  pr: number;
  flag: "--force" | "--allow-secret-commit" | "--allow-secret-to-llm";
  user: string;
  hostname: string;
  reason: string;          // required for --force; freeform but non-empty
}

export function prMergeAuditPath(): string {
  return path.join(runtimeAuditDir(), "pr-merge.log");
}

export function appendPrMergeOverride(entry: PrMergeOverrideEntry): void {
  if (entry.flag === "--force" && (!entry.reason || entry.reason.trim() === "")) {
    throw new Error("appendPrMergeOverride: --force requires a non-empty reason");
  }
  ensureRuntimeDirs();
  const fp = prMergeAuditPath();
  // Rotate if file > 10 MiB (gzip optional; v1 does plain rename, future
  // /stark-gh:housekeeping can compress).
  try {
    const st = fs.statSync(fp);
    if (st.size > 10 * 1024 * 1024) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(fp, `${fp}.${stamp}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(fp, 0o600);
  } catch {
    // best-effort
  }
}

// Print stderr warning when --allow-secret-to-llm is used. Centralized so the
// exact wording is testable.
export const SECRET_TO_LLM_WARNING =
  "WARNING: secret material is being sent to an external LLM provider; review provider data-handling policies";
