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
//
// Plus, ONCE across the whole skill set:
//   5. Every distinct `tools/*.ts` CLI mentioned by any skill exits
//      cleanly (status 0 or 1) on `--help`. Crashes (status > 1,
//      signal, timeout) mean the CLI is broken.
//
// Cross-repo references (e.g. `~/Code/Playground/stark-insights/...`)
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
  "~/Code/Playground/stark-insights/",
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
// Skill discovery
// ---------------------------------------------------------------------------

function listSkills(): string[] {
  return fs
    .readdirSync(SKILLS_ROOT)
    .filter((n) => n.startsWith("stark-"))
    .filter((n) => {
      try {
        return fs.statSync(path.join(SKILLS_ROOT, n)).isDirectory();
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
}

const SKILL_CONTENT: Record<string, SkillContent> = {};
for (const name of SKILLS) {
  const file = path.join(SKILLS_ROOT, name, "SKILL.md");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const fm = text ? parseFrontmatter(text) : null;
  const refs = text ? extractRefs(text) : [];
  SKILL_CONTENT[name] = { name, text, fm, refs };
}

// ---------------------------------------------------------------------------
// 0. We expect a sane number of skills — guard against a silent regression
//    in `listSkills()` itself.
// ---------------------------------------------------------------------------

test("skill smoke: discovers at least 15 stark-* skills", () => {
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
      ["--experimental-strip-types", "--no-warnings", file, "--help"],
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
