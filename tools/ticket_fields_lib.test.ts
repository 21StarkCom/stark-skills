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
  alfredSkipReason,
  resolveTicketForFields,
  ticketFromBranch,
  ticketFromRepoInfo,
  writePrOpenFields,
  firstDiagnosticLine,
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

test("ticketFromBranch: the handle is a whole word, never a substring", () => {
  // Without a leading \b the match runs INSIDE a longer word, so a branch that
  // merely mentions the org resolves to a ticket it never named — and the
  // stamp lands on somebody else's ticket with no sign of the mistake.
  assert.equal(ticketFromBranch("copilot/21stark-6108-fix"), null);
  assert.equal(ticketFromBranch("copilot/nostark-42"), null);
  // The real shapes still resolve: `/` and `-` are both non-word characters.
  assert.equal(ticketFromBranch("copilot/STARK-6108-fields"), "STARK-6108");
  assert.equal(ticketFromBranch("build/stark-42-thing"), "STARK-42");
  assert.equal(ticketFromBranch("STARK-7"), "STARK-7");
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

test("the case raise is scoped to the custom-id shape, never a provider id", () => {
  // alfred takes `<id|STARK-n>`. `workCustomIDShape` is case-SENSITIVE
  // `^STARK-[0-9]+$`, so a lower-cased handle must be raised — but a raw
  // ClickUp task id is the other legal selector, ClickUp mints those
  // lower-case, and `repo info`'s `.ticket` IS one whenever the ticket has no
  // custom id (refLabel falls back to r.ID). A blanket .toUpperCase() passes
  // alfred's local `^[A-Za-z0-9]+$` shape check and then 404s at the live
  // read, so the write is lost and the skip line blames the provider.
  const explicit = resolveTicketForFields({
    explicit: "z8znm10hn8",
    branch: null,
    run: NEVER_RUN,
  });
  assert.deepEqual(explicit, { ticket: "z8znm10hn8", source: "explicit" });

  assert.equal(
    ticketFromRepoInfo(() => ({ code: 0, stdout: '{"ticket":"z8znm10hn8"}', stderr: "" })),
    "z8znm10hn8",
  );
  // The custom-id shape is still raised, from either rung.
  assert.equal(
    ticketFromRepoInfo(() => ({ code: 0, stdout: '{"ticket":"stark-6108"}', stderr: "" })),
    "STARK-6108",
  );
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

// The two payloads alfred REALLY produces on the unset-space_id path, copied
// from its emitters rather than imagined: `fieldEditOut` marshals `Skipped` as
// a JSON **string** under `fields_skipped`
// (alfred/internal/cli/task_fields.go:174, set at :212), and the text line goes
// out as `cwarn(stderr, "alfred: %s\n", FieldsSkippedNoSpaceID)` (:213), so it
// carries alfred's own `alfred: ` prefix.
//
// This matters more than it looks: the first cut of `alfredSkipReason` expected
// an ARRAY and anchored the line at `^[ \t]*`, and its tests asserted those
// invented shapes. Every assertion passed while the function returned null for
// all three real ones — the exact false `wrote` it exists to prevent, behind a
// green suite. Fixtures for an external CLI come from that CLI.
const ALFRED_SKIP_JSON = JSON.stringify({
  fields_set: [],
  fields_skipped_same_value: [],
  ladder_restarted: false,
  field_ops: [],
  fields_skipped: "fields: skipped (clickup.space_id unset)",
});
const ALFRED_SKIP_STDERR = "alfred: fields: skipped (clickup.space_id unset)\n";

test("alfredSkipReason: exit 0 is not a write", () => {
  // With clickup.space_id unset, `alfred task edit --field` says so and exits 0
  // — the spec is explicit that nothing about fields makes a config red.
  assert.match(alfredSkipReason(ALFRED_SKIP_JSON) ?? "", /clickup\.space_id unset/);
  assert.match(alfredSkipReason("{}", ALFRED_SKIP_STDERR) ?? "", /clickup\.space_id unset/);
  assert.match(alfredSkipReason(ALFRED_SKIP_JSON, ALFRED_SKIP_STDERR) ?? "", /clickup\.space_id unset/);

  // Tolerated variants: an unprefixed line (a future non-cwarn caller) and an
  // array-valued key (a future alfred widening the field). Neither is the live
  // shape; both cost one branch and buy insurance against a false "wrote".
  assert.match(alfredSkipReason("fields: skipped (clickup.space_id unset)\n") ?? "", /unset/);
  assert.equal(
    alfredSkipReason('{"fields_skipped":["pr_url","pr_state"]}'),
    "alfred skipped pr_url, pr_state",
  );

  // A real write, and the shapes that must NOT read as a skip. An empty
  // `fields_set` is a same-value re-write, which the spec says journals
  // nothing — and `land` re-runs on the adopt path by design, so reading that
  // as a skip would cry wolf on every healthy second landing. `omitempty`
  // means a healthy run omits `fields_skipped` entirely, and the SIBLING key
  // `fields_skipped_same_value` means the opposite of a skip, so a prefix
  // match on the key name would invert this case.
  assert.equal(alfredSkipReason('{"fields_set":["pr_url","pr_state"]}'), null);
  assert.equal(
    alfredSkipReason(
      JSON.stringify({ fields_set: [], fields_skipped_same_value: ["pr_url", "pr_state"], field_ops: [] }),
    ),
    null,
  );
  assert.equal(alfredSkipReason('{"fields_set":[],"fields_skipped":""}'), null);
  assert.equal(alfredSkipReason('{"fields_set":[],"fields_skipped":[]}'), null);
  assert.equal(alfredSkipReason("not json at all"), null);
});

test("writeTicketFields: an exit 0 that wrote nothing is reported as a skip", () => {
  // Driven by alfred's real pair — the `--json` string key on stdout and the
  // `alfred: `-prefixed warning on stderr — exactly as a live run delivers them.
  const skipped = writeTicketFields(
    "STARK-1",
    [{ name: "pr_state", value: "open" }],
    () => ({ code: 0, stdout: ALFRED_SKIP_JSON, stderr: ALFRED_SKIP_STDERR }),
  );
  assert.equal(skipped.ok, true, "the process itself succeeded");
  assert.match(skipped.skipped ?? "", /clickup\.space_id unset/);

  // And the entry point must not claim a write over it — a `wrote pr_url=…`
  // line on an untouched ticket is the silent skip with a voice.
  const report = writePrOpenFields({
    explicit: "STARK-1",
    prUrl: "https://github.com/o/r/pull/1",
    run: () => ({ code: 0, stdout: ALFRED_SKIP_JSON, stderr: ALFRED_SKIP_STDERR }),
  });
  assert.equal(report.wrote, false);
  assert.deepEqual(report.fields, ["pr_url", "pr_state"]);
  assert.match(report.line, /^ticket fields: skipped \(alfred skipped the fields: .*clickup\.space_id unset\)/);
  assert.match(report.line, /on STARK-1$/);

  // A healthy write over the same path still reads as a write: `omitempty`
  // drops `fields_skipped` entirely, so nothing here can turn a real write
  // into a reported skip.
  const wrote = writePrOpenFields({
    explicit: "STARK-1",
    prUrl: "https://github.com/o/r/pull/1",
    run: () => ({
      code: 0,
      stdout: JSON.stringify({ fields_set: ["pr_url", "pr_state"], field_ops: ["a", "b"] }),
      stderr: "",
    }),
  });
  assert.equal(wrote.wrote, true);
});

test("writeTicketFields: alfred's JSON log lines never stand in for the error", () => {
  // Measured live on STARK-6108 (2026-09-20). alfred logs one JSON record per
  // HTTP attempt to stderr, so they are the FIRST thing there on any run that
  // reached ClickUp, and "first non-empty line" reported
  // `exited 1: {"time":…,"level":"INFO","msg":"clickup.request",…}` — noise
  // occupying the single line rule 2 promises is the whole report.
  const LOGS = [
    '{"time":"2026-09-20T06:44:08.104569+03:00","level":"INFO","msg":"clickup.request","op":"clickup.get_task","attempt":1}',
    '{"time":"2026-09-20T06:44:08.615397+03:00","level":"INFO","msg":"clickup.request","op":"clickup.get_task","status":200,"latency_ms":511}',
  ].join("\n");

  const result = writeTicketFields(
    "STARK-6108",
    [{ name: "pr_state", value: "open" }],
    () => ({
      code: 1,
      stdout: "",
      stderr: `${LOGS}\nalfred: task edit: delivery failed: field pr_url left journaled\n`,
    }),
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /delivery failed: field pr_url left journaled/);
  assert.doesNotMatch(result.error ?? "", /clickup\.request/);

  // Recognised by SHAPE, not by a leading `{`: alfred's own `--json` payload is
  // an object too, and on a failure with nothing else to say it is the most
  // informative thing available — so it must not be filtered out.
  assert.equal(
    firstDiagnosticLine("", '{"fields_set":[],"error":"something structured"}'),
    '{"fields_set":[],"error":"something structured"}',
  );

  // Degrade, never blank: when a stream carried ONLY log lines, report one of
  // them rather than claiming "no output" over a stream that had content.
  assert.match(firstDiagnosticLine(LOGS, ""), /clickup\.request/);
  assert.equal(firstDiagnosticLine("", ""), "no output");

  // stderr still outranks stdout when both carry a real message.
  assert.equal(firstDiagnosticLine("the real error", "some stdout"), "the real error");
});

test("writeTicketFields: a spawn that never happened does not report an exit status", () => {
  // `FieldRunResult.code` is -1 for a spawn failure by this module's own
  // contract, and no process exits -1. Saying so misdirects the operator to
  // alfred's exit codes for a `command not found`.
  const missing = writeTicketFields(
    "STARK-1",
    [{ name: "pr_state", value: "open" }],
    () => ({ code: -1, stdout: "", stderr: "spawn alfred ENOENT" }),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /could not run: spawn alfred ENOENT/);
  assert.doesNotMatch(missing.error ?? "", /exited/);
});

test("writeTicketFields: a blank-but-present stderr does not hide a real stdout reason", () => {
  // `stderr || stdout` is truthy for "  ", so that spelling discarded the only
  // message alfred emitted and reported "no output".
  const quiet = writeTicketFields(
    "STARK-1",
    [{ name: "pr_state", value: "open" }],
    () => ({ code: 2, stdout: "pr_state: refusing to move back", stderr: "   " }),
  );
  assert.equal(quiet.ok, false);
  assert.match(quiet.error ?? "", /exited 2: pr_state: refusing to move back/);
});

test("writeTicketFields: names and values reach alfred trimmed", () => {
  const { run, calls } = recorder(() => OK);
  writeTicketFields("STARK-1", [{ name: " pr_url ", value: " https://u/pull/1 " }], run);
  assert.deepEqual(calls[0]?.slice(0, 4), [
    "alfred", "task", "edit", "--field",
  ]);
  assert.equal(calls[0]?.[4], "pr_url=https://u/pull/1");
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
