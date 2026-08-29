// Tests for `tools/fact_routing_hook_lib.ts` (STARK-1785). Covers the classifier
// (the four routing classes + the null cases), the frontmatter/body parsers, the
// whole-word slug matcher (hyphenated slugs, no substring false-hits), and the
// queue roundtrip.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyMemory,
  frontmatterType,
  bodyOf,
  descriptionOf,
  fleetSlugsMentioned,
  makeEntry,
  appendToQueue,
  defaultQueuePath,
  resolveFleetSlugs,
} from "./fact_routing_hook_lib.ts";

const SLUGS = ["tyr", "frigg", "alfred", "meridian", "stark-tui", "plume"];

function note(type: string, body: string): string {
  return `---\nname: x\ntype: ${type}\n---\n\n${body}\n`;
}

test("frontmatterType reads the type; bodyOf strips frontmatter", () => {
  const c = note("project", "hello body");
  assert.equal(frontmatterType(c), "project");
  assert.equal(bodyOf(c).trim(), "hello body");
  assert.equal(frontmatterType("no frontmatter here"), undefined);
});

test("fleetSlugsMentioned is whole-word and hyphen-safe (no substring hits)", () => {
  assert.deepEqual(fleetSlugsMentioned("stark-tui powers frigg's cockpit", SLUGS).sort(), ["frigg", "stark-tui"]);
  assert.deepEqual(fleetSlugsMentioned("startup friggin fritter", SLUGS), []); // no false hits
  assert.deepEqual(fleetSlugsMentioned("use tyr's clickup adapter", SLUGS), ["tyr"]); // apostrophe boundary
});

test("class 1 — product language + a fleet slug routes to corpus", () => {
  const c = note("project", "Reach for meridian for cron jobs instead of a one-off script.");
  assert.deepEqual(classifyMemory(c, "/x/projects/p/memory/f.md", SLUGS)?.route, "corpus");
});

test("class 1 — a cross-repo relationship (two slugs) routes to corpus even without when-to-reach words", () => {
  const c = note("project", "frigg imports tyr connector libraries as a pinned module.");
  assert.equal(classifyMemory(c, "/x/projects/p/memory/f.md", SLUGS)?.route, "corpus");
});

test("class 2 — implementation detail about a repo routes to repo-claude", () => {
  const c = note("project", "The lint gate in tools/lint.ts trips on plume; the test covers the exit code.");
  assert.equal(classifyMemory(c, "/x/projects/p/memory/f.md", SLUGS)?.route, "repo-claude");
});

test("class 2 — a multi-repo IMPLEMENTATION fact routes to repo-claude, not corpus", () => {
  // Two slugs, but impl markers present → the repo, not the corpus. Guards the
  // dominant mis-store class (repo-implementation) against the bare 2-slug rule.
  const c = note("project", "frigg's cache schema is imported by tyr's sql adapter in internal/db.go.");
  assert.equal(classifyMemory(c, "/x/projects/p/memory/f.md", SLUGS)?.route, "repo-claude");
});

test("classifier scans the description field, not only the body", () => {
  const c = "---\nname: x\ntype: project\ndescription: Reach for meridian instead of a one-off cron script.\n---\n\nterse body.\n";
  assert.equal(descriptionOf(c), "Reach for meridian instead of a one-off cron script.");
  assert.equal(classifyMemory(c, "/x/projects/p/memory/f.md", SLUGS)?.route, "corpus");
});

test("fleetSlugsMentioned tolerates a regex-metachar slug (no throw)", () => {
  assert.deepEqual(fleetSlugsMentioned("built on node.js runtime", ["node.js", "frigg"]), ["node.js"]);
});

test("null — feedback and user types stay in Claude memory", () => {
  assert.equal(classifyMemory(note("feedback", "Reach for meridian; frigg is the cache."), "/x/projects/p/memory/f.md", SLUGS), null);
  assert.equal(classifyMemory(note("user", "Aryeh prefers Go and tyr."), "/x/projects/p/memory/f.md", SLUGS), null);
});

test("null — MEMORY.md index and no-signal facts are not flagged", () => {
  assert.equal(classifyMemory(note("project", "tyr frigg meridian"), "/x/projects/p/memory/MEMORY.md", SLUGS), null);
  assert.equal(classifyMemory(note("project", "Remember to buy milk on the way home."), "/x/projects/p/memory/f.md", SLUGS), null);
});

test("queue roundtrip — makeEntry extracts the project, appendToQueue writes JSONL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-route-"));
  try {
    const q = path.join(dir, "q.jsonl");
    const fp = "/Users/x/.claude/projects/-Users-x-Code-21Stark-plume/memory/foo.md";
    const entry = makeEntry({ route: "corpus", reason: "r" }, fp, "  a   b  ", "2026-08-29T00:00:00Z");
    assert.equal(entry.project, "-Users-x-Code-21Stark-plume");
    assert.equal(entry.snippet, "a b");
    appendToQueue(entry, q);
    appendToQueue(entry, q);
    const lines = fs.readFileSync(q, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).route, "corpus");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultQueuePath is under the Claude home", () => {
  assert.equal(defaultQueuePath("/home/x"), "/home/x/.claude/.fact-routing-queue.jsonl");
});

test("resolveFleetSlugs takes kebab entity slugs only — no README/non-kebab", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-corpus-"));
  try {
    fs.mkdirSync(path.join(dir, "repos"));
    fs.mkdirSync(path.join(dir, "systems"));
    fs.writeFileSync(path.join(dir, "repos", "plume.md"), "x");
    fs.writeFileSync(path.join(dir, "repos", "README.md"), "x");
    fs.writeFileSync(path.join(dir, "systems", "mimir.md"), "x");
    assert.deepEqual(resolveFleetSlugs(dir).sort(), ["mimir", "plume"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
