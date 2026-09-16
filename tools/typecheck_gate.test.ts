// Guards the shape that makes `.github/workflows/tests.yml`'s jobs real gates.
//
// STARK-5008: `typecheck` was not in `main`'s ruleset required checks, so a
// type regression merged on a rollup that read green — `node --test` strips
// types rather than checking them, so the `test` job cannot catch one. Adding
// the context alone would NOT have fixed it: the step carried
// `continue-on-error: true`, which reports the CHECK as SUCCESS whether or not
// `tsc` passed, so requiring it would have satisfied the gate unconditionally.
//
// Regressions this pins out. Each turns a required check back into decoration
// while the merge box still renders green, or stops it reporting at all:
//   1. `continue-on-error` reappearing on a job that backs a required check.
//   2. A conditional skipping the work — at JOB **or STEP** level. A guarded
//      job reports `skipped`, which GitHub counts as satisfying the check; a
//      guarded step is worse, leaving the job SUCCESS with nothing run.
//   3. A new sibling job landing here without anyone deciding whether it is
//      required — which is exactly how `typecheck` was missed.
//   4. A job-level `name:` renaming the reported context away from the one the
//      ruleset requires, or a trigger narrowing (`types:` / `paths:`) that
//      stops a run existing for the head sha at all. Both leave a required
//      check permanently unreported, which blocks every merge.
//
// The ruleset itself lives on GitHub and is not readable offline, so this test
// pins the local half of the contract and names the remote half below.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW_PATH = "../.github/workflows/tests.yml";
const PACKAGE_PATH = "./package.json";

// Required status-check contexts on `main`, ruleset 20607400, measured
// 2026-09-16 with `gh api repos/21StarkCom/stark-skills/rules/branches/main`:
//   ["Analyze (go)", "Analyze (javascript-typescript)", "test", "typecheck"]
// The two `Analyze` contexts come from GitHub's repo-level code-quality setup —
// a server-side dynamic workflow (`dynamic/github-code-quality/codeql`), NOT a
// file under `.github/workflows/`, so grepping this repo for `codeql.yml` finds
// nothing and proves nothing. These two come from `tests.yml`.
//
// Named EXPECTED_JOBS, not REQUIRED_*: the assertion is "these are all the jobs
// in the file". A future job deliberately left OUT of the ruleset still belongs
// in this list — with a comment saying so.
const EXPECTED_JOBS = ["test", "typecheck"];

/**
 * Drop whole-line comments. The workflow's own prose names the directives this
 * file bans, so matching raw text would fire on the warning rather than the
 * regression it warns about — and, worse, would let a comment that merely
 * MENTIONS a required directive satisfy an assertion after the real line is
 * deleted. Everything below reads the stripped text for that reason.
 */
function stripComments(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Split the `jobs:` mapping into `{ jobId: rawBody }`. */
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
    // The trailing `(#.*)?` is load-bearing: `  lint:  # advisory` is a real
    // job, and a header regex that missed it would hide the new job from the
    // exact-set assertion below — the one guarantee this file exists to make.
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):[ \t]*(#.*)?$/);
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

const workflow = stripComments(
  readFileSync(new URL(WORKFLOW_PATH, import.meta.url), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(new URL(PACKAGE_PATH, import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const jobs = parseJobs(workflow);
const triggers = workflow.slice(0, workflow.indexOf("\njobs:"));

test("tests.yml defines exactly the jobs whose checks are required on main", () => {
  assert.deepEqual(
    [...jobs.keys()].sort(),
    [...EXPECTED_JOBS].sort(),
    "a job was added to or removed from tests.yml. Every job here reports a " +
      "check on every PR; decide whether it belongs in ruleset 20607400's " +
      "required_status_checks, apply that, then update this list. Listing one " +
      "of two sibling jobs is how STARK-5008 happened.",
  );
});

test("no job backing a required check swallows its own failure", () => {
  for (const [id, body] of jobs) {
    assert.ok(
      !/^\s*continue-on-error\s*:/m.test(body),
      `job \`${id}\` carries continue-on-error. Its check is required on ` +
        "main, and continue-on-error reports SUCCESS whether the step passed " +
        "or not — the gate would be satisfied unconditionally.",
    );
  }
});

test("no job backing a required check is conditional, at job or step level", () => {
  // A guarded JOB reports `skipped`, and GitHub counts skipped as satisfying a
  // required check. A guarded STEP is worse: the job still concludes SUCCESS,
  // so the check is green with nothing run. Match any indentation for both.
  // See standards/workflows/skip-draft-guard.md.
  for (const [id, body] of jobs) {
    assert.ok(
      !/^\s*if\s*:/m.test(body),
      `job \`${id}\` is conditional. A skipped required check reads as a ` +
        "pass, and a skipped step leaves the job green with nothing run.",
    );
  }
});

test("no job renames the check context the ruleset requires", () => {
  // The check-run name is the job id UNLESS the job sets `name:`. A rename
  // makes `typecheck` (the required context) never report, so every PR sits on
  // a permanently pending gate while the Actions tab looks green.
  for (const [id, body] of jobs) {
    assert.ok(
      !/^ {4}name\s*:/m.test(body),
      `job \`${id}\` sets a job-level name:, which renames its check-run. ` +
        "Ruleset 20607400 requires the job id; a renamed check never reports.",
    );
  }
});

test("the typecheck job runs the repo's pinned tsc gate over tools/", () => {
  const body = jobs.get("typecheck");
  assert.ok(body, "typecheck job missing");
  assert.match(body!, /working-directory: tools/);
  // `npm run typecheck`, not `npx tsc`: npx silently downloads a missing
  // package from the registry when stdin is not a TTY, so a devDependency drop
  // would quietly move this required gate onto an unpinned latest TypeScript
  // instead of failing. `npm run` resolves the locked local binary or errors.
  assert.match(body!, /npm run typecheck/);
  assert.match(pkg.scripts?.typecheck ?? "", /^tsc -p \.$/);
});

test("the test job runs the suite", () => {
  const body = jobs.get("test");
  assert.ok(body, "test job missing");
  assert.match(body!, /working-directory: tools/);
  assert.match(body!, /npm test/);
  assert.match(pkg.scripts?.test ?? "", /node --test/);
});

test("runs cannot be cancelled out from under a required check", () => {
  // `pr-merge` pushes then un-drafts moments later: two events, same sha.
  // Cancelling leaves `test: CANCELLED`, which GitHub counts as failing.
  assert.match(workflow, /^ {2}cancel-in-progress: false$/m);
  assert.ok(
    !/cancel-in-progress:\s*true/.test(workflow),
    "a cancel-in-progress: true (workflow- or job-level) can cancel a run a " +
      "required check is waiting on, leaving CANCELLED on the head sha.",
  );
});

test("every push to a PR head still produces a run", () => {
  // `if:` is not the only way to stop a job reporting. Narrowing `types:` or
  // adding a path filter means no run exists for the head sha at all, so the
  // required check never reports and the merge gate has to be waived
  // (`idun gh pr-merge --allow-skipped-checks`) — which this repo has no
  // reason to need.
  assert.match(triggers, /types: \[[^\]]*\bopened\b[^\]]*\]/);
  assert.match(triggers, /types: \[[^\]]*\bsynchronize\b[^\]]*\]/);
  assert.ok(
    !/^\s*paths(-ignore)?\s*:/m.test(triggers),
    "tests.yml gained a path filter. A filtered-out PR produces no run, so " +
      "`test` / `typecheck` never report and the merge gate blocks or is " +
      "waived — neither is the gate STARK-5008 installed.",
  );
});
