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
});

test("loadTicketPolicy: malformed config falls back to off, with a warning", () => {
  // A broken config must not silently start blocking every PR — nor silently
  // stop enforcing without saying so.
  for (const body of ["{ not json", '"a string"', "[1,2]"]) {
    const r = loadTicketPolicy("/repo", () => body, () => true);
    assert.equal(r.policy.requireTicketScope, false);
    assert.notEqual(r.warning, null);
  }
});

test("loadTicketPolicy: wrong-typed fields warn and keep the default", () => {
  const r = loadTicketPolicy("/repo", () => '{"requireTicketScope":"yes","ticketKey":"way-too-long-key!"}', () => true);
  assert.deepEqual(r.policy, DEFAULT_TICKET_POLICY);
  assert.match(r.warning!, /requireTicketScope must be a boolean/);
  assert.match(r.warning!, /ticketKey must be/);
});

// --- branch resolution -----------------------------------------------------

test("extractTicketFromBranch: finds the configured key in any case", () => {
  for (const b of ["worktree-STARK-229", "stark-229-retro", "feat/STARK-7-thing", "STARK-42"]) {
    assert.match(extractTicketFromBranch(b, "STARK") ?? "", /^STARK-\d+$/, b);
  }
  assert.equal(extractTicketFromBranch("stark-229-retro", "STARK"), "STARK-229");
});

test("extractTicketFromBranch: no configured key means UPPER-CASE only", () => {
  // Without a key to anchor on, an any-case scan turns ordinary branch names
  // into fabricated tickets.
  assert.equal(extractTicketFromBranch("feat/fix-2-things", null), null);
  assert.equal(extractTicketFromBranch("chore/bump-node-22", null), null);
  assert.equal(extractTicketFromBranch("feat/STARK-9-thing", null), "STARK-9");
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

test("decideTicketRequirement: an existing PR is never gated", () => {
  // Its title is not being written here; failing would strand branches whose
  // PR predates the policy.
  assert.equal(
    decideTicketRequirement({ policy: ON, branch: "feat/no-ticket", userTitle: null, existingPr: true }),
    null,
  );
});
