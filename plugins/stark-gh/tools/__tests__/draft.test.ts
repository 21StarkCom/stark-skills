import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  validateOutput,
  parseFencedJson,
  CONVENTIONAL_COMMIT_TITLE_RE,
  CONVENTIONAL_COMMIT_TYPES,
} from "../gh_pr_open_draft.ts";

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

test("parseFencedJson handles nested ``` fences inside JSON string values", () => {
  // Regression: codex emits a body field containing ```text fenced blocks.
  // The old non-greedy regex stopped at the first inner ``` and broke parse.
  const out = [
    "```json",
    "{",
    '  "title": "docs: x",',
    '  "body": "## Summary\\n\\n```text\\nfoo\\n```\\ndone"',
    "}",
    "```",
  ].join("\n");
  const parsed = parseFencedJson(out) as { title: string; body: string };
  assert.equal(parsed.title, "docs: x");
  assert.match(parsed.body, /```text\nfoo\n```/);
});

test("validateOutput rejects oversized title", () => {
  const r = validateOutput(
    { title: "feat: " + "a".repeat(201), body: null, commit_message: null },
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

test("validateOutput accepts well-formed Conventional Commits titles", () => {
  const cases = [
    "feat: add request_id propagation",
    "fix(slack): handle 429 retry-after",
    "chore(deps): bump golang.org/x/net",
    "refactor(executor)!: require non-nil ActionStore",
    "docs: clarify CLAUDE.md log fields contract",
    "ci: pin pr-title action to a tag",
  ];
  for (const title of cases) {
    const r = validateOutput(
      { title, body: null, commit_message: null },
      { needTitle: true, needBody: false, needCommitMessage: false },
    );
    assert.equal(r.ok, true, `expected ok for "${title}", reason=${r.reason}`);
  }
});

test("validateOutput rejects title missing Conventional Commits type prefix", () => {
  const cases = [
    "Add request_id propagation",                           // no prefix
    "feature: add propagation",                             // wrong type
    "feat add propagation",                                 // no colon-space
    "feat:add propagation",                                 // no space after colon
    "feat(): empty scope",                                  // empty scope
    "feat(scope) : add",                                    // space before colon
    "FEAT: uppercase type",                                 // case-sensitive
  ];
  for (const title of cases) {
    const r = validateOutput(
      { title, body: null, commit_message: null },
      { needTitle: true, needBody: false, needCommitMessage: false },
    );
    assert.equal(r.ok, false, `expected reject for "${title}"`);
    assert.match(r.reason || "", /Conventional Commits/);
  }
});

test("validateOutput enforces same prefix on commit_message subject", () => {
  const bad = validateOutput(
    { title: null, body: null, commit_message: "add request_id propagation" },
    { needTitle: false, needBody: false, needCommitMessage: true },
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason || "", /Conventional Commits/);

  const good = validateOutput(
    { title: null, body: null, commit_message: "feat(obs): add request_id propagation\n\nbody" },
    { needTitle: false, needBody: false, needCommitMessage: true },
  );
  assert.equal(good.ok, true, `expected ok, reason=${good.reason}`);
});

test("CONVENTIONAL_COMMIT_TITLE_RE covers each declared type", () => {
  for (const t of CONVENTIONAL_COMMIT_TYPES) {
    assert.match(`${t}: subject`, CONVENTIONAL_COMMIT_TITLE_RE);
  }
});

test("buildPrompt names the Conventional Commits prefix rule", () => {
  const plan: any = {
    branch: "feat/1",
    baseBranch: "main",
    candidateIssues: { preflight: [] },
    userArgs: { title: null, commitMessage: null },
    stage2: { needTitle: true, needBody: false, needCommitMessage: false },
    untrustedInputs: {
      combinedStat: "", committedDiff: "", stagedDiff: "",
      unstagedDiff: null, untrackedFiles: null, prTemplate: null,
      commitMessages: "", userBody: null,
    },
  };
  const p = buildPrompt(plan);
  assert.match(p, /Conventional Commits type prefix/);
  assert.match(p, /feat, fix, chore/);
});
