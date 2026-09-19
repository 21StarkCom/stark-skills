// Tests for `tools/copilot_land.ts` — the CLI layer. `copilot_land_lib.test.ts` covers the
// pure decisions; nothing covered the argument surface, and that is where two defects lived:
// `--body` was documented required and never validated (so an unset shell variable opened a
// REAL PR with an empty description), and `--lead` defaulted to "claude" in the `--dry-run`
// plan even when unset, contradicting the header that calls the flag inert.
//
// Every case here is `--dry-run` or a pre-flight refusal, so no case reaches git or gh.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI = path.join(import.meta.dirname, "copilot_land.ts");

function run(argv: string[]): { code: number; out: string; error: string } {
  const child = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, out: child.stdout, error: child.stderr };
}

// ── Stubbed-PATH harness for the open-time ticket-field stamp (STARK-6108) ───
//
// These cases run the REAL `land` path — push, PR listing, PR create, then the
// alfred field write — against stub executables on PATH. A unit test of
// `ticket_fields_lib` alone cannot see whether `cmdLand` ever calls it, or with
// which arguments; that wiring seam is the whole point of the ticket, so it is
// proven here rather than asserted.

interface Harness {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Every argv `alfred` was invoked with, one array per invocation. */
  alfredCalls: () => string[][];
}

function writeStub(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/**
 * A temp dir holding stub `git`, `gh` and `alfred` on PATH.
 *
 * `alfredRepoInfo` is the JSON `alfred repo info --json` answers with, and
 * `alfredEditExit` the exit status `alfred task edit` reports — the two knobs
 * every case below turns.
 */
function harness(
  t: { after: (fn: () => void) => void },
  opts: { alfredRepoInfo: string; alfredEditExit?: number; alfredEditStderr?: string },
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-land-fields-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "alfred.log");

  // `rev-parse --abbrev-ref --symbolic-full-name @{u}` must FAIL (no upstream),
  // which selects `push -u`. Everything else succeeds silently.
  writeStub(dir, "git", `#!/bin/sh\n[ "$1" = "rev-parse" ] && exit 1\nexit 0\n`);

  // `gh api .../pulls?...` is slurped, so it must print an ARRAY OF ARRAYS;
  // empty means no open PR for the head, which selects the create path.
  writeStub(
    dir,
    "gh",
    `#!/bin/sh
if [ "$1" = "api" ]; then echo '[[]]'; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/o/r/pull/123"; exit 0
fi
exit 1
`,
  );

  writeStub(
    dir,
    "alfred",
    `#!/bin/sh
# One arg per line, so a value containing a space cannot forge an argv boundary.
for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done
printf '%s\\n' '--' >> "${log}"
if [ "$1" = "repo" ]; then printf '%s' '${opts.alfredRepoInfo}'; exit 0; fi
if [ -n "${opts.alfredEditStderr ?? ""}" ]; then echo '${opts.alfredEditStderr ?? ""}' >&2; fi
echo '{"fields_set":["pr_url","pr_state"]}'
exit ${opts.alfredEditExit ?? 0}
`,
  );

  return {
    dir,
    // PATH is the stub dir ALONE, never prepended to the real one. Prepending
    // looks equivalent and is not: a stub that is absent (the alfred-missing
    // case below) or that declines an argv shape falls THROUGH to the machine's
    // real `git`/`gh`/`alfred`. Measured while writing this — the fall-through
    // reached the operator's installed alfred, resolved this very worktree's
    // bound ticket, and asserted against a live CLI's refusal text. Every stub
    // here is `#!/bin/sh` with an absolute interpreter and shell builtins only,
    // so an empty PATH costs them nothing.
    env: { ...process.env, PATH: dir },
    alfredCalls: () => {
      if (!fs.existsSync(log)) return [];
      const calls: string[][] = [];
      let current: string[] = [];
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (line === "--") {
          calls.push(current);
          current = [];
        } else if (line !== "") {
          current.push(line);
        }
      }
      return calls;
    },
  };
}

function runIn(h: Harness, argv: string[]): { code: number; out: string; error: string } {
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    cwd: h.dir,
    env: h.env,
  });
  return { code: child.status ?? -1, out: child.stdout, error: child.stderr };
}

const LAND_REAL = [
  "land", "--repo", "o/r", "--title", "T", "--body", "B", "--repo-dir",
];

const LAND = ["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--body", "B"];

test("copilot_land land: --body is required, like every other documented-required flag", () => {
  // Without this the run reached `gh pr create --body ""` and opened a real PR with an
  // empty description — a side effect no re-run undoes, since `land` then ADOPTS that PR
  // by head ref rather than opening a correct one.
  const missing = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--dry-run", "--json"]);
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.out), { ok: false, error: "--body is required" });

  // Present-but-empty is refused too: `--body "$UNSET"` is the shape that produced the bug.
  const empty = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--body", "", "--dry-run", "--json"]);
  assert.equal(empty.code, 2);
  assert.deepEqual(JSON.parse(empty.out), { ok: false, error: "--body is required" });

  // Non-JSON mode reports the same refusal on stderr and still exits non-zero.
  const plain = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--dry-run"]);
  assert.equal(plain.code, 2);
  assert.match(plain.error, /--body is required/);

  // And the refusal is ordered after the flags that were already validated, so supplying
  // every flag reaches the plan.
  const ok = run([...LAND, "--dry-run"]);
  assert.equal(ok.code, 0, ok.error);
});

test("copilot_land land: --dry-run echoes lead only when the caller supplied it", () => {
  const unset = JSON.parse(run([...LAND, "--dry-run"]).out);
  // The header calls --lead inert and selecting-nothing. A defaulted "claude" in the plan
  // reads as a selected agent, which is the one thing the flag promises it never does.
  assert.equal("lead" in unset, false, `unset --lead leaked into the plan: ${JSON.stringify(unset)}`);
  assert.equal(unset.dry_run, true);
  assert.equal(unset.base, "main");

  const supplied = JSON.parse(run([...LAND, "--lead", "codex", "--dry-run"]).out);
  assert.equal(supplied.lead, "codex");

  // `--lead "$UNSET_VAR"` is present-but-blank. A `present()` check treats that as
  // supplied and echoes `"lead": ""`, which reads as a selected-but-nameless agent —
  // the same wrong signal the old "claude" default gave, just harder to spot.
  const blank = JSON.parse(run([...LAND, "--lead", "", "--dry-run"]).out);
  assert.equal("lead" in blank, false, `blank --lead leaked into the plan: ${JSON.stringify(blank)}`);
});

test("copilot_land: the header and help name a live command, never the buried copilot skill", () => {
  // The retired-names rule in ~/Code/CLAUDE.md: a buried command must never be presented as
  // live. This text vendors into every bifrost bundle on both runtimes, so a stale name here
  // teaches the dead command to every installed plugin.
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.out, /\/stark-copilot/);
  assert.match(help.out, /\/stark-build/);
});

test("copilot_land writes fields after create", (t) => {
  // The done-when case: a real `land` that opens a PR must stamp pr_url and
  // pr_state=open on the ticket the BRANCH names, through
  // `alfred task edit --field`, and say so in its report.
  const h = harness(t, { alfredRepoInfo: '{"ticket":"STARK-0000"}' });
  const result = runIn(h, [
    ...LAND_REAL, h.dir, "--branch", "copilot/STARK-6108-fields", "--json",
  ]);
  assert.equal(result.code, 0, result.error);

  const payload = JSON.parse(result.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.pr.number, 123);
  assert.deepEqual(payload.ticket_fields, {
    wrote: true,
    ticket: "STARK-6108",
    source: "branch",
    fields: ["pr_url", "pr_state"],
    line:
      "ticket fields: wrote pr_url=https://github.com/o/r/pull/123 pr_state=open " +
      "on STARK-6108 (ticket from branch)",
  });

  // The argv alfred actually received — the wiring seam itself. The branch
  // handle must win over the bound ticket the stub would have reported, and the
  // URL must be the one `gh pr create` printed, not a reconstruction.
  assert.deepEqual(h.alfredCalls(), [[
    "task", "edit",
    "--field", "pr_url=https://github.com/o/r/pull/123",
    "--field", "pr_state=open",
    "--json", "STARK-6108",
  ]]);
});

test("copilot_land writes fields on an explicit --ticket, overriding the branch", (t) => {
  const h = harness(t, { alfredRepoInfo: '{"ticket":"STARK-0000"}' });
  const result = runIn(h, [
    ...LAND_REAL, h.dir,
    "--branch", "copilot/STARK-6108-fields", "--ticket", "STARK-6093", "--json",
  ]);
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.out).ticket_fields.ticket, "STARK-6093");
  assert.deepEqual(h.alfredCalls()[0]?.slice(-2), ["--json", "STARK-6093"]);
});

test("copilot_land skips visibly without ticket", (t) => {
  // No handle in the branch and no bound ticket. The landing still succeeds —
  // the PR is open — and the skip is one line on stdout, never silence.
  const h = harness(t, { alfredRepoInfo: "{}" });
  const result = runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/no-handle", "--json"]);
  assert.equal(result.code, 0, result.error);

  const fields = JSON.parse(result.out).ticket_fields;
  assert.equal(fields.wrote, false);
  assert.equal(fields.ticket, null);
  assert.equal(fields.source, "none");
  assert.match(fields.line, /^ticket fields: skipped \(no ticket/);
  assert.match(fields.line, /copilot\/no-handle/);

  // Only the `repo info` probe ran: nothing was written to a ticket that was
  // never identified.
  assert.deepEqual(h.alfredCalls(), [["repo", "info", "--json"]]);

  // Non-JSON mode prints the same line where a human will see it.
  const plain = runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/no-handle"]);
  assert.equal(plain.code, 0, plain.error);
  assert.match(plain.out, /^ticket fields: skipped \(no ticket/m);
});

test("copilot_land: a refused field write never fails the landing", (t) => {
  // The PR is already open by the time alfred is asked. A non-zero exit there —
  // the pr_state ladder refusing a backwards move, a Jira handle, a dead daemon
  // — must cost one reported line and nothing else.
  const h = harness(t, {
    alfredRepoInfo: '{"ticket":"STARK-6108"}',
    alfredEditExit: 2,
    alfredEditStderr: "pr_state: refusing to move back (current value merged)",
  });
  const result = runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/no-handle", "--json"]);
  assert.equal(result.code, 0, result.error);

  const payload = JSON.parse(result.out);
  assert.equal(payload.ok, true, "the landing itself still succeeded");
  assert.equal(payload.pr.number, 123);
  assert.equal(payload.ticket_fields.wrote, false);
  assert.equal(payload.ticket_fields.source, "repo-info");
  assert.match(payload.ticket_fields.line, /exited 2/);
  assert.match(payload.ticket_fields.line, /current value merged/);
});

test("copilot_land: alfred missing from PATH degrades to a skip, not a crash", (t) => {
  // A machine without alfred installed is the ordinary case for this repo's
  // tools. The spawn failure has to arrive as a result, because nothing
  // downstream of `landImpl` catches.
  const h = harness(t, { alfredRepoInfo: "{}" });
  fs.rmSync(path.join(h.dir, "alfred"));
  const result = runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/no-handle", "--json"]);
  assert.equal(result.code, 0, result.error);
  const payload = JSON.parse(result.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.ticket_fields.wrote, false);
  assert.match(payload.ticket_fields.line, /^ticket fields: skipped \(no ticket/);
});

test("copilot_land land: --dry-run names the ticket it could resolve offline", (t) => {
  // A dry run must not spawn alfred, so it can answer only the first two rungs
  // of the ladder. `null` there means "not decidable without a subprocess",
  // never "no ticket exists" — which is why the real run resolves again.
  const h = harness(t, { alfredRepoInfo: '{"ticket":"STARK-6108"}' });

  const fromBranch = JSON.parse(
    runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/STARK-6108-x", "--dry-run"]).out,
  );
  assert.equal(fromBranch.ticket, "STARK-6108");

  const explicit = JSON.parse(
    runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/x", "--ticket", "STARK-9", "--dry-run"]).out,
  );
  assert.equal(explicit.ticket, "STARK-9");

  const unknown = JSON.parse(runIn(h, [...LAND_REAL, h.dir, "--branch", "copilot/x", "--dry-run"]).out);
  assert.equal(unknown.ticket, null);

  assert.deepEqual(h.alfredCalls(), [], "a dry run must reach no subprocess");
});
