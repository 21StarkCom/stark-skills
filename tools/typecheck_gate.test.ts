// Guards the shape that makes `.github/workflows/tests.yml`'s jobs real gates.
//
// STARK-5008: `typecheck` was not in `main`'s ruleset required checks, so a
// type regression merged on a rollup that read green — `node --test` strips
// types rather than checking them, so the `test` job cannot catch one. Adding
// the context alone would NOT have fixed it: the step carried
// `continue-on-error: true`, which reports the CHECK as SUCCESS whether or not
// `tsc` passed, so requiring it would have satisfied the gate unconditionally.
//
// Two regressions this pins out, both of which turn a required check back into
// decoration while the merge box still renders green:
//   1. `continue-on-error` reappearing on a job that backs a required check.
//   2. A new sibling job landing in this workflow without anyone deciding
//      whether it is required — which is exactly how `typecheck` was missed.
//
// The ruleset itself lives on GitHub and is not readable offline, so this test
// pins the local half of the contract and names the remote half below.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW_PATH = "../.github/workflows/tests.yml";

// Required status-check contexts on `main`, ruleset 20607400, measured
// 2026-09-16 with `gh api repos/21StarkCom/stark-skills/rules/branches/main`:
//   ["Analyze (go)", "Analyze (javascript-typescript)", "test", "typecheck"]
// The two CodeQL contexts come from `codeql.yml`; these two come from
// `tests.yml`. A check-run name is the job id unless the job sets `name:`.
const REQUIRED_FROM_THIS_WORKFLOW = ["test", "typecheck"];

const workflow = readFileSync(new URL(WORKFLOW_PATH, import.meta.url), "utf8");

/**
 * Drop whole-line comments. The workflow's own prose names the directives this
 * file bans, so matching raw text would fire on the warning rather than the
 * regression it warns about.
 */
function stripComments(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Split the `jobs:` mapping into `{ jobId: rawBody }`, comments included. */
function parseJobs(yaml: string): Map<string, string> {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(start, -1, "tests.yml must have a top-level `jobs:` block");

  const jobs = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];

  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-blank line ends the jobs block.
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      if (current) jobs.set(current, body.join("\n"));
      current = header[1];
      body = [];
      continue;
    }
    if (current) body.push(line);
  }
  if (current) jobs.set(current, body.join("\n"));
  return jobs;
}

const jobs = parseJobs(workflow);

test("tests.yml defines exactly the jobs whose checks are required on main", () => {
  assert.deepEqual(
    [...jobs.keys()].sort(),
    [...REQUIRED_FROM_THIS_WORKFLOW].sort(),
    "a job was added to or removed from tests.yml. Every job here reports a " +
      "check on every PR; decide whether it belongs in ruleset 20607400's " +
      "required_status_checks, apply that, then update this list. Listing one " +
      "of two sibling jobs is how STARK-5008 happened.",
  );
});

test("no job backing a required check swallows its own failure", () => {
  for (const [id, body] of jobs) {
    assert.ok(
      !/^\s*continue-on-error\s*:/m.test(stripComments(body)),
      `job \`${id}\` carries continue-on-error. Its check is required on ` +
        "main, and continue-on-error reports SUCCESS whether the step passed " +
        "or not — the gate would be satisfied unconditionally.",
    );
  }
});

test("no job backing a required check is draft-guarded", () => {
  // A guarded job reports `skipped`, and GitHub counts skipped as satisfying a
  // required check. See standards/workflows/skip-draft-guard.md.
  for (const [id, body] of jobs) {
    assert.ok(
      !/^ {4}if:/m.test(stripComments(body)),
      `job \`${id}\` is conditional. A skipped required check reads as a pass.`,
    );
  }
});

test("the typecheck job actually runs tsc over tools/", () => {
  const body = jobs.get("typecheck");
  assert.ok(body, "typecheck job missing");
  assert.match(body!, /working-directory: tools/);
  assert.match(body!, /tsc -p \./);
});

test("runs cannot be cancelled out from under a required check", () => {
  // `pr-merge` pushes then un-drafts moments later: two events, same sha.
  // Cancelling leaves `test: CANCELLED`, which GitHub counts as failing.
  assert.match(workflow, /cancel-in-progress: false/);
});
