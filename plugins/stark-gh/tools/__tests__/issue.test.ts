import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, formatLine } from "../lib/issue.ts";

const repo = { owner: "evinced", name: "stark-skills" };

test("branch name produces Refs candidate", () => {
  const cs = extractCandidates({ branch: "feat/123-foo", commits: "", baseRepo: repo });
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.number, 123);
  assert.equal(cs[0]!.relation, "Refs");
  assert.equal(cs[0]!.source, "branch");
});

test("commit close-keyword produces Closes candidate", () => {
  const cs = extractCandidates({ branch: "wip", commits: "fix: blah\n\nFixes #45", baseRepo: repo });
  const closes = cs.find(c => c.number === 45);
  assert.ok(closes);
  assert.equal(closes.relation, "Closes");
  assert.equal(closes.source, "commit-keyword");
});

test("Closes wins over Refs for same number", () => {
  const cs = extractCandidates({
    branch: "feat/45-x",
    commits: "fixes #45",
    baseRepo: repo,
  });
  const fortyFive = cs.find(c => c.number === 45);
  assert.equal(fortyFive!.relation, "Closes");
});

test("cross-repo reference is captured", () => {
  const cs = extractCandidates({ branch: "wip", commits: "see other-org/foo#7", baseRepo: repo });
  const cross = cs.find(c => c.owner === "other-org");
  assert.ok(cross);
  assert.equal(cross.number, 7);
  assert.equal(cross.repo, "foo");
});

test("formatLine emits same-repo and cross-repo correctly", () => {
  assert.equal(
    formatLine({ number: 1, owner: "evinced", repo: "stark-skills", source: "branch", relation: "Refs" }, repo),
    "Refs #1",
  );
  assert.equal(
    formatLine({ number: 7, owner: "other", repo: "thing", source: "cross-repo", relation: "Refs" }, repo),
    "Refs other/thing#7",
  );
});
