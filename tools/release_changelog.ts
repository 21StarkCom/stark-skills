#!/usr/bin/env node

// stark-release Step 3 — assemble the unreleased-changes payload for the next
// version bump. Two sources, in priority order:
//
//   1. The `## [Unreleased]` section of CHANGELOG.md, if it has bullets.
//   2. `git log <last-tag>..HEAD` (or full history when no tag exists),
//      categorized by Conventional Commits prefix.
//
// Output is a structured JSON receipt the skill can render and act on, so the
// SKILL.md doesn't have to inline 60 lines of bash + parsing rules.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type CategoryName = "added" | "fixed" | "changed" | "removed";

export type CommitRecord = { subject: string; body: string };

export type CategorizedEntry = {
  category: CategoryName;
  entry: string;
  breaking: boolean;
};

export type UnreleasedSection = {
  added: string[];
  fixed: string[];
  changed: string[];
  removed: string[];
  raw: string;
  isEmpty: boolean;
};

export type GatheredChanges = {
  source: "changelog" | "git-log" | "empty";
  lastTag: string | null;
  added: string[];
  fixed: string[];
  changed: string[];
  removed: string[];
  hasBreaking: boolean;
  totalEntries: number;
  recommendedBump: "patch" | "minor" | "major" | null;
};

// ── Pure parsers ────────────────────────────────────────────────

const TYPE_RE =
  /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<subject>.*)$/;

export function parseGitLogRecords(output: string): CommitRecord[] {
  if (!output.trim()) return [];
  // `--format='%s%n%b%x1e'` separates commits with the ASCII Record Separator
  // () so commit bodies can contain blank lines without being mistaken
  // for inter-commit boundaries. Tolerate trailing whitespace/newlines.
  return output
    .split(/\n?/)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [first, ...rest] = record.split("\n");
      return { subject: first ?? "", body: rest.join("\n").trim() };
    });
}

export function categorizeCommit(record: CommitRecord): CategorizedEntry {
  const bodyBreaking = /^BREAKING CHANGE:/m.test(record.body);
  const match = record.subject.match(TYPE_RE);
  if (!match?.groups) {
    return { category: "changed", entry: record.subject.trim(), breaking: bodyBreaking };
  }
  const type = match.groups.type.toLowerCase();
  const scope = match.groups.scope?.trim();
  const bang = match.groups.bang === "!";
  const subject = match.groups.subject.trim();
  const breaking = bodyBreaking || bang;

  let category: CategoryName;
  if (type === "feat") category = "added";
  else if (type === "fix") category = "fixed";
  else category = "changed";
  // Breaking changes always go under Changed with a BREAKING marker, matching
  // the legacy SKILL.md mapping. A `feat!` is a breaking-feature; users want
  // to see it called out explicitly rather than buried under Added.
  if (breaking) category = "changed";

  const body = scope ? `${scope}: ${subject}` : subject;
  const entry = breaking ? `**BREAKING:** ${body}` : body;
  return { category, entry, breaking };
}

export function parseChangelogUnreleased(changelogContent: string): UnreleasedSection {
  // Find the `## [Unreleased]` heading; bail if absent.
  const headerIdx = changelogContent.search(/^##\s*\[Unreleased\]/m);
  if (headerIdx === -1) {
    return { added: [], fixed: [], changed: [], removed: [], raw: "", isEmpty: true };
  }
  // Strip the heading line itself, then truncate at the next versioned
  // section (`## [vX.Y.Z]`). JS regex has no `\Z` anchor, so we slice
  // manually instead of relying on a lookahead-to-EOF.
  const afterHeader = changelogContent.slice(headerIdx).replace(/^[^\n]*\n?/, "");
  const nextSection = afterHeader.search(/^##\s*\[/m);
  const sectionContent =
    nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  return parseUnreleasedSections(sectionContent);
}

function parseUnreleasedSections(raw: string): UnreleasedSection {
  const added: string[] = [];
  const fixed: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  let current: CategoryName | null = null;
  for (const line of raw.split("\n")) {
    const sub = line.match(/^###\s+(\w+)/);
    if (sub) {
      const name = sub[1].toLowerCase();
      current =
        name === "added" || name === "fixed" || name === "changed" || name === "removed"
          ? name
          : null;
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet && current) {
      const text = bullet[1].trim();
      if (!text) continue;
      if (current === "added") added.push(text);
      else if (current === "fixed") fixed.push(text);
      else if (current === "removed") removed.push(text);
      else changed.push(text);
    }
  }
  return {
    added,
    fixed,
    changed,
    removed,
    raw: raw.trim(),
    isEmpty: added.length + fixed.length + changed.length + removed.length === 0,
  };
}

// ── Composition ─────────────────────────────────────────────────

export function recommendBump(
  added: string[],
  fixed: string[],
  changed: string[],
  hasBreaking: boolean,
  // Trailing optional so existing 4-arg callers keep working. A bare ### Removed
  // entry is NOT auto-major: many removals (docs, dead tooling, internal churn)
  // are non-breaking. Authors mark genuinely breaking removals with a
  // `**BREAKING:**` prefix, which routes through hasBreaking → major.
  removed: string[] = [],
): "patch" | "minor" | "major" | null {
  if (added.length + fixed.length + changed.length + removed.length === 0) return null;
  if (hasBreaking) return "major";
  if (added.length > 0) return "minor";
  // Only Fixed / Changed / Removed entries → patch (no new feature, no breaking).
  return "patch";
}

export function gatherChanges(opts: {
  changelogContent: string;
  gitLogOutput: string;
  lastTag: string | null;
}): GatheredChanges {
  const unreleased = parseChangelogUnreleased(opts.changelogContent);

  if (!unreleased.isEmpty) {
    const hasBreaking = [...unreleased.changed, ...unreleased.removed].some((entry) =>
      /^\*\*BREAKING:\*\*/.test(entry),
    );
    return {
      source: "changelog",
      lastTag: opts.lastTag,
      added: unreleased.added,
      fixed: unreleased.fixed,
      changed: unreleased.changed,
      removed: unreleased.removed,
      hasBreaking,
      totalEntries:
        unreleased.added.length +
        unreleased.fixed.length +
        unreleased.changed.length +
        unreleased.removed.length,
      recommendedBump: recommendBump(
        unreleased.added,
        unreleased.fixed,
        unreleased.changed,
        hasBreaking,
        unreleased.removed,
      ),
    };
  }

  const records = parseGitLogRecords(opts.gitLogOutput);
  if (records.length === 0) {
    return {
      source: "empty",
      lastTag: opts.lastTag,
      added: [],
      fixed: [],
      changed: [],
      removed: [],
      hasBreaking: false,
      totalEntries: 0,
      recommendedBump: null,
    };
  }

  const added: string[] = [];
  const fixed: string[] = [];
  const changed: string[] = [];
  let hasBreaking = false;
  for (const record of records) {
    const result = categorizeCommit(record);
    if (result.breaking) hasBreaking = true;
    if (result.category === "added") added.push(result.entry);
    else if (result.category === "fixed") fixed.push(result.entry);
    else changed.push(result.entry);
  }
  // git-log categorization never yields "removed": Conventional Commits has no
  // removal type, so removals surface as chore/refactor → changed. ### Removed
  // is a CHANGELOG-authored category only.
  return {
    source: "git-log",
    lastTag: opts.lastTag,
    added,
    fixed,
    changed,
    removed: [],
    hasBreaking,
    totalEntries: added.length + fixed.length + changed.length,
    recommendedBump: recommendBump(added, fixed, changed, hasBreaking),
  };
}

// ── CLI plumbing ────────────────────────────────────────────────

function readChangelog(repoRoot: string): string {
  const candidate = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(candidate)) {
    throw new Error(`CHANGELOG.md not found at ${candidate}`);
  }
  return fs.readFileSync(candidate, "utf8");
}

export function readLastTag(repoRoot: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "tag", "--sort=-v:refname"],
      { encoding: "utf8" },
    ).split("\n").map((line) => line.trim()).filter(Boolean);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

export function readGitLogSince(
  repoRoot: string,
  lastTag: string | null,
): string {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const args = [
    "-C",
    repoRoot,
    "log",
    range,
    "--no-merges",
    "--format=%s%n%b%x1e",
  ];
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch (err) {
    // No commits in range / fresh repo → empty string is fine; caller handles.
    if (lastTag) return "";
    throw err;
  }
}

function formatText(changes: GatheredChanges): string {
  const out: string[] = [];
  const sourceLabel =
    changes.source === "changelog"
      ? "from CHANGELOG"
      : changes.source === "git-log"
        ? "auto-generated from git log"
        : "no commits";
  const since = changes.lastTag ? `since ${changes.lastTag}` : "from full history";
  out.push(`Unreleased changes (${sourceLabel}, ${since}):`);
  out.push("");
  if (changes.added.length) {
    out.push("### Added");
    for (const e of changes.added) out.push(`- ${e}`);
    out.push("");
  }
  if (changes.fixed.length) {
    out.push("### Fixed");
    for (const e of changes.fixed) out.push(`- ${e}`);
    out.push("");
  }
  if (changes.changed.length) {
    out.push("### Changed");
    for (const e of changes.changed) out.push(`- ${e}`);
    out.push("");
  }
  if (changes.removed.length) {
    out.push("### Removed");
    for (const e of changes.removed) out.push(`- ${e}`);
    out.push("");
  }
  out.push(
    `Recommended bump: ${changes.recommendedBump ?? "none"}` +
      (changes.hasBreaking ? "  (BREAKING)" : ""),
  );
  return out.join("\n");
}

function parseArgs(argv: string[]): {
  asJson: boolean;
  repo: string;
} {
  let asJson = false;
  let repo = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") asJson = true;
    else if (arg === "--repo") repo = argv[++i] ?? repo;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: release_changelog [--json] [--repo PATH]\n" +
          "\n" +
          "Reads CHANGELOG.md and (when [Unreleased] is empty) git log\n" +
          "since the last tag, and emits the categorized unreleased changes.",
      );
      process.exit(0);
    }
  }
  return { asJson, repo: path.resolve(repo) };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  let changelogContent: string;
  try {
    changelogContent = readChangelog(opts.repo);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const lastTag = readLastTag(opts.repo);
  const gitLogOutput = readGitLogSince(opts.repo, lastTag);
  const changes = gatherChanges({ changelogContent, gitLogOutput, lastTag });
  if (opts.asJson) {
    console.log(JSON.stringify(changes, null, 2));
  } else {
    console.log(formatText(changes));
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url ===
    pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href;
if (invokedDirectly) {
  main();
}
