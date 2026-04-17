// These tests require a writable os.tmpdir(). In sandboxed environments
// where /tmp is locked down, makeRepo returns null and the test exits
// early rather than failing the setup before it reaches any assertion.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildBundle,
  collectSharedRefs,
  discoverSkillBundles,
  listSkillPaths,
  resolveSkillTarget,
} from "./skill_lib.ts";

function makeRepo(): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-lib-"));
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    return tmp;
  } catch {
    return null;
  }
}

test("resolveRefs picks up inline, reference-style, and angle-bracket links", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, "skill", "alpha", "inline.md"), "# inline\n");
    fs.writeFileSync(path.join(tmp, "skill", "alpha", "ref-style.md"), "# ref\n");
    fs.writeFileSync(path.join(tmp, "skill", "alpha", "angle.md"), "# angle\n");
    fs.writeFileSync(path.join(tmp, "skill", "alpha", "titled.md"), "# titled\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "# alpha",
        "",
        "[inline](./inline.md)",
        "[ref][r1]",
        "[angle](<./angle.md>)",
        "[titled](./titled.md \"Human title\")",
        "",
        "[r1]: ./ref-style.md",
      ].join("\n"),
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs.sort(), [
      "skill/alpha/angle.md",
      "skill/alpha/inline.md",
      "skill/alpha/ref-style.md",
      "skill/alpha/titled.md",
    ]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs handles reference-style definitions with angle-bracketed spaced paths", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "My Guide.md"), "# guide\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "# alpha",
        "",
        "[g][guide]",
        "",
        "[guide]: <./My Guide.md>",
      ].join("\n"),
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs, ["skill/alpha/My Guide.md"]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs handles inline links with balanced parens in the destination", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "Guide (v2).md"), "# guide\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      "# alpha\n\n[g](./Guide (v2).md)\n",
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs, ["skill/alpha/Guide (v2).md"]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs handles collapsed reference links [label][]", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "guide.md"), "# guide\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "# alpha",
        "",
        "See [guide][].",
        "",
        "[guide]: ./guide.md",
      ].join("\n"),
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs, ["skill/alpha/guide.md"]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs strips trailing titles from reference-style definitions", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "spec.md"), "# spec\n");
    fs.writeFileSync(path.join(skillDir, "My Guide.md"), "# guide\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "# alpha",
        "",
        "[s][spec]",
        "[g][guide]",
        "",
        "[spec]: ./spec.md \"Human title\"",
        "[guide]: <./My Guide.md> 'Wrapped title'",
      ].join("\n"),
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs.sort(), [
      "skill/alpha/My Guide.md",
      "skill/alpha/spec.md",
    ]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs ignores links inside fenced code blocks and inline code", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "real.md"), "# real\n");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      [
        "# alpha",
        "",
        "[r](./real.md)",
        "",
        "Inline `[example](./fake.md)` should not count.",
        "",
        "```markdown",
        "[also-example](./also-fake.md)",
        "[defn]: ./also-fake.md",
        "```",
      ].join("\n"),
    );
    const bundle = buildBundle(tmp, skillPath);
    // Only the real inline link counts; the two code-span mentions are
    // ignored and therefore don't show up in missingRefs either.
    assert.deepEqual(bundle.refs, ["skill/alpha/real.md"]);
    assert.deepEqual(bundle.missingRefs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRefs flags out-of-repo paths as missing", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const skillDir = path.join(tmp, "skill", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      "# alpha\n\n[escape](../../../../etc/passwd.md)\n",
    );
    const bundle = buildBundle(tmp, skillPath);
    assert.deepEqual(bundle.refs, []);
    assert.equal(bundle.missingRefs.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("listSkillPaths rejects symlinked SKILL.md files", () => {
  if (process.platform === "win32") return; // skip on Windows symlink perms
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const real = path.join(tmp, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "SKILL.md"), "# real\n");
    const evilDir = path.join(tmp, "skill", "evil");
    fs.mkdirSync(evilDir, { recursive: true });
    // evil/SKILL.md is a symlink out of the repo
    fs.symlinkSync("/etc/hosts", path.join(evilDir, "SKILL.md"));
    const paths = listSkillPaths(tmp);
    // The real SKILL.md should be found; the symlinked one must not.
    assert.ok(paths.some((p) => p.endsWith("real/SKILL.md")));
    assert.ok(!paths.some((p) => p.endsWith("evil/SKILL.md")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveSkillTarget rejects a slug that matches two bundles under different parents", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    for (const parent of ["skill", "vendor"]) {
      const dir = path.join(tmp, parent, "alpha");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# alpha\n");
    }
    const bundles = discoverSkillBundles(tmp);
    assert.equal(bundles.length, 2);
    assert.throws(
      () => resolveSkillTarget(tmp, bundles, "alpha"),
      /ambiguous/,
    );
    // A disambiguated path still resolves deterministically.
    const resolved = resolveSkillTarget(tmp, bundles, "vendor/alpha/SKILL.md");
    assert.equal(resolved.skillPath, "vendor/alpha/SKILL.md");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectSharedRefs identifies markdown files referenced by multiple bundles", () => {
  const tmp = makeRepo();
  if (!tmp) return;
  try {
    const shared = path.join(tmp, "standards");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "observability.md"), "# shared\n");
    for (const name of ["alpha", "beta"]) {
      const dir = path.join(tmp, "skill", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `# ${name}\n\n[obs](../../standards/observability.md)\n`,
      );
    }
    const bundles = [
      buildBundle(tmp, path.join(tmp, "skill", "alpha", "SKILL.md")),
      buildBundle(tmp, path.join(tmp, "skill", "beta", "SKILL.md")),
    ];
    const shared_out = collectSharedRefs(bundles);
    assert.equal(shared_out.length, 1);
    assert.equal(shared_out[0].ref, "standards/observability.md");
    assert.deepEqual(shared_out[0].skills.sort(), [
      "skill/alpha/SKILL.md",
      "skill/beta/SKILL.md",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
