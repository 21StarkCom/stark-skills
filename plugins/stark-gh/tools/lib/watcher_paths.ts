import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export function watcherDir(): string {
  if (process.env.CODEX_SANDBOX) {
    return path.join(os.tmpdir(), "stark-gh", "watchers");
  }
  return path.join(os.homedir(), ".claude", "code-review", "stark-gh", "watchers");
}

export function prDir(host: string, owner: string, repo: string, pr: number): string {
  return path.join(watcherDir(), host, owner, repo, `pr-${pr}`);
}

export function stateFile(host: string, owner: string, repo: string, pr: number, headSha: string): string {
  return path.join(prDir(host, owner, repo, pr), `${headSha}.json`);
}

export function lockFile(host: string, owner: string, repo: string, pr: number, headSha: string): string {
  return stateFile(host, owner, repo, pr, headSha) + ".lock";
}

export function latestPointer(host: string, owner: string, repo: string, pr: number): string {
  return path.join(prDir(host, owner, repo, pr), "latest.json");
}

export function ensurePrDir(host: string, owner: string, repo: string, pr: number): string {
  const dir = prDir(host, owner, repo, pr);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function atomicWriteJson(filepath: string, obj: unknown): void {
  const tmp = filepath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filepath);
}
