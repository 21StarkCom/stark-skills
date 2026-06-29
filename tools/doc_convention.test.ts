// Contract test for the doc-convention reconcile (PR #617): stark-init-docs'
// scaffolding + spec stub paths and the mkdocs nav template must all use the
// singular docs/{adr,spec,plan,retro} layout, never the old plural
// docs/specs|plans. Guards against the inconsistency being reintroduced.
// Uses only node built-ins, so it runs under `npm test` and the smoke harness.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("stark-init-docs scaffolds docs/{adr,spec,plan,retro}", () => {
  const s = read("skill/stark-init-docs/SKILL.md");
  assert.match(s, /docs\/\{adr,spec,plan,retro/, "mkdir line must use singular spec/plan + retro");
  assert.doesNotMatch(s, /docs\/specs\//, "no plural docs/specs/ paths");
  assert.doesNotMatch(s, /docs\/plans\//, "no plural docs/plans/ paths");
});

test("mkdocs template nav uses singular spec/plan + adr + retro", () => {
  const m = read("standards/templates/mkdocs.yml");
  for (const p of ["adr/", "spec/", "plan/", "retro/"]) {
    assert.ok(m.includes(p), `mkdocs nav missing ${p}`);
  }
  assert.doesNotMatch(m, /:\s*specs\//, "no plural specs/ nav target");
  assert.doesNotMatch(m, /:\s*plans\//, "no plural plans/ nav target");
});

test("adr-template matches `brain adr` render (bullet Status/Date)", () => {
  const t = read("standards/templates/adr-template.md");
  assert.match(t, /^- \*\*Status:\*\*/m, "Status must be a `- **Status:**` bullet so `brain adr list` parses it");
  assert.match(t, /^- \*\*Date:\*\*/m, "Date must be a `- **Date:**` bullet");
});
