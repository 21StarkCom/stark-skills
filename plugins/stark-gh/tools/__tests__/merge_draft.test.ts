import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScrubbedEnv,
  buildMergePrompt,
  parseFencedJson,
  driveDraft,
  type DraftCtx,
} from "../gh_pr_merge_draft.ts";
import type { PrMergePlan } from "../lib/plan.ts";

const minimalPlan: PrMergePlan = {
  command: "pr-merge",
  schemaVersion: 1,
  createdAt: "2026-04-28T00:00:00Z",
  runId: "test-run",
  pr: {
    number: 42,
    headRef: "feat/foo",
    baseRef: "main",
    url: "https://github.com/o/r/pull/42",
    nameWithOwner: "o/r",
    headRepositoryOwner: "o",
    headRepositoryName: "r",
    isCrossRepository: false,
  },
  baseOid: "base",
  originalHeadOid: "orig",
  rebasedHeadOid: "rebased",
  changelogCommitOid: null,
  pushedHeadOid: null,
  originalChangelogPath: "/tmp/x",
  changelog: { filePath: "/tmp/CL.md", section: "Added", markerComment: "<!-- m -->" },
  startingRef: "feat/foo",
  forceReason: null,
  stage2: { skip: false, subjectFile: null, bodyFile: null, changelogBulletFile: null, model: "gpt-5.5", reasoningEffort: "medium" },
  execute: { watch: true, force: false, watchTimeoutHours: 6, secretOverrides: { commit: false, toLlm: false }, allowNoRequiredChecks: false },
};

const ctx: DraftCtx = {
  prTitle: "Add cool feature",
  prBody: "Implements the cool feature.",
  commitMessages: "feat: add cool",
  diffSummary: " 1 file changed, 10 insertions(+)",
};

test("buildScrubbedEnv: PATH and HOME pass through", () => {
  const env = buildScrubbedEnv({ PATH: "/usr/bin", HOME: "/home/u", GITHUB_TOKEN: "secret", FOO: "bar" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.FOO, undefined);
});

test("buildScrubbedEnv: strips GitHub/AWS/Anthropic/STARK secrets", () => {
  const env = buildScrubbedEnv({
    PATH: "/usr/bin",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    AWS_ACCESS_KEY_ID: "key",
    AWS_SECRET_ACCESS_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    STARK_CLAUDE_PRIVATE_KEY: "secret",
    OPENAI_API_KEY: "ok-passthrough",
  });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.STARK_CLAUDE_PRIVATE_KEY, undefined);
  // OPENAI_API_KEY IS allowed (codex CLI needs it).
  assert.equal(env.OPENAI_API_KEY, "ok-passthrough");
});

test("buildScrubbedEnv: passes through LC_* locale prefix", () => {
  const env = buildScrubbedEnv({ PATH: "/x", LC_TIME: "en_US.UTF-8", LC_NUMERIC: "C" });
  assert.equal(env.LC_TIME, "en_US.UTF-8");
  assert.equal(env.LC_NUMERIC, "C");
});

test("buildMergePrompt: contains untrusted boundary marker + all required keys", () => {
  const p = buildMergePrompt(minimalPlan, ctx);
  assert.match(p, /UNTRUSTED INPUT BOUNDARY/);
  assert.match(p, /pr_number/);
  assert.match(p, /head_ref/);
  assert.match(p, /changelog_section/);
  assert.match(p, /pr_title/);
  assert.match(p, /diff_summary/);
  assert.match(p, /Never emit Closes\/Refs\/Fixes\/Resolves/);
});

test("parseFencedJson: extracts JSON from fenced block", () => {
  const r = parseFencedJson('Here is output:\n```json\n{"a": 1}\n```\n');
  assert.deepEqual(r, { a: 1 });
});

test("parseFencedJson: throws when no fence", () => {
  assert.throws(() => parseFencedJson("no fences here"), /no fenced json/);
});

test("driveDraft: returns valid draft on first attempt", async () => {
  const callCodex = (_prompt: string) => '```json\n{"subject":"feat: add cool feature","body":"Implements it.","changelog_bullet":"- add cool feature"}\n```';
  const r = await driveDraft(minimalPlan, ctx, callCodex);
  assert.equal(r.subject, "feat: add cool feature");
  assert.equal(r.changelog_bullet, "- add cool feature");
});

test("driveDraft: retries once on validation failure, succeeds on second", async () => {
  let calls = 0;
  const callCodex = (prompt: string) => {
    calls++;
    if (calls === 1) {
      // Bad: subject too long
      return '```json\n{"subject":"' + "x".repeat(100) + '","body":"b","changelog_bullet":"- ok"}\n```';
    }
    assert.match(prompt, /PREVIOUS ATTEMPT REJECTED/, "retry should include rejection reason");
    return '```json\n{"subject":"feat: ok","body":"b","changelog_bullet":"- ok"}\n```';
  };
  const r = await driveDraft(minimalPlan, ctx, callCodex);
  assert.equal(calls, 2);
  assert.equal(r.subject, "feat: ok");
});

test("driveDraft: throws after second failure", async () => {
  const callCodex = (_prompt: string) => '```json\n{"subject":"' + "x".repeat(100) + '","body":"b","changelog_bullet":"- ok"}\n```';
  await assert.rejects(() => driveDraft(minimalPlan, ctx, callCodex), /draft validation failed after retry/);
});

test("driveDraft: handles bare JSON output (no fence)", async () => {
  const callCodex = () => '{"subject":"feat: bare","body":"b","changelog_bullet":"- bare"}';
  const r = await driveDraft(minimalPlan, ctx, callCodex);
  assert.equal(r.subject, "feat: bare");
});

test("driveDraft: rejects output containing forbidden Closes #N", async () => {
  let calls = 0;
  const callCodex = () => {
    calls++;
    return '```json\n{"subject":"feat: ok","body":"Closes #5","changelog_bullet":"- ok"}\n```';
  };
  await assert.rejects(() => driveDraft(minimalPlan, ctx, callCodex), /forbidden pattern/);
  assert.equal(calls, 2);  // retried once
});
