import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const CLI = new URL("./stark_handover.ts", import.meta.url).pathname;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], opts: { cwd: string; root: string; home: string }) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    env: {
      HOME: opts.home,
      PATH: process.env.PATH ?? "",
      STARK_HANDOVER_ROOT: opts.root,
    },
  });
}

function parseStdout(res: ReturnType<typeof runCli>): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(res.stdout), res.stdout);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

test("stark_handover CLI: save/resume/list use stable JSON and persist content", () => {
  const cwd = tmpDir("stark-handover-cli-cwd-");
  const root = tmpDir("stark-handover-cli-root-");
  const home = tmpDir("stark-handover-cli-home-");
  const handoverFile = path.join(cwd, "handover-body.md");
  const progressFile = path.join(cwd, "progress.md");
  fs.writeFileSync(handoverFile, "## Goal\nShip the handover CLI.\n");
  fs.writeFileSync(progressFile, "# cli-task progress\n\n## Next\n- [ ] continue\n");

  const save = runCli(
    ["save", "--task", "CLI Task", "--handover-file", handoverFile, "--progress-file", progressFile],
    { cwd, root, home },
  );
  assert.equal(save.status, 0, save.stderr || save.stdout);
  const saved = parseStdout(save);
  assert.equal(saved["task"], "cli-task");
  assert.equal(saved["seq"], 1);
  assert.ok(String(saved["handover_path"]).endsWith("handover_1.md"));
  assert.ok(String(saved["progress_path"]).endsWith("PROGRESS.md"));
  assert.deepEqual(saved["warnings"], []);

  const handoverPath = String(saved["handover_path"]);
  const progressPath = String(saved["progress_path"]);
  assert.ok(fs.readFileSync(handoverPath, "utf8").includes("Ship the handover CLI."));
  assert.equal(fs.readFileSync(progressPath, "utf8"), "# cli-task progress\n\n## Next\n- [ ] continue\n");

  const resume = runCli(["resume", "--task", "cli-task"], { cwd, root, home });
  assert.equal(resume.status, 0, resume.stderr || resume.stdout);
  const resumed = parseStdout(resume);
  assert.equal(resumed["task"], "cli-task");
  assert.equal(resumed["seq"], 1);
  assert.ok(String(resumed["handover_content"]).includes("Ship the handover CLI."));
  assert.equal(resumed["progress_content"], "# cli-task progress\n\n## Next\n- [ ] continue\n");
  assert.deepEqual(resumed["task_slugs"], ["cli-task"]);
  assert.equal(Object.prototype.hasOwnProperty.call(resumed, "tasks"), false);

  const list = runCli(["list"], { cwd, root, home });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const listed = parseStdout(list);
  assert.ok(Array.isArray(listed["tasks"]));
  const tasks = listed["tasks"] as Array<Record<string, unknown>>;
  assert.equal(tasks[0]?.["task"], "cli-task");
  assert.equal(tasks[0]?.["latest_seq"], 1);
  assert.equal(tasks[0]?.["has_progress"], true);
});

test("stark_handover CLI: save requires progress tracker", () => {
  const cwd = tmpDir("stark-handover-cli-cwd-");
  const root = tmpDir("stark-handover-cli-root-");
  const home = tmpDir("stark-handover-cli-home-");
  const handoverFile = path.join(cwd, "handover-body.md");
  fs.writeFileSync(handoverFile, "body\n");

  const res = runCli(["save", "--task", "missing-progress", "--handover-file", handoverFile], {
    cwd,
    root,
    home,
  });
  assert.equal(res.status, 2);
  assert.deepEqual(parseStdout(res), { error: "save requires --progress-file" });
});
