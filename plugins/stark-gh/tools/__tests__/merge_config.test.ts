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
  watchTimeoutExplicit: false,
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
test("a read failure is reported as a read failure, naming the real source", () => {
  const r = loadMergeDefaults(
    () => { throw new Error("EACCES: permission denied"); },
    "/repo/.stark-gh.json",
  );
  assert.match(r.error ?? "", /could not be read/);
  // The message must name what was actually read. pr-open validates the local
  // file, so blaming "the merge base" sent operators to inspect a ref that was
  // fine while the real problem was a file mode.
  assert.match(r.error ?? "", /\/repo\/\.stark-gh\.json/);
  assert.doesNotMatch(r.error ?? "", /not valid JSON/);
});

// A misspelling one level down is the same silently-inert config the top-level
// check exists to refuse.
test("a near-miss key INSIDE the merge block is fatal too", () => {
  for (const key of ["allowNoRequiredCheck", "AllowSecretToLlm", "noWatchs"]) {
    const r = loadMergeDefaults(at(JSON.stringify({ merge: { [key]: true } })));
    assert.match(r.error ?? "", /did you mean/, `expected a fatal error for ${key}`);
  }
});

test("a genuinely foreign merge key still only warns", () => {
  const r = loadMergeDefaults(at('{"merge":{"someFutureKey":true}}'));
  assert.equal(r.error, null);
  assert.match(r.warning ?? "", /unknown merge key/);
});

// Announcing a timeout the CLI already overrode misreports the run on the one
// line the operator reads to learn what is in force.
test("a config timeout the CLI overrode is not announced", () => {
  const cfg = { ...DEFAULT_MERGE_DEFAULTS, watchTimeoutHours: 24 };
  const typed = describeSource(cfg, { ...NO_CLI, watchTimeoutExplicit: true });
  assert.deepEqual(typed.filter((n) => n.flag.startsWith("--watch-timeout")), []);
  const untyped = describeSource(cfg, NO_CLI);
  assert.deepEqual(untyped.map((n) => n.flag), ["--watch-timeout 24"]);
});

// The cap is load-bearing on BOTH paths: the hours-for-milliseconds mix-up it
// exists to catch is a typed mistake, so capping only the config half left the
// likelier half open.
test("--watch-timeout is capped like the config value", () => {
  assert.throws(() => parseRawArgs(`19 --watch-timeout ${MAX_WATCH_TIMEOUT_HOURS + 1}`), /at most 168/);
  assert.equal(parseRawArgs(`19 --watch-timeout ${MAX_WATCH_TIMEOUT_HOURS}`).watchTimeoutHours, MAX_WATCH_TIMEOUT_HOURS);
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
