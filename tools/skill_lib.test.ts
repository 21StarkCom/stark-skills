// These tests require a writable os.tmpdir(). In sandboxed environments
// where /tmp is locked down, makeRepo calls t.skip() so the test reports a
// visible skip instead of a silent green pass that would hide regressions.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  buildBundle,
  collectSharedRefs,
  discoverSkillBundles,
  findRepoRoot,
  listSkillPaths,
  resolveSkillTarget,
} from "./skill_lib.ts";

function makeRepo(t: TestContext): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-lib-"));
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    return tmp;
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

test("resolveRefs picks up inline, reference-style, and angle-bracket links", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs handles reference-style definitions with angle-bracketed spaced paths", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs handles inline links with balanced parens in the destination", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs handles collapsed reference links [label][]", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs strips trailing titles from reference-style definitions", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs ignores links inside fenced code blocks and inline code", (t) => {
  const tmp = makeRepo(t);
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

test("resolveRefs flags out-of-repo paths as missing", (t) => {
  const tmp = makeRepo(t);
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

test("listSkillPaths rejects symlinked SKILL.md files", (t) => {
  if (process.platform === "win32") return; // skip on Windows symlink perms
  const tmp = makeRepo(t);
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

test("findRepoRoot walks up from a nested cwd inside the repo", (t) => {
  const tmp = makeRepo(t);
  if (!tmp) return;
  try {
    const nested = path.join(tmp, "skill", "alpha", "deep", "inner");
    fs.mkdirSync(nested, { recursive: true });
    // findRepoRoot uses path.resolve (no symlink resolution), so compare
    // against path.resolve(tmp). On macOS the tmp path itself is already
    // under /var/folders which is symlinked to /private/var/folders;
    // realpathSync would report the resolved target, which this function
    // intentionally doesn't do.
    assert.equal(findRepoRoot(nested), path.resolve(tmp));
    assert.notEqual(findRepoRoot(nested), null);
    // And confirm the null-return on a cwd outside any repo.
    const sibling = fs.mkdtempSync(path.join(path.dirname(tmp), "no-repo-"));
    try {
      // Only reliable when the tmp root itself isn't inside a git repo
      // (which we verified via makeRepo above). If the ancestor check
      // finds an outer .git, treat as skip.
      let check = path.dirname(sibling);
      while (check && check !== path.dirname(check)) {
        if (fs.existsSync(path.join(check, ".git"))) {
          t.diagnostic(
            "skipping outside-repo assertion: tmp root itself is inside a repo",
          );
          return;
        }
        check = path.dirname(check);
      }
      assert.equal(findRepoRoot(sibling), null);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveSkillTarget rejects a slug that matches two bundles under different parents", (t) => {
  const tmp = makeRepo(t);
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

test("collectSharedRefs identifies markdown files referenced by multiple bundles", (t) => {
  const tmp = makeRepo(t);
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
