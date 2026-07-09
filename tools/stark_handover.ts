#!/usr/bin/env node
/**
 * stark_handover CLI — storage engine for `/stark-handover`.
 *
 * Persists handovers under {root}/{project}/{worktree}/{task}/ so a session
 * can `/clear` and resume from disk. JSON on stdout (snake_case keys); the
 * skill renders it. Content (handover body, PROGRESS.md) is Claude-authored
 * and passed in via files — this CLI owns only paths, numbering, and writes.
 *
 * Subcommands:
 *   resolve [--task T]                                  context + chain + tasks
 *   save [--task T] --handover-file F --progress-file P     write handover_{N}.md + PROGRESS.md
 *   resume [--task T]                                   latest handover + progress payload
 *   list [--all]                                        tasks here (or across all projects)
 *
 * Root precedence: STARK_HANDOVER_ROOT env > `handover.root` config
 * (default ~/Code/Handovers).
 */

import fs from "node:fs";
import path from "node:path";

import { getHandoverConfig } from "./stark_config_lib.ts";
import {
  chainFiles,
  deriveGitContext,
  listTasks,
  nextSeq,
  pickTask,
  resolveRoot,
  resumePayload,
  sanitizeSlug,
  saveHandover,
  taskDirFor,
  type GitContext,
  type TaskInfo,
} from "./stark_handover_lib.ts";

const USAGE = `Usage: stark_handover.ts <resolve|save|resume|list> [options]

Subcommands:
  resolve [--task T]        Print storage context: root, project, worktree,
                            picked task, next seq, chain, known tasks.
  save [--task T] --handover-file F --progress-file P
                            Append handover_{N}.md from F's content (frontmatter
                            added) and replace PROGRESS.md from P's content.
                            --task defaults to the most recent task; required
                            for a task's first save.
  resume [--task T]         Print the latest handover + PROGRESS.md contents
                            for the task (default: most recently touched).
                            Exits 2 when there is nothing to resume.
  list [--all]              List tasks for this project/worktree, newest first
                            (--all: every project/worktree under the root).

Env:
  STARK_HANDOVER_ROOT       Override the storage root (default: handover.root
                            config, ~/Code/Handovers).

Output is JSON on stdout.`;

interface Args {
  cmd: string | null;
  task?: string;
  handoverFile?: string;
  progressFile?: string;
  all: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: null, all: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--all") args.all = true;
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--handover-file") args.handoverFile = argv[++i];
    else if (a === "--progress-file") args.progressFile = argv[++i];
    else positional.push(a);
  }
  args.cmd = positional[0] ?? null;
  return args;
}

function fail(message: string, code = 2): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(code);
}

function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function taskInfoJson(t: TaskInfo) {
  return {
    task: t.task,
    dir: t.dir,
    latest_seq: t.latestSeq,
    mtime: new Date(t.mtimeMs).toISOString(),
    has_progress: t.hasProgress,
  };
}

function ctxJson(root: string, ctx: GitContext) {
  return {
    root,
    project: ctx.project,
    worktree: ctx.worktree,
    branch: ctx.branch,
    head: ctx.head,
    is_git: ctx.isGit,
  };
}

function cmdResolve(root: string, ctx: GitContext, task?: string): void {
  const picked = task !== undefined ? sanitizeSlug(task) : pickTask(root, ctx);
  const dir = picked === null ? null : taskDirFor(root, ctx, picked);
  emit({
    ...ctxJson(root, ctx),
    task: picked,
    dir,
    next_seq: dir === null ? 1 : nextSeq(dir),
    chain: dir === null ? [] : chainFiles(dir),
    tasks: listTasks(root, ctx).map(taskInfoJson),
  });
}

function cmdSave(root: string, ctx: GitContext, args: Args): void {
  if (!args.handoverFile) fail("save requires --handover-file");
  if (!args.progressFile) fail("save requires --progress-file");
  let body: string;
  try {
    body = fs.readFileSync(args.handoverFile, "utf8");
  } catch {
    fail(`cannot read --handover-file: ${args.handoverFile}`);
  }
  if (body.trim() === "") fail("--handover-file is empty — refusing to save a blank handover");

  let progress: string;
  try {
    progress = fs.readFileSync(args.progressFile, "utf8");
  } catch {
    fail(`cannot read --progress-file: ${args.progressFile}`);
  }

  const task = args.task ?? pickTask(root, ctx) ?? undefined;
  if (task === undefined) {
    fail("no existing task to continue — pass --task <slug> for the first save");
  }

  const res = saveHandover({ root, ctx, task, body, progress });
  emit({
    ...ctxJson(root, ctx),
    task: res.task,
    dir: res.dir,
    seq: res.seq,
    handover_path: res.handoverPath,
    progress_path: res.progressPath,
    warnings: res.warnings,
  });
}

function cmdResume(root: string, ctx: GitContext, task?: string): void {
  const payload = resumePayload({ root, ctx, task });
  if (payload === null) {
    fail(
      task !== undefined
        ? `no handovers found for task '${sanitizeSlug(task)}' under ${path.join(root, ctx.project, ctx.worktree)}`
        : `no handovers found under ${path.join(root, ctx.project, ctx.worktree)}`,
    );
  }
  emit({
    ...ctxJson(root, ctx),
    task: payload.task,
    dir: payload.dir,
    seq: payload.seq,
    handover_path: payload.handoverPath,
    handover_content: payload.handoverContent,
    progress_path: payload.progressPath,
    progress_content: payload.progressContent,
    chain: payload.chain,
    task_slugs: payload.taskSlugs,
  });
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function readdirDirsOrEmpty(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    return [];
  }
}

function cmdList(root: string, ctx: GitContext, all: boolean): void {
  if (!all) {
    emit({
      ...ctxJson(root, ctx),
      tasks: listTasks(root, ctx).map(taskInfoJson),
    });
    return;
  }
  // --all: walk {root}/{project}/{worktree} and reuse listTasks per pair.
  const entries: unknown[] = [];
  const projects = readdirDirsOrEmpty(root);
  for (const project of projects) {
    const worktrees = readdirDirsOrEmpty(path.join(root, project));
    for (const worktree of worktrees) {
      const fakeCtx: GitContext = { ...ctx, project, worktree };
      for (const t of listTasks(root, fakeCtx)) {
        entries.push({ project, worktree, ...taskInfoJson(t) });
      }
    }
  }
  emit({ root, entries });
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.cmd === null) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(args.help ? 0 : 2);
  }

  const root = resolveRoot({ configRoot: getHandoverConfig().root });
  const ctx = deriveGitContext();

  try {
    switch (args.cmd) {
      case "resolve":
        cmdResolve(root, ctx, args.task);
        break;
      case "save":
        cmdSave(root, ctx, args);
        break;
      case "resume":
        cmdResume(root, ctx, args.task);
        break;
      case "list":
        cmdList(root, ctx, args.all);
        break;
      default:
        process.stderr.write(`unknown subcommand: ${args.cmd}\n${USAGE}\n`);
        process.exit(2);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
