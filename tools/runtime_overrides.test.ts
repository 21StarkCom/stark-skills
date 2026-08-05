import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  mayDeleteLocalBranch,
  shouldFetchForPlan,
} from "../runtime-overrides/codex/plugins/stark-gh/tools/cleanup_policy.ts";

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
  "standards/index.md",
  "standards/preflight.md",
  "standards/stage-completion-line.md",
  "standards/templates/docs-index.md",
  "tools/alert_delivery_lib.ts",
  "tools/approach_contract_lib.ts",
  "tools/asset_root_lib.ts",
  "tools/copilot_dispatch.ts",
  "tools/copilot_land.ts",
  "tools/failure_classifier_lib.ts",
  "tools/gemini_utils_lib.ts",
  "tools/healer_canary_lib.ts",
  "tools/housekeeping_infra.ts",
  "tools/iac_review.ts",
  "tools/iac_review_lib.ts",
  "tools/jury.ts",
  "tools/preflight_lib.ts",
  "tools/runtime_env_lib.ts",
  "tools/self_healer.ts",
  "tools/self_healer_lib.ts",
  "tools/session_id_lib.ts",
  "tools/session_state_lib.ts",
  "tools/skill_router_lib.ts",
  "tools/stark_review.ts",
  "tools/stark_review_doc_analytics_lib.ts",
  "tools/stark_session_lib.ts",
  "tools/validation_gate_lib.ts",
  "plugins/stark-gh/tools/cleanup_policy.ts",
  "plugins/stark-gh/tools/gh_cleanup.ts",
  "plugins/stark-gh/tools/gh_pr_merge_complete.ts",
  "plugins/stark-gh/tools/gh_pr_merge_execute.ts",
  "plugins/stark-gh/tools/gh_pr_open_execute.ts",
  "plugins/stark-gh/tools/lib/audit.ts",
  "plugins/stark-gh/tools/lib/runtime.ts",
  "plugins/stark-gh/tools/lib/watcher_paths.ts",
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
  assert.equal(expected.length, 73);
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
  for (const rel of [
    "plugins/stark-gh/tools/lib/runtime.ts",
    "plugins/stark-gh/tools/lib/watcher_paths.ts",
  ]) {
    const body = fs.readFileSync(path.join(CODEX_ROOT, rel), "utf8");
    assert.match(body, /STARK_STATE_ROOT/);
    assert.match(body, /"\.stark", "code-review"/);
    assert.doesNotMatch(body, /"\.claude", "code-review"/);
  }

  const cleanup = fs.readFileSync(
    path.join(CODEX_ROOT, "plugins/stark-gh/commands/cleanup.md"),
    "utf8",
  );
  assert.match(cleanup, /~\/.stark\/code-review\/stark-gh\/watchers/);
  assert.doesNotMatch(cleanup, /~\/.claude\/code-review\/stark-gh\/watchers/);
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

test("Codex runtime instructions never target Claude-owned state", () => {
  const portableClaudeAssetMarker = /\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\/code-review\}/g;

  for (const rel of walkFiles(CODEX_ROOT)) {
    if (rel === "skill/stark-ssot/SKILL.md") continue;
    const body = fs
      .readFileSync(path.join(CODEX_ROOT, rel), "utf8")
      .replace(portableClaudeAssetMarker, "${CLAUDE_PLUGIN_ROOT}");
    assert.doesNotMatch(body, /~\/\.claude\/code-review|\$HOME\/\.claude\/code-review|"\.claude"\s*,\s*"code-review"/,
      `Claude state path leaked into ${rel}`);
  }

  const housekeeping = fs.readFileSync(
    path.join(CODEX_ROOT, "skill/stark-housekeeping/SKILL.md"),
    "utf8",
  );
  assert.match(housekeeping, /~\/\.stark\/code-review/);
  assert.doesNotMatch(housekeeping, /~\/\.claude/);

  const ghUserHandler = fs.readFileSync(
    path.join(CODEX_ROOT, "skill/stark-gh-user/scripts/handler.sh"),
    "utf8",
  );
  assert.doesNotMatch(ghUserHandler, /CLAUDE_PLUGIN_ROOT|~\/\.claude/);
});

test("Codex user-facing output uses dollar skill invocation", () => {
  const rels = [
    ...COMMANDS.map((name) => `plugins/stark-gh/commands/${name}.md`),
    "plugins/stark-gh/tools/gh_cleanup.ts",
    "plugins/stark-gh/tools/gh_pr_merge_complete.ts",
    "plugins/stark-gh/tools/gh_pr_merge_execute.ts",
    "plugins/stark-gh/tools/gh_pr_open_execute.ts",
    "standards/index.md",
    "standards/stage-completion-line.md",
    "standards/templates/docs-index.md",
    "tools/copilot_land.ts",
    "tools/stark_review_doc_analytics_lib.ts",
  ];
  const slashInvocation = /\/stark(?:-[a-z0-9]+)*(?::[a-z0-9-]+)?(?=[\s`'"(]|$)/i;

  for (const rel of rels) {
    const body = fs
      .readFileSync(path.join(CODEX_ROOT, rel), "utf8")
      .split("\n")
      .filter((line) => !line.includes("on Claude Code"))
      .join("\n");
    assert.doesNotMatch(body, slashInvocation, `Claude slash invocation leaked into ${rel}`);
  }
});
