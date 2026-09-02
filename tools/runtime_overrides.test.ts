import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CODEX_ROOT = path.join(REPO_ROOT, "runtime-overrides", "codex");
const SKILL_ROOT = path.join(REPO_ROOT, "skill");

// The skill roster is the filesystem, and whether a skill ships a Codex variant
// is declared exactly ONCE — in its own SKILL.md `runtimes:` frontmatter. That
// key is what bifrost's importer reads (engine/internal/importer/
// runtime_override.go::artifactTargetsCodex) to decide whether a missing Codex
// overlay is a hard import error, so a hand-kept mirror of it here was only ever
// a second answer that could disagree — and did: stark-bury declared
// `runtimes: [claude]` in #867 and never reached the array, leaving main red
// across three merged PRs. Adding a skill still forces a conscious choice; the
// choice is now made once, in the file the real consumer reads.
function canonicalSkillNames(): string[] {
  return fs
    .readdirSync(SKILL_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(SKILL_ROOT, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** Runtimes a skill declares, or null when it declares none. Mirrors the forms
 * bifrost's parseToolList accepts: a block sequence, and a bare or comma-joined
 * scalar. Returns null for an EMPTY list on purpose — bifrost keeps Runtimes
 * unset when `len(rts) == 0` (importer/skill.go) and then defaults it to
 * [claude, codex] (importer/defaults.go), so `runtimes: []` REQUIRES an overlay.
 * Reading it as an exemption here would green a tree that `stark sync` rejects. */
function declaredRuntimes(file: string): string[] | null {
  const block = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
  if (!block) return null;
  let runtimes: string[] | null = null;
  const sequence = block[1].match(/^runtimes:[ \t]*\n((?:[ \t]+-[ \t]*\S+[ \t]*\n?)+)/m);
  if (sequence) {
    runtimes = [...sequence[1].matchAll(/-[ \t]*(\S+)/g)].map((m) => m[1]);
  } else {
    const scalar = block[1].match(/^runtimes:[ \t]*(\S[^\n]*)$/m);
    if (scalar) {
      runtimes = scalar[1]
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  }
  return runtimes && runtimes.length > 0 ? runtimes : null;
}

function isClaudeOnly(name: string): boolean {
  const runtimes = declaredRuntimes(path.join(SKILL_ROOT, name, "SKILL.md"));
  return runtimes !== null && !runtimes.includes("codex");
}

const CANONICAL_SKILLS = canonicalSkillNames();
const CLAUDE_ONLY_SKILLS = CANONICAL_SKILLS.filter(isClaudeOnly);
const SKILLS = CANONICAL_SKILLS.filter((name) => !isClaudeOnly(name));

const SUPPORT_FILES = [
  "global/config.json",
  "skill/stark-build/references/hooks/protect-paths.sh",
  "skill/stark-build/references/hooks/stop-gate.sh",
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
  "tools/agent_dispatch_lib.ts",
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
    ...SUPPORT_FILES,
  ].sort();

  assert.deepEqual(walkFiles(CODEX_ROOT), expected);
  // The last hand-maintained fact in this file, and deliberately so: with SKILLS
  // derived, this literal is the only tripwire that fires when a Codex-backed
  // artifact is added or deleted. Deriving it from the two list lengths would
  // make it a tautology.
  assert.equal(
    expected.length,
    58,
    `runtime-overrides/codex inventory size changed (computed ${expected.length}) — if the tree is right, bump this literal`,
  );
});

test("required Codex parity skills remain model-discoverable", () => {
  for (const name of ["stark-bury", "simple-gate"]) {
    const body = fs.readFileSync(
      path.join(CODEX_ROOT, "skill", name, "SKILL.md"),
      "utf8",
    );
    assert.doesNotMatch(
      body,
      /^disable-model-invocation:\s*true$/m,
      `${name} must enter Codex's model-visible skill catalog`,
    );
  }
});

test("Codex artifact overrides preserve canonical identities", () => {
  // SKILLS and CLAUDE_ONLY_SKILLS are complementary filters over the same
  // directory listing, so asserting their union equals it can no longer fail.
  // What CAN fail is the parse itself, and the half of the contract the old
  // union never covered: a claude-only skill must ship no Codex overlay.
  assert.ok(SKILLS.length > 0, "no skill targets Codex — the runtimes: parse is broken");

  for (const name of CLAUDE_ONLY_SKILLS) {
    assert.equal(
      fs.existsSync(path.join(CODEX_ROOT, "skill", name)),
      false,
      `${name} declares claude-only runtimes yet ships runtime-overrides/codex/skill/${name}/ — drop the override, or drop the narrowing`,
    );
  }

  for (const name of SKILLS) {
    // Guard before the read: without it a missing overlay surfaces as an opaque
    // ENOENT out of frontmatterName rather than an actionable message.
    const override = path.join(CODEX_ROOT, "skill", name, "SKILL.md");
    assert.ok(
      fs.existsSync(override),
      `${name} targets Codex but has no override: add runtime-overrides/codex/skill/${name}/SKILL.md, or narrow skill/${name}/SKILL.md to 'runtimes:\n  - claude'`,
    );
    assert.equal(
      frontmatterName(override),
      frontmatterName(path.join(SKILL_ROOT, name, "SKILL.md")),
      `skill identity drift: ${name}`,
    );
  }
});

test("Codex runtime instructions never target Claude-owned state", () => {
  const portableClaudeAssetMarker = /\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\/code-review\}/g;

  for (const rel of walkFiles(CODEX_ROOT)) {
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
});

test("Codex user-facing output uses dollar skill invocation", () => {
  const rels = [
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
