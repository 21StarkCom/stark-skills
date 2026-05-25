/**
 * First-boot secret seeding for the SQLite-index volume.
 *
 * The container generates THREE scoped secrets on first run if missing:
 *
 *   - /data/bootstrap_token   256-bit, mode 0600 — accepted ONLY by
 *                             POST /api/auth/bootstrap (Phase 4).
 *   - /data/prune_token       256-bit, mode 0600 — accepted ONLY by
 *                             POST /api/internal/retention/notify on the
 *                             loopback retention listener (Phase 4).
 *   - /data/token             symlink → bootstrap_token, for one-release
 *                             backward compat (removed in the Phase 8
 *                             docs cut).
 *
 * Writes are atomic (tmp + rename) and umask-bracketed so a wide host
 * umask cannot leak the mode. Values are NEVER logged in any flag, error
 * path, or audit row — see the plan's Risks → "Token leak in docker logs".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SeededReport {
  /** Token-file basenames that were newly created on this boot. */
  generated: string[];
}

/**
 * Idempotently generate `bootstrap_token` and `prune_token` (256-bit, hex,
 * mode 0600) plus the `token` backward-compat symlink in `dataDir`. Returns
 * the list of newly-created basenames so the caller can log a single
 * presence-only hint without ever touching the secret values.
 */
export function seedTokens(dataDir: string): SeededReport {
  const generated: string[] = [];
  const targets: Array<{ name: string; file: string }> = [
    { name: "bootstrap_token", file: path.join(dataDir, "bootstrap_token") },
    { name: "prune_token", file: path.join(dataDir, "prune_token") },
  ];

  const prev = process.umask(0o077);
  try {
    for (const t of targets) {
      if (fs.existsSync(t.file)) continue;
      const value = crypto.randomBytes(32).toString("hex");
      const tmp = t.file + ".tmp";
      try {
        fs.writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, t.file);
        fs.chmodSync(t.file, 0o600);
        generated.push(t.name);
      } finally {
        if (fs.existsSync(tmp)) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // Best-effort cleanup; rename above already moved the file if it
            // succeeded.
          }
        }
      }
    }
  } finally {
    process.umask(prev);
  }

  const compat = path.join(dataDir, "token");
  if (!fs.existsSync(compat)) {
    try {
      fs.symlinkSync("bootstrap_token", compat);
      generated.push("token");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  return { generated };
}
