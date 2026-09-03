// Tests for `tools/memory_tidy_lib.ts` (STARK-2363). Covers the cap measurers
// (index load cap in lines/chars, per-file recall cap in BYTES), the index
// parser (entries, stray prose, frontmatter, over-length lines, orphans,
// dangling links, the drop cut), own-slug resolution (trailing fleet-slug match,
// worktree strip), cross-repo strength, fleet-slug union, and the tree walk over
// a synthesized ~/.claude/projects tree.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INDEX_MAX_LINES,
  INDEX_MAX_CHARS,
  FILE_MAX_BYTES,
  FILE_MAX_LINES,
  INDEX_LINE_SOFT_MAX,
  CAP_SOURCE_VERSION,
  FALLBACK_SLUGS,
  resolveFleetSlugSet,
  ownSlugOf,
  measureFile,
  measureIndex,
  crossRepoStrength,
  measureTree,
} from "./memory_tidy_lib.ts";

const SLUGS = ["tyr", "frigg", "alfred", "meridian", "stark-skills", "stark-tui", "plume"];

// ---- caps are pinned literals, cited to a claude version ----

test("caps match the Claude Code load/recall limits and are version-pinned", () => {
  assert.equal(INDEX_MAX_LINES, 200);
  assert.equal(INDEX_MAX_CHARS, 25000);
  assert.equal(FILE_MAX_LINES, 200);
  assert.equal(FILE_MAX_BYTES, 4096);
  assert.equal(INDEX_LINE_SOFT_MAX, 150);
  assert.match(CAP_SOURCE_VERSION, /^\d+\.\d+\.\d+$/);
});

// ---- per-file recall cap is measured in BYTES, not chars ----

test("measureFile flags the 4096-BYTE cap using byte length, not char length", () => {
  // 1500 em-dashes = 1500 JS chars but 4500 UTF-8 bytes: under the char count,
  // over the byte cap. A char-length measure would miss it.
  const content = "—".repeat(1500);
  const r = measureFile(content);
  assert.ok(content.length < FILE_MAX_BYTES, "precondition: under cap by chars");
  assert.equal(r.bytes, 4500);
  assert.equal(r.overByteCap, true);
  assert.equal(r.recallTruncated, true);
});

test("measureFile flags the 200-line cap independently of bytes", () => {
  const content = Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n");
  const r = measureFile(content);
  assert.equal(r.lines, 250);
  assert.equal(r.overLineCap, true);
  assert.equal(r.overByteCap, false);
  assert.equal(r.recallTruncated, true);
});

test("measureFile leaves a small file untruncated", () => {
  const r = measureFile("---\nname: x\n---\n\nshort body\n");
  assert.equal(r.overByteCap, false);
  assert.equal(r.overLineCap, false);
  assert.equal(r.recallTruncated, false);
});

// ---- index parsing ----

const idx = (lines: string[]) => lines.join("\n") + "\n";

test("measureIndex counts entries and parses their link targets", () => {
  const r = measureIndex(idx([
    "- [Alpha](alpha.md) — the alpha hook",
    "- [Beta](beta.md) — the beta hook",
  ]));
  assert.equal(r.entries, 2);
  assert.deepEqual(r.linkedFiles.sort(), ["alpha.md", "beta.md"]);
});

test("measureIndex flags stray prose and a frontmatter block", () => {
  const r = measureIndex(idx([
    "---",
    "name: nope",
    "---",
    "- [Alpha](alpha.md) — hook",
    "just some prose that is not an entry",
  ]));
  assert.equal(r.hasFrontmatter, true);
  assert.deepEqual(r.strayLines, [5]);
});

test("measureIndex tolerates an H1 heading and blank lines as non-stray", () => {
  const r = measureIndex(idx([
    "# Memory index",
    "",
    "- [Alpha](alpha.md) — hook",
  ]));
  assert.equal(r.hasFrontmatter, false);
  assert.deepEqual(r.strayLines, []);
  assert.equal(r.entries, 1);
});

test("measureIndex flags index lines over the 150-char soft cap with their line numbers", () => {
  const long = "- [Big](big.md) — " + "x".repeat(200);
  const r = measureIndex(idx(["- [Small](small.md) — hi", long]));
  assert.equal(r.longLines.length, 1);
  assert.equal(r.longLines[0]!.line, 2);
  assert.ok(r.longLines[0]!.chars > INDEX_LINE_SOFT_MAX);
});

test("measureIndex reports the char cap and the first dropped line", () => {
  // Each line ~260 chars; 100 lines ~26k chars > 25000 → cut mid-file, under the
  // 200-line cap. firstDroppedLine names where the load stops.
  const lines = Array.from({ length: 100 }, (_, i) => `- [n${i}](n${i}.md) — ` + "y".repeat(240));
  const r = measureIndex(idx(lines));
  assert.equal(r.overCharCap, true);
  assert.equal(r.overLineCap, false);
  assert.ok(r.firstDroppedLine !== null && r.firstDroppedLine > 1 && r.firstDroppedLine <= 100);
});

test("measureIndex drops line 201 first when only the line cap is hit", () => {
  const lines = Array.from({ length: 260 }, (_, i) => `- [n${i}](n${i}.md) — h`);
  const r = measureIndex(idx(lines));
  assert.equal(r.overLineCap, true);
  assert.equal(r.firstDroppedLine, 201);
});

test("measureIndex returns firstDroppedLine null when nothing is dropped", () => {
  const r = measureIndex(idx(["- [A](a.md) — hook", "- [B](b.md) — hook"]));
  assert.equal(r.firstDroppedLine, null);
});

// ---- own-slug resolution (forward match against the known fleet list) ----

test("ownSlugOf returns the longest trailing fleet slug of a project dir", () => {
  assert.equal(ownSlugOf("-Users-x-Code-21Stark-alfred", SLUGS), "alfred");
  // stark-skills must win over a shorter accidental match
  assert.equal(ownSlugOf("-Users-x-Code-21Stark-stark-skills", SLUGS), "stark-skills");
});

test("ownSlugOf strips a worktree suffix before matching", () => {
  assert.equal(ownSlugOf("-Users-x-Code-21Stark-alfred--claude-worktrees-STARK-2363", SLUGS), "alfred");
});

test("ownSlugOf is null for a dir that ends in no known slug", () => {
  assert.equal(ownSlugOf("-Users-x-Code-Evinced-site-scanner", SLUGS), null);
});

// ---- cross-repo strength ----

const note = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ntype: project\ndescription: ${desc}\nmetadata:\n  type: project\n---\n\n${body}\n`;

test("crossRepoStrength is strong when a foreign slug is in the description", () => {
  const c = note("some-fact", "how tyr classifies a jira write", "terse body");
  const r = crossRepoStrength(c, "some-fact.md", "alfred", SLUGS);
  assert.equal(r?.strength, "strong");
  assert.deepEqual(r?.foreignSlugs, ["tyr"]);
});

test("crossRepoStrength is strong when a foreign slug is in the filename", () => {
  const c = note("meridian-cron", "a scheduling note", "body without the slug");
  const r = crossRepoStrength(c, "meridian-cron.md", "alfred", SLUGS);
  assert.equal(r?.strength, "strong");
  assert.deepEqual(r?.foreignSlugs, ["meridian"]);
});

test("crossRepoStrength is weak when the foreign slug is only in the body", () => {
  const c = note("some-fact", "a local note", "deep in the body we mention frigg once");
  const r = crossRepoStrength(c, "some-fact.md", "alfred", SLUGS);
  assert.equal(r?.strength, "weak");
  assert.deepEqual(r?.foreignSlugs, ["frigg"]);
});

test("crossRepoStrength excludes the project's own slug and returns null when nothing foreign", () => {
  const c = note("alfred-thing", "an alfred detail mentioning alfred again", "alfred body");
  assert.equal(crossRepoStrength(c, "alfred-thing.md", "alfred", SLUGS), null);
});

// ---- fleet-slug union ----

test("resolveFleetSlugSet is non-empty via the fallback even with no corpus", () => {
  const set = resolveFleetSlugSet(path.join(os.tmpdir(), "no-such-corpus-xyz"));
  assert.ok(set.length >= FALLBACK_SLUGS.length);
  for (const s of FALLBACK_SLUGS) assert.ok(set.includes(s), `fallback slug ${s} present`);
  // deduped + sorted
  assert.deepEqual(set, [...new Set(set)].sort());
});

test("resolveFleetSlugSet unions corpus slugs with the fallback, deduped", () => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tidy-corpus-"));
  try {
    fs.mkdirSync(path.join(corpus, "repos"), { recursive: true });
    fs.writeFileSync(path.join(corpus, "repos", "newrepo.md"), "x");
    fs.writeFileSync(path.join(corpus, "repos", "alfred.md"), "x"); // dup with fallback
    const set = resolveFleetSlugSet(corpus);
    assert.ok(set.includes("newrepo"));
    assert.equal(set.filter((s) => s === "alfred").length, 1);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

// ---- tree walk integration ----

function mkTree(): { projectsDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tidy-tree-"));
  const projectsDir = path.join(root, "projects");
  const mk = (slug: string) => {
    const d = path.join(projectsDir, slug, "memory");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const alfred = mk("-Users-x-Code-21Stark-alfred");
  fs.writeFileSync(path.join(alfred, "MEMORY.md"), idx([
    "- [Big note](big.md) — " + "z".repeat(200),
    "- [Tyr fact](tyr-fact.md) — tyr write model",
    "- [Local](local.md) — a local alfred fact",
  ]));
  fs.writeFileSync(path.join(alfred, "big.md"), "—".repeat(2000)); // >4096 bytes
  fs.writeFileSync(path.join(alfred, "tyr-fact.md"),
    note("tyr-fact", "how tyr classifies a jira write", "body"));
  fs.writeFileSync(path.join(alfred, "local.md"),
    note("local", "a purely local alfred detail", "body"));

  // an empty memory dir (dir exists, no .md)
  mk("-private-tmp-scratch");

  return { projectsDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("measureTree reports over-cap files, index long-lines, and cross-repo facts per project", () => {
  const { projectsDir, cleanup } = mkTree();
  try {
    const report = measureTree({ projectsDir, corpusPath: path.join(os.tmpdir(), "no-corpus") });
    const alfred = report.projects.find((p) => p.slug.endsWith("-alfred"))!;
    assert.ok(alfred, "alfred project found");
    assert.equal(alfred.ownSlug, "alfred");
    assert.equal(alfred.empty, false);

    // big.md is over the byte cap
    assert.ok(alfred.overCapFiles.some((f) => f.name === "big.md" && f.overByteCap));
    // the big index line is over the soft cap
    assert.ok(alfred.index!.longLines.some((l) => l.text.includes("Big note")));
    // tyr-fact is a strong cross-repo fact; local is not flagged
    const cross = alfred.crossRepo.find((c) => c.name === "tyr-fact.md");
    assert.equal(cross?.strength, "strong");
    assert.ok(!alfred.crossRepo.some((c) => c.name === "local.md"));

    // the scratch dir is reported empty, not errored
    const scratch = report.projects.find((p) => p.slug.endsWith("-scratch"))!;
    assert.equal(scratch.empty, true);
  } finally {
    cleanup();
  }
});

test("measureTree with a project filter returns only that project", () => {
  const { projectsDir, cleanup } = mkTree();
  try {
    const report = measureTree({
      projectsDir,
      corpusPath: path.join(os.tmpdir(), "no-corpus"),
      project: "-Users-x-Code-21Stark-alfred",
    });
    assert.equal(report.projects.length, 1);
    assert.ok(report.projects[0]!.slug.endsWith("-alfred"));
  } finally {
    cleanup();
  }
});

test("measureTree reports orphan topic files and dangling index links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tidy-orphan-"));
  try {
    const d = path.join(root, "projects", "-Users-x-Code-21Stark-plume", "memory");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "MEMORY.md"), idx([
      "- [Kept](kept.md) — hook",
      "- [Gone](gone.md) — points at a missing file",
    ]));
    fs.writeFileSync(path.join(d, "kept.md"), note("kept", "x", "y"));
    fs.writeFileSync(path.join(d, "orphan.md"), note("orphan", "x", "y")); // no index line
    const report = measureTree({ projectsDir: path.join(root, "projects"), corpusPath: path.join(os.tmpdir(), "no-corpus") });
    const plume = report.projects[0]!;
    assert.deepEqual(plume.index!.orphans, ["orphan.md"]);
    assert.deepEqual(plume.index!.dangling, ["gone.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
