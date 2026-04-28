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
