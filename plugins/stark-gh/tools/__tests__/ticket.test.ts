import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TICKET_POLICY,
  loadTicketPolicy,
  extractTicketFromBranch,
  extractTicketFromTitle,
  checkTitleTicket,
} from "../lib/ticket.ts";
import { decideTicketRequirement } from "../gh_pr_open_preflight.ts";

const OFF = DEFAULT_TICKET_POLICY;
const ON = { requireTicketScope: true, ticketKey: "STARK" };

// --- policy loading --------------------------------------------------------

test("loadTicketPolicy: absent config is off", () => {
  const r = loadTicketPolicy("/repo", () => { throw new Error("should not read"); }, () => false);
  assert.deepEqual(r.policy, DEFAULT_TICKET_POLICY);
  assert.equal(r.warning, null);
});

test("loadTicketPolicy: reads the opt-in", () => {
  const r = loadTicketPolicy("/repo", () => '{"requireTicketScope":true,"ticketKey":"stark"}', () => true);
  assert.deepEqual(r.policy, { requireTicketScope: true, ticketKey: "STARK" });
  assert.equal(r.warning, null);
  assert.equal(r.error, null);
});

test("loadTicketPolicy: a PRESENT but broken config is a FATAL error, not silent-off", () => {
  // A gate that has been opted into must fail closed on a broken config, never
  // revert to off unnoticed.
  for (const body of ["{ not json", '"a string"', "[1,2]"]) {
    const r = loadTicketPolicy("/repo", () => body, () => true);
    assert.notEqual(r.error, null, body);
  }
});

test("loadTicketPolicy: wrong-typed fields are fatal", () => {
  for (const body of ['{"requireTicketScope":"yes"}', '{"ticketKey":"way-too-long-key!"}']) {
    const r = loadTicketPolicy("/repo", () => body, () => true);
    assert.notEqual(r.error, null, body);
  }
});

test("loadTicketPolicy: enforcement without a ticketKey is fatal", () => {
  // A keyless generic scan would fabricate tickets from version tokens.
  const r = loadTicketPolicy("/repo", () => '{"requireTicketScope":true}', () => true);
  assert.match(r.error!, /needs a "ticketKey"/);
});

test("loadTicketPolicy: unknown keys warn but do not block", () => {
  const r = loadTicketPolicy("/repo", () => '{"requireTicketScope":true,"ticketKey":"STARK","nope":1}', () => true);
  assert.equal(r.error, null);
  assert.match(r.warning!, /unknown key/);
});

// --- branch resolution -----------------------------------------------------

test("extractTicketFromBranch: finds the configured key in any case", () => {
  for (const b of ["worktree-STARK-229", "stark-229-retro", "feat/STARK-7-thing", "STARK-42"]) {
    assert.match(extractTicketFromBranch(b, "STARK") ?? "", /^STARK-\d+$/, b);
  }
  assert.equal(extractTicketFromBranch("stark-229-retro", "STARK"), "STARK-229");
});

test("extractTicketFromBranch: underscore counts as a separator", () => {
  // `\b` treats `_` as a word char; a common branch convention uses it.
  for (const b of ["feature_STARK-247", "STARK-247_wip", "wip_STARK-247"]) {
    assert.equal(extractTicketFromBranch(b, "STARK"), "STARK-247", b);
  }
});

test("extractTicketFromBranch: a key glued to another alnum does not match", () => {
  assert.equal(extractTicketFromBranch("XSTARK-1", "STARK"), null);
  assert.equal(extractTicketFromBranch("STARK-1x", "STARK"), null);
});

test("extractTicketFromBranch: a null key resolves nothing (no keyless mode)", () => {
  assert.equal(extractTicketFromBranch("feat/STARK-9-thing", null), null);
  assert.equal(extractTicketFromBranch("chore/AWS-2-upgrade", null), null);
});

test("extractTicketFromBranch: unrelated branches resolve to nothing", () => {
  for (const b of ["main", "feat/add-the-thing", "dependabot/npm_and_yarn/foo-1.2.3"]) {
    assert.equal(extractTicketFromBranch(b, "STARK"), null, b);
  }
});

// --- title checks ----------------------------------------------------------

test("extractTicketFromTitle: reads the ticket out of a conventional title", () => {
  assert.equal(extractTicketFromTitle("feat(STARK-247): gate pr-open"), "STARK-247");
  assert.equal(extractTicketFromTitle("feat(STARK-247)!: breaking"), "STARK-247");
  assert.equal(extractTicketFromTitle("feat: no scope"), null);
  assert.equal(extractTicketFromTitle("feat(tools): non-ticket scope"), null);
});

test("checkTitleTicket: rejects a ticket-less title", () => {
  const why = checkTitleTicket("feat: add the thing", "STARK-247");
  assert.match(why!, /must carry a ticket scope/);
});

test("checkTitleTicket: rejects the wrong ticket", () => {
  const why = checkTitleTicket("feat(STARK-1): wrong", "STARK-247");
  assert.match(why!, /does not match the branch's ticket/);
});

test("checkTitleTicket: accepts the right ticket", () => {
  assert.equal(checkTitleTicket("feat(STARK-247): gate pr-open", "STARK-247"), null);
  assert.equal(checkTitleTicket("feat(STARK-9): any ticket", null), null);
});

test("checkTitleTicket: a wrong-case ticket names the real problem", () => {
  // The ecosystem canonical is uppercase (the merge side requires it), so a
  // lowercase title is still rejected — but the message must say why.
  const why = checkTitleTicket("feat(stark-247): x", "STARK-247");
  assert.match(why!, /must be upper-case/);
  assert.doesNotMatch(why!, /must carry a ticket scope/);
});

// --- the preflight decision ------------------------------------------------

test("decideTicketRequirement: policy off imposes nothing", () => {
  assert.equal(
    decideTicketRequirement({ policy: OFF, branch: "feat/whatever", userTitle: "feat: no ticket", existingPr: false }),
    null,
  );
});

test("decideTicketRequirement: pins the branch's ticket for a drafted title", () => {
  assert.equal(
    decideTicketRequirement({ policy: ON, branch: "stark-247", userTitle: null, existingPr: false }),
    "STARK-247",
  );
});

test("decideTicketRequirement: refuses when no ticket can be resolved", () => {
  assert.throws(
    () => decideTicketRequirement({ policy: ON, branch: "feat/no-ticket", userTitle: null, existingPr: false }),
    /ticket-scope:.*no ticket could be resolved/,
  );
});

test("decideTicketRequirement: refuses a ticket-less explicit title", () => {
  assert.throws(
    () => decideTicketRequirement({ policy: ON, branch: "stark-247", userTitle: "feat: no ticket", existingPr: false }),
    /ticket-scope:.*must carry a ticket scope/,
  );
});

test("decideTicketRequirement: refuses an explicit title naming a different ticket", () => {
  assert.throws(
    () => decideTicketRequirement({ policy: ON, branch: "stark-247", userTitle: "feat(STARK-1): mismatch", existingPr: false }),
    /does not match the branch's ticket/,
  );
});

test("decideTicketRequirement: an explicit title on a ticket-less branch is honored", () => {
  // The branch names nothing, but the author does — that is enough.
  assert.equal(
    decideTicketRequirement({ policy: ON, branch: "scratch", userTitle: "feat(STARK-5): explicit", existingPr: false }),
    "STARK-5",
  );
});

test("decideTicketRequirement: an existing PR with NO title change is not gated", () => {
  // Its title is left untouched; failing would strand branches whose PR
  // predates the policy.
  assert.equal(
    decideTicketRequirement({ policy: ON, branch: "feat/no-ticket", userTitle: null, existingPr: true }),
    null,
  );
});

test("decideTicketRequirement: an existing PR retitled ticket-less is refused", () => {
  // pr-open WRITES an explicit --title onto an existing PR, so it must be
  // validated — otherwise the gate is bypassed by editing rather than creating.
  assert.throws(
    () => decideTicketRequirement({ policy: ON, branch: "stark-247", userTitle: "feat: no ticket", existingPr: true }),
    /must carry a ticket scope/,
  );
});

test("decideTicketRequirement: an existing PR retitled WITH the ticket is accepted", () => {
  assert.equal(
    decideTicketRequirement({ policy: ON, branch: "stark-247", userTitle: "feat(STARK-247): retitle", existingPr: true }),
    "STARK-247",
  );
});
