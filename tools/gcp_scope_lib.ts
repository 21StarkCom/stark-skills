/**
 * gcp_scope_lib.ts — pure logic behind `gcp_scope.ts`: map parsing, `.envrc`
 * block rendering, marker splicing, and the ambient-default audit. No I/O.
 *
 * WHY THIS EXISTS
 * ---------------
 * `gcloud config set project` and `gcloud auth login` write GLOBAL state that
 * every other shell and parallel agent session inherits — the same hazard class
 * as an ambient `kubectl` context. Whichever repo you touched last silently
 * decides where the next command goes.
 *
 * The fix is per-directory scoping via direnv. That works, but a hand-wired
 * `.envrc` lives on exactly one machine: `.envrc` belongs in the global
 * gitignore and must STAY there — real ones hold keyfile paths, admin subjects,
 * database URLs and git identity, so un-ignoring that file class would arm them
 * for a stray `git add -A`.
 *
 * So the tool travels and the DATA DOES NOT. The repo→project map is read from a
 * local file outside any repository (see MAP_DOC). Nothing in this package
 * contains a real project id, account, or workspace layout — this package is
 * published to a public marketplace.
 */

/** Where the map lives, and what it looks like. Printed by the CLI on first run. */
export const MAP_DOC = `The map is local data, never committed. Default location:

  $GCP_SCOPE_MAP, else ~/.config/gcp-scope/map.json

  {
    "repos": [
      {
        "repo":       "<path relative to the workspace root>",
        "project":    "<gcp project id>",
        "region":     "<compute region, optional>",
        "account":    "<gcloud account, optional — omit to leave gcloud's own>",
        "sourceUp":   true,          // emit source_up_if_exists (parent .envrc matters)
        "alternates": ["<project>"], // other projects check should accept for this repo
        "why":        "<evidence for this mapping>",
        "notes":      ["<extra comment lines>"]
      }
    ]
  }

Run \`gcp_scope.ts init\` to write a starter file.`;

export type RepoScope = {
  /** Repo path relative to the workspace root. */
  repo: string;
  project: string;
  /** Compute region (`CLOUDSDK_COMPUTE_REGION`). Never a Vertex serving location. */
  region: string;
  /** gcloud account to pin. Empty = leave gcloud's own account resolution alone. */
  account: string;
  /**
   * Emit `source_up_if_exists`. Needed wherever a parent directory's `.envrc`
   * carries state (keys, tokens) that a repo-level `.envrc` would shadow.
   */
  sourceUp: boolean;
  /** Projects `check` also accepts here — e.g. a migration target reached via `.envrc.local`. */
  alternates: string[];
  /** Evidence for the mapping, rendered into the block so the choice stays auditable. */
  why: string;
  /** Extra comment lines emitted after the `use_gcp` call. */
  notes: string[];
};

export const BLOCK_OPEN = "# >>> gcp scope (direnv) >>>";
export const BLOCK_CLOSE = "# <<< gcp scope (direnv) <<<";

export const DIRENVRC_OPEN = "# >>> gcp scope functions (managed) >>>";
export const DIRENVRC_CLOSE = "# <<< gcp scope functions (managed) <<<";

const NEW_FILE_HEADER = "# Local-only (global gitignore). `direnv allow` to activate.";

const SOURCE_UP_HEADER = [
  "# Keep this first: a repo .envrc shadows the parent tree's .envrc, which may",
  "# load credentials. source_up_if_exists pulls it back in.",
  "source_up_if_exists",
];

/** Repo-local overrides go here; `install` never reads or writes this file. */
export const LOCAL_OVERRIDE = ".envrc.local";

/** Safe local file copied by Codex-managed worktrees. */
export const WORKTREE_INCLUDE_PATH = ".envrc";
export const WORKTREE_INCLUDE_COMMENT =
  "# Managed by gcp_scope.ts: copy the generated scope into Codex worktrees.";

export type WorktreeIncludeResult = {
  content: string;
  action: "create" | "append" | "deduplicate" | "unchanged";
  count: number;
};

/**
 * Ensure `.worktreeinclude` names `.envrc` exactly once. Every unrelated line,
 * including comments and ordering, is preserved byte-for-byte. Duplicate
 * `.envrc` rows are collapsed to the first row; no broad glob is introduced.
 */
export function ensureWorktreeInclude(existing: string | null): WorktreeIncludeResult {
  if (existing === null) {
    return {
      content: `${WORKTREE_INCLUDE_COMMENT}\n${WORKTREE_INCLUDE_PATH}\n`,
      action: "create",
      count: 1,
    };
  }

  const lines = existing.split("\n");
  let seen = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim() === WORKTREE_INCLUDE_PATH) {
      seen += 1;
      if (seen > 1) continue;
    }
    kept.push(line);
  }
  if (seen > 1) {
    return { content: kept.join("\n"), action: "deduplicate", count: 1 };
  }
  if (seen === 1) return { content: existing, action: "unchanged", count: 1 };

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const commentSeparator = existing.length === 0 ? "" : "\n";
  return {
    content: `${existing}${separator}${commentSeparator}${WORKTREE_INCLUDE_COMMENT}\n${WORKTREE_INCLUDE_PATH}\n`,
    action: "append",
    count: 1,
  };
}

export function worktreeIncludeCount(content: string): number {
  return content.split("\n").filter((line) => line.trim() === WORKTREE_INCLUDE_PATH).length;
}

// ---------------------------------------------------------------------------
// Map loading
// ---------------------------------------------------------------------------

export type ParsedMap = { scopes: RepoScope[]; errors: string[] };

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Validate an already-parsed map document. Every problem is collected rather
 * than thrown — a single bad row should name itself, not abort the whole run.
 */
export function parseMap(doc: unknown): ParsedMap {
  const errors: string[] = [];
  const scopes: RepoScope[] = [];

  if (typeof doc !== "object" || doc === null || !Array.isArray((doc as { repos?: unknown }).repos)) {
    return { scopes, errors: ['map must be an object with a "repos" array'] };
  }

  const seen = new Set<string>();
  for (const [i, raw] of (doc as { repos: unknown[] }).repos.entries()) {
    const at = `repos[${i}]`;
    if (typeof raw !== "object" || raw === null) {
      errors.push(`${at}: not an object`);
      continue;
    }
    const row = raw as Record<string, unknown>;
    const repo = typeof row.repo === "string" ? row.repo : "";
    const project = typeof row.project === "string" ? row.project : "";

    if (!repo) {
      errors.push(`${at}: missing "repo"`);
      continue;
    }
    if (!project) {
      errors.push(`${at} (${repo}): missing "project"`);
      continue;
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
      errors.push(`${at} (${repo}): "${project}" is not a valid GCP project id`);
      continue;
    }
    if (seen.has(repo)) {
      errors.push(`${at}: duplicate entry for ${repo}`);
      continue;
    }
    seen.add(repo);

    const region = typeof row.region === "string" ? row.region : "";
    if (region && !/^[a-z]+-[a-z]+\d$/.test(region)) {
      errors.push(`${at} (${repo}): "${region}" is not a valid compute region`);
      continue;
    }

    scopes.push({
      repo,
      project,
      region,
      account: typeof row.account === "string" ? row.account : "",
      sourceUp: row.sourceUp === true,
      alternates: asStringArray(row.alternates),
      why: typeof row.why === "string" ? row.why : "",
      notes: asStringArray(row.notes),
    });
  }

  return { scopes, errors };
}

/** Projects `check` accepts for a repo: the mapped one plus any declared alternates. */
export function acceptedProjects(scope: RepoScope): string[] {
  return [scope.project, ...scope.alternates];
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/** The managed block, markers included. Deterministic — no timestamps. */
export function renderBlock(scope: RepoScope): string {
  const args = [scope.project, scope.region, scope.account].filter(Boolean).join(" ");
  const lines = [
    BLOCK_OPEN,
    `# Pins gcloud + ADC to ${scope.project} for this repo ONLY, so a`,
    "# 'gcloud auth login' / 'gcloud config set project' anywhere else cannot move it.",
    "# Managed by gcp_scope.ts — edit the map, not this block.",
  ];
  if (scope.why) lines.push(`# Why this project: ${scope.why}`);
  lines.push(`use_gcp ${args}`);
  for (const note of scope.notes) lines.push(`# ${note}`);
  if (scope.alternates.length > 0) {
    lines.push(
      `# Also valid here: ${scope.alternates.join(", ")}.`,
      `# To switch, put a use_gcp line in ${LOCAL_OVERRIDE} — do NOT edit inside these`,
      "# markers; the next install replaces everything between them.",
    );
  }
  // Sourced last so a local override wins. Never written or read by install.
  lines.push(`source_env_if_exists ${LOCAL_OVERRIDE}`);
  lines.push(BLOCK_CLOSE);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Splicing — additive only
// ---------------------------------------------------------------------------

export type SpliceAction =
  | "create"
  | "replace"
  | "append"
  | "prepend+append"
  | "prepend+replace"
  | "unchanged";

export type SpliceResult =
  | { ok: true; content: string; action: SpliceAction }
  | { ok: false; error: string };

/** Count non-overlapping occurrences of a marker line. */
function countMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/**
 * Locate the managed region, refusing anything ambiguous.
 *
 * A naive `indexOf(OPEN)` + `indexOf(CLOSE)` pair is a file-shredder: given a
 * stray OPEN with no CLOSE (hand edit, or an interrupted write), the first run
 * appends a fresh block, and the SECOND run pairs the stray OPEN with the new
 * block's CLOSE and deletes everything in between — which is exactly the
 * hand-written content this tool promises never to touch. So: exactly one of
 * each, in order, or we refuse to write at all.
 */
export function findBlock(text: string): { start: number; end: number } | null | { error: string } {
  const opens = countMarker(text, BLOCK_OPEN);
  const closes = countMarker(text, BLOCK_CLOSE);

  if (opens === 0 && closes === 0) return null;
  if (opens !== 1 || closes !== 1) {
    return {
      error:
        `malformed managed block (${opens} open marker(s), ${closes} close marker(s)) — ` +
        "refusing to write. Fix the file by hand, leaving exactly one matched pair.",
    };
  }

  const start = text.indexOf(BLOCK_OPEN);
  const end = text.indexOf(BLOCK_CLOSE);
  if (end < start) {
    return { error: "managed block markers are out of order — refusing to write." };
  }
  return { start, end };
}

/**
 * Insert or refresh the managed block.
 *
 * - no file                → create one
 * - exactly one marker pair → replace ONLY between them
 * - no markers             → append; and if `sourceUp` is required but absent,
 *                            PREPEND the guard line too. Prepending is additive:
 *                            without it, a pre-existing `.envrc` silently shadows
 *                            the parent tree's credential loader forever, and
 *                            re-running install can never repair it.
 * - anything ambiguous     → refuse, with the reason
 *
 * Existing hand-written lines are never rewritten or deleted on any path.
 */
export function spliceBlock(existing: string | null, scope: RepoScope): SpliceResult {
  const block = renderBlock(scope);

  if (existing === null) {
    const parts = [NEW_FILE_HEADER];
    if (scope.sourceUp) parts.push(...SOURCE_UP_HEADER);
    parts.push("", block, "");
    return { ok: true, content: parts.join("\n"), action: "create" };
  }

  const found = findBlock(existing);
  if (found !== null && "error" in found) return { ok: false, error: found.error };

  let content: string;
  let action: SpliceAction;

  if (found !== null) {
    content = existing.slice(0, found.start) + block + existing.slice(found.end + BLOCK_CLOSE.length);
    action = "replace";
  } else {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    content = `${existing}${sep}${block}\n`;
    action = "append";
  }

  // The guard is checked on EVERY path, not just first write. A repo whose
  // `.envrc` predates this tool already carries a managed block, so it lands on
  // the replace path — and without this it would stay permanently shadowed,
  // with `install` reporting success and `check` reporting a failure it can
  // never fix. Prepending is purely additive; nothing existing is touched.
  if (scope.sourceUp && !hasSourceUp(content)) {
    content = `${SOURCE_UP_HEADER.join("\n")}\n\n${content}`;
    action = found !== null ? "prepend+replace" : "prepend+append";
  }

  return { ok: true, content, action: content === existing ? "unchanged" : action };
}

/**
 * Splice the shared functions into an existing direnvrc.
 *
 * There is deliberately NO "replace the whole file" path. direnvrc is shared
 * with every other direnv helper the user has written (`layout_go`, `use_nvm`,
 * …); discarding it because it happens to define `use_gcp` would silently break
 * every `.envrc` that calls those. An unmarked pre-existing `use_gcp` is
 * reported so a human can remove it, not deleted.
 */
export function spliceDirenvrc(existing: string | null, functions: string): SpliceResult {
  const block = [DIRENVRC_OPEN, functions.trimEnd(), DIRENVRC_CLOSE].join("\n");

  if (existing === null) return { ok: true, content: `${block}\n`, action: "create" };

  const opens = countMarker(existing, DIRENVRC_OPEN);
  const closes = countMarker(existing, DIRENVRC_CLOSE);

  if (opens > 1 || closes > 1 || opens !== closes) {
    return {
      ok: false,
      error:
        `direnvrc has a malformed managed block (${opens} open, ${closes} close) — ` +
        "refusing to write. Fix it by hand, leaving exactly one matched pair.",
    };
  }

  if (opens === 1) {
    const start = existing.indexOf(DIRENVRC_OPEN);
    const end = existing.indexOf(DIRENVRC_CLOSE);
    if (end < start) {
      return { ok: false, error: "direnvrc managed markers are out of order — refusing to write." };
    }
    const content = existing.slice(0, start) + block + existing.slice(end + DIRENVRC_CLOSE.length);
    return { ok: true, content, action: content === existing ? "unchanged" : "replace" };
  }

  if (definesUseGcp(existing)) {
    return {
      ok: false,
      error:
        "direnvrc already defines use_gcp outside the managed markers. Remove that " +
        "definition by hand, then re-run — refusing to shadow or delete it.",
    };
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return { ok: true, content: `${existing}${sep}${block}\n`, action: "append" };
}

/** Does this direnvrc define `use_gcp` in its own right? */
export function definesUseGcp(content: string): boolean {
  return /^\s*use_gcp\s*\(\s*\)/m.test(content);
}

/** Does an `.envrc` pull in the parent tree's `.envrc`? */
export function hasSourceUp(content: string): boolean {
  return /^\s*source_up(_if_exists)?\b/m.test(content);
}

// ---------------------------------------------------------------------------
// Ambient audit
// ---------------------------------------------------------------------------

export type AmbientState = {
  /** `core/project` on the `default` gcloud configuration of the SHARED state dir. */
  defaultConfigProject: string;
  /** Which gcloud state dir was audited — "" means the process default. */
  auditedConfigDir: string;
  /** Whether the login shell rc still exports a global `GOOGLE_CLOUD_PROJECT`. */
  shellRcExportsProject: boolean;
  /** Path of that rc, for the message. */
  shellRcPath: string;
};

/**
 * An ambient project default is worse than none: it makes an unscoped context
 * resolve *some* project and come back empty, which reads as "nothing deployed"
 * instead of "wrong project". Clearing both known sources makes gcloud say
 * "The required property [project] is not currently set" and client libraries
 * resolve project None.
 *
 * The ADC `quota_project_id` is deliberately left alone — it drives billing
 * attribution, not project resolution, and `use_gcp` overrides it per repo.
 */
export function ambientProblems(state: AmbientState): string[] {
  const problems: string[] = [];
  if (state.defaultConfigProject) {
    const where = state.auditedConfigDir ? ` (state dir ${state.auditedConfigDir})` : "";
    problems.push(
      `gcloud \`default\` configuration${where} still pins ` +
        `core/project=${state.defaultConfigProject} — an unscoped shell will silently ` +
        "use it. Fix, from a shell scoped to that same state dir: " +
        "`env -u CLOUDSDK_ACTIVE_CONFIG_NAME -u CLOUDSDK_CORE_PROJECT gcloud config unset project`",
    );
  }
  if (state.shellRcExportsProject) {
    problems.push(
      `${state.shellRcPath} still exports a global GOOGLE_CLOUD_PROJECT — remove it; ` +
        "the project belongs in the repo's .envrc via `use_gcp`",
    );
  }
  return problems;
}

/** True when a line exports GOOGLE_CLOUD_PROJECT for real (comments don't count). */
export function exportsProject(rc: string): boolean {
  return rc.split("\n").some((line) => /^\s*export\s+GOOGLE_CLOUD_PROJECT\s*=/.test(line));
}

// ---------------------------------------------------------------------------
// Probe interpretation
// ---------------------------------------------------------------------------

export type ProbeResult = {
  /** Value of the proof-of-execution marker `use_gcp` exports. */
  active: string;
  /** `CLOUDSDK_CORE_PROJECT` as observed. */
  project: string;
  /** Anything direnv wrote to stderr. */
  stderr: string;
};

/**
 * Decide whether a probe proves the scope is live.
 *
 * `direnv exec` exits 0 even when the `.envrc` failed — it logs the error to
 * stderr and runs the command anyway, with the CALLER's environment. So an
 * inherited `CLOUDSDK_CORE_PROJECT` alone proves nothing; we require the marker
 * that only `use_gcp` sets, and treat any direnv stderr diagnostic as fatal.
 */
export function probeProblem(scope: RepoScope, probe: ProbeResult): string | null {
  // `direnv: loading …` / `direnv: export …` are normal chatter; only quote the
  // line that actually names the failure, or the message points at the wrong one.
  const fault = /error|command not found|denied|permission|failed|is blocked/i;
  const faultLine = probe.stderr.split("\n").find((l) => fault.test(l));
  if (faultLine !== undefined) {
    return `${scope.repo}: .envrc failed to load — ${faultLine.replace(/\[[0-9;]*m/g, "").trim()}`;
  }
  if (!probe.active) {
    return (
      `${scope.repo}: use_gcp did not run (no GCP_SCOPE_ACTIVE marker). ` +
      "The direnv functions are missing or the .envrc is not allowed — any project " +
      "you see here leaked in from the calling shell."
    );
  }
  const accepted = acceptedProjects(scope);
  if (!accepted.includes(probe.active)) {
    return `${scope.repo}: resolves to "${probe.active}", expected ${accepted.map((p) => `"${p}"`).join(" or ")}`;
  }
  if (probe.project && probe.project !== probe.active) {
    return (
      `${scope.repo}: CLOUDSDK_CORE_PROJECT="${probe.project}" disagrees with ` +
      `GCP_SCOPE_ACTIVE="${probe.active}" — something overrode the scope after use_gcp ran`
    );
  }
  return null;
}
