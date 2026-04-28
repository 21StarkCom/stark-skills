import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
