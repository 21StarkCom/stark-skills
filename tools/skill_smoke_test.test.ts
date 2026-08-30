// Skill reference smoke test — runs on every `npm test`. Catches the
// drift that would otherwise only surface at runtime: a SKILL.md
// referencing a `tools/*.ts` or `scripts/*.py` that no longer exists,
// or a TS CLI that crashes on `--help`.
//
// The one-shot version (run ad-hoc on 2026-05-18, this PR formalizes
// it) caught zero real issues across 18 skills + 13 TS CLI references.
// Baking it in means any future PR that deletes a tool referenced by
// a SKILL.md fails CI before merge.
//
// Validation surface, per SKILL.md:
//   1. Frontmatter parses; `name` + `description` are present.
//   2. `name:` field matches the directory name.
//   3. Every in-repo `tools/X.ts` reference resolves to a real file.
//   4. Every in-repo `scripts/X.py` reference resolves to a real file.
//   6. Every `references/X.md` link resolves under that skill's own
//      `references/` dir. Skills carry their templates there, and a
//      SKILL.md that points at a template which was renamed or never
//      written is a broken skill at runtime — silently, since nothing
//      else reads those links.
//   7. Frontmatter is strict-YAML safe (no plain-scalar colon-space trap that
//      the lenient parser accepts but bifrost's Go importer rejects).
//
// Discovery covers EVERY `skill/<name>/SKILL.md`, not just `stark-*` — the old
// prefix filter left the non-`stark-` skills (`simple-gate`, the team-agent
// pair) unvalidated, which is how a strict-YAML frontmatter bug reached bifrost.
//
// Plus, ONCE across the whole skill set:
//   5. Every distinct `tools/*.ts` CLI mentioned by any skill exits
//      cleanly (status 0 or 1) on `--help`. Crashes (status > 1,
//      signal, timeout) mean the CLI is broken.
//
// Cross-repo references (e.g. `~/Code/21Stark/stark-insights/...`)
// are skipped by an explicit prefix allowlist — those targets aren't
// owned by this repo, and the SKILL.md sites are already defensive
// (`if [ -f "$X" ]`).

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS_ROOT = path.join(REPO_ROOT, "skill");

// Path prefixes that point at OTHER repos checked out on the same
// machine. References inside these are skipped by every check below.
// Add new entries here if a skill ever references another sibling repo.
const CROSS_REPO_PREFIXES: readonly string[] = [
  "~/Code/21Stark/stark-insights/",
  // stark-bury references the Náströnd graveyard repo (its README/template
  // are the ritual's source of truth).
  "~/Code/21Stark/nastrond/",
  // The Evinced production repos are mounted at ~/Code/Evinced; if a
  // skill ever references them directly, it would also be cross-repo.
  "~/Code/Evinced/",
];

// ---------------------------------------------------------------------------
// Frontmatter parse — tiny, just enough for what the smoke test asserts.
// ---------------------------------------------------------------------------

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const fm: Frontmatter = {};
  const descLines: string[] = [];
  let inDesc = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    if (line.startsWith("name:")) {
      fm.name = line.slice("name:".length).trim();
      inDesc = false;
    } else if (line.startsWith("description:")) {
      const rest = line.slice("description:".length).trim();
      inDesc = true;
      if (rest && rest !== ">-") descLines.push(rest);
    } else if (inDesc && line.startsWith(" ")) {
      descLines.push(line.trim());
    } else {
      inDesc = false;
    }
  }
  if (descLines.length > 0) fm.description = descLines.join(" ").trim();
  return fm;
}

// ---------------------------------------------------------------------------
// Strict-YAML frontmatter lint. `parseFrontmatter` above is deliberately
// lenient — it hand-rolls the parse and accepts things a real YAML parser
// rejects. That gap shipped a live bug: team-minion-agent's `description` held
// an unquoted colon-space ("a minion runs under: untrusted-content"), which
// strict YAML reads as a nested mapping. This smoke test passed; bifrost's Go
// importer rejected it with `mapping values are not allowed in this context`
// and blocked the marketplace sync. tools/ carries no YAML dependency (node:
// builtins only), so this is a TARGETED check for the one trap that bit us: a
// top-level plain-scalar mapping value must not contain ": " (colon + space).
// Quoted, flow (`[`/`{`), and block (`>`/`|`) scalars are exempt — they carry
// colons safely.
// ---------------------------------------------------------------------------

function strictYamlFrontmatterIssues(frontmatter: string): string[] {
  const issues: string[] = [];
  let inBlockScalar = false;
  let blockIndent = 0;
  for (const line of frontmatter.split("\n")) {
    if (inBlockScalar) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > blockIndent) continue;
      inBlockScalar = false; // dedented out of the block scalar body
    }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue; // list items / continuation lines start with whitespace
    const value = m[2].replace(/^[ \t]+/, "");
    if (value === "") continue; // empty value → nested mapping or block follows
    if (/^[|>]/.test(value)) {
      inBlockScalar = true;
      blockIndent = line.length - line.trimStart().length;
      continue;
    }
    if (/^["'[{]/.test(value)) continue; // quoted or flow scalar — colons allowed
    if (/:[ \t]/.test(value)) {
      issues.push(
        `key "${m[1]}": plain-scalar value contains ": " (colon-space) — strict YAML reads it as a nested mapping; quote the value or use a ">-" block scalar`,
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Reference extraction — captures the full path token so we can detect
// whether a `tools/X.ts` match is in-repo or cross-repo before checking
// the filesystem. The negative lookbehind on `\w` keeps a candidate like
// `something_tools/X.ts` from matching, which would never be a real ref.
// ---------------------------------------------------------------------------

const REF_RE = /(?<!\w)([~./\w-]*?(tools|scripts)\/[\w_\-./]+\.(ts|py))/g;

interface FileRef {
  /** The full token as it appears in the SKILL.md, e.g. `~/.claude/code-review/tools/x.ts`. */
  full: string;
  /** The repo-relative path, e.g. `tools/x.ts`. */
  relative: string;
  /** `ts` or `py`. */
  kind: "ts" | "py";
  /** True iff `full` starts with a known cross-repo prefix. */
  crossRepo: boolean;
}

function isCrossRepo(fullToken: string): boolean {
  return CROSS_REPO_PREFIXES.some((p) => fullToken.startsWith(p));
}

function extractRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    const full = m[1];
    if (seen.has(full)) continue;
    seen.add(full);
    // Pull off everything before `tools/` or `scripts/` to get the
    // repo-relative form. The matched group `m[2]` is `tools` or
    // `scripts` — use it to find the split point.
    const segment = m[2];
    const idx = full.lastIndexOf(`${segment}/`);
    const relative = full.slice(idx);
    refs.push({
      full,
      relative,
      kind: m[3] as "ts" | "py",
      crossRepo: isCrossRepo(full),
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// `references/*.md` links — a skill's own template dir. Matched against the
// SKILL.md body regardless of link syntax (markdown link, bare mention, code
// span). The negative lookbehind on `\w` and `/` keeps `some_references/x.md`
// and cross-repo `~/other/references/x.md` from matching a local template.
// ---------------------------------------------------------------------------

const REFERENCE_RE = /(?<![\w/])references\/([\w_\-./]+\.md)/g;

function extractReferenceLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(REFERENCE_RE)) seen.add(m[1]);
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

function listSkills(): string[] {
  // Discover every skill dir that carries a SKILL.md — NOT just `stark-*`.
  // The old `startsWith("stark-")` filter silently skipped the non-`stark-`
  // skills (`simple-gate`, `team-leader-agent`, `team-minion-agent`), so
  // nothing validated their frontmatter, refs, or --help contract — that is how
  // the team-minion-agent colon-space frontmatter bug (see the strict-YAML
  // check below) reached bifrost. Keying on SKILL.md presence also excludes
  // non-skill dirs like `evals/`.
  return fs
    .readdirSync(SKILLS_ROOT)
    .filter((n) => {
      try {
        return (
          fs.statSync(path.join(SKILLS_ROOT, n)).isDirectory() &&
          fs.existsSync(path.join(SKILLS_ROOT, n, "SKILL.md"))
        );
      } catch {
        return false;
      }
    })
    .sort();
}

// Discover once; reused by every test below.
const SKILLS = listSkills();

interface SkillContent {
  name: string;
  text: string;
  fm: Frontmatter | null;
  refs: FileRef[];
  /** `references/*.md` links, relative to the skill's own dir. */
  referenceLinks: string[];
}

const SKILL_CONTENT: Record<string, SkillContent> = {};
for (const name of SKILLS) {
  const file = path.join(SKILLS_ROOT, name, "SKILL.md");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const fm = text ? parseFrontmatter(text) : null;
  const refs = text ? extractRefs(text) : [];
  const referenceLinks = text ? extractReferenceLinks(text) : [];
  SKILL_CONTENT[name] = { name, text, fm, refs, referenceLinks };
}

// ---------------------------------------------------------------------------
// 0. We expect a sane number of skills — guard against a silent regression
//    in `listSkills()` itself.
// ---------------------------------------------------------------------------

test("skill smoke: discovers at least 15 skills", () => {
  assert.ok(
    SKILLS.length >= 15,
    `expected >= 15 skills, found ${SKILLS.length}`,
  );
});

// ---------------------------------------------------------------------------
// 1. Frontmatter parse + required fields, per skill.
// ---------------------------------------------------------------------------

for (const name of SKILLS) {
  test(`skill smoke: ${name} — SKILL.md exists + has parseable frontmatter`, () => {
    const c = SKILL_CONTENT[name];
    assert.ok(c.text, `SKILL.md missing for ${name}`);
    assert.ok(c.fm, `frontmatter does not parse for ${name}`);
    assert.ok(c.fm!.name, `frontmatter missing name: for ${name}`);
    assert.ok(c.fm!.description, `frontmatter missing description: for ${name}`);
  });

  test(`skill smoke: ${name} — frontmatter name matches directory name`, () => {
    const c = SKILL_CONTENT[name];
    if (!c.fm) return; // already failed above
    assert.equal(
      c.fm.name,
      name,
      `frontmatter name '${c.fm.name}' doesn't match dir '${name}'`,
    );
  });

  test(`skill smoke: ${name} — declares --help via standards/help.md`, () => {
    const c = SKILL_CONTENT[name];
    assert.ok(
      c.text.includes("standards/help.md"),
      `${name} SKILL.md has no reference to standards/help.md — every skill must honor --help`,
    );
  });

  test(`skill smoke: ${name} — frontmatter is strict-YAML safe`, () => {
    const c = SKILL_CONTENT[name];
    const block = c.text.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(block, `${name}: SKILL.md has no frontmatter block`);
    assert.deepEqual(
      strictYamlFrontmatterIssues(block![1]),
      [],
      `${name}: frontmatter is not strict-YAML safe (bifrost's Go importer will reject it)`,
    );
  });
}

// The shared help protocol every skill points at must exist.
test("skill smoke: standards/help.md exists", () => {
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "standards", "help.md")),
    "standards/help.md is missing but skills reference it",
  );
});

// ---------------------------------------------------------------------------
// 2 + 3. Every in-repo `tools/*.ts` and `scripts/*.py` reference resolves.
// ---------------------------------------------------------------------------

for (const name of SKILLS) {
  test(`skill smoke: ${name} — every in-repo tools/*.ts + scripts/*.py reference resolves`, () => {
    const c = SKILL_CONTENT[name];
    const broken: string[] = [];
    for (const ref of c.refs) {
      if (ref.crossRepo) continue;
      const file = path.join(REPO_ROOT, ref.relative);
      if (!fs.existsSync(file)) {
        broken.push(`${ref.relative} (from token '${ref.full}')`);
      }
    }
    assert.deepEqual(broken, [], `unresolved refs in ${name}`);
  });
}

// ---------------------------------------------------------------------------
// 6. Every `references/*.md` link resolves under the skill's own dir.
// ---------------------------------------------------------------------------

for (const name of SKILLS) {
  test(`skill smoke: ${name} — every references/*.md link resolves`, () => {
    const c = SKILL_CONTENT[name];
    const skillDir = path.join(SKILLS_ROOT, name);
    const broken: string[] = [];
    for (const link of c.referenceLinks) {
      if (!fs.existsSync(path.join(skillDir, "references", link))) {
        broken.push(`references/${link}`);
      }
    }
    assert.deepEqual(
      broken,
      [],
      `unresolved references/*.md links in ${name} — the SKILL.md points at templates that do not exist`,
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Every distinct in-repo `tools/*.ts` CLI mentioned by any skill exits
//    cleanly on --help. Run in parallel (~13 spawns total, ~600ms each
//    sequential → ~1.5s with parallelism).
// ---------------------------------------------------------------------------

const ALL_TS_REFS = (() => {
  const refs = new Set<string>();
  for (const c of Object.values(SKILL_CONTENT)) {
    for (const r of c.refs) {
      if (r.crossRepo) continue;
      if (r.kind !== "ts") continue;
      refs.add(r.relative);
    }
  }
  return [...refs].sort();
})();

for (const relative of ALL_TS_REFS) {
  test(`skill smoke: ${relative} — exits cleanly on --help`, () => {
    const file = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(file)) {
      // The reference-resolution test above already flagged this; don't
      // pile on with a duplicate spawn failure.
      return;
    }
    const result = spawnSync(
      "node",
      ["--no-warnings", file, "--help"],
      { encoding: "utf8", timeout: 15_000 },
    );
    // Exit 0 (help printed) or 1 (some CLIs return 1 from --help) are
    // both fine. What we're guarding against: a CLI that crashes —
    // signal, timeout, or any other non-clean exit.
    assert.ok(
      result.status === 0 || result.status === 1,
      `${relative} --help exited ${result.status} (signal=${result.signal}): ${(result.stderr ?? "").slice(0, 200)}`,
    );
  });
}
