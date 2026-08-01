// Contract test for the doc-convention layout (PR #617): stark-init-docs'
// scaffolding + spec stub paths and the mkdocs nav template must use the
// docs/{adr, specs, retros} layout — `adr` stays the established singular
// acronym (docs/adr/), the full-word types are plural. Guards against drift back
// to singular docs/spec paths, and against re-sanctioning `docs/plans/`, retired
// 2026-08-01 when the /stark-author spec absorbed the plan (task DAG, done-whens,
// verification command). Existing docs/plans/ files are historical archive.
// node built-ins only — runs under `npm test` and the smoke harness.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("stark-init-docs scaffolds docs/{adr,specs,retros} and no plans/", () => {
  const s = read("skill/stark-init-docs/SKILL.md");
  assert.match(s, /docs\/\{adr,specs,retros/, "mkdir line must use adr + plural specs/retros");
  assert.doesNotMatch(s, /docs\/spec\//, "no singular docs/spec/ paths (use docs/specs/)");
  assert.doesNotMatch(s, /mkdir[^\n]*plans/, "scaffolding must not create docs/plans/ (retired — the spec carries the plan)");
});

test("mkdocs template nav uses adr/ + plural specs/retros, no plans/", () => {
  const m = read("standards/templates/mkdocs.yml");
  for (const p of ["adr/", "specs/", "retros/"]) {
    assert.ok(m.includes(p), `mkdocs nav missing ${p}`);
  }
  assert.doesNotMatch(m, /:\s*spec\//, "no singular spec/ nav target (use specs/)");
  assert.doesNotMatch(m, /:\s*plans?\//, "no plans/ nav target — docs/plans/ is retired");
});

test("standards no longer sanction docs/plans/", () => {
  for (const rel of [
    "standards/index.md",
    "standards/templates/docs-index.md",
    "standards/templates/doc-staleness.yml",
    "standards/workflows/doc-staleness.yml",
    "standards/stage-completion-line.md",
  ]) {
    assert.doesNotMatch(read(rel), /docs\/plans\//, `${rel} still points at docs/plans/`);
  }
});

test("adr-template matches `brain adr` render (bullet Status/Date)", () => {
  const t = read("standards/templates/adr-template.md");
  assert.match(t, /^- \*\*Status:\*\*/m, "Status must be a `- **Status:**` bullet so `brain adr list` parses it");
  assert.match(t, /^- \*\*Date:\*\*/m, "Date must be a `- **Date:**` bullet");
});
