#!/usr/bin/env node
/**
 * github_projects CLI — TypeScript port of `scripts/github_projects.py`'s
 * surface, exposed as subcommands so SKILL.md callers can shell out
 * instead of going through `python3 -c "import github_projects; ..."`.
 *
 * All commands print JSON on stdout by default — the Python module's
 * callers piped its `print(json.dumps(...))` output through `jq`, so
 * keeping the contract JSON-first preserves that pattern.
 *
 *   github_projects.ts find-project --org ORG --name NAME
 *   github_projects.ts add-issue --project PID --issue ISSUE_NODE_ID
 *   github_projects.ts get-field-ids --project PID
 *   github_projects.ts get-items --project PID [--filter KEY=VALUE ...]
 *   github_projects.ts get-item-fields --item ITEM_ID
 *   github_projects.ts set-field --project PID --item ITEM_ID --name NAME --value V
 *   github_projects.ts set-fields --project PID --item ITEM_ID --fields JSON
 *   github_projects.ts find-item --org ORG --repo REPO --issue NUM --project PID
 *   github_projects.ts get-issue-node-id --org ORG --repo REPO --issue NUM
 *   github_projects.ts transition-status --project PID --item ITEM_ID --status S [--no-validate]
 *   github_projects.ts is-legal-transition --from FROM --to TO
 *   github_projects.ts check-spec-completeness --fields JSON
 *   github_projects.ts load-config [--repo-root DIR]
 */

import fs from "node:fs";

import {
  addIssueToProject,
  checkSpecCompleteness,
  findItemForIssue,
  findProject,
  getFieldIds,
  getItemFields,
  getIssueNodeId,
  getItems,
  isLegalTransition,
  loadProjectConfig,
  setField,
  setFields,
  transitionStatus,
  type FieldValue,
} from "./github_projects_lib.ts";

const HELP = `usage: github_projects.ts <command> [flags...]

Commands:
  find-project           --org ORG --name NAME
  add-issue              --project PID --issue ISSUE_NODE_ID
  get-field-ids          --project PID
  get-items              --project PID [--filter KEY=VALUE]...
  get-item-fields        --item ITEM_ID
  set-field              --project PID --item ITEM_ID --name NAME --value V
  set-fields             --project PID --item ITEM_ID --fields JSON
  find-item              --org ORG --repo REPO --issue NUM --project PID
  get-issue-node-id      --org ORG --repo REPO --issue NUM
  transition-status      --project PID --item ITEM_ID --status S [--no-validate]
  is-legal-transition    --from FROM --to TO
  check-spec-completeness --fields JSON
  load-config            [--repo-root DIR]

All commands print JSON to stdout. Errors go to stderr; exit code is 0
on success, 1 on operation failure, 2 on usage error.
`;

// ---------------------------------------------------------------------------
// Tiny arg parser — handles --flag, --key value, and multi --filter K=V
// ---------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  options: Map<string, string>;
  multi: Map<string, string[]>;
  flags: Set<string>;
}

const KNOWN_FLAGS = new Set(["no-validate", "help"]);
const MULTI_OPTS = new Set(["filter"]);

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    positional: [],
    options: new Map(),
    multi: new Map(),
    flags: new Set(),
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.flags.add("help");
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (KNOWN_FLAGS.has(name)) {
        out.flags.add(name);
        i++;
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for --${name}`);
      }
      if (MULTI_OPTS.has(name)) {
        const list = out.multi.get(name) ?? [];
        list.push(value);
        out.multi.set(name, list);
      } else {
        out.options.set(name, value);
      }
      i += 2;
      continue;
    }
    out.positional.push(a);
    i++;
  }
  return out;
}

function requireOpt(parsed: Parsed, key: string): string {
  const v = parsed.options.get(key);
  if (v === undefined) throw new Error(`Missing required flag: --${key}`);
  return v;
}

function jsonOut(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Coerce a `--value` flag string into the right primitive for the field. */
function coerceFieldValue(raw: string): FieldValue {
  if (raw === "") return raw;
  const num = Number(raw);
  if (!Number.isNaN(num) && /^-?\d+(?:\.\d+)?$/.test(raw)) return num;
  return raw;
}

function parseFilter(spec: string): [string, string | number] {
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error(`--filter must be KEY=VALUE (got '${spec}')`);
  }
  const key = spec.slice(0, eq);
  const value = coerceFieldValue(spec.slice(eq + 1));
  return [key, value];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function run(command: string, parsed: Parsed): Promise<void> {
  switch (command) {
    case "find-project": {
      const org = requireOpt(parsed, "org");
      const name = requireOpt(parsed, "name");
      jsonOut(await findProject(org, name));
      return;
    }
    case "add-issue": {
      const project = requireOpt(parsed, "project");
      const issue = requireOpt(parsed, "issue");
      const itemId = await addIssueToProject(project, issue);
      jsonOut({ item_id: itemId });
      return;
    }
    case "get-field-ids": {
      const project = requireOpt(parsed, "project");
      jsonOut(await getFieldIds(project));
      return;
    }
    case "get-items": {
      const project = requireOpt(parsed, "project");
      const filters: Record<string, string | number> = {};
      for (const spec of parsed.multi.get("filter") ?? []) {
        const [k, v] = parseFilter(spec);
        filters[k] = v;
      }
      jsonOut(await getItems(project, filters));
      return;
    }
    case "get-item-fields": {
      const item = requireOpt(parsed, "item");
      jsonOut(await getItemFields(item));
      return;
    }
    case "set-field": {
      const project = requireOpt(parsed, "project");
      const item = requireOpt(parsed, "item");
      const name = requireOpt(parsed, "name");
      const value = coerceFieldValue(requireOpt(parsed, "value"));
      await setField(project, item, name, value);
      jsonOut({ ok: true });
      return;
    }
    case "set-fields": {
      const project = requireOpt(parsed, "project");
      const item = requireOpt(parsed, "item");
      const fields = JSON.parse(requireOpt(parsed, "fields")) as Record<
        string,
        unknown
      >;
      await setFields(project, item, fields);
      jsonOut({ ok: true });
      return;
    }
    case "find-item": {
      const org = requireOpt(parsed, "org");
      const repo = requireOpt(parsed, "repo");
      const issue = Number(requireOpt(parsed, "issue"));
      const project = requireOpt(parsed, "project");
      if (!Number.isFinite(issue)) throw new Error("--issue must be a number");
      const itemId = await findItemForIssue(org, repo, issue, project);
      jsonOut({ item_id: itemId });
      return;
    }
    case "get-issue-node-id": {
      const org = requireOpt(parsed, "org");
      const repo = requireOpt(parsed, "repo");
      const issue = Number(requireOpt(parsed, "issue"));
      if (!Number.isFinite(issue)) throw new Error("--issue must be a number");
      jsonOut({ node_id: await getIssueNodeId(org, repo, issue) });
      return;
    }
    case "transition-status": {
      const project = requireOpt(parsed, "project");
      const item = requireOpt(parsed, "item");
      const status = requireOpt(parsed, "status");
      const transitioned = await transitionStatus(project, item, status, {
        validate: !parsed.flags.has("no-validate"),
      });
      jsonOut({ transitioned, status });
      return;
    }
    case "is-legal-transition": {
      const from = requireOpt(parsed, "from");
      const to = requireOpt(parsed, "to");
      jsonOut({ legal: isLegalTransition(from, to) });
      return;
    }
    case "check-spec-completeness": {
      const raw = requireOpt(parsed, "fields");
      const fields = JSON.parse(raw) as Record<string, FieldValue | undefined>;
      jsonOut(checkSpecCompleteness(fields));
      return;
    }
    case "load-config": {
      const root = parsed.options.get("repo-root") ?? ".";
      jsonOut(loadProjectConfig(root));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, ...rest] = argv;
  let parsed: Parsed;
  try {
    parsed = parseArgs(rest);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (parsed.flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    await run(command!, parsed);
    return 0;
  } catch (err) {
    process.stderr.write(`github_projects: ${(err as Error).message}\n`);
    return 1;
  }
}

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const realArgv = fs.realpathSync(argv1);
    const realModule = fs.realpathSync(new URL(import.meta.url).pathname);
    return realArgv === realModule;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`github_projects: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
