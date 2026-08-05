import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  mayDeleteLocalBranch,
  shouldFetchForPlan,
} from "../runtime-overrides/codex/tools/cleanup_policy.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CODEX_ROOT = path.join(REPO_ROOT, "runtime-overrides", "codex");

const SKILLS = [
  "remember",
  "stark-adr",
  "stark-author",
  "stark-blog-sharpen",
  "stark-build",
  "stark-cc-user",
  "stark-copilot",
  "stark-fresh-eyes",
  "stark-gh-user",
  "stark-gha-cost",
  "stark-handover",
  "stark-housekeeping",
  "stark-init-docs",
  "stark-jury",
  "stark-logging",
  "stark-persona",
  "stark-refactor-plan",
  "stark-release",
  "stark-review",
  "stark-review-improvement",
  "stark-session",
  "stark-ssot",
  "stark-story-edit",
  "stark-story-judge",
  "stark-terraform-review",
  "stark-terragrunt-review",
  "stark-voice",
] as const;

const COMMANDS = ["cleanup", "pr-merge", "pr-open"] as const;

const SUPPORT_FILES = [
  "global/config.json",
  "skill/stark-build/references/hooks/protect-paths.sh",
  "skill/stark-build/references/hooks/stop-gate.sh",
  "skill/stark-gh-user/scripts/handler.sh",
  "skill/stark-gha-cost/scripts/gha-cost-breakdown.sh",
  "skill/stark-gha-cost/scripts/gha-cost-json.ts",
  "skill/stark-gha-cost/scripts/gha-repo-actions-drill.sh",
  "standards/help.md",
  "standards/preflight.md",
  "tools/iac_review.ts",
  "tools/iac_review_lib.ts",
  "tools/cleanup_policy.ts",
  "tools/gh_cleanup.ts",
  "tools/jury.ts",
  "tools/lib/runtime.ts",
  "tools/lib/watcher_paths.ts",
] as const;

function walkFiles(root: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(rel, entry.name);
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    })
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

function frontmatterName(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\n[\s\S]*?^name:\s*([^\n]+)$/m);
  assert.ok(match, `missing name frontmatter: ${file}`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

test("Codex runtime override inventory is exact", () => {
  const expected = [
    ...SKILLS.map((name) => `skill/${name}/SKILL.md`),
    ...COMMANDS.map((name) => `plugins/stark-gh/commands/${name}.md`),
    ...SUPPORT_FILES,
  ].sort();

  assert.deepEqual(walkFiles(CODEX_ROOT), expected);
  assert.equal(expected.length, 46);
});

test("Codex cleanup dry-run never fetches or prunes refs", () => {
  assert.equal(shouldFetchForPlan({ dryRun: true }), false);
  assert.equal(shouldFetchForPlan({ dryRun: false }), true);
});

test("Codex cleanup preserves unique post-merge commits without --force", () => {
  assert.equal(mayDeleteLocalBranch({ safeDelete: false }, { force: false }), false);
  assert.equal(mayDeleteLocalBranch({ safeDelete: true }, { force: false }), true);
  assert.equal(mayDeleteLocalBranch({ safeDelete: false }, { force: true }), true);
});

test("Codex GitHub state defaults are runtime-neutral", () => {
  for (const rel of ["tools/lib/runtime.ts", "tools/lib/watcher_paths.ts"]) {
    const body = fs.readFileSync(path.join(CODEX_ROOT, rel), "utf8");
    assert.match(body, /STARK_STATE_ROOT/);
    assert.match(body, /"\.stark", "code-review"/);
    assert.doesNotMatch(body, /"\.claude", "code-review"/);
  }
});

test("Codex artifact overrides preserve canonical identities", () => {
  const canonicalSkills = fs
    .readdirSync(path.join(REPO_ROOT, "skill"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(REPO_ROOT, "skill", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual([...SKILLS].sort(), canonicalSkills);

  const canonicalCommands = fs
    .readdirSync(path.join(REPO_ROOT, "plugins", "stark-gh", "commands"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name) === ".md")
    .map((entry) => path.basename(entry.name, ".md"))
    .sort();

  assert.deepEqual([...COMMANDS].sort(), canonicalCommands);

  for (const name of SKILLS) {
    assert.equal(
      frontmatterName(path.join(CODEX_ROOT, "skill", name, "SKILL.md")),
      frontmatterName(path.join(REPO_ROOT, "skill", name, "SKILL.md")),
      `skill identity drift: ${name}`,
    );
  }

  for (const name of COMMANDS) {
    assert.equal(
      frontmatterName(path.join(CODEX_ROOT, "plugins", "stark-gh", "commands", `${name}.md`)),
      frontmatterName(path.join(REPO_ROOT, "plugins", "stark-gh", "commands", `${name}.md`)),
      `command identity drift: ${name}`,
    );
  }
});
