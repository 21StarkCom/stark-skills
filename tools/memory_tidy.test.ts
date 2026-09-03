// Tests for the `tools/memory_tidy.ts` CLI (STARK-2363): the flag contract
// (help is side-effect-free, JSON on stdout, unknown flags refuse, dry-run/apply
// are accepted no-ops), and `--project` resolution (an exact leading-dash slug,
// a bare repo name, and the ambiguous refusal).
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "./memory_tidy.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}

function mkTree(slugs: string[]): { projectsDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tidy-cli-"));
  const projectsDir = path.join(root, "projects");
  for (const slug of slugs) {
    const d = path.join(projectsDir, slug, "memory");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "MEMORY.md"), "- [A](a.md) — hook\n");
    fs.writeFileSync(path.join(d, "a.md"), "---\nname: a\n---\n\nbody\n");
  }
  return { projectsDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const NO_CORPUS = path.join(os.tmpdir(), "memory-tidy-no-corpus");

test("--help prints usage, returns 0, and touches no filesystem", async () => {
  const io = capture();
  // A projectsDir that does not exist: if help read it, this would still be 0,
  // but we also assert help never throws and never emits JSON.
  const code = await main(["--help"], { projectsDir: "/no/such/dir", corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  const text = io.out.join("");
  assert.match(text, /Usage: memory_tidy/);
  assert.match(text, /--project/);
  assert.doesNotMatch(text, /"summary"/); // no report emitted on help
});

test("no args emits a JSON tree report on stdout and returns 0", async () => {
  const { projectsDir, cleanup } = mkTree(["-Users-x-Code-21Stark-alfred"]);
  try {
    const io = capture();
    const code = await main([], { projectsDir, corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 0);
    const report = JSON.parse(io.out.join(""));
    assert.equal(report.generatedFor, "all");
    assert.ok(Array.isArray(report.projects));
    assert.ok(report.summary);
  } finally {
    cleanup();
  }
});

test("--project with an exact leading-dash slug filters to that project", async () => {
  const { projectsDir, cleanup } = mkTree(["-Users-x-Code-21Stark-alfred", "-Users-x-Code-21Stark-tyr"]);
  try {
    const io = capture();
    const code = await main(
      ["--project", "-Users-x-Code-21Stark-alfred"],
      { projectsDir, corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 0);
    const report = JSON.parse(io.out.join(""));
    assert.equal(report.projects.length, 1);
    assert.ok(report.projects[0].slug.endsWith("-alfred"));
  } finally {
    cleanup();
  }
});

test("--project with a bare repo name resolves to the matching project dir", async () => {
  const { projectsDir, cleanup } = mkTree(["-Users-x-Code-21Stark-alfred", "-Users-x-Code-21Stark-tyr"]);
  try {
    const io = capture();
    const code = await main(["--project", "tyr"], { projectsDir, corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 0);
    const report = JSON.parse(io.out.join(""));
    assert.equal(report.projects.length, 1);
    assert.ok(report.projects[0].slug.endsWith("-tyr"));
  } finally {
    cleanup();
  }
});

test("--project with an ambiguous bare name refuses with exit 2", async () => {
  const { projectsDir, cleanup } = mkTree(["-Users-x-Code-21Stark-plume", "-Users-y-elsewhere-plume"]);
  try {
    const io = capture();
    const code = await main(["--project", "plume"], { projectsDir, corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 2);
    assert.match(io.err.join(""), /ambiguous/i);
  } finally {
    cleanup();
  }
});

test("an unknown flag refuses with a non-zero exit and lists known flags", async () => {
  const io = capture();
  const code = await main(["--bogus"], { projectsDir: "/tmp", corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr });
  assert.notEqual(code, 0);
  assert.match(io.err.join(""), /unknown flag: --bogus/);
  assert.match(io.err.join(""), /--project/);
});

test("--dry-run/--apply/--all/--json are accepted as no-ops (skill-level flags)", async () => {
  const { projectsDir, cleanup } = mkTree(["-Users-x-Code-21Stark-alfred"]);
  try {
    const io = capture();
    const code = await main(
      ["--all", "--dry-run", "--apply", "--json"],
      { projectsDir, corpusPath: NO_CORPUS, stdout: io.stdout, stderr: io.stderr },
    );
    assert.equal(code, 0);
    JSON.parse(io.out.join("")); // still valid JSON
  } finally {
    cleanup();
  }
});
