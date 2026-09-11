// Tests for `tools/statusline_setup_lib.ts` — the statusline segment
// configurator ported from `config/statusline-setup.py`. HOME is
// redirected so config + install writes stay in a temp dir.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyToggle,
  installStatusline,
  loadConfig,
  renderList,
  saveConfig,
  SEGMENTS,
  segmentsJsonPath,
  VALID_IDS,
} from "./statusline_setup_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "statusline-test-"));
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

test("SEGMENTS: 14 segments, ids unique, all on line 1/2/3", () => {
  assert.equal(SEGMENTS.length, 14);
  assert.equal(VALID_IDS.size, 14);
  for (const s of SEGMENTS) assert.ok(s.line === 1 || s.line === 2 || s.line === 3);
});

// ---------------------------------------------------------------------------
// loadConfig / saveConfig
// ---------------------------------------------------------------------------

test("loadConfig: no file → every segment enabled", () => {
  const home = tmp();
  try {
    const states = withHome(home, () => loadConfig());
    assert.equal(Object.keys(states).length, 14);
    assert.ok(Object.values(states).every((v) => v === true));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: on-disk overrides merge over the all-enabled defaults", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      fs.mkdirSync(path.dirname(segmentsJsonPath()), { recursive: true });
      fs.writeFileSync(segmentsJsonPath(), JSON.stringify({ vim_mode: false }));
      const states = loadConfig();
      assert.equal(states.vim_mode, false);
      assert.equal(states.model, true);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: malformed JSON → falls back to all-enabled", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      fs.mkdirSync(path.dirname(segmentsJsonPath()), { recursive: true });
      fs.writeFileSync(segmentsJsonPath(), "not-json{");
      const states = loadConfig();
      assert.ok(Object.values(states).every((v) => v === true));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saveConfig → loadConfig round-trips", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      const states = loadConfig();
      states.code_churn = false;
      saveConfig(states);
      assert.equal(loadConfig().code_churn, false);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// applyToggle
// ---------------------------------------------------------------------------

test("applyToggle: disables a comma-separated set and persists", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      const states = loadConfig();
      const r = applyToggle(states, "model, code_churn", false);
      assert.equal(r.ok, true);
      const reloaded = loadConfig();
      assert.equal(reloaded.model, false);
      assert.equal(reloaded.code_churn, false);
      assert.equal(reloaded.vim_mode, true);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("applyToggle: unknown id → error, nothing persisted", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      const states = loadConfig();
      const r = applyToggle(states, "model,bogus_id", false);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /Unknown segment: bogus_id/);
      assert.equal(fs.existsSync(segmentsJsonPath()), false);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// renderList
// ---------------------------------------------------------------------------

test("renderList: groups by line and shows on/off state", () => {
  const all: Record<string, boolean> = {};
  for (const s of SEGMENTS) all[s.id] = true;
  all.vim_mode = false;
  const out = renderList(all);
  assert.match(out, /Line 1/);
  assert.match(out, /Line 2/);
  assert.match(out, /repo_name/);
});

// ---------------------------------------------------------------------------
// installStatusline
// ---------------------------------------------------------------------------

test("installStatusline: first run links + patches, second run is idempotent", () => {
  const home = tmp();
  try {
    withHome(home, () => {
      const first = installStatusline();
      assert.ok(first.some((a) => a.startsWith("Linked")));
      assert.ok(first.includes("Patched settings.json"));

      const settings = JSON.parse(
        fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
      );
      assert.equal(settings.statusLine.type, "command");
      assert.match(settings.statusLine.command, /^bash /);

      const second = installStatusline();
      assert.deepEqual(second, ["Script symlink OK", "settings.json OK"]);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
