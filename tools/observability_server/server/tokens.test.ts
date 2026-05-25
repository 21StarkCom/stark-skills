// First-boot token-seeding tests. Phase 1 wing-review fix #1.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { seedTokens } from "./tokens.ts";

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-tokens-test-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function modeOf(p: string): number {
  return fs.lstatSync(p).mode & 0o777;
}

test("first boot generates bootstrap_token + prune_token at 0600", () => {
  const dir = tmpDataDir();
  try {
    const report = seedTokens(dir);
    assert.deepEqual(
      report.generated.sort(),
      ["bootstrap_token", "prune_token", "token"],
    );
    const bootstrap = path.join(dir, "bootstrap_token");
    const prune = path.join(dir, "prune_token");
    assert.equal(fs.existsSync(bootstrap), true);
    assert.equal(fs.existsSync(prune), true);
    assert.equal(modeOf(bootstrap), 0o600);
    assert.equal(modeOf(prune), 0o600);
    // 256 bits hex-encoded → 64 chars.
    assert.equal(fs.readFileSync(bootstrap, "utf8").length, 64);
    assert.equal(fs.readFileSync(prune, "utf8").length, 64);
    assert.notEqual(
      fs.readFileSync(bootstrap, "utf8"),
      fs.readFileSync(prune, "utf8"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("second boot is a no-op — generated values are preserved verbatim", () => {
  const dir = tmpDataDir();
  try {
    seedTokens(dir);
    const before = {
      bootstrap: fs.readFileSync(path.join(dir, "bootstrap_token"), "utf8"),
      prune: fs.readFileSync(path.join(dir, "prune_token"), "utf8"),
    };
    const second = seedTokens(dir);
    assert.deepEqual(second.generated, []);
    const after = {
      bootstrap: fs.readFileSync(path.join(dir, "bootstrap_token"), "utf8"),
      prune: fs.readFileSync(path.join(dir, "prune_token"), "utf8"),
    };
    assert.equal(before.bootstrap, after.bootstrap);
    assert.equal(before.prune, after.prune);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/data/token is a symlink to bootstrap_token (backward compat)", () => {
  const dir = tmpDataDir();
  try {
    seedTokens(dir);
    const link = path.join(dir, "token");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), "bootstrap_token");
    // Reads through the symlink return the bootstrap value.
    assert.equal(
      fs.readFileSync(link, "utf8"),
      fs.readFileSync(path.join(dir, "bootstrap_token"), "utf8"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mode 0600 survives a wide host umask", () => {
  const dir = tmpDataDir();
  const prevUmask = process.umask(0o022); // macOS default
  try {
    seedTokens(dir);
    assert.equal(modeOf(path.join(dir, "bootstrap_token")), 0o600);
    assert.equal(modeOf(path.join(dir, "prune_token")), 0o600);
  } finally {
    process.umask(prevUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial seed: only the missing tokens are regenerated", () => {
  const dir = tmpDataDir();
  try {
    fs.writeFileSync(path.join(dir, "bootstrap_token"), "preexisting", {
      mode: 0o600,
    });
    const report = seedTokens(dir);
    assert.deepEqual(report.generated.sort(), ["prune_token", "token"]);
    assert.equal(
      fs.readFileSync(path.join(dir, "bootstrap_token"), "utf8"),
      "preexisting",
    );
    assert.equal(fs.readFileSync(path.join(dir, "prune_token"), "utf8").length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
