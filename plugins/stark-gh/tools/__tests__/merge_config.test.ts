import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MERGE_DEFAULTS,
  applyMergeDefaults,
  describeSource,
  loadMergeDefaults,
} from "../lib/merge_config.ts";
import { loadTicketPolicy } from "../lib/ticket.ts";
import { parseRawArgs } from "../gh_pr_merge_preflight.ts";

const read = (s: string) => () => s;
const present = () => true;

// --- loading ---------------------------------------------------------------

test("absent config yields the built-in defaults and never reads", () => {
  const r = loadMergeDefaults("/repo", () => { throw new Error("should not read"); }, () => false);
  assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  assert.equal(r.error, null);
  assert.equal(r.warning, null);
});

test("a config with no merge block is not an error", () => {
  const r = loadMergeDefaults("/repo", read('{"requireTicketScope":true,"ticketKey":"STARK"}'), present);
  assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  assert.equal(r.error, null);
});

test("reads every settable key", () => {
  const r = loadMergeDefaults("/repo", read(JSON.stringify({
    merge: {
      allowNoRequiredChecks: true,
      allowSecretToLlm: true,
      allowSecretCommit: true,
      noWatch: true,
      watchTimeoutHours: 2,
    },
  })), present);
  assert.equal(r.error, null);
  assert.deepEqual(r.defaults, {
    allowNoRequiredChecks: true,
    allowSecretToLlm: true,
    allowSecretCommit: true,
    noWatch: true,
    watchTimeoutHours: 2,
  });
});

// A broken config that was opted into must BLOCK. Reverting to the built-in
// defaults would reproduce the silent 6-hour hang this feature exists to remove.
test("present-but-broken fails closed", () => {
  for (const body of [
    "{not json",
    "[]",
    '{"merge":[]}',
    '{"merge":{"allowNoRequiredChecks":"yes"}}',
    '{"merge":{"watchTimeoutHours":0}}',
    '{"merge":{"watchTimeoutHours":"6"}}',
  ]) {
    const r = loadMergeDefaults("/repo", read(body), present);
    assert.ok(r.error, `expected a fatal error for ${body}`);
    assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  }
});

test("unknown merge keys warn but do not block", () => {
  const r = loadMergeDefaults("/repo", read('{"merge":{"nope":true}}'), present);
  assert.equal(r.error, null);
  assert.match(r.warning ?? "", /unknown merge key/);
});

// The two halves of .stark-gh.json must not each call the other's keys unknown.
test("the ticket loader does not warn about the merge block", () => {
  const r = loadTicketPolicy("/repo", read('{"ticketKey":"STARK","merge":{"noWatch":true}}'), present);
  assert.equal(r.error, null);
  assert.equal(r.warning, null);
});

// --- precedence ------------------------------------------------------------

test("config supplies defaults the command line did not give", () => {
  const args = parseRawArgs("19");
  const merged = applyMergeDefaults(args, {
    ...DEFAULT_MERGE_DEFAULTS,
    allowNoRequiredChecks: true,
    noWatch: true,
  }, args.watchTimeoutExplicit);
  assert.equal(merged.allowNoRequiredChecks, true);
  assert.equal(merged.noWatch, true);
});

test("a typed flag still wins when the config is silent", () => {
  const args = parseRawArgs("19 --allow-no-required-checks");
  const merged = applyMergeDefaults(args, DEFAULT_MERGE_DEFAULTS, args.watchTimeoutExplicit);
  assert.equal(merged.allowNoRequiredChecks, true);
});

test("an explicit --watch-timeout beats the config, even at the default value", () => {
  const args = parseRawArgs("19 --watch-timeout 6");
  assert.equal(args.watchTimeoutExplicit, true);
  const merged = applyMergeDefaults(args, { ...DEFAULT_MERGE_DEFAULTS, watchTimeoutHours: 2 }, args.watchTimeoutExplicit);
  assert.equal(merged.watchTimeoutHours, 6);
});

test("the config's watch timeout applies when none was typed", () => {
  const args = parseRawArgs("19");
  assert.equal(args.watchTimeoutExplicit, false);
  const merged = applyMergeDefaults(args, { ...DEFAULT_MERGE_DEFAULTS, watchTimeoutHours: 2 }, args.watchTimeoutExplicit);
  assert.equal(merged.watchTimeoutHours, 2);
});

// --- visibility ------------------------------------------------------------

test("a config-supplied waiver is reported, and names the file", () => {
  const lines = describeSource(
    { ...DEFAULT_MERGE_DEFAULTS, allowSecretToLlm: true, allowNoRequiredChecks: true },
    { allowNoRequiredChecks: false, allowSecretToLlm: false, allowSecretCommit: false },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.includes(".stark-gh.json")));
});

test("a typed waiver is attributed to the command line, not the file", () => {
  const lines = describeSource(
    { ...DEFAULT_MERGE_DEFAULTS, allowSecretToLlm: true },
    { allowNoRequiredChecks: false, allowSecretToLlm: true, allowSecretCommit: false },
  );
  assert.deepEqual(lines, ["--allow-secret-to-llm: command line"]);
});

test("no waivers means nothing is printed", () => {
  const lines = describeSource(DEFAULT_MERGE_DEFAULTS, {
    allowNoRequiredChecks: false, allowSecretToLlm: false, allowSecretCommit: false,
  });
  assert.deepEqual(lines, []);
});
