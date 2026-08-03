// Tests for `tools/jury_store.ts` — the run store's three load-bearing
// properties: private by construction (0700 dirs / 0600 files), manifest
// skeleton BEFORE dispatch with an ATOMIC final write, and an append-only
// audit trail that survives a crash mid-line.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAudit,
  candidateMetaPath,
  candidatePath,
  candidateSeats,
  createRun,
  findRun,
  juryRoot,
  listRuns,
  makeRunId,
  readAudit,
  readManifest,
  runPaths,
  sanitizeName,
  sha256Hex,
  verifyPath,
  writeCandidate,
  writeCandidateMeta,
  writeInput,
  writeManifest,
  writeManifestSkeleton,
  writeMerge,
  writePrompt,
  writeReport,
  writeVerify,
  type JuryManifest,
  type RunPaths,
} from "./jury_store.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jury-store-"));
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function tempLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
}

function manifestFixture(runId: string, overrides: Partial<JuryManifest> = {}): JuryManifest {
  return {
    run_id: runId,
    name: "post",
    skill: "stark-voice",
    mode: "rewrite",
    input_path: "/tmp/post.md",
    input_sha256: sha256Hex("post"),
    panel: [
      { seat: "claude", model: "claude-opus-5", effort: "max" },
      { seat: "gemini", model: "gemini-3.1-pro-preview", effort: "n/a" },
    ],
    started_at: "2026-08-03T14:37:45.000Z",
    finished_at: null,
    seats: [],
    totals: { cost_usd: null, input_tokens: null, output_tokens: null },
    ...overrides,
  };
}

function newRun(root: string, name = "post"): RunPaths {
  return createRun({
    name,
    root,
    now: new Date("2026-08-03T14:37:45.000Z"),
    rand: () => "a3f9",
  });
}

// ---------------------------------------------------------------------------
// Naming + pure path assembly
// ---------------------------------------------------------------------------

test("sanitizeName slugs the input basename and cannot escape the store", () => {
  assert.equal(sanitizeName("My Post.md"), "my-post");
  assert.equal(sanitizeName("2026-08-03-Draft.markdown"), "2026-08-03-draft");
  // A `../` in a basename must not become a path segment.
  assert.equal(sanitizeName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeName("../.."), "run");
  assert.equal(sanitizeName(""), "run");
  assert.equal(sanitizeName("!!!"), "run");
  assert.ok(!sanitizeName("a".repeat(200)).includes("/"));
  assert.ok(sanitizeName("a".repeat(200)).length <= 60);
});

test("makeRunId is a UTC stamp plus a 4-char suffix", () => {
  const id = makeRunId(new Date("2026-08-03T14:37:45.123Z"), () => "a3f9");
  assert.equal(id, "20260803T143745Z-a3f9");
  assert.match(makeRunId(new Date("2026-08-03T14:37:45.000Z")), /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
});

test("runPaths is pure assembly — every artifact under {root}/<name>/<run-id>", () => {
  const p = runPaths("/root", "post", "20260803T143745Z-a3f9");
  assert.equal(p.dir, "/root/post/20260803T143745Z-a3f9");
  assert.equal(p.manifest, `${p.dir}/manifest.json`);
  assert.equal(p.input, `${p.dir}/input.md`);
  assert.equal(p.prompt, `${p.dir}/prompt.md`);
  assert.equal(p.candidatesDir, `${p.dir}/candidates`);
  assert.equal(p.verifyDir, `${p.dir}/verify`);
  assert.equal(p.merge, `${p.dir}/merge.md`);
  assert.equal(p.report, `${p.dir}/report.md`);
  assert.equal(p.audit, `${p.dir}/audit.jsonl`);
  assert.equal(candidatePath(p, "claude"), `${p.candidatesDir}/claude.md`);
  assert.equal(candidateMetaPath(p, "codex"), `${p.candidatesDir}/codex.meta.json`);
  assert.equal(verifyPath(p, "gemini"), `${p.verifyDir}/gemini.json`);
  assert.equal(fs.existsSync(p.dir), false, "runPaths must not touch the filesystem");
});

test("juryRoot lives under the state root's history tree, never the repo", () => {
  assert.ok(juryRoot().endsWith(path.join("history", "jury")));
});

test("sha256Hex is the hex digest of the UTF-8 bytes", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});

// ---------------------------------------------------------------------------
// Run creation — private by construction
// ---------------------------------------------------------------------------

test("createRun makes the run dir plus candidates/ and verify/, all 0700", () => {
  const root = tmpRoot();
  const p = newRun(root);

  assert.equal(p.runId, "20260803T143745Z-a3f9");
  assert.equal(p.name, "post");
  assert.equal(p.dir, path.join(root, "post", "20260803T143745Z-a3f9"));
  for (const dir of [path.join(root, "post"), p.dir, p.candidatesDir, p.verifyDir]) {
    assert.ok(fs.statSync(dir).isDirectory(), `${dir} should exist`);
    assert.equal(mode(dir), 0o700, `${dir} should be 0700`);
  }
});

test("createRun 0700 holds even under a permissive umask (mode alone is masked)", () => {
  const root = tmpRoot();
  const prev = process.umask(0o000);
  try {
    const p = newRun(root, "umask-case");
    assert.equal(mode(p.dir), 0o700);
    assert.equal(mode(p.candidatesDir), 0o700);
  } finally {
    process.umask(prev);
  }
});

test("createRun sanitizes the name it was handed", () => {
  const root = tmpRoot();
  const p = createRun({ name: "My Post.md", root, rand: () => "0001" });
  assert.equal(p.name, "my-post");
  assert.ok(fs.existsSync(path.join(root, "my-post")));
});

test("a run-id collision draws a fresh id instead of sharing a directory", () => {
  const root = tmpRoot();
  const now = new Date("2026-08-03T14:37:45.000Z");
  const suffixes = ["aaaa", "aaaa", "bbbb"];
  let i = 0;
  const rand = () => suffixes[Math.min(i++, suffixes.length - 1)] as string;

  const first = createRun({ name: "post", root, now, rand });
  const second = createRun({ name: "post", root, now, rand });

  assert.equal(first.runId, "20260803T143745Z-aaaa");
  assert.equal(second.runId, "20260803T143745Z-bbbb");
  assert.notEqual(first.dir, second.dir);
});

test("an EXPLICIT run id gets no retry — EEXIST is the caller's error", () => {
  const root = tmpRoot();
  const opts = { name: "post", root, runId: "20260803T143745Z-fixed" };
  createRun(opts);
  assert.throws(() => createRun(opts), /EEXIST/);
});

// ---------------------------------------------------------------------------
// Manifest — skeleton first, final write atomic
// ---------------------------------------------------------------------------

test("the skeleton is written BEFORE dispatch so a crash leaves a diagnosable dir", () => {
  const root = tmpRoot();
  const p = newRun(root);
  writeManifestSkeleton(p, manifestFixture(p.runId));

  // Simulate the crash: nothing else ever runs.
  const crashed = readManifest(p.dir);
  assert.ok(crashed, "a crashed run must still have a readable manifest");
  assert.equal(crashed.run_id, p.runId);
  assert.equal(crashed.skill, "stark-voice");
  assert.equal(crashed.finished_at, null, "the skeleton records the run as unfinished");
  assert.equal(mode(p.manifest), 0o600);
});

test("the final manifest is written atomically and leaves no temp file behind", () => {
  const root = tmpRoot();
  const p = newRun(root);
  writeManifestSkeleton(p, manifestFixture(p.runId));
  writeManifest(
    p,
    manifestFixture(p.runId, {
      finished_at: "2026-08-03T14:41:02.000Z",
      totals: { cost_usd: 1.25, input_tokens: 4000, output_tokens: 900 },
    }),
  );

  const final = readManifest(p);
  assert.ok(final);
  assert.equal(final.finished_at, "2026-08-03T14:41:02.000Z");
  assert.equal(final.totals.cost_usd, 1.25);
  assert.deepEqual(tempLeftovers(p.dir), [], "the temp file must be renamed, not left");
  assert.equal(mode(p.manifest), 0o600);
  // Parses standalone: the rename is what guarantees no half-written JSON.
  JSON.parse(fs.readFileSync(p.manifest, "utf8"));
});

test("a failed rename cleans up its temp file instead of littering the run dir", () => {
  const root = tmpRoot();
  const p = newRun(root);
  // A directory at the manifest path makes rename fail; the write must not
  // leave its temp file behind on that path.
  fs.mkdirSync(p.manifest);
  assert.throws(() => writeManifest(p, manifestFixture(p.runId)));
  assert.deepEqual(tempLeftovers(p.dir), []);
});

test("readManifest returns null for an absent or corrupt manifest, never throws", () => {
  const root = tmpRoot();
  const p = newRun(root);
  assert.equal(readManifest(p), null, "absent");
  assert.equal(readManifest(p.dir), null, "absent, by dir");

  fs.writeFileSync(p.manifest, "{ this is not json");
  assert.equal(readManifest(p), null, "corrupt");

  fs.writeFileSync(p.manifest, '"a string"');
  assert.equal(readManifest(p), null, "valid JSON that is not an object");
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

test("every artifact write lands in its documented path at 0600", () => {
  const root = tmpRoot();
  const p = newRun(root);

  writeInput(p, "the source document\n");
  writePrompt(p, "the byte-identical payload\n");
  const candidate = writeCandidate(p, "claude", "rewritten\n");
  const meta = writeCandidateMeta(p, "claude", { rc: 0, latency_ms: 1234, usage_source: "cli" });
  const verify = writeVerify(p, "claude", { verdict: "CLEAN", violations: [] });
  writeMerge(p, "merged\n");
  writeReport(p, "calibration\n");

  assert.equal(fs.readFileSync(p.input, "utf8"), "the source document\n");
  assert.equal(fs.readFileSync(p.prompt, "utf8"), "the byte-identical payload\n");
  assert.equal(candidate, candidatePath(p, "claude"));
  assert.equal(fs.readFileSync(candidate, "utf8"), "rewritten\n");
  assert.equal(meta, candidateMetaPath(p, "claude"));
  assert.equal(JSON.parse(fs.readFileSync(meta, "utf8")).usage_source, "cli");
  assert.equal(verify, verifyPath(p, "claude"));
  assert.equal(JSON.parse(fs.readFileSync(verify, "utf8")).verdict, "CLEAN");
  assert.equal(fs.readFileSync(p.merge, "utf8"), "merged\n");
  assert.equal(fs.readFileSync(p.report, "utf8"), "calibration\n");

  for (const file of [p.input, p.prompt, candidate, meta, verify, p.merge, p.report]) {
    assert.equal(mode(file), 0o600, `${file} should be 0600`);
  }
});

test("candidateSeats reports what the run actually captured, in canonical order", () => {
  const root = tmpRoot();
  const p = newRun(root);
  assert.deepEqual(candidateSeats(p), []);

  writeCandidate(p, "gemini", "g\n");
  writeCandidate(p, "claude", "c\n");
  writeCandidateMeta(p, "claude", { rc: 0 });
  // A seat with only a meta file did not produce a candidate.
  writeCandidateMeta(p, "codex", { rc: 1 });

  assert.deepEqual(candidateSeats(p), ["claude", "gemini"]);
});

// ---------------------------------------------------------------------------
// Audit — append-only
// ---------------------------------------------------------------------------

test("appendAudit appends one row per call, in order, at 0600", () => {
  const root = tmpRoot();
  const p = newRun(root);

  appendAudit(p, { ts: "2026-08-03T14:38:00.000Z", kind: "seat", model: "claude-opus-5" });
  appendAudit(p, { ts: "2026-08-03T14:39:00.000Z", kind: "seat", model: "gpt-5.5-pro" });
  // The session's own merge row goes through the same append.
  appendAudit(p, { ts: "2026-08-03T14:45:00.000Z", kind: "merge", model: "session" });

  const rows = readAudit(p);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["seat", "seat", "merge"],
  );
  assert.equal(rows[2]?.model, "session");
  assert.equal(mode(p.audit), 0o600);
  // One line per row — never a rewritten array.
  assert.equal(fs.readFileSync(p.audit, "utf8").trimEnd().split("\n").length, 3);
});

test("a truncated final line from a killed process does not hide the rows before it", () => {
  const root = tmpRoot();
  const p = newRun(root);
  appendAudit(p, { ts: "t1", kind: "seat", model: "claude-opus-5" });
  appendAudit(p, { ts: "t2", kind: "seat", model: "gpt-5.5-pro" });
  fs.appendFileSync(p.audit, '{"ts":"t3","kind":"seat","mod');

  const rows = readAudit(p);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.ts),
    ["t1", "t2"],
  );
});

test("readAudit on a run with no calls yet is empty, not an error", () => {
  const root = tmpRoot();
  assert.deepEqual(readAudit(newRun(root)), []);
});

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

test("listRuns returns every run newest-first, and narrows by name", () => {
  const root = tmpRoot();
  const a = createRun({ name: "post", root, runId: "20260803T140000Z-aaaa" });
  const b = createRun({ name: "post", root, runId: "20260803T150000Z-bbbb" });
  const c = createRun({ name: "other", root, runId: "20260803T160000Z-cccc" });
  writeManifest(b, manifestFixture(b.runId));

  // Pin the mtimes AFTER the writes — a write bumps the dir's mtime, which is
  // exactly the ordering key.
  fs.utimesSync(a.dir, new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(b.dir, new Date(2_000_000), new Date(2_000_000));
  fs.utimesSync(c.dir, new Date(3_000_000), new Date(3_000_000));

  const all = listRuns({ root });
  assert.deepEqual(
    all.map((r) => r.runId),
    [c.runId, b.runId, a.runId],
  );
  assert.equal(all[1]?.manifest?.run_id, b.runId);
  assert.equal(all[2]?.manifest, null, "a crashed run lists with a null manifest");

  // The filter sanitizes too, so callers pass the raw basename.
  const narrowed = listRuns({ root, name: "Post.md" });
  assert.deepEqual(
    narrowed.map((r) => r.runId),
    [b.runId, a.runId],
  );
});

test("listRuns on an empty or absent store is empty, not an error", () => {
  assert.deepEqual(listRuns({ root: tmpRoot() }), []);
  assert.deepEqual(listRuns({ root: path.join(tmpRoot(), "nope") }), []);
  assert.deepEqual(listRuns({ root: tmpRoot(), name: "post" }), []);
});

test("findRun locates a run by id across names and returns null when absent", () => {
  const root = tmpRoot();
  createRun({ name: "post", root, runId: "20260803T140000Z-aaaa" });
  const target = createRun({ name: "other", root, runId: "20260803T150000Z-bbbb" });

  const found = findRun("20260803T150000Z-bbbb", { root });
  assert.equal(found?.dir, target.dir);
  assert.equal(found?.name, "other");
  assert.equal(findRun("20260803T150000Z-zzzz", { root }), null);
});
