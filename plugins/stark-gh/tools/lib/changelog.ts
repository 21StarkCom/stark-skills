// CHANGELOG.md marker-based update under ## [Unreleased] → ### <Section>.
// Marker is matched on PR number ONLY (runId is informational); reruns find
// their own entry deterministically across runs (rt7 idempotency).

const SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"] as const;
export type Section = (typeof SECTIONS)[number];

export interface UpdateInput {
  content: string;
  pr: number;
  runId: string;
  section: Section;
  bullet: string;          // must match /^- [^\n]{1,198}$/
}

export interface UpdateResult {
  content: string;
  changed: boolean;
  markerLine: string;      // the canonical marker line for this PR
}

const BULLET_RE = /^- [^\n]{1,198}$/;
const PR_RE = /^[1-9]\d*$/;       // positive integer (no leading zeros, no zero)

function buildMarker(pr: number, runId: string): string {
  return `<!-- stark-gh:pr-merge pr=${pr} runId=${runId} -->`;
}

function buildPrPrefix(pr: number): string {
  return `<!-- stark-gh:pr-merge pr=${pr} `;
}

// Parse the [Unreleased] block: returns the line indices [start, end) where
// `start` is the line index of `## [Unreleased]` and `end` is the line index
// of the next `## ` heading (or content length).
function findUnreleasedBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(l => /^## \[Unreleased\]\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// Inside [start, end), find the section subheading line index. Sections look
// like `### Added`. Returns -1 if not present.
function findSection(lines: string[], start: number, end: number, section: Section): number {
  const re = new RegExp(`^### ${section}\\s*$`);
  for (let i = start + 1; i < end; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

// Inside the [Unreleased] block, find a marker line whose PR number matches.
// Returns the line index of the marker, or -1 if not found.
function findMarker(lines: string[], start: number, end: number, pr: number): number {
  const prefix = buildPrPrefix(pr);
  for (let i = start + 1; i < end; i++) {
    if (lines[i].startsWith(prefix) && lines[i].endsWith("-->")) return i;
  }
  return -1;
}

export function updateUnreleasedChangelog(input: UpdateInput): UpdateResult {
  if (!PR_RE.test(String(input.pr))) {
    throw new Error(`updateUnreleasedChangelog: pr must be a positive integer; got ${input.pr}`);
  }
  if (!BULLET_RE.test(input.bullet)) {
    throw new Error(`updateUnreleasedChangelog: bullet must match /^- .{1,198}$/ (single line); got ${JSON.stringify(input.bullet)}`);
  }
  if (!SECTIONS.includes(input.section)) {
    throw new Error(`updateUnreleasedChangelog: invalid section ${input.section}`);
  }

  const lines = input.content.split("\n");
  const unrel = findUnreleasedBlock(lines);
  if (!unrel) {
    throw new Error("updateUnreleasedChangelog: ## [Unreleased] section not found");
  }

  const newMarker = buildMarker(input.pr, input.runId);
  const markerIdx = findMarker(lines, unrel.start, unrel.end, input.pr);

  if (markerIdx >= 0) {
    // Rerun: existing marker found. Bullet is the line immediately following.
    const bulletIdx = markerIdx + 1;
    const existingBullet = lines[bulletIdx] ?? "";
    if (existingBullet === input.bullet) {
      // Byte-identical bullet — no change at all (don't even update runId).
      return { content: input.content, changed: false, markerLine: lines[markerIdx] };
    }
    // Replace bullet line and rewrite marker with current runId.
    const next = lines.slice();
    next[markerIdx] = newMarker;
    next[bulletIdx] = input.bullet;
    return { content: next.join("\n"), changed: true, markerLine: newMarker };
  }

  // First-run insert: locate or create ### <Section> under [Unreleased].
  let sectionIdx = findSection(lines, unrel.start, unrel.end, input.section);
  const next = lines.slice();
  if (sectionIdx < 0) {
    // Create section right after `## [Unreleased]` (and any blank line).
    const insertAt = unrel.start + 1;
    // Skip blank line if present right after the heading
    let blanks = 0;
    while (insertAt + blanks < unrel.end && next[insertAt + blanks] === "") blanks++;
    const insertion = [`### ${input.section}`, newMarker, input.bullet, ""];
    next.splice(insertAt + blanks, 0, ...insertion);
    return { content: next.join("\n"), changed: true, markerLine: newMarker };
  }
  // Insert at top of subsection (right after `### Section`).
  // Find the line right after the section heading. Skip a blank line if present.
  let insertAt = sectionIdx + 1;
  if (next[insertAt] === "") insertAt++;
  next.splice(insertAt, 0, newMarker, input.bullet);
  return { content: next.join("\n"), changed: true, markerLine: newMarker };
}
