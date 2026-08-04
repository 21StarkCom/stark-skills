// CLI parser + flag→API mapping tests for `tools/github_app.ts`.
//
// The pure helpers (`parseArgs`, `reviewEventFromFlags`) are intentionally
// exported so that flag-mapping regressions — e.g. `--approve` silently
// downgrading to `COMMENT` — get caught at unit-test time instead of via live
// PR mishaps.
//
// `draftFromFlags` / `mergeMethodFromFlags` tests were dropped 2026-08-04 with
// the `pr create` / `pr merge` actions. The identity guard that replaced them is
// covered by the HUMAN_ONLY_ACTIONS tests below.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  HUMAN_ONLY_ACTIONS,
  parseArgs,
  reviewEventFromFlags,
} from "./github_app.ts";

// ---------------------------------------------------------------------------
// reviewEventFromFlags
// ---------------------------------------------------------------------------

test("reviewEventFromFlags: --approve → APPROVE", () => {
  const flags = new Map<string, true>([["approve", true]]);
  assert.equal(reviewEventFromFlags(flags), "APPROVE");
});

test("reviewEventFromFlags: --request-changes → REQUEST_CHANGES", () => {
  const flags = new Map<string, true>([["request-changes", true]]);
  assert.equal(reviewEventFromFlags(flags), "REQUEST_CHANGES");
});

test("reviewEventFromFlags: --comment → COMMENT", () => {
  const flags = new Map<string, true>([["comment", true]]);
  assert.equal(reviewEventFromFlags(flags), "COMMENT");
});

test("reviewEventFromFlags: no flag → COMMENT (safe default)", () => {
  assert.equal(reviewEventFromFlags(new Map()), "COMMENT");
});

test("reviewEventFromFlags: --approve beats --request-changes when both set", () => {
  // Defensive: argparse should reject mutually-exclusive flags, but
  // collisions shouldn't silently demote an APPROVE to REQUEST_CHANGES.
  const flags = new Map<string, true>([
    ["approve", true],
    ["request-changes", true],
  ]);
  assert.equal(reviewEventFromFlags(flags), "APPROVE");
});

// ---------------------------------------------------------------------------
// Identity policy — the bot may not author Aryeh's acts
// ---------------------------------------------------------------------------

test("HUMAN_ONLY_ACTIONS covers exactly the four bot-forbidden actions", () => {
  assert.deepEqual(Object.keys(HUMAN_ONLY_ACTIONS).sort(), [
    "issue create",
    "pr create",
    "pr merge",
    "pr ready",
  ]);
});

test("HUMAN_ONLY_ACTIONS: every entry names a gh replacement", () => {
  // The refusal is only useful if it tells the operator what to run instead.
  for (const [action, replacement] of Object.entries(HUMAN_ONLY_ACTIONS)) {
    assert.match(replacement, /^gh /, `${action} must map to a gh command`);
  }
});

test("HUMAN_ONLY_ACTIONS: review posting stays available to the bot", () => {
  // Three distinct bot authors are what makes multi-LLM review attribution
  // legible — locking these down too would destroy that.
  assert.equal(HUMAN_ONLY_ACTIONS["pr review"], undefined);
  assert.equal(HUMAN_ONLY_ACTIONS["pr comment"], undefined);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs: defaults app to stark-codex, repo to null", () => {
  const p = parseArgs(["token"]);
  assert.equal(p.app, "stark-codex");
  assert.equal(p.repo, null);
  assert.deepEqual(p.positional, ["token"]);
});

test("parseArgs: --app overrides default and is type-narrowed", () => {
  const p = parseArgs(["--app", "stark-claude", "token"]);
  assert.equal(p.app, "stark-claude");
});

test("parseArgs: --app rejects unknown names with the available list", () => {
  assert.throws(
    () => parseArgs(["--app", "typo", "token"]),
    (err: Error) => {
      assert.match(err.message, /Unknown app 'typo'/);
      assert.match(err.message, /stark-claude/);
      return true;
    },
  );
});

test("parseArgs: --repo captured into parsed.repo", () => {
  const p = parseArgs(["--repo", "OtherOrg/their-repo", "pr", "list"]);
  assert.equal(p.repo, "OtherOrg/their-repo");
  assert.deepEqual(p.positional, ["pr", "list"]);
});

test("parseArgs: pr review --approve --body 'lgtm' parses correctly", () => {
  const p = parseArgs(["pr", "review", "42", "--approve", "--body", "lgtm"]);
  assert.deepEqual(p.positional, ["pr", "review", "42"]);
  assert.equal(p.flags.has("approve"), true);
  assert.equal(p.options.get("body"), "lgtm");
  assert.equal(reviewEventFromFlags(p.flags), "APPROVE");
});

test("parseArgs: pr review --request-changes --body 'needs work' parses", () => {
  const p = parseArgs([
    "pr",
    "review",
    "42",
    "--request-changes",
    "--body",
    "needs work",
  ]);
  assert.equal(p.flags.has("request-changes"), true);
  assert.equal(p.options.get("body"), "needs work");
  assert.equal(reviewEventFromFlags(p.flags), "REQUEST_CHANGES");
});

test("parseArgs: pr comment --body captures the body", () => {
  const p = parseArgs(["pr", "comment", "7", "--body", "hello"]);
  assert.deepEqual(p.positional, ["pr", "comment", "7"]);
  assert.equal(p.options.get("body"), "hello");
});

// The removed actions must still PARSE, so that an old invocation reaches the
// identity refusal (with the gh command to run) instead of a generic usage
// error from parseArgs. These assert the flags stay accepted.
test("parseArgs: pr merge --rebase --title 'msg' still parses", () => {
  const p = parseArgs(["pr", "merge", "5", "--rebase", "--title", "msg"]);
  assert.equal(p.flags.has("rebase"), true);
  assert.equal(p.options.get("title"), "msg");
});

test("parseArgs: issue create --labels collects multi-value list", () => {
  const p = parseArgs([
    "issue",
    "create",
    "--title",
    "Bug X",
    "--labels",
    "bug",
    "priority-high",
  ]);
  assert.equal(p.options.get("title"), "Bug X");
  assert.deepEqual(p.multi.get("labels"), ["bug", "priority-high"]);
});

test("parseArgs: pr create --draft still parses", () => {
  const p = parseArgs([
    "pr",
    "create",
    "--head",
    "feature/x",
    "--title",
    "T",
    "--draft",
  ]);
  assert.equal(p.flags.has("draft"), true);
  assert.equal(p.options.get("head"), "feature/x");
});

test("parseArgs: --ready / --no-draft are still recognized flags", () => {
  assert.equal(parseArgs(["pr", "create", "--ready"]).flags.has("ready"), true);
  assert.equal(
    parseArgs(["pr", "create", "--no-draft"]).flags.has("no-draft"),
    true,
  );
});

test("parseArgs: missing value for known option throws", () => {
  assert.throws(() => parseArgs(["--app"]), /Missing value for --app/);
});

test("parseArgs: unknown option throws", () => {
  assert.throws(() => parseArgs(["--bogus", "x"]), /Unknown option: --bogus/);
});

test("parseArgs: -h / --help marks help flag", () => {
  assert.equal(parseArgs(["-h"]).flags.has("help"), true);
  assert.equal(parseArgs(["--help"]).flags.has("help"), true);
});
