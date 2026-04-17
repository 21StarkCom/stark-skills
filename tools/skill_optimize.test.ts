// Integration tests for the skill_optimize CLI. Spawns `node
// --experimental-strip-types tools/skill_optimize.ts` in an isolated tmp git
// repo so that argument parsing, disk I/O, and top-level control flow are
// actually exercised on every run.
//
// These tests depend on a writable os.tmpdir(); they skip when the platform
// refuses to create the fixture root.

import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  bundleArtifactSlug,
  commitStagedOps,
  planProposalApply,
  stagingName,
} from "./skill_optimize.ts";
import type { RewriteProposal } from "./skill_validate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "skill_optimize.ts");

type Change = {
  path: string;
  action: "update" | "delete" | "keep";
  summary: string;
  content: string;
};

function makeRepo(): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-opt-cli-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    return tmp;
  } catch {
    return null;
  }
}

function writeSkill(
  repo: string,
  slug: string,
  body: string,
  refs: Record<string, string> = {},
): void {
  const dir = path.join(repo, "skill", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  for (const [name, content] of Object.entries(refs)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function mkProposal(changes: Change[]): Record<string, unknown> {
  return {
    bundle_summary: "test",
    global_notes: [],
    changes,
    refs_kept: [],
    refs_removed: [],
    contradictions_resolved: [],
    terminology_normalizations: [],
    warnings: [],
  };
}

function artifactDir(repo: string, slug: string): string {
  // Derived from the full relative skill path via bundleArtifactSlug so
  // bundles sharing a leaf directory name don't collide.
  return path.join(
    repo,
    "artifacts",
    "skill-optimizer",
    bundleArtifactSlug(`skill/${slug}/SKILL.md`),
  );
}

function writeProposal(
  repo: string,
  slug: string,
  proposal: Record<string, unknown>,
): string {
  const dir = artifactDir(repo, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "proposal.json");
  fs.writeFileSync(file, JSON.stringify(proposal));
  return file;
}

function runCli(repo: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

test("--mode plan writes bundle manifest and rewrite request", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal content.\n");
    const res = runCli(repo, ["--mode", "plan", "--skill", "alpha"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(artifactDir(repo, "alpha"), "bundle.json"), "utf8"),
    );
    assert.equal(manifest.skill, "skill/alpha/SKILL.md");
    assert.ok(
      fs.existsSync(path.join(artifactDir(repo, "alpha"), "rewrite-request.md")),
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode api without --skill exits with a guard error", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const res = runCli(repo, ["--mode", "api"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--mode api requires/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--reuse-proposal --apply writes the rewritten content", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    writeProposal(
      repo,
      "alpha",
      mkProposal([
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "rewrite",
          content: "# alpha\n\nRewritten body.\n",
        },
      ]),
    );
    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--apply",
      "--skill",
      "alpha",
    ]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nRewritten body.\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--reuse-proposal rejects a stale proposal when a bundle file was modified", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const proposalPath = writeProposal(
      repo,
      "alpha",
      mkProposal([
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "rewrite",
          content: "# alpha\n\nRewritten.\n",
        },
      ]),
    );
    // Force the bundle file's mtime to be strictly after the proposal's.
    const nowSec = Date.now() / 1000;
    fs.utimesSync(proposalPath, nowSec - 120, nowSec - 120);
    fs.utimesSync(
      path.join(repo, "skill/alpha/SKILL.md"),
      nowSec,
      nowSec,
    );
    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--apply",
      "--skill",
      "alpha",
    ]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Refusing to reuse proposal/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function fullProposal(changes: Change[]): RewriteProposal {
  return {
    bundle_summary: "test",
    global_notes: [],
    changes,
    refs_kept: [],
    refs_removed: [],
    contradictions_resolved: [],
    terminology_normalizations: [],
    warnings: [],
  };
}

test("planProposalApply does not mutate bundle files when a later proposal's target is a symlink", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal alpha body.\n");
    writeSkill(repo, "beta", "# beta\n\nOriginal beta body.\n");
    // beta/linked.md is a symlink target — planProposalApply rejects writes
    // to it so a phase-1 error aborts before any bundle file is overwritten.
    fs.writeFileSync(path.join(repo, "skill/beta/real.md"), "# real\n");
    fs.symlinkSync(
      path.join(repo, "skill/beta/real.md"),
      path.join(repo, "skill/beta/linked.md"),
    );
    const stagingRoot = fs.mkdtempSync(path.join(repo, "staging-"));

    const alphaProposal = fullProposal([
      {
        path: "skill/alpha/SKILL.md",
        action: "update",
        summary: "rewrite alpha",
        content: "# alpha\n\nRewritten alpha body.\n",
      },
    ]);
    const betaProposal = fullProposal([
      {
        path: "skill/beta/linked.md",
        action: "update",
        summary: "rewrite linked",
        content: "# linked\n",
      },
    ]);

    // Phase 1 succeeds for alpha (staging only; no bundle mutation).
    const alphaOps = planProposalApply(alphaProposal, stagingRoot, repo);
    // Phase 1 rejects beta because its target is a symlink.
    assert.throws(
      () => planProposalApply(betaProposal, stagingRoot, repo),
      /is a symlink/,
    );

    // Alpha's bundle file is still the original — staging doesn't overwrite.
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nOriginal alpha body.\n",
    );
    // The staged content is what WOULD have been written, had we committed.
    const stagedWrite = alphaOps.find((op) => op.kind === "write");
    assert.ok(stagedWrite && stagedWrite.kind === "write");
    assert.equal(
      fs.readFileSync(stagedWrite.staged, "utf8"),
      "# alpha\n\nRewritten alpha body.\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commitStagedOps atomically swaps staged content over originals and honors deletes", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    fs.writeFileSync(path.join(repo, "skill/alpha/old.md"), "# old\n");
    const stagingRoot = fs.mkdtempSync(path.join(repo, "staging-"));
    const proposal = fullProposal([
      {
        path: "skill/alpha/SKILL.md",
        action: "update",
        summary: "rewrite",
        content: "# alpha\n\nNew body.\n",
      },
      {
        path: "skill/alpha/old.md",
        action: "delete",
        summary: "drop",
        content: "",
      },
    ]);
    const ops = planProposalApply(proposal, stagingRoot, repo);
    commitStagedOps(ops);
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nNew body.\n",
    );
    assert.ok(!fs.existsSync(path.join(repo, "skill/alpha/old.md")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("stagingName flattens nested repo paths into a single segment", () => {
  assert.equal(
    stagingName("/repo/skill/alpha/SKILL.md", "/repo"),
    "skill__alpha__SKILL.md",
  );
  assert.equal(
    stagingName("/repo/standards/shared.md", "/repo"),
    "standards__shared.md",
  );
});

test("bundleArtifactSlug gives distinct slugs for bundles with the same leaf name", () => {
  assert.equal(
    bundleArtifactSlug("skill/alpha/SKILL.md"),
    "skill__alpha__SKILL_md",
  );
  assert.equal(
    bundleArtifactSlug("vendor/alpha/SKILL.md"),
    "vendor__alpha__SKILL_md",
  );
  assert.notEqual(
    bundleArtifactSlug("skill/alpha/SKILL.md"),
    bundleArtifactSlug("vendor/alpha/SKILL.md"),
  );
});

test("--reuse-proposal --apply handles two bundles sharing a ref", () => {
  const repo = makeRepo();
  if (!repo) return;
  try {
    fs.mkdirSync(path.join(repo, "standards"), { recursive: true });
    fs.writeFileSync(path.join(repo, "standards/shared.md"), "Shared v1\n");
    writeSkill(
      repo,
      "alpha",
      "# alpha\n\n[s](../../standards/shared.md)\n",
    );
    writeSkill(
      repo,
      "beta",
      "# beta\n\n[s](../../standards/shared.md)\n",
    );
    const sharedChange: Change = {
      path: "standards/shared.md",
      action: "update",
      summary: "tighten",
      content: "Shared v2\n",
    };
    writeProposal(
      repo,
      "alpha",
      mkProposal([
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "alpha rewrite",
          content: "# alpha\n\n[s](../../standards/shared.md)\nNew alpha.\n",
        },
        sharedChange,
      ]),
    );
    writeProposal(
      repo,
      "beta",
      mkProposal([
        {
          path: "skill/beta/SKILL.md",
          action: "update",
          summary: "beta rewrite",
          content: "# beta\n\n[s](../../standards/shared.md)\nNew beta.\n",
        },
        sharedChange,
      ]),
    );
    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--apply",
      "--skills",
      "alpha,beta",
    ]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(repo, "standards/shared.md"), "utf8"),
      "Shared v2\n",
    );
    assert.ok(
      fs
        .readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8")
        .includes("New alpha."),
    );
    assert.ok(
      fs
        .readFileSync(path.join(repo, "skill/beta/SKILL.md"), "utf8")
        .includes("New beta."),
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
