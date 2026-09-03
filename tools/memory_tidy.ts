#!/usr/bin/env node
/**
 * memory_tidy — CLI over memory_tidy_lib. Measures Claude Code auto-memory dirs
 * against the load/recall caps and flags mis-stored cross-repo facts, then prints
 * one JSON report on stdout. READ-ONLY: it never writes a memory file — the
 * `/stark-memory` skill reads this report and does the rewriting.
 *
 *   node memory_tidy.ts [--project <slug>|--all] [--dry-run] [--apply] [--json]
 *
 * `--project` takes an exact project-dir slug (leading `-`, e.g.
 * `-Users-you-Code-org-alfred`) OR a bare repo name (`alfred`) resolved against
 * the projects that have a memory/ dir. `--all` (default), `--dry-run`,
 * `--apply` and `--json` are accepted so the skill can pass `$ARGUMENTS`
 * verbatim; the tool always emits JSON and never mutates, so they are no-ops
 * here — the dry-run/apply distinction lives in the skill's write phase.
 */
import { isMainModule } from "./main_module_lib.ts";
import {
  measureTree,
  listMemoryProjects,
  ownSlugOf,
  resolveFleetSlugSet,
  defaultProjectsDir,
  defaultCorpusPath,
} from "./memory_tidy_lib.ts";

const USAGE = `Usage: memory_tidy [--project <slug>|--all] [--dry-run] [--apply] [--json]

Measures every ~/.claude/projects/<slug>/memory dir against the Claude Code
load/recall caps (index: first 200 lines / 25,000 chars; each file: first 200
lines / 4,096 bytes; index line soft cap 150 chars) and flags cross-repo facts
(a memory whose subject is a different fleet repo). Read-only; prints a JSON
report on stdout. The /stark-memory skill consumes it and does any rewriting.

  --project <slug>  restrict to one project (exact leading-dash slug or a bare
                    repo name resolved against dirs with a memory/)
  --all             every project (default)
  --dry-run/--apply accepted no-ops (the skill gates writes, not this tool)
  --json            accepted no-op (output is always JSON)
  -h, --help        print this and exit`;

export interface MainDeps {
  projectsDir?: string;
  corpusPath?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

const BOOLEANS = new Set(["all", "dry-run", "apply", "json", "help", "h"]);
const VALUES = new Set(["project"]);

interface Parsed {
  project?: string;
  help: boolean;
}

/** Parse flags; unknown flags are a hard error (never a silent drop). A value
 *  that begins with `-` is still consumed as the value of the preceding flag. */
function parseFlags(argv: string[]): Parsed {
  const out: Parsed = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") && arg !== "-h") throw new Error(`unexpected argument: ${arg}`);
    const key = arg === "-h" ? "h" : arg.slice(2);
    if (BOOLEANS.has(key)) {
      if (key === "help" || key === "h") out.help = true;
      continue;
    }
    if (!VALUES.has(key)) {
      const known = [...BOOLEANS, ...VALUES].filter((k) => k !== "h").sort().map((k) => `--${k}`).join(", ");
      throw new Error(`unknown flag: --${key} (known flags: ${known}, -h)`);
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} requires a value`);
    out.project = v;
  }
  return out;
}

/** Resolve a `--project` value to an exact project-dir slug. A leading-dash value
 *  is taken literally; a bare name is matched against each project's own fleet
 *  slug (refusing an empty or ambiguous match). */
function resolveProject(value: string, projectsDir: string, corpusPath: string): { slug?: string; error?: string } {
  if (value.startsWith("-")) return { slug: value };
  const fleetSlugs = resolveFleetSlugSet(corpusPath);
  const matches = listMemoryProjects(projectsDir).filter((slug) => ownSlugOf(slug, fleetSlugs) === value);
  if (matches.length === 0) return { error: `no project with a memory dir resolves to "${value}"` };
  if (matches.length > 1) return { error: `ambiguous project "${value}" — matches: ${matches.join(", ")}` };
  return { slug: matches[0]! };
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));

  let parsed: Parsed;
  try {
    parsed = parseFlags(argv);
  } catch (e) {
    stderr(`memory_tidy: ${(e as Error).message}\n`);
    return 2;
  }

  if (parsed.help) {
    stdout(USAGE + "\n");
    return 0;
  }

  const projectsDir = deps.projectsDir ?? defaultProjectsDir();
  const corpusPath = deps.corpusPath ?? defaultCorpusPath();

  let project: string | undefined;
  if (parsed.project !== undefined) {
    const r = resolveProject(parsed.project, projectsDir, corpusPath);
    if (r.error) {
      stderr(`memory_tidy: ${r.error}\n`);
      return 2;
    }
    project = r.slug;
  }

  const report = measureTree({ projectsDir, corpusPath, project });
  stdout(JSON.stringify(report, null, 2) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
