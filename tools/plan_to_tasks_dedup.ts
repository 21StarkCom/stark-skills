#!/usr/bin/env node
/**
 * plan_to_tasks_dedup CLI — thin wrapper over `plan_to_tasks_dedup_lib.ts`
 * for `skill/stark-plan-to-tasks/SKILL.md` Phase 5. Pure decision, no
 * network: the skill fetches this plan's existing issues via
 * `gh issue list --label "plan:{plan_slug}" --state all --json number,title,body`
 * ONCE, writes that array plus the planned-tasks array to temp files, and
 * calls this CLI to get back which tasks to create vs. skip.
 *
 * Usage:
 *   plan_to_tasks_dedup.ts --plan-slug SLUG \
 *     --existing-issues-file PATH --planned-tasks-file PATH
 *
 * `--existing-issues-file` is a JSON array of
 *   {"number": 101, "title": "...", "body": "..."}
 * `--planned-tasks-file` is a JSON array of
 *   {"task_id": "...", "title": "...", "phase_id": "..."}
 *
 * Prints one JSON object to stdout:
 *   {"toCreate": [...], "toSkip": [...], "issueNumbers": [101, 102]}
 */

import fs from "node:fs";

import { computePlanToTasksDedup, type ExistingIssueRecord, type PlannedTaskInput } from "./plan_to_tasks_dedup_lib.ts";

const HELP = `plan_to_tasks_dedup.ts — plan-scoped issue-creation dedup decision

Usage:
  plan_to_tasks_dedup.ts --plan-slug SLUG --existing-issues-file PATH --planned-tasks-file PATH

Reads the plan's existing issues (already scoped by the plan:{slug} label)
and the planned task breakdown, and prints which tasks still need to be
created vs. which already exist for this plan (exact marker match, never a
title match). See plan_to_tasks_dedup_lib.ts for the decision logic.

Options:
  --plan-slug SLUG              plan slug (required)
  --existing-issues-file PATH   JSON array of {number, title, body} (required)
  --planned-tasks-file PATH     JSON array of {task_id, title, phase_id} (required)
  -h, --help                    print this help and exit
`;

function parseArgs(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "");
    }
  }
  return flags;
}

function readJsonArray<T>(path: string, label: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${label}: cannot read '${path}': ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: '${path}' is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${label}: '${path}' must contain a JSON array`);
  }
  return data as T[];
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const args = parseArgs(argv);
  const planSlug = args.get("plan-slug");
  const existingIssuesFile = args.get("existing-issues-file");
  const plannedTasksFile = args.get("planned-tasks-file");

  if (!planSlug || !existingIssuesFile || !plannedTasksFile) {
    process.stderr.write(
      "plan_to_tasks_dedup: --plan-slug, --existing-issues-file, and --planned-tasks-file are all required\n\n",
    );
    process.stderr.write(HELP);
    return 1;
  }

  const existingIssues = readJsonArray<ExistingIssueRecord>(existingIssuesFile, "existing-issues-file");
  const plannedTasks = readJsonArray<PlannedTaskInput>(plannedTasksFile, "planned-tasks-file");

  const result = computePlanToTasksDedup(planSlug, plannedTasks, existingIssues);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
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
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan_to_tasks_dedup: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
