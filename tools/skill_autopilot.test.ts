import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { bundleArtifactSlug } from "./skill_optimize.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeRepo(t: TestContext): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-autopilot-cli-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.cpSync(HERE, path.join(tmp, "tools"), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
    });
    return tmp;
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

function writeSkill(repo: string): void {
  fs.mkdirSync(path.join(repo, "skill", "demo"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "skill", "demo", "SKILL.md"),
    [
      "---",
      "name: demo",
      "description: Demo skill.",
      "---",
      "",
      "Run `scripts/helper.py` before finishing.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, "scripts", "helper.py"),
    "def main():\n    return 'ok'\n",
  );
}

function writeNoopProposal(repo: string): void {
  const dir = path.join(
    repo,
    "artifacts",
    "skill-optimizer",
    bundleArtifactSlug("skill/demo/SKILL.md"),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "proposal.json"),
    JSON.stringify({
      bundle_summary: "No-op upgrade.",
      global_notes: [],
      changes: [],
      refs_kept: ["scripts/helper.py"],
      refs_removed: [],
      contradictions_resolved: [],
      terminology_normalizations: [],
      warnings: [],
    }),
  );
}

function runAutopilot(repo: string, outputPath: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repo, "tools", "skill_autopilot.ts"),
      "--skill",
      "demo",
      "--reuse-proposal",
      "--output",
      outputPath,
    ],
    { cwd: repo, encoding: "utf8" },
  );
}

test("skill_autopilot renders validated snapshot with referenced Python files", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(repo);
    writeNoopProposal(repo);
    const outputPath = path.join(repo, "skill-upgraded.md");

    const res = runAutopilot(repo, outputPath);

    assert.equal(res.status, 0, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const result = JSON.parse(res.stdout) as {
      validationOk: boolean;
      pythonFiles: string[];
    };
    assert.equal(result.validationOk, true);
    assert.deepEqual(result.pythonFiles, ["scripts/helper.py"]);

    const rendered = fs.readFileSync(outputPath, "utf8");
    assert.match(rendered, /## Python Files/);
    assert.match(rendered, /### `scripts\/helper\.py`/);
    assert.match(rendered, /def main\(\):/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
