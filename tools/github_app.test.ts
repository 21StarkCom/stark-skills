// CLI parser + flag→API mapping tests for `tools/github_app.ts`.
//
// The pure helpers (`parseArgs`, `reviewEventFromFlags`,
// `mergeMethodFromFlags`) are intentionally exported so that flag-mapping
// regressions — e.g. `--approve` silently downgrading to `COMMENT` — get
// caught at unit-test time instead of via live PR mishaps.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  mergeMethodFromFlags,
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
// mergeMethodFromFlags
// ---------------------------------------------------------------------------

test("mergeMethodFromFlags: --rebase → rebase", () => {
  const flags = new Map<string, true>([["rebase", true]]);
  assert.equal(mergeMethodFromFlags(flags), "rebase");
});

test("mergeMethodFromFlags: --merge → merge", () => {
  const flags = new Map<string, true>([["merge", true]]);
  assert.equal(mergeMethodFromFlags(flags), "merge");
});

test("mergeMethodFromFlags: --squash → squash", () => {
  const flags = new Map<string, true>([["squash", true]]);
  assert.equal(mergeMethodFromFlags(flags), "squash");
});

test("mergeMethodFromFlags: no flag → squash (safe default)", () => {
  assert.equal(mergeMethodFromFlags(new Map()), "squash");
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

test("parseArgs: pr merge --rebase --title 'msg' parses", () => {
  const p = parseArgs(["pr", "merge", "5", "--rebase", "--title", "msg"]);
  assert.equal(p.flags.has("rebase"), true);
  assert.equal(p.options.get("title"), "msg");
  assert.equal(mergeMethodFromFlags(p.flags), "rebase");
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

test("parseArgs: pr create --draft sets the flag", () => {
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
