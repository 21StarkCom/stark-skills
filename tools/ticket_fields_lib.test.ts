// Tests for `tools/ticket_fields_lib.ts` — the open-time ticket-field stamp
// (STARK-6108; alfred spec STARK-6093 node T7).
//
// Everything here drives the pure functions with a fake `run`, so no case
// reaches a real `alfred`. The CLI wiring — that `copilot_land land` actually
// CALLS this, with the arguments claimed — is proven end to end against stub
// executables in `copilot_land.test.ts`, because a library with a green unit
// suite and no live caller is exactly the dead code a green gate hides.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  resolveTicketForFields,
  ticketFromBranch,
  ticketFromRepoInfo,
  writePrOpenFields,
  writeTicketFields,
  type FieldRun,
  type FieldRunResult,
} from "./ticket_fields_lib.ts";

/** A `run` that records every invocation and replays canned results. */
function recorder(
  replies: (args: string[]) => FieldRunResult,
): { run: FieldRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: FieldRun = (cmd, args) => {
    calls.push([cmd, ...args]);
    return replies(args);
  };
  return { run, calls };
}

const NEVER_RUN: FieldRun = () => {
  throw new Error("run() should not have been called");
};

const OK: FieldRunResult = { code: 0, stdout: "{}", stderr: "" };

// ── Ticket resolution ───────────────────────────────────────────────────────

test("ticketFromBranch: reads a STARK handle out of a branch, case-insensitively", () => {
  assert.equal(ticketFromBranch("copilot/STARK-6108-fields"), "STARK-6108");
  assert.equal(ticketFromBranch("build/stark-42-thing"), "STARK-42");
  assert.equal(ticketFromBranch("spec/ticket-custom-fields"), null);
  assert.equal(ticketFromBranch(""), null);
  assert.equal(ticketFromBranch(null), null);
  assert.equal(ticketFromBranch(undefined), null);
});

test("ticketFromBranch: the matcher carries no lastIndex between calls", () => {
  // A module-level /g regex would make the SECOND call start scanning where the
  // first stopped, so a process that lands two PRs would silently stamp only
  // the first. The bug is invisible in any single-call test.
  const branch = "copilot/STARK-6108-fields";
  assert.equal(ticketFromBranch(branch), "STARK-6108");
  assert.equal(ticketFromBranch(branch), "STARK-6108");
  assert.equal(ticketFromBranch(branch), "STARK-6108");
});

test("resolveTicketForFields: explicit wins, and is taken verbatim", () => {
  // Verbatim, NOT regex-matched: --ticket is the operator saying which ticket
  // this is. Dropping an unrecognized handle would silently fall through to the
  // branch and stamp a DIFFERENT ticket with no sign of the override.
  const explicit = resolveTicketForFields({
    explicit: "stark-77",
    branch: "copilot/STARK-6108-fields",
    run: NEVER_RUN,
  });
  assert.deepEqual(explicit, { ticket: "STARK-77", source: "explicit" });

  const odd = resolveTicketForFields({ explicit: " proj-12 ", branch: null, run: NEVER_RUN });
  assert.deepEqual(odd, { ticket: "PROJ-12", source: "explicit" });
});

test("resolveTicketForFields: a blank --ticket is absent, not a claim", () => {
  // `--ticket "$UNSET_VAR"` is present-but-blank. Treating it as an explicit
  // answer would resolve to the empty string and write onto nothing.
  const { run, calls } = recorder(() => ({ code: 0, stdout: '{"ticket":"STARK-5"}', stderr: "" }));
  const resolved = resolveTicketForFields({ explicit: "   ", branch: null, run });
  assert.deepEqual(resolved, { ticket: "STARK-5", source: "repo-info" });
  assert.deepEqual(calls, [["alfred", "repo", "info", "--json"]]);
});

test("resolveTicketForFields: branch beats repo-info, and short-circuits the subprocess", () => {
  const resolved = resolveTicketForFields({
    branch: "copilot/STARK-6108-fields",
    run: NEVER_RUN,
  });
  assert.deepEqual(resolved, { ticket: "STARK-6108", source: "branch" });
});

test("resolveTicketForFields: falls back to alfred's bound ticket", () => {
  const { run, calls } = recorder(() => ({
    code: 0,
    stdout: JSON.stringify({ name: "stark-skills", ticket: "STARK-6108" }),
    stderr: "",
  }));
  const resolved = resolveTicketForFields({ branch: "copilot/no-handle", run });
  assert.deepEqual(resolved, { ticket: "STARK-6108", source: "repo-info" });
  assert.deepEqual(calls, [["alfred", "repo", "info", "--json"]]);
});

test("resolveTicketForFields: no ticket anywhere names the branch it looked at", () => {
  const { run } = recorder(() => ({ code: 0, stdout: "{}", stderr: "" }));
  const resolved = resolveTicketForFields({ branch: "copilot/no-handle", run });
  assert.equal(resolved.ticket, null);
  assert.equal(resolved.source, "none");
  assert.match(resolved.reason ?? "", /copilot\/no-handle/);
  assert.match(resolved.reason ?? "", /no bound ticket/);
});

test("ticketFromRepoInfo: every broken shape is 'no ticket', never an exception", () => {
  // Each of these is a real shape: alfred absent (spawn throw), a non-zero exit,
  // stdout that is not JSON (a warning line), a JSON scalar, and a `.ticket`
  // that is absent, blank, or not a string. A throw from any of them would take
  // down a landing whose PR is already open.
  const throws: FieldRun = () => {
    throw new Error("spawn alfred ENOENT");
  };
  assert.equal(ticketFromRepoInfo(throws), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 1, stdout: "", stderr: "not a repo" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: "warning: x", stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: "null", stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: '"STARK-1"', stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: "{}", stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: '{"ticket":""}', stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: '{"ticket":"  "}', stderr: "" })), null);
  assert.equal(ticketFromRepoInfo(() => ({ code: 0, stdout: '{"ticket":42}', stderr: "" })), null);
});

// ── The write ───────────────────────────────────────────────────────────────

test("writeTicketFields: builds the exact alfred argv, one --field per pair", () => {
  const { run, calls } = recorder(() => ({ code: 0, stdout: '{"fields_set":["pr_url"]}', stderr: "" }));
  const result = writeTicketFields(
    "STARK-6108",
    [
      { name: "pr_url", value: "https://github.com/o/r/pull/1" },
      { name: "pr_state", value: "open" },
    ],
    run,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[
    "alfred", "task", "edit",
    "--field", "pr_url=https://github.com/o/r/pull/1",
    "--field", "pr_state=open",
    "--json", "STARK-6108",
  ]]);
});

test("writeTicketFields: an empty value is refused before the spawn", () => {
  // `--field pr_url=` is an alfred exit 2. Refusing here names the FIELD, which
  // is what the caller has to print, instead of a generic CLI refusal.
  const { run, calls } = recorder(() => OK);
  const empty = writeTicketFields("STARK-1", [{ name: "pr_url", value: "" }], run);
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /pr_url has no value/);

  const blankName = writeTicketFields("STARK-1", [{ name: " ", value: "x" }], run);
  assert.equal(blankName.ok, false);

  const none = writeTicketFields("STARK-1", [], run);
  assert.equal(none.ok, false);

  assert.deepEqual(calls, [], "nothing should have been spawned");
});

test("writeTicketFields: alfred's own refusal comes back as ok:false, never a throw", () => {
  const laddered = writeTicketFields(
    "STARK-1",
    [{ name: "pr_state", value: "open" }],
    () => ({ code: 2, stdout: "", stderr: "pr_state: refusing to move back (current value merged)" }),
  );
  assert.equal(laddered.ok, false);
  assert.match(laddered.error ?? "", /exited 2/);
  assert.match(laddered.error ?? "", /current value merged/);

  const spawnFailed = writeTicketFields("STARK-1", [{ name: "pr_state", value: "open" }], () => {
    throw new Error("spawn alfred ENOENT");
  });
  assert.equal(spawnFailed.ok, false);
  assert.match(spawnFailed.error ?? "", /could not run/);
});

test("writeTicketFields: a silent refusal still yields a usable line", () => {
  // Exit non-zero with nothing on either stream. Reporting an empty `exited 2:`
  // would leave the operator with a skip and no reason at all.
  const quiet = writeTicketFields(
    "STARK-1",
    [{ name: "pr_state", value: "open" }],
    () => ({ code: 2, stdout: "   \n", stderr: "" }),
  );
  assert.equal(quiet.ok, false);
  assert.match(quiet.error ?? "", /exited 2: no output/);
});

// ── writePrOpenFields: the one entry point ──────────────────────────────────

test("writePrOpenFields: stamps pr_url and pr_state=open on the resolved ticket", () => {
  const { run, calls } = recorder(() => OK);
  const report = writePrOpenFields({
    branch: "copilot/STARK-6108-fields",
    prUrl: "https://github.com/21StarkCom/stark-skills/pull/900",
    run,
  });
  assert.equal(report.wrote, true);
  assert.equal(report.ticket, "STARK-6108");
  assert.equal(report.source, "branch");
  assert.deepEqual(report.fields, ["pr_url", "pr_state"]);
  assert.match(report.line, /^ticket fields: wrote pr_url=https:\/\/github\.com/);
  assert.match(report.line, /pr_state=open on STARK-6108 \(ticket from branch\)/);
  assert.deepEqual(calls, [[
    "alfred", "task", "edit",
    "--field", "pr_url=https://github.com/21StarkCom/stark-skills/pull/900",
    "--field", "pr_state=open",
    "--json", "STARK-6108",
  ]]);
});

test("writePrOpenFields: an empty PR url skips rather than writing half the pair", () => {
  // `landImpl` reports `html_url ?? ""` on the adopt path. Writing pr_state=open
  // alone would leave the ticket claiming an open PR it cannot name.
  const { run, calls } = recorder(() => OK);
  const report = writePrOpenFields({ explicit: "STARK-6108", prUrl: "", run });
  assert.equal(report.wrote, false);
  assert.equal(report.ticket, "STARK-6108");
  assert.deepEqual(report.fields, []);
  assert.match(report.line, /^ticket fields: skipped \(the PR reported no URL\)/);
  assert.deepEqual(calls, [], "no alfred call should have been made");

  const missing = writePrOpenFields({ explicit: "STARK-6108", prUrl: undefined, run });
  assert.equal(missing.wrote, false);
});

test("writePrOpenFields: every outcome renders exactly one 'ticket fields: ' line", () => {
  // Rule 2 of the module: a skip that prints nothing is indistinguishable from
  // a successful write, which is how a whole plane of ticket state stays empty.
  const reports = [
    writePrOpenFields({ branch: "copilot/STARK-1-x", prUrl: "https://u/pull/1", run: () => OK }),
    writePrOpenFields({ branch: "copilot/none", prUrl: "https://u/pull/1", run: () => ({ code: 0, stdout: "{}", stderr: "" }) }),
    writePrOpenFields({ branch: "copilot/STARK-1-x", prUrl: "", run: () => OK }),
    writePrOpenFields({
      branch: "copilot/STARK-1-x",
      prUrl: "https://u/pull/1",
      run: () => ({ code: 2, stdout: "", stderr: "jiraVerbUnsupported" }),
    }),
  ];
  for (const report of reports) {
    assert.match(report.line, /^ticket fields: /);
    assert.equal(report.line.includes("\n"), false, `multi-line report: ${report.line}`);
  }
  assert.deepEqual(reports.map((r) => r.wrote), [true, false, false, false]);
});
