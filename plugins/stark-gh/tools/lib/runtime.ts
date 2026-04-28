import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export function runtimeDir(): string {
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "runtime");
}

export function ensureRuntimeDir(): string {
  const dir = runtimeDir();
  try {
    return ensureDir(dir);
  } catch (err) {
    if (process.env.CODEX_SANDBOX && (err as NodeJS.ErrnoException).code === "EPERM") {
      return ensureDir(path.join(os.tmpdir(), "stark-gh", "runtime"));
    }
    throw err;
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: some filesystems may reject chmod.
  }
  return dir;
}

export function mktempInRuntime(template = "stark-gh-XXXXXX"): string {
  const dir = ensureRuntimeDir();
  const random = crypto.randomBytes(6).toString("hex");
  const name = template.replace(/X+/g, random);
  const p = path.join(dir, name);
  fs.writeFileSync(p, "", { mode: 0o600, flag: "wx" });
  return p;
}

// pr-merge runtime layout: runtime/, audit/, watchers/. ensureRuntimeDirs()
// creates all three idempotently with mode 0700. Call before any first write.
export function auditDir(): string {
  if (process.env.CODEX_SANDBOX) return path.join(os.tmpdir(), "stark-gh", "audit");
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "audit");
}

export function watchersDir(): string {
  if (process.env.CODEX_SANDBOX) return path.join(os.tmpdir(), "stark-gh", "watchers");
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "watchers");
}

export function releaseDir(): string {
  if (process.env.CODEX_SANDBOX) return path.join(os.tmpdir(), "stark-gh", "release");
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "release");
}

export function ensureRuntimeDirs(): { runtime: string; audit: string; watchers: string; release: string } {
  return {
    runtime: ensureRuntimeDir(),
    audit: ensureDir(auditDir()),
    watchers: ensureDir(watchersDir()),
    release: ensureDir(releaseDir()),
  };
}
