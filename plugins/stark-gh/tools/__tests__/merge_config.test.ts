import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MERGE_DEFAULTS,
  MAX_WATCH_TIMEOUT_HOURS,
  applyMergeDefaults,
  describeSource,
  loadMergeDefaults,
  renderWaiver,
} from "../lib/merge_config.ts";
import { loadTicketPolicy } from "../lib/ticket.ts";
import { parseRawArgs } from "../gh_pr_merge_preflight.ts";

const at = (s: string | null) => () => s;
const NO_CLI = {
  allowNoRequiredChecks: false,
  allowSecretToLlm: false,
  allowSecretCommit: false,
  noWatch: false,
};

// --- loading ---------------------------------------------------------------

test("a file absent from the base ref yields the built-in defaults", () => {
  const r = loadMergeDefaults(at(null));
  assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  assert.equal(r.error, null);
  assert.equal(r.warning, null);
});

test("a config with no merge block is not an error", () => {
  const r = loadMergeDefaults(at('{"requireTicketScope":true,"ticketKey":"STARK"}'));
  assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  assert.equal(r.error, null);
  assert.equal(r.warning, null);
});

test("reads every settable key", () => {
  const r = loadMergeDefaults(at(JSON.stringify({
    merge: {
      allowNoRequiredChecks: true,
      allowSecretToLlm: true,
      allowSecretCommit: true,
      noWatch: true,
      watchTimeoutHours: 2,
    },
  })));
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
// defaults would silently drop settings the repo is relying on.
test("present-but-broken fails closed", () => {
  for (const body of [
    "{not json",
    "[]",
    '{"merge":[]}',
    '{"merge":{"allowNoRequiredChecks":"yes"}}',
    '{"merge":{"watchTimeoutHours":0}}',
    '{"merge":{"watchTimeoutHours":"6"}}',
  ]) {
    const r = loadMergeDefaults(at(body));
    assert.ok(r.error, `expected a fatal error for ${body}`);
    assert.deepEqual(r.defaults, DEFAULT_MERGE_DEFAULTS);
  }
});

// A read failure is not a syntax error, and saying so sent operators to inspect
// the syntax of a file whose syntax was never the problem.
test("a read failure is reported as a read failure", () => {
  const r = loadMergeDefaults(() => { throw new Error("EACCES: permission denied"); });
  assert.match(r.error ?? "", /could not be read from the merge base/);
  assert.doesNotMatch(r.error ?? "", /not valid JSON/);
});

// The whole point is to stop a merge failing for a reason the file appears to
// have handled — a miscased key that silently does nothing is that same bug.
test("a near-miss top-level key is fatal, not silently inert", () => {
  for (const key of ["Merge", "merges", "MERGE"]) {
    const r = loadMergeDefaults(at(JSON.stringify({ [key]: { noWatch: true } })));
    assert.match(r.error ?? "", /did you mean "merge"/, `expected a fatal error for ${key}`);
  }
});

test("an unrelated unknown top-level key only warns", () => {
  const r = loadMergeDefaults(at('{"somethingElse":1}'));
  assert.equal(r.error, null);
  assert.match(r.warning ?? "", /unknown top-level key/);
});

test("unknown merge keys warn but do not block", () => {
  const r = loadMergeDefaults(at('{"merge":{"nope":true}}'));
  assert.equal(r.error, null);
  assert.match(r.warning ?? "", /unknown merge key/);
});

// An unbounded timeout strands the PR behind a watcher that never exits.
test("watchTimeoutHours is bounded", () => {
  const r = loadMergeDefaults(at(`{"merge":{"watchTimeoutHours":${MAX_WATCH_TIMEOUT_HOURS + 1}}}`));
  assert.match(r.error ?? "", /at most 168/);
  const ok = loadMergeDefaults(at(`{"merge":{"watchTimeoutHours":${MAX_WATCH_TIMEOUT_HOURS}}}`));
  assert.equal(ok.error, null);
});

// The two halves of .stark-gh.json must not each call the other's keys unknown.
test("neither loader warns about the other's keys", () => {
  const body = '{"ticketKey":"STARK","merge":{"noWatch":true}}';
  assert.equal(loadTicketPolicy("/repo", () => body, () => true).warning, null);
  assert.equal(loadMergeDefaults(at(body)).warning, null);
});

// --- precedence ------------------------------------------------------------

test("config supplies defaults the command line did not give", () => {
  const merged = applyMergeDefaults(parseRawArgs("19"), {
    ...DEFAULT_MERGE_DEFAULTS,
    allowNoRequiredChecks: true,
    noWatch: true,
  });
  assert.equal(merged.allowNoRequiredChecks, true);
  assert.equal(merged.noWatch, true);
});

test("a typed flag still wins when the config is silent", () => {
  const merged = applyMergeDefaults(parseRawArgs("19 --allow-no-required-checks"), DEFAULT_MERGE_DEFAULTS);
  assert.equal(merged.allowNoRequiredChecks, true);
});

test("an explicit --watch-timeout beats the config, even at the default value", () => {
  const args = parseRawArgs("19 --watch-timeout 6");
  assert.equal(args.watchTimeoutExplicit, true);
  const merged = applyMergeDefaults(args, { ...DEFAULT_MERGE_DEFAULTS, watchTimeoutHours: 2 });
  assert.equal(merged.watchTimeoutHours, 6);
});

test("the config's watch timeout applies when none was typed", () => {
  const args = parseRawArgs("19");
  assert.equal(args.watchTimeoutExplicit, false);
  const merged = applyMergeDefaults(args, { ...DEFAULT_MERGE_DEFAULTS, watchTimeoutHours: 2 });
  assert.equal(merged.watchTimeoutHours, 2);
});

// The OR has no inverse, so this flag is the only way to turn a configured
// waiver back off for one run — and the only way past a broken committed file.
test("--ignore-repo-config parses", () => {
  assert.equal(parseRawArgs("19 --ignore-repo-config").ignoreRepoConfig, true);
  assert.equal(parseRawArgs("19").ignoreRepoConfig, false);
});

// --- visibility ------------------------------------------------------------

test("every setting is reported, not just the allow* trio", () => {
  const notes = describeSource(
    { ...DEFAULT_MERGE_DEFAULTS, noWatch: true, watchTimeoutHours: 3 },
    NO_CLI,
  );
  const flags = notes.map((n) => n.flag);
  assert.ok(flags.includes("--no-watch"), "a config noWatch skips the CI wait and must be visible");
  assert.ok(flags.some((f) => f.startsWith("--watch-timeout")));
  assert.ok(notes.every((n) => n.fromConfig));
});

test("a config-supplied waiver names the file", () => {
  const notes = describeSource(
    { ...DEFAULT_MERGE_DEFAULTS, allowSecretToLlm: true, allowNoRequiredChecks: true },
    NO_CLI,
  );
  assert.equal(notes.length, 2);
  assert.ok(notes.map(renderWaiver).every((l) => l.includes(".stark-gh.json")));
});

test("a typed waiver is attributed to the command line, not the file", () => {
  const notes = describeSource(
    { ...DEFAULT_MERGE_DEFAULTS, allowSecretToLlm: true },
    { ...NO_CLI, allowSecretToLlm: true },
  );
  assert.deepEqual(notes.map(renderWaiver), ["--allow-secret-to-llm: command line"]);
});

test("no settings means nothing is printed", () => {
  assert.deepEqual(describeSource(DEFAULT_MERGE_DEFAULTS, NO_CLI), []);
});
