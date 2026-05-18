// Tests for `tools/optimize_skill_description.ts` — pure helpers only.
// `runEval` and `proposeImprovement` shell out to external processes and
// are exercised via integration runs, not unit tests (matching the Python
// scope at `scripts/test_optimize_skill_description.py`).

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCleanEnv,
  buildImprovePrompt,
  IMPROVE_PROMPT_TEMPLATE,
  parseSkillDescription,
} from "./optimize_skill_description.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optimize-skill-desc-"));
}

function writeSkill(frontmatter: string): string {
  const dir = path.join(tmp(), "my-skill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n## body\n`);
  return dir;
}

// ---------------------------------------------------------------------------
// parseSkillDescription — SKILL.md YAML frontmatter parsing
// ---------------------------------------------------------------------------

test("parseSkillDescription: single-line description", () => {
  const skill = writeSkill(
    "---\nname: my-skill\ndescription: a short description\n---",
  );
  const { name, description } = parseSkillDescription(skill);
  assert.equal(name, "my-skill");
  assert.equal(description, "a short description");
});

test("parseSkillDescription: YAML block-scalar (>-) joined into one line", () => {
  const skill = writeSkill(
    [
      "---",
      "name: stark-forged-review",
      "description: >-",
      "  Multi-agent PR review with leader + second-opinion per domain, dynamic triage, and forge-style escalation on non-trivial findings. Replaces stark-review.",
      "model: opus[1m]",
      "---",
    ].join("\n"),
  );
  const { name, description } = parseSkillDescription(skill);
  assert.equal(name, "stark-forged-review");
  assert.ok(description.includes("leader + second-opinion"));
  assert.ok(description.includes("Replaces stark-review"));
});

test("parseSkillDescription: ignores other frontmatter fields", () => {
  const skill = writeSkill(
    [
      "---",
      "name: x",
      "description: just the description",
      'argument-hint: "[ARG]"',
      "model: opus",
      "---",
    ].join("\n"),
  );
  const { description } = parseSkillDescription(skill);
  assert.equal(description, "just the description");
});

test("parseSkillDescription: throws when SKILL.md has no frontmatter", () => {
  const dir = path.join(tmp(), "bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter here\n");
  assert.throws(() => parseSkillDescription(dir), /no YAML frontmatter/);
});

test("parseSkillDescription: multi-line block scalar with explicit continuation lines", () => {
  // The Python parser treats any indented line after `description:` as
  // continuation until it hits an un-indented field. Verify the same.
  const skill = writeSkill(
    [
      "---",
      "name: stark-multi",
      "description: >-",
      "  first line of the description",
      "  second line that wraps",
      "  third line",
      "model: opus",
      "---",
    ].join("\n"),
  );
  const { description } = parseSkillDescription(skill);
  assert.equal(
    description,
    "first line of the description second line that wraps third line",
  );
});

// ---------------------------------------------------------------------------
// IMPROVE_PROMPT_TEMPLATE / buildImprovePrompt
// ---------------------------------------------------------------------------

test("IMPROVE_PROMPT_TEMPLATE keeps the guardrails that stop the model from drifting", () => {
  // What stops `claude -p` from proposing a 500-char marketing blurb when
  // we hand the failing eval queries back. If any of these strings drop
  // out of the template, the optimizer will start producing junk.
  assert.ok(IMPROVE_PROMPT_TEMPLATE.includes("200 characters"));
  assert.ok(IMPROVE_PROMPT_TEMPLATE.includes("Disambiguate from sibling skills"));
  assert.ok(IMPROVE_PROMPT_TEMPLATE.includes("Output ONLY the new description"));
});

test("buildImprovePrompt: splits failed queries into should-trigger / should-not-trigger buckets", () => {
  const rendered = buildImprovePrompt({
    skillName: "stark-x",
    currentDescription: "current",
    evalResults: {
      results: [
        { query: "do X please", should_trigger: true, pass: false },
        { query: "do Y instead", should_trigger: false, pass: false },
        { query: "passing query", should_trigger: true, pass: true },
      ],
    },
  });
  assert.ok(rendered.includes("Skill name: stark-x"));
  assert.ok(rendered.includes("current"));
  assert.ok(rendered.includes("do X please"));
  assert.ok(rendered.includes("do Y instead"));
  assert.ok(!rendered.includes("passing query"));
});

test("buildImprovePrompt: emits '(none)' when both buckets are empty", () => {
  const rendered = buildImprovePrompt({
    skillName: "x",
    currentDescription: "c",
    evalResults: { results: [] },
  });
  assert.ok(rendered.includes("(none)"));
});

test("buildImprovePrompt: truncates query text to 200 chars (Python parity)", () => {
  const longQuery = "q".repeat(500);
  const rendered = buildImprovePrompt({
    skillName: "x",
    currentDescription: "c",
    evalResults: {
      results: [{ query: longQuery, should_trigger: true, pass: false }],
    },
  });
  // The Python wraps each failure as `  * {query[:200]}`. Verify the
  // 200-char slice ended up in the output, not the 500-char original.
  assert.ok(rendered.includes("q".repeat(200)));
  assert.ok(!rendered.includes("q".repeat(201)));
});

// ---------------------------------------------------------------------------
// buildCleanEnv — Anthropic key allowlist for headless dispatch
// ---------------------------------------------------------------------------

test("buildCleanEnv: surfaces ANTHROPIC_AGENTS as ANTHROPIC_API_KEY", () => {
  const env = buildCleanEnv({
    PATH: "/bin",
    HOME: "/home/x",
    ANTHROPIC_AGENTS: "sk-secret",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-secret");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/x");
});

test("buildCleanEnv: never forwards ANTHROPIC_AGENTS itself", () => {
  const env = buildCleanEnv({
    PATH: "/bin",
    ANTHROPIC_AGENTS: "sk-secret",
  });
  assert.ok(!("ANTHROPIC_AGENTS" in env));
});

test("buildCleanEnv: drops stale ANTHROPIC_API_KEY from the host", () => {
  // If the host already exports a stale key, it must NOT leak through —
  // the only source of truth is ANTHROPIC_AGENTS.
  const env = buildCleanEnv({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-stale-host-key",
    ANTHROPIC_AGENTS: "sk-fresh",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-fresh");
});

test("buildCleanEnv: throws when ANTHROPIC_AGENTS is missing", () => {
  assert.throws(
    () => buildCleanEnv({ PATH: "/bin" }),
    /ANTHROPIC_AGENTS not set/,
  );
});

test("buildCleanEnv: includes the canonical PATH/HOME/LANG/LC_ALL/TMPDIR allowlist", () => {
  const env = buildCleanEnv({
    PATH: "/bin",
    HOME: "/h",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    ANTHROPIC_AGENTS: "sk-x",
    SOME_RANDOM_VAR: "should-not-leak",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TMPDIR, "/tmp");
  assert.ok(!("SOME_RANDOM_VAR" in env));
});
