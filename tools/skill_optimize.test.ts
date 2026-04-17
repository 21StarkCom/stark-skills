// Integration tests for the skill_optimize CLI. Spawns `node
// --experimental-strip-types tools/skill_optimize.ts` in an isolated tmp git
// repo so that argument parsing, disk I/O, and top-level control flow are
// actually exercised on every run.
//
// These tests depend on a writable os.tmpdir(); they skip when the platform
// refuses to create the fixture root.

import { strict as assert } from "node:assert";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

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

function makeRepo(t: TestContext): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-opt-cli-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    return tmp;
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
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

function runCli(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

// Async variant for tests that also run a node:http server in the same
// process. spawnSync blocks the event loop, which would starve the mock
// server and make the CLI's fetch time out.
function runCliAsync(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", CLI, ...args],
      { cwd: repo, env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
}

test("diff generation failure is non-fatal — proposal.json and summary are still saved", (t) => {
  const repo = makeRepo(t);
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
          content: "# alpha\n\nRewritten.\n",
        },
      ]),
    );
    // Forcing TMPDIR to a missing directory makes diffText's
    // fs.mkdtempSync(os.tmpdir()) throw. The CLI must still complete so the
    // proposal.json + summary we already paid for stay usable.
    const missingTmp = path.join(repo, "nonexistent-tmpdir");
    const res = runCli(
      repo,
      [
        "--mode",
        "api",
        "--reuse-proposal",
        "--skill",
        "alpha",
      ],
      { TMPDIR: missingTmp },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /diff generation failed/);
    const diff = fs.readFileSync(
      path.join(artifactDir(repo, "alpha"), "proposal.diff"),
      "utf8",
    );
    assert.equal(diff, "");
    // Original JSON / summary are unaffected by the diff failure.
    assert.ok(
      fs.existsSync(
        path.join(artifactDir(repo, "alpha"), "proposal.json"),
      ),
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function startMockResponsesServer(
  response: Record<string, unknown>,
): Promise<{ port: number; close: () => Promise<void>; hits: { post: number; get: number } }> {
  const hits = { post: 0, get: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST") hits.post += 1;
      if (req.method === "GET") hits.get += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        hits,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

test("--mode api polls until terminal status", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const completedPayload = {
      bundle_summary: "polled",
      global_notes: [],
      changes: [
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "rewrite",
          content: "# alpha\n\nPolled result.\n",
        },
      ],
      refs_kept: [],
      refs_removed: [],
      contradictions_resolved: [],
      terminology_normalizations: [],
      warnings: [],
    };
    // Stateful mock: first POST returns in_progress; the first two GETs
    // keep returning in_progress; subsequent GETs return completed.
    let getCount = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.method === "POST") {
          res.end(JSON.stringify({ id: "poll-1", status: "in_progress" }));
          return;
        }
        getCount += 1;
        if (getCount < 3) {
          res.end(JSON.stringify({ id: "poll-1", status: "in_progress" }));
          return;
        }
        res.end(
          JSON.stringify({
            id: "poll-1",
            status: "completed",
            output_text: JSON.stringify(completedPayload),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const res = await runCliAsync(
        repo,
        [
          "--mode",
          "api",
          "--skill",
          "alpha",
          // Poll fast so the test isn't paced by the 5s production default.
          "--poll-interval-ms",
          "25",
          "--api-timeout-ms",
          "10000",
        ],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${port}/v1/responses`,
        },
      );
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.ok(getCount >= 3, `expected at least 3 polling GETs, got ${getCount}`);
      const persisted = JSON.parse(
        fs.readFileSync(
          path.join(artifactDir(repo, "alpha"), "proposal.json"),
          "utf8",
        ),
      );
      assert.equal(persisted.bundle_summary, "polled");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode api with mock Responses server submits, parses, and persists a proposal", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const proposalPayload = {
      bundle_summary: "mock rewrite",
      global_notes: [],
      changes: [
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "rewrite",
          content: "# alpha\n\nRewritten by mock.\n",
        },
      ],
      refs_kept: [],
      refs_removed: [],
      contradictions_resolved: [],
      terminology_normalizations: [],
      warnings: [],
    };
    const mock = await startMockResponsesServer({
      id: "mock-resp-1",
      status: "completed",
      output_text: JSON.stringify(proposalPayload),
    });
    try {
      const res = await runCliAsync(
        repo,
        ["--mode", "api", "--skill", "alpha"],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${mock.port}/v1/responses`,
        },
      );
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.ok(mock.hits.post >= 1, "mock server should receive a POST");
      const persisted = JSON.parse(
        fs.readFileSync(
          path.join(artifactDir(repo, "alpha"), "proposal.json"),
          "utf8",
        ),
      );
      assert.equal(persisted.bundle_summary, "mock rewrite");
      assert.equal(persisted.changes[0].content, "# alpha\n\nRewritten by mock.\n");
      // Dry-run (no --apply): the source file must NOT yet be rewritten.
      assert.equal(
        fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
        "# alpha\n\nOriginal.\n",
      );
    } finally {
      await mock.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode api surfaces a Responses status: failed as a non-zero exit", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const mock = await startMockResponsesServer({
      id: "mock-failed-1",
      status: "failed",
      error: { message: "upstream model timed out" },
    });
    try {
      const res = await runCliAsync(
        repo,
        [
          "--mode",
          "api",
          "--skill",
          "alpha",
          "--poll-interval-ms",
          "25",
          "--api-timeout-ms",
          "5000",
        ],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${mock.port}/v1/responses`,
        },
      );
      assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
      assert.match(res.stderr, /did not complete successfully/);
      assert.match(res.stderr, /failed/);
      // No proposal should have been persisted for a failed run.
      assert.ok(
        !fs.existsSync(path.join(artifactDir(repo, "alpha"), "proposal.json")),
        "a failed Responses run must not persist proposal.json",
      );
    } finally {
      await mock.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode api surfaces cancelled and incomplete statuses as errors", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  for (const terminalStatus of ["cancelled", "incomplete"] as const) {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const mock = await startMockResponsesServer({
      id: `mock-${terminalStatus}`,
      status: terminalStatus,
      error: { message: `${terminalStatus} run` },
    });
    try {
      const res = await runCliAsync(
        repo,
        [
          "--mode",
          "api",
          "--skill",
          "alpha",
          "--poll-interval-ms",
          "25",
          "--api-timeout-ms",
          "5000",
        ],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${mock.port}/v1/responses`,
        },
      );
      assert.notEqual(res.status, 0, `expected failure for ${terminalStatus}`);
      assert.match(res.stderr, new RegExp(terminalStatus));
    } finally {
      await mock.close();
    }
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

test("--mode api hits --api-timeout-ms when the background job never terminates", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    // Stateful mock: POST + every GET returns in_progress forever. The CLI
    // must bail out on --api-timeout-ms instead of hanging.
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "stuck-1", status: "in_progress" }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const res = await runCliAsync(
        repo,
        [
          "--mode",
          "api",
          "--skill",
          "alpha",
          "--poll-interval-ms",
          "25",
          "--api-timeout-ms",
          "250",
        ],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${port}/v1/responses`,
        },
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /timed out/i);
      assert.ok(
        !fs.existsSync(path.join(artifactDir(repo, "alpha"), "proposal.json")),
        "timed-out runs must not persist proposal.json",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode api rejects a completed response with malformed output_text", async (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const mock = await startMockResponsesServer({
      id: "mock-malformed-1",
      status: "completed",
      output_text: "not valid json {[",
    });
    try {
      const res = await runCliAsync(
        repo,
        [
          "--mode",
          "api",
          "--skill",
          "alpha",
          "--poll-interval-ms",
          "25",
          "--api-timeout-ms",
          "5000",
        ],
        {
          OPENAI_API_KEY: "test-key",
          OPENAI_RESPONSES_BASE: `http://127.0.0.1:${mock.port}/v1/responses`,
        },
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /Failed to parse proposal JSON|proposal/i);
      assert.ok(
        !fs.existsSync(path.join(artifactDir(repo, "alpha"), "proposal.json")),
        "a malformed completed response must not persist proposal.json",
      );
    } finally {
      await mock.close();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--apply refuses to start when apply-staging has a .recovery marker", (t) => {
  const repo = makeRepo(t);
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
          summary: "x",
          content: "# alpha\n\nNew body.\n",
        },
      ]),
    );
    const stagingRoot = path.join(repo, "artifacts/skill-optimizer/apply-staging");
    fs.mkdirSync(stagingRoot, { recursive: true });
    const marker = path.join(stagingRoot, ".recovery");
    fs.writeFileSync(marker, '{"failed_at":"2026-04-17T00:00:00Z"}');
    // Pre-stage a sentinel file to verify we don't delete it.
    const sentinel = path.join(stagingRoot, "earlier-staged-content");
    fs.writeFileSync(sentinel, "do not delete");

    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--apply",
      "--skill",
      "alpha",
    ]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /recovery dir from an earlier failed run/);
    // Marker and sentinel both survive — the guard must NOT have wiped the dir.
    assert.ok(fs.existsSync(marker));
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do not delete");
    // And the target SKILL.md is untouched.
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nOriginal.\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--mode plan writes bundle manifest and rewrite request", (t) => {
  const repo = makeRepo(t);
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

test("--mode api without --skill exits with a guard error", (t) => {
  const repo = makeRepo(t);
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

test("--reuse-proposal --apply writes the rewritten content", (t) => {
  const repo = makeRepo(t);
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

test("--reuse-proposal rejects a stale proposal when a bundle file was modified", (t) => {
  const repo = makeRepo(t);
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

test("planProposalApply rejects targets whose ancestor directory is a symlink", (t) => {
  if (process.platform === "win32") return; // symlinks need extra perms
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "beta", "# beta\n\nOriginal beta body.\n");
    // Attacker-style setup: `skill/alpha` is a symlink that resolves inside
    // the repo, so realpath-based checks still see everything as in-tree.
    // A plain write to skill/alpha/SKILL.md would follow the symlink and
    // clobber skill/beta/SKILL.md; the ancestor-symlink guard must catch it.
    fs.symlinkSync(
      path.join(repo, "skill/beta"),
      path.join(repo, "skill/alpha"),
    );
    const stagingRoot = fs.mkdtempSync(path.join(repo, "staging-"));
    const proposal = fullProposal([
      {
        path: "skill/alpha/SKILL.md",
        action: "update",
        summary: "sneaky",
        content: "# alpha\n\nWould overwrite beta.\n",
      },
    ]);
    assert.throws(
      () => planProposalApply(proposal, stagingRoot, repo),
      /symlinked ancestor/,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/beta/SKILL.md"), "utf8"),
      "# beta\n\nOriginal beta body.\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("planProposalApply does not mutate bundle files when a later proposal's target is a symlink", (t) => {
  const repo = makeRepo(t);
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

test("commitStagedOps aborts when a target becomes a symlink between stage and commit", (t) => {
  if (process.platform === "win32") return;
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "beta", "# beta\n\nbeta body.\n");
    writeSkill(repo, "alpha", "# alpha\n\nOriginal alpha.\n");
    const stagingRoot = fs.mkdtempSync(path.join(repo, "staging-"));
    const proposal = fullProposal([
      {
        path: "skill/alpha/SKILL.md",
        action: "update",
        summary: "rewrite",
        content: "# alpha\n\nShould never land.\n",
      },
    ]);
    const ops = planProposalApply(proposal, stagingRoot, repo);
    // Attacker swaps the already-staged target into a symlink. Phase-2 must
    // detect the change and abort instead of following the link and
    // overwriting skill/beta/SKILL.md.
    fs.unlinkSync(path.join(repo, "skill/alpha/SKILL.md"));
    fs.symlinkSync(
      path.join(repo, "skill/beta/SKILL.md"),
      path.join(repo, "skill/alpha/SKILL.md"),
    );
    assert.throws(
      () => commitStagedOps(ops, repo),
      /became a symlink between staging and commit/,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/beta/SKILL.md"), "utf8"),
      "# beta\n\nbeta body.\n",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commitStagedOps falls back to copy+unlink when renameSync reports EXDEV", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo, "alpha", "# alpha\n\nOriginal.\n");
    const stagingRoot = fs.mkdtempSync(path.join(repo, "staging-"));
    const proposal = fullProposal([
      {
        path: "skill/alpha/SKILL.md",
        action: "update",
        summary: "rewrite",
        content: "# alpha\n\nCross-device content.\n",
      },
    ]);
    const ops = planProposalApply(proposal, stagingRoot, repo);
    // Simulate a cross-device rename: the first renameSync call throws
    // EXDEV, so commitStagedOps must fall through to copyFileSync + unlink.
    const originalRename = fs.renameSync;
    let renameHits = 0;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((
      ...args: Parameters<typeof fs.renameSync>
    ) => {
      renameHits += 1;
      const err = new Error("mock EXDEV") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    }) as typeof fs.renameSync;
    try {
      commitStagedOps(ops, repo);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync =
        originalRename;
    }
    assert.ok(renameHits > 0, "renameSync should have been attempted first");
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nCross-device content.\n",
    );
    // Staged file must be unlinked by the fallback path so the staging
    // dir doesn't hold a stale copy that a retry could confuse with fresh work.
    const stagedPath = ops.find((o) => o.kind === "write") as {
      kind: "write";
      staged: string;
    };
    assert.ok(!fs.existsSync(stagedPath.staged));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("commitStagedOps atomically swaps staged content over originals and honors deletes", (t) => {
  const repo = makeRepo(t);
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
    commitStagedOps(ops, repo);
    assert.equal(
      fs.readFileSync(path.join(repo, "skill/alpha/SKILL.md"), "utf8"),
      "# alpha\n\nNew body.\n",
    );
    assert.ok(!fs.existsSync(path.join(repo, "skill/alpha/old.md")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("stagingName preserves the repo-relative structure one-to-one", (t) => {
  const expectedA = path.join("skill", "alpha", "SKILL.md");
  const expectedB = path.join("standards", "shared.md");
  assert.equal(stagingName("/repo/skill/alpha/SKILL.md", "/repo"), expectedA);
  assert.equal(stagingName("/repo/standards/shared.md", "/repo"), expectedB);

  // Two paths that would have collided under the old flat-slug scheme
  // (`a__b/c.md` and `a/b__c.md` both mapping to `a__b__c.md`) must now map
  // to distinct strings so staging can never alias them.
  const nested1 = stagingName("/repo/a__b/c.md", "/repo");
  const nested2 = stagingName("/repo/a/b__c.md", "/repo");
  assert.notEqual(nested1, nested2);
});

test("bundleArtifactSlug gives distinct slugs for bundles with the same leaf name", () => {
  assert.equal(
    bundleArtifactSlug("skill/alpha/SKILL.md"),
    "skill_salpha_sSKILL.md",
  );
  assert.equal(
    bundleArtifactSlug("vendor/alpha/SKILL.md"),
    "vendor_salpha_sSKILL.md",
  );
  assert.notEqual(
    bundleArtifactSlug("skill/alpha/SKILL.md"),
    bundleArtifactSlug("vendor/alpha/SKILL.md"),
  );
  // Dots survive so `foo.bar` and `foo_bar` don't collide.
  assert.notEqual(
    bundleArtifactSlug("skill/foo.bar/SKILL.md"),
    bundleArtifactSlug("skill/foo_bar/SKILL.md"),
  );
  // Path separators vs literal underscore must stay distinguishable. The
  // `_` → `_u` escape precedes the `/` → `_s` substitution so these two
  // legitimate repo layouts can't produce the same slug.
  assert.notEqual(
    bundleArtifactSlug("skill/foo__bar/SKILL.md"),
    bundleArtifactSlug("skill/foo/bar/SKILL.md"),
  );
});

test("dry-run surfaces cross-bundle conflicts on a shared ref", (t) => {
  const repo = makeRepo(t);
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
    writeProposal(
      repo,
      "alpha",
      mkProposal([
        {
          path: "standards/shared.md",
          action: "update",
          summary: "alpha wants X",
          content: "Shared v2 (alpha flavor)\n",
        },
      ]),
    );
    writeProposal(
      repo,
      "beta",
      mkProposal([
        {
          path: "standards/shared.md",
          action: "update",
          summary: "beta wants Y",
          content: "Shared v2 (beta flavor)\n",
        },
      ]),
    );
    // Dry run — no --apply. Previously the consistency check was gated on
    // --apply, so conflicting proposals were silently accepted until the
    // user re-ran with --apply. Now the check fires whenever 2+ proposals
    // are in play.
    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--skills",
      "alpha,beta",
    ]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /Cross-bundle conflict on standards\/shared\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("single-proposal multi-bundle delete still fires the co-owner link guard", (t) => {
  const repo = makeRepo(t);
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
    // Only alpha has a proposal, and it deletes the shared ref. Beta is
    // selected but has no proposal, so its SKILL.md still links to the
    // ref after alpha's rewrite lands. The dry-run guard must catch this
    // dangling link without requiring a matching proposal on beta.
    writeProposal(
      repo,
      "alpha",
      mkProposal([
        {
          path: "skill/alpha/SKILL.md",
          action: "update",
          summary: "drop shared",
          content: "# alpha\n\nNo shared ref.\n",
        },
        {
          path: "standards/shared.md",
          action: "delete",
          summary: "cleanup",
          content: "",
        },
      ]),
    );
    // Beta's proposal is a no-op so its SKILL.md still links to the ref.
    // The cross-bundle guard must still check beta's post-rewrite content
    // even though only alpha actually touches the shared ref.
    writeProposal(repo, "beta", mkProposal([]));
    const res = runCli(repo, [
      "--mode",
      "api",
      "--reuse-proposal",
      "--skills",
      "alpha,beta",
    ]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /skill\/beta\/SKILL\.md still links to it/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("--reuse-proposal --apply handles two bundles sharing a ref", (t) => {
  const repo = makeRepo(t);
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
