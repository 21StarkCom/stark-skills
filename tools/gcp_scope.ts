#!/usr/bin/env node --no-warnings
/**
 * gcp_scope.ts — install and verify per-repo GCP project scope.
 *
 * All logic lives in `gcp_scope_lib.ts` and the shell text in
 * `gcp_scope_direnvrc.ts`; this file is I/O only — the filesystem, and `direnv`
 * and `gcloud` as subprocesses.
 *
 * Subcommands:
 *   init                               write a starter map file
 *   install [--dry-run] [--no-allow]   write the shared direnv functions +
 *                                      every mapped repo's `.envrc` block
 *   check                              verify each repo resolves to its mapped
 *                                      project (LIVE); exit 1 on drift
 *   list                               print the map
 *
 * Options:
 *   --root <dir>        workspace root (default $STARK_CODE_ROOT or ~/Code)
 *   --map <file>        map file (default $GCP_SCOPE_MAP or ~/.config/gcp-scope/map.json)
 *   --direnvrc <file>   direnvrc to manage. Defaults under --root when --root is
 *                       given, so a sandbox run cannot touch the real one.
 *
 * `install` is additive: it owns only the region between its markers, and
 * refuses to write anything it cannot splice unambiguously.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  MAP_DOC,
  acceptedProjects,
  ambientProblems,
  exportsProject,
  parseMap,
  probeProblem,
  renderBlock,
  spliceBlock,
  spliceDirenvrc,
} from "./gcp_scope_lib.ts";
import type { RepoScope } from "./gcp_scope_lib.ts";
import { direnvrcFunctions } from "./gcp_scope_direnvrc.ts";

const KNOWN_FLAGS = new Set(["--root", "--map", "--direnvrc"]);
const KNOWN_SWITCHES = new Set(["--dry-run", "--no-allow"]);

type Options = {
  root: string;
  mapPath: string;
  direnvrc: string;
  dryRun: boolean;
  allow: boolean;
};

/** Accepts both `--flag value` and `--flag=value`, and rejects anything unknown. */
function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (KNOWN_SWITCHES.has(name)) {
      if (eq !== -1) die(`${name} takes no value`);
      switches.add(name);
      continue;
    }
    if (!KNOWN_FLAGS.has(name)) die(`unknown argument: ${arg}`);

    if (eq !== -1) {
      values[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`${name} needs a value`);
    values[name] = next;
    i += 1;
  }

  const rootGiven = values["--root"] !== undefined;
  const root = resolve(values["--root"] ?? process.env.STARK_CODE_ROOT ?? join(homedir(), "Code"));

  // A --root run is a sandbox run. Keeping DIRENVRC pinned to the real home
  // would let "try it safely" clobber the user's live direnvrc, so it moves too
  // unless explicitly overridden.
  const defaultDirenvrc = rootGiven
    ? join(root, ".config", "direnv", "direnvrc")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "direnv", "direnvrc");

  return {
    root,
    mapPath: resolve(
      values["--map"] ??
        process.env.GCP_SCOPE_MAP ??
        join(homedir(), ".config", "gcp-scope", "map.json"),
    ),
    direnvrc: resolve(values["--direnvrc"] ?? process.env.GCP_SCOPE_DIRENVRC ?? defaultDirenvrc),
    dryRun: switches.has("--dry-run"),
    allow: !switches.has("--no-allow"),
  };
}

function die(message: string): never {
  console.error(`gcp_scope: ${message}`);
  process.exit(2);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function loadScopes(opts: Options): RepoScope[] {
  const raw = readIfExists(opts.mapPath);
  if (raw === null) {
    console.error(`gcp_scope: no map at ${opts.mapPath}\n\n${MAP_DOC}`);
    process.exit(2);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    die(`${opts.mapPath} is not valid JSON: ${(err as Error).message}`);
  }
  const { scopes, errors } = parseMap(doc);
  if (errors.length > 0) {
    console.error(`gcp_scope: ${opts.mapPath} has problems:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  return scopes;
}

function repoDir(opts: Options, scope: RepoScope): string {
  return isAbsolute(scope.repo) ? scope.repo : join(opts.root, scope.repo);
}

function isRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function haveDirenv(): boolean {
  try {
    execFileSync("direnv", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

function init(opts: Options): number {
  if (existsSync(opts.mapPath)) {
    console.log(`map already exists: ${opts.mapPath}`);
    return 0;
  }
  const starter = {
    repos: [
      {
        repo: "example/repo",
        project: "example-project-id",
        region: "us-central1",
        account: "",
        sourceUp: false,
        alternates: [],
        why: "replace with real evidence for this mapping",
        notes: [],
      },
    ],
  };
  mkdirSync(dirname(opts.mapPath), { recursive: true });
  writeFileSync(opts.mapPath, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
  console.log(`wrote starter map: ${opts.mapPath}\n\n${MAP_DOC}`);
  return 0;
}

function install(opts: Options): number {
  const scopes = loadScopes(opts);
  const allow = opts.allow && haveDirenv();
  const problems: string[] = [];

  // --- shared functions -----------------------------------------------------
  const existingRc = readIfExists(opts.direnvrc);
  const rc = spliceDirenvrc(existingRc, direnvrcFunctions());

  if (!rc.ok) {
    console.error(`direnvrc  REFUSED   ${opts.direnvrc}\n  ${rc.error}`);
    return 1;
  }
  if (rc.action !== "unchanged" && !opts.dryRun) {
    mkdirSync(dirname(opts.direnvrc), { recursive: true });
    if (existingRc !== null) {
      // Always back up before modifying, under a unique name — a fixed `.bak`
      // gets overwritten by the next run and a content-sniffing guard silently
      // stops firing once our own marker text is present.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(opts.direnvrc, `${opts.direnvrc}.${stamp}.bak`);
    }
    writeFileSync(opts.direnvrc, rc.content, "utf8");
  }
  console.log(`direnvrc  ${rc.action.padEnd(14)} ${opts.direnvrc}`);

  // --- per-repo blocks ------------------------------------------------------
  let wired = 0;

  for (const scope of scopes) {
    const dir = repoDir(opts, scope);
    if (!isRepo(dir)) {
      console.log(`  skip           ${scope.repo} — not a git repo under ${opts.root}`);
      problems.push(`${scope.repo}: not cloned at ${dir}`);
      continue;
    }

    const path = join(dir, ".envrc");
    const result = spliceBlock(readIfExists(path), scope);

    if (!result.ok) {
      console.log(`  REFUSED        ${scope.repo}`);
      problems.push(`${scope.repo}: ${result.error}`);
      continue;
    }
    if (result.action !== "unchanged" && !opts.dryRun) {
      writeFileSync(path, result.content, "utf8");
      // Only re-bless a file we just changed. Blanket `direnv allow` would
      // auto-approve `.envrc` edits made by anything else since the last run.
      if (allow) execFileSync("direnv", ["allow", dir], { stdio: "ignore" });
    }

    console.log(
      `  ${result.action.padEnd(14)} ${scope.repo.padEnd(46)} ${scope.project}${
        scope.region ? ` (${scope.region})` : ""
      }`,
    );
    wired += 1;
  }

  console.log(`\n${wired}/${scopes.length} repo(s) wired${opts.dryRun ? " — DRY RUN, nothing written" : ""}.`);
  if (!allow && !opts.dryRun) {
    console.log("direnv not run — `direnv allow <repo>` each before the scope takes effect.");
  }
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  return 0;
}

/**
 * Read the ambient fallbacks a scoped repo is meant to make irrelevant.
 *
 * CLOUDSDK_CONFIG is scrubbed along with the project vars: without that, this
 * audits whichever gcloud STATE DIR the calling shell happens to be scoped to
 * (an identity tree flips it), so it would both miss a live default in the
 * shared dir and print a fix command that damages the wrong config.
 */
function readAmbient(): {
  defaultConfigProject: string;
  auditedConfigDir: string;
  shellRcExportsProject: boolean;
  shellRcPath: string;
} {
  const env = { ...process.env };
  delete env.CLOUDSDK_CONFIG;
  delete env.CLOUDSDK_ACTIVE_CONFIG_NAME;
  delete env.CLOUDSDK_CORE_PROJECT;
  const auditedConfigDir = join(homedir(), ".config", "gcloud");

  let defaultConfigProject = "";
  try {
    defaultConfigProject = execFileSync(
      "gcloud",
      ["config", "configurations", "describe", "default", "--format=value(properties.core.project)"],
      { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // gcloud absent, or no `default` configuration — nothing ambient to leak.
  }

  const shellRcPath = resolve(
    process.env.GCP_SCOPE_SHELL_RC ??
      (existsSync(join(homedir(), ".zshrc")) ? join(homedir(), ".zshrc") : join(homedir(), ".bashrc")),
  );
  const rc = readIfExists(shellRcPath);

  return {
    defaultConfigProject,
    auditedConfigDir,
    shellRcExportsProject: rc === null ? false : exportsProject(rc),
    shellRcPath,
  };
}

/** Env for the live probe: everything the `.envrc` is supposed to set is removed. */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLOUDSDK_|GOOGLE_CLOUD_|GCP_)/.test(k)) continue;
    if (k === "GOOGLE_APPLICATION_CREDENTIALS") continue;
    env[k] = v;
  }
  return env;
}

function check(opts: Options): number {
  const scopes = loadScopes(opts);
  const live = haveDirenv();
  const problems: string[] = [...ambientProblems(readAmbient())];

  if (!live) console.log("direnv not on PATH — static checks only.\n");

  for (const scope of scopes) {
    const dir = repoDir(opts, scope);
    if (!isRepo(dir)) {
      problems.push(`${scope.repo}: not cloned at ${dir}`);
      continue;
    }

    const path = join(dir, ".envrc");
    const content = readIfExists(path);

    if (content === null) {
      problems.push(`${scope.repo}: no .envrc — run \`gcp_scope.ts install\``);
      continue;
    }
    if (!content.includes(renderBlock(scope))) {
      problems.push(`${scope.repo}: .envrc block is stale — run \`gcp_scope.ts install\``);
    }
    if (!live) continue;

    // LIVE probe. spawnSync, not execFileSync, because stderr must be READ:
    // `direnv exec` exits 0 even when the .envrc failed — it logs the error and
    // runs the command anyway with the caller's env — so its diagnostics are the
    // only signal that the scope is dead.
    const probe = spawnSync(
      "direnv",
      ["exec", dir, "sh", "-c", 'printf "%s\\n%s" "$GCP_SCOPE_ACTIVE" "$CLOUDSDK_CORE_PROJECT"'],
      { encoding: "utf8", env: probeEnv() },
    );
    if (probe.error || probe.status !== 0) {
      const why = (probe.stderr ?? probe.error?.message ?? "").trim();
      problems.push(`${scope.repo}: direnv exec failed — ${why}`);
      continue;
    }
    const [active = "", project = ""] = (probe.stdout ?? "").split("\n");
    const problem = probeProblem(scope, { active, project, stderr: probe.stderr ?? "" });

    console.log(
      `  ${problem === null ? "ok   " : "DRIFT"} ${scope.repo.padEnd(46)} ${active || "<unset>"}`,
    );
    if (problem !== null) problems.push(problem);
  }

  if (problems.length === 0) {
    console.log(`\nAll ${scopes.length} repo(s) scoped correctly; no ambient default survives.`);
    return 0;
  }
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

function list(opts: Options): number {
  const scopes = loadScopes(opts);
  for (const scope of scopes) {
    const alt = scope.alternates.length > 0 ? ` [+${scope.alternates.join(",")}]` : "";
    console.log(
      `${scope.repo.padEnd(46)} ${(scope.project + alt).padEnd(34)} ${scope.region.padEnd(12)} ${scope.why}`,
    );
  }
  console.log(`\n${scopes.length} repo(s) mapped — ${opts.mapPath}`);
  return 0;
}

const [, , command = "", ...rest] = process.argv;
if (!["init", "install", "check", "list"].includes(command)) {
  console.error(
    "usage: gcp_scope.ts <init|install|check|list> [--root <dir>] [--map <file>]\n" +
      "                   [--direnvrc <file>] [--dry-run] [--no-allow]",
  );
  process.exit(2);
}

const options = parseArgs(rest);
switch (command) {
  case "init":
    process.exit(init(options));
  case "install":
    process.exit(install(options));
  case "check":
    process.exit(check(options));
  default:
    process.exit(list(options));
}
