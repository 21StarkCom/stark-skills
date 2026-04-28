import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, validateOutput, parseFencedJson } from "../gh_pr_open_draft.ts";

test("buildPrompt substitutes plan fields without leaking trusted/untrusted", () => {
  const plan: any = {
    branch: "feat/1",
    baseBranch: "main",
    candidateIssues: { preflight: [] },
    userArgs: { title: null, commitMessage: null },
    stage2: { needTitle: true, needBody: true, needCommitMessage: false },
    untrustedInputs: {
      combinedStat: "X",
      committedDiff: "Y",
      stagedDiff: "Z",
      unstagedDiff: null,
      untrackedFiles: null,
      prTemplate: null,
      commitMessages: "W",
      userBody: null,
    },
  };
  const p = buildPrompt(plan);
  assert.match(p, /UNTRUSTED INPUT BOUNDARY/);
  assert.match(p, /needTitle/);
  assert.match(p, /committedDiff/);
});

test("parseFencedJson extracts the first json block", () => {
  const out = 'preamble\n```json\n{"title":"x"}\n```\nepilogue';
  assert.deepEqual(parseFencedJson(out), { title: "x" });
});

test("validateOutput rejects oversized title", () => {
  const r = validateOutput(
    { title: "a".repeat(201), body: null, commit_message: null },
    { needTitle: true, needBody: false, needCommitMessage: false },
  );
  assert.equal(r.ok, false);
});

test("validateOutput strips Closes/Refs from body but warns", () => {
  const r = validateOutput(
    { title: null, body: "## S\nfoo\nCloses #1\n", commit_message: null },
    { needTitle: false, needBody: true, needCommitMessage: false },
  );
  assert.equal(r.ok, true);
  assert.equal(r.body!.includes("Closes"), false);
  assert.match(r.warnings.join(","), /closes/i);
});
