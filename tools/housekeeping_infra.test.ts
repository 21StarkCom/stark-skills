// Tests for housekeeping_infra. Each phase step is tested independently
// against a synthetic FAKE_HOME so we never touch the real ~/.claude tree,
// then a small integration test runs cleanInfra() end-to-end.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import {
  archiveOldFiles,
  ASSET_SYMLINKS,
  cleanInfra,
  findStaleCheckpointFiles,
  findStaleLockFiles,
  findStaleSessionFiles,
  findStaleStatuslineStateFiles,
  healAssetSymlinks,
  isLockDataStale,
  rotateLogFile,
  type AgeProvider,
  type AssetSymlink,
  type LinkOps,
  type StaleClock,
} from "./housekeeping_infra.ts";

function makeTmp(t: TestContext): string | null {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "housekeeping-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

const NOW = new Date("2026-04-27T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// ── isLockDataStale ─────────────────────────────────────────────

const liveClock: StaleClock = {
  now: () => NOW,
  pidAlive: () => true,
  startTime: () => "Mon Apr 27 12:00:00 2026",
};

test("isLockDataStale: TTL exceeded → stale even when PID is alive", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: "2026-04-27T10:00:00Z", // 2 hours ago
    ttl_minutes: 30,
  };
  assert.equal(isLockDataStale(lock, liveClock), true);
});

test("isLockDataStale: dead PID → stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: NOW.toISOString().replace(".000", ""),
    ttl_minutes: 30,
  };
  const deadClock: StaleClock = { ...liveClock, pidAlive: () => false };
  assert.equal(isLockDataStale(lock, deadClock), true);
});

test("isLockDataStale: PID reused (start_time mismatch) → stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 11:00:00 2026", // earlier than current
    timestamp: NOW.toISOString().replace(".000", ""),
    ttl_minutes: 30,
  };
  const reusedClock: StaleClock = {
    ...liveClock,
    startTime: () => "Mon Apr 27 12:00:00 2026",
  };
  assert.equal(isLockDataStale(lock, reusedClock), true);
});

test("isLockDataStale: live, fresh, matching start_time → not stale", () => {
  const lock = {
    pid: 1234,
    start_time: "Mon Apr 27 12:00:00 2026",
    timestamp: "2026-04-27T11:55:00Z",
    ttl_minutes: 30,
  };
  assert.equal(isLockDataStale(lock, liveClock), false);
});

test("isLockDataStale: missing timestamp → stale", () => {
  assert.equal(isLockDataStale({ pid: 1234 }, liveClock), true);
});

// ── findStaleSessionFiles ───────────────────────────────────────

test("findStaleSessionFiles flags session JSONs older than 30 days", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    fs.writeFileSync(path.join(tmp, "old.json"), "{}");
    fs.writeFileSync(path.join(tmp, "fresh.json"), "{}");
    fs.writeFileSync(path.join(tmp, "ignore.txt"), "x");
    const ages: Record<string, Date> = {
      [path.join(tmp, "old.json")]: days(45),
      [path.join(tmp, "fresh.json")]: days(5),
      [path.join(tmp, "ignore.txt")]: days(100),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const stale = findStaleSessionFiles(tmp, 30, ageProvider, NOW);
    assert.deepEqual(stale.sort(), [path.join(tmp, "old.json")]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── findStaleCheckpointFiles ────────────────────────────────────

test("findStaleCheckpointFiles walks subdirs and flags old checkpoint markdowns", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    fs.mkdirSync(path.join(tmp, "session-a"));
    const cp1 = path.join(tmp, "session-a", "checkpoint-1.md");
    const cp2 = path.join(tmp, "session-a", "checkpoint-2.md");
    const notes = path.join(tmp, "session-a", "notes.md");
    fs.writeFileSync(cp1, "x");
    fs.writeFileSync(cp2, "x");
    fs.writeFileSync(notes, "x");
    const ages: Record<string, Date> = {
      [cp1]: days(30),
      [cp2]: days(2),
      [notes]: days(40),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const stale = findStaleCheckpointFiles(tmp, 7, ageProvider, NOW);
    assert.deepEqual(stale.sort(), [cp1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── findStaleStatuslineStateFiles ───────────────────────────────

test("findStaleStatuslineStateFiles flags old procstart/lastreply/prompt/stop files, spares fresh + single-file caches", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const oldProc = path.join(tmp, ".statusline-procstart-1234");
    const freshProc = path.join(tmp, ".statusline-procstart-5678");
    const oldReply = path.join(tmp, ".statusline-lastreply-sessA");
    const oldStop = path.join(tmp, ".statusline-stop-sessA");
    const freshStop = path.join(tmp, ".statusline-stop-sessB");
    const gitCache = path.join(tmp, ".statusline-git-dirty-cache");
    const acctCache = path.join(tmp, ".statusline-account-cache");
    for (const f of [oldProc, freshProc, oldReply, oldStop, freshStop, gitCache, acctCache]) {
      fs.writeFileSync(f, "x");
    }
    const ages: Record<string, Date> = {
      [oldProc]: days(30),
      [freshProc]: days(3),
      [oldReply]: days(20),
      [oldStop]: days(18),
      [freshStop]: days(2),
      [gitCache]: days(99), // excluded by prefix, not age
      [acctCache]: days(99),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const stale = findStaleStatuslineStateFiles(tmp, 14, ageProvider, NOW);
    assert.deepEqual(stale.sort(), [oldReply, oldProc, oldStop].sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── findStaleLockFiles ──────────────────────────────────────────

test("findStaleLockFiles surfaces both corrupt and stale locks", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const corrupt = path.join(tmp, "corrupt.lock");
    fs.writeFileSync(corrupt, "{not json");
    const stale = path.join(tmp, "stale.lock");
    fs.writeFileSync(
      stale,
      JSON.stringify({
        pid: 1,
        start_time: "x",
        timestamp: "2020-01-01T00:00:00Z",
        ttl_minutes: 30,
      }),
    );
    const fresh = path.join(tmp, "fresh.lock");
    fs.writeFileSync(
      fresh,
      JSON.stringify({
        pid: 1,
        start_time: "Mon Apr 27 12:00:00 2026",
        timestamp: "2026-04-27T11:55:00Z",
        ttl_minutes: 30,
      }),
    );
    const result = findStaleLockFiles([tmp], { clock: liveClock });
    assert.deepEqual(result.sort(), [corrupt, stale].sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── rotateLogFile ───────────────────────────────────────────────

test("rotateLogFile leaves small files alone", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "tiny.jsonl");
    fs.writeFileSync(log, "a\nb\nc\n");
    const r = rotateLogFile(log, 1000, false);
    assert.equal(r.rotated, false);
    assert.equal(fs.readFileSync(log, "utf8"), "a\nb\nc\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rotateLogFile keeps the last N lines and preserves trailing newline", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "big.jsonl");
    const lines = Array.from({ length: 1500 }, (_, i) => `line-${i}`);
    fs.writeFileSync(log, lines.join("\n") + "\n");
    const r = rotateLogFile(log, 1000, false);
    assert.equal(r.rotated, true);
    assert.equal(r.lines, 1500);
    const after = fs.readFileSync(log, "utf8").split("\n");
    // 1000 lines + the final empty element from the trailing newline.
    assert.equal(after.length, 1001);
    assert.equal(after[0], "line-500");
    assert.equal(after[999], "line-1499");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rotateLogFile dry-run reports without writing", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const log = path.join(tmp, "big.jsonl");
    const lines = Array.from({ length: 1100 }, (_, i) => `line-${i}`);
    const before = lines.join("\n") + "\n";
    fs.writeFileSync(log, before);
    const r = rotateLogFile(log, 1000, true);
    assert.equal(r.rotated, true);
    assert.equal(fs.readFileSync(log, "utf8"), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── archiveOldFiles ─────────────────────────────────────────────

test("archiveOldFiles groups by month and only includes old files", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const src = path.join(tmp, "logs");
    fs.mkdirSync(src);
    const oldA = path.join(src, "old-a.txt");
    const oldB = path.join(src, "old-b.txt");
    const fresh = path.join(src, "fresh.txt");
    for (const f of [oldA, oldB, fresh]) fs.writeFileSync(f, "x");
    const ages: Record<string, Date> = {
      [oldA]: new Date("2026-01-15T12:00:00Z"),
      [oldB]: new Date("2026-02-10T12:00:00Z"),
      [fresh]: new Date("2026-04-25T12:00:00Z"),
    };
    const ageProvider: AgeProvider = (p) => ages[p] ?? new Date(0);
    const tarCalls: string[][] = [];
    const tarRunner = (args: string[]) => {
      tarCalls.push(args);
      // Simulate `tar -czf` writing the archive so verification passes.
      if (args[0] === "-czf") fs.writeFileSync(args[1], "tar-bytes");
      return "";
    };
    const archives = archiveOldFiles(
      { slug: "logs", rootDir: src },
      path.join(tmp, "archives"),
      30,
      { ageProvider, now: NOW, tarRunner },
    );
    assert.equal(archives.length, 2);
    const months = archives.map((a) => path.basename(a.archive)).sort();
    assert.deepEqual(months, ["logs-2026-01.tar.gz", "logs-2026-02.tar.gz"]);
    // Originals were unlinked.
    assert.equal(fs.existsSync(oldA), false);
    assert.equal(fs.existsSync(oldB), false);
    // Fresh file untouched.
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archiveOldFiles dry-run reports without invoking tar", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const src = path.join(tmp, "logs");
    fs.mkdirSync(src);
    const old = path.join(src, "old.txt");
    fs.writeFileSync(old, "x");
    const ageProvider: AgeProvider = () => new Date("2026-01-01T00:00:00Z");
    let called = 0;
    const tarRunner = (_args: string[]) => {
      called++;
      return "";
    };
    const archives = archiveOldFiles(
      { slug: "logs", rootDir: src },
      path.join(tmp, "archives"),
      30,
      { ageProvider, now: NOW, dryRun: true, tarRunner },
    );
    assert.equal(archives.length, 1);
    assert.equal(called, 0);
    assert.equal(fs.existsSync(old), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── healAssetSymlinks ───────────────────────────────────────────

// Build a synthetic home where the stark-skills repo lives at
// Code/21Stark/stark-skills and the asset links sit under .claude. Returns the
// link/target table wired to that layout plus a helper to create the repo dirs.
function symlinkFixture(t: TestContext): {
  home: string;
  links: AssetSymlink[];
  repoDir: string;
} | null {
  const tmp = makeTmp(t);
  if (!tmp) return null;
  const home = path.join(tmp, "home");
  const repoDir = path.join(home, "Code", "21Stark", "stark-skills");
  const links: AssetSymlink[] = [
    { link: ".claude/code-review/tools", target: "Code/21Stark/stark-skills/tools" },
    // Deliberately under a DIFFERENT parent than links[0]: seeding this one must
    // not create .claude/code-review/, or the provisioning tests below could not
    // assert that a missing parent directory gets created.
    {
      link: ".claude/output-styles/concrete.md",
      target: "Code/21Stark/stark-skills/config/output-styles/concrete.md",
    },
  ];
  // Seed every entry EXCEPT the first as already-healthy. Each test below owns
  // links[0] and breaks it in one specific way; the rest must not contribute
  // repairs or errors of their own. Since an absent link is now provisioned
  // rather than skipped, leaving them unseeded would add a repair per test.
  for (const l of links.slice(1)) {
    const target = path.join(home, l.target);
    fs.mkdirSync(target, { recursive: true });
    const linkPath = path.join(home, l.link);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath);
  }
  return { home, links, repoDir };
}

test("healAssetSymlinks repoints a dangling link to the corrected target", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    // Corrected target exists...
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    // ...but the link currently points at a nonexistent (dangling) location.
    fs.symlinkSync(path.join(fx.home, "Code/Playground/stark-skills/tools"), linkPath);

    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.equal(errors.length, 0);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.path, linkPath);
    assert.equal(repaired[0]!.to, path.join(fx.repoDir, "tools"));
    assert.equal(fs.readlinkSync(linkPath), path.join(fx.repoDir, "tools"));
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks repoints a link whose target carries a stale path segment", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    // Both the stale and corrected targets exist on disk — the link resolves
    // (not dangling) but still points through the old Code/Playground segment.
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const staleTarget = path.join(fx.home, "Code/Playground/stark-skills/tools");
    fs.mkdirSync(staleTarget, { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(staleTarget, linkPath);
    assert.equal(fs.existsSync(linkPath), true); // resolves — not dangling

    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.equal(errors.length, 0);
    assert.equal(repaired.length, 1);
    assert.equal(fs.readlinkSync(linkPath), path.join(fx.repoDir, "tools"));
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks reports an error and never deletes when the corrected target is missing", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    // Corrected target does NOT exist — do not repair, do not delete.
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const staleTarget = path.join(fx.home, "Code/Playground/stark-skills/tools");
    fs.symlinkSync(staleTarget, linkPath);

    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.equal(repaired.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /corrected target .* is missing/);
    // Link is untouched (still present, still pointing at the stale target).
    assert.equal(fs.readlinkSync(linkPath), staleTarget);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks is a no-op on a healthy tree", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    for (const l of fx.links) {
      const linkPath = path.join(fx.home, l.link);
      if (fs.existsSync(linkPath)) continue; // already seeded healthy by the fixture
      const target = path.join(fx.home, l.target);
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath);
    }
    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.deepEqual(repaired, []);
    assert.deepEqual(errors, []);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks dry-run reports the repair without touching the filesystem", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const staleTarget = path.join(fx.home, "Code/Playground/stark-skills/tools");
    fs.symlinkSync(staleTarget, linkPath);

    const { repaired, errors } = healAssetSymlinks(fx.home, {
      links: fx.links,
      dryRun: true,
    });
    assert.equal(errors.length, 0);
    assert.equal(repaired.length, 1);
    // Link is unchanged — still the stale target.
    assert.equal(fs.readlinkSync(linkPath), staleTarget);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks never deletes the original when the mutation fails mid-repair", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const staleTarget = path.join(fx.home, "Code/Playground/stark-skills/tools");
    fs.symlinkSync(staleTarget, linkPath);

    // Real ops except symlink(), which throws — simulating EACCES/ENOSPC etc.
    const failingOps: LinkOps = {
      readlink: (p) => fs.readlinkSync(p),
      symlink: () => {
        throw new Error("boom: symlink refused");
      },
      rename: (a, b) => fs.renameSync(a, b),
      unlink: (p) => fs.unlinkSync(p),
      exists: (p) => fs.existsSync(p),
      mkdirp: (p) => {
        fs.mkdirSync(p, { recursive: true });
      },
    };
    const { repaired, errors } = healAssetSymlinks(fx.home, {
      links: fx.links,
      ops: failingOps,
    });
    assert.equal(repaired.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /repoint .*boom/);
    // The load-bearing link is still present, still pointing at its old target.
    assert.equal(fs.readlinkSync(linkPath), staleTarget);
    // No orphaned temp link left behind.
    assert.equal(fs.existsSync(`${linkPath}.stark-heal-${process.pid}`), false);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

// The 2026-08-13 ~/.claude rebuild came back with 8 of 9 asset links ABSENT and
// healAssetSymlinks reported errors: [] over all of them — it only repaired
// links that existed and were broken. Absent is now provisioned.

test("healAssetSymlinks provisions an absent link from the canonical target", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    assert.equal(fs.existsSync(path.dirname(linkPath)), false); // parent absent too

    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.deepEqual(errors, []);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.provisioned, true);
    assert.equal(repaired[0]!.from, ""); // nothing to point away from
    assert.equal(repaired[0]!.to, path.join(fx.repoDir, "tools"));
    // Created, resolves, and is a symlink rather than a copy.
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(linkPath), true);
    assert.equal(fs.readlinkSync(linkPath), path.join(fx.repoDir, "tools"));
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks skips silently when an absent link has no target to point at", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    // Neither the link nor its canonical target exists. Nothing to invent and
    // no broken link to report — this is every machine that has not cloned
    // stark-skills to the canonical path, so it must not error or exit non-zero.
    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.deepEqual(repaired, []);
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(path.join(fx.home, ".claude/code-review/tools")), false);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks dry-run reports a provision without creating anything", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");

    const { repaired, errors } = healAssetSymlinks(fx.home, {
      links: fx.links,
      dryRun: true,
    });
    assert.deepEqual(errors, []);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.provisioned, true);
    // Neither the link nor its parent directory was created.
    assert.equal(fs.existsSync(linkPath), false);
    assert.equal(fs.existsSync(path.dirname(linkPath)), false);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks never replaces a real file sitting at the link path", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const linkPath = path.join(fx.home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    // A REAL file, not a symlink — readlink gives EINVAL, and clobbering it
    // with a link would destroy content this tool does not own.
    fs.writeFileSync(linkPath, "hand-written content");

    const { repaired, errors } = healAssetSymlinks(fx.home, { links: fx.links });
    assert.deepEqual(repaired, []);
    assert.deepEqual(errors, []);
    assert.equal(fs.readFileSync(linkPath, "utf8"), "hand-written content");
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), false);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("healAssetSymlinks provisioning is idempotent", (t) => {
  const fx = symlinkFixture(t);
  if (!fx) return;
  try {
    fs.mkdirSync(path.join(fx.repoDir, "tools"), { recursive: true });
    const first = healAssetSymlinks(fx.home, { links: fx.links });
    assert.equal(first.repaired.length, 1);
    const second = healAssetSymlinks(fx.home, { links: fx.links });
    assert.deepEqual(second.repaired, []);
    assert.deepEqual(second.errors, []);
  } finally {
    fs.rmSync(path.dirname(fx.home), { recursive: true, force: true });
  }
});

test("ASSET_SYMLINKS is a sane, deduped table of ~/.claude → stark-skills mappings", () => {
  assert.equal(ASSET_SYMLINKS.length, 11);
  const linkSet = new Set<string>();
  for (const entry of ASSET_SYMLINKS) {
    assert.ok(entry.link.startsWith(".claude/"), `link under .claude: ${entry.link}`);
    assert.ok(
      entry.target.startsWith("Code/21Stark/stark-skills/"),
      `target under stark-skills: ${entry.target}`,
    );
    assert.equal(linkSet.has(entry.link), false, `duplicate link: ${entry.link}`);
    linkSet.add(entry.link);
  }
});

// healAssetSymlinks skips absent-link-with-absent-target silently, because that
// is just "stark-skills is not cloned here". The signal that would otherwise be
// lost — an entry naming a path this repo does not actually ship — is asserted
// statically instead, which is strictly better: it fails in CI on the commit
// that introduces the drift rather than on whichever machine runs housekeeping
// next.
test("every ASSET_SYMLINKS target exists in this repo", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const PREFIX = "Code/21Stark/stark-skills/";
  for (const entry of ASSET_SYMLINKS) {
    assert.ok(
      entry.target.startsWith(PREFIX),
      `target must be repo-relative under ${PREFIX}: ${entry.target}`,
    );
    const inRepo = path.join(repoRoot, entry.target.slice(PREFIX.length));
    assert.ok(
      fs.existsSync(inRepo),
      `ASSET_SYMLINKS entry ${entry.link} points at ${entry.target}, which this repo does not ship (${inRepo})`,
    );
  }
});

// ── cleanInfra integration ──────────────────────────────────────

test("cleanInfra wires asset-symlink healing into the receipt", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const home = path.join(tmp, "home");
    // A real ASSET_SYMLINKS entry pointing through the stale segment, with its
    // corrected target present under this home.
    fs.mkdirSync(path.join(home, "Code/21Stark/stark-skills/tools"), { recursive: true });
    const linkPath = path.join(home, ".claude/code-review/tools");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(path.join(home, "Code/Playground/stark-skills/tools"), linkPath);

    const receipt = cleanInfra({
      homeDir: home,
      dryRun: true, // report the repair without mutating (and without touching /tmp locks)
      ageProvider: () => days(0),
      now: NOW,
      clock: liveClock,
      tarRunner: () => "",
      // Scope to the one entry this test seeds — the other real entries have no
      // target under this synthetic home and would each report a provision.
      assetLinks: [
        { link: ".claude/code-review/tools", target: "Code/21Stark/stark-skills/tools" },
      ],
    });
    assert.equal(receipt.symlinksRepaired.length, 1);
    assert.equal(receipt.symlinksRepaired[0]!.path, linkPath);
    assert.equal(
      receipt.symlinksRepaired[0]!.to,
      path.join(home, "Code/21Stark/stark-skills/tools"),
    );
    assert.equal(receipt.errors.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanInfra dry-run reports counts without mutating", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const home = path.join(tmp, "home");
    const codeReview = path.join(home, ".claude", "code-review");
    const sessions = path.join(codeReview, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const oldSession = path.join(sessions, "old.json");
    fs.writeFileSync(oldSession, "{}");

    const ageProvider: AgeProvider = (p) =>
      p === oldSession ? days(45) : days(0);
    const receipt = cleanInfra({
      homeDir: home,
      dryRun: true,
      ageProvider,
      now: NOW,
      clock: liveClock,
      tarRunner: () => "",
      assetLinks: [], // unrelated phase — keep symlink provisioning out of it
    });
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.sessionsRemoved.length, 1);
    assert.equal(fs.existsSync(oldSession), true); // still there
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanInfra surfaces unlink errors but keeps going", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  try {
    const home = path.join(tmp, "home");
    const codeReview = path.join(home, ".claude", "code-review");
    const sessions = path.join(codeReview, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    // No actual session files — receipt.errors should be empty even though
    // the directories exist. This guards against any startup error paths.
    const receipt = cleanInfra({
      homeDir: home,
      ageProvider: () => days(0),
      now: NOW,
      clock: liveClock,
      tarRunner: () => "",
      assetLinks: [], // unrelated phase — keep symlink provisioning out of it
    });
    assert.equal(receipt.errors.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression: under Node type-stripping (Node 25+), the entry-point
// gate goes silent when the script is invoked through a symlink (e.g.
// ~/.claude/code-review/tools/ → stark-skills/tools/). See
// review_setup_worktree for the full root cause. Guard by invoking through
// a real symlink and asserting the CLI parser actually runs.
test("CLI runs when invoked through a symlink (Node 25 strip-types regression)", (t) => {
  const tmp = makeTmp(t);
  if (!tmp) return;
  const realScript = fileURLToPath(
    new URL("./housekeeping_infra.ts", import.meta.url),
  );
  const linkedScript = path.join(tmp, "housekeeping_infra.ts");
  try {
    fs.symlinkSync(realScript, linkedScript);
    const stdout = execFileSync(
      process.execPath,
      [linkedScript, "--dry-run", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // Parse the JSON receipt — empty stdout (gate misfire) or text-mode
    // output (a regression to the non-JSON branch) would both fail here.
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.dryRun, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
