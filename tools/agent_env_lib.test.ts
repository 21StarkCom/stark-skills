import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as path from "node:path";

import { resolvedPath } from "./agent_env_lib.ts";

test("resolvedPath: backfills standard dirs onto a truncated PATH", () => {
  const out = resolvedPath("/some/narrow/dir").split(path.delimiter);
  assert.ok(out.includes("/some/narrow/dir"), "keeps the inherited entry");
  assert.ok(out.includes("/usr/bin"), "backfills /usr/bin");
  assert.ok(out.includes("/bin"), "backfills /bin");
});

test("resolvedPath: backfills onto an empty/missing PATH", () => {
  const out = resolvedPath("").split(path.delimiter).filter(Boolean);
  assert.ok(out.includes("/usr/bin"), "recovers a usable PATH from nothing");
  const undef = resolvedPath(undefined).split(path.delimiter).filter(Boolean);
  assert.ok(undef.length > 0, "undefined input yields a non-empty PATH");
});

test("resolvedPath: preserves inherited precedence and does not duplicate", () => {
  const inherited = "/usr/bin:/custom/tool/bin";
  const out = resolvedPath(inherited).split(path.delimiter);
  // inherited entries come first, in order
  assert.equal(out[0], "/usr/bin");
  assert.equal(out[1], "/custom/tool/bin");
  // no duplicate of an already-present standard dir
  assert.equal(out.filter((d) => d === "/usr/bin").length, 1);
});

test("resolvedPath: idempotent", () => {
  const once = resolvedPath("/usr/bin");
  const twice = resolvedPath(once);
  assert.equal(once, twice);
});
