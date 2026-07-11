#!/usr/bin/env node
/**
 * github_app CLI — sole implementation (the parallel Python CLI
 * `scripts/github_app.py` was deleted on 2026-05-19). Surface preserved
 * so SKILL.md bash snippets that pipe / capture output keep working:
 *
 *   github_app.ts [--app APP] [--repo OWNER/NAME] token
 *   github_app.ts [--app APP] [--repo OWNER/NAME] repo
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr list
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr view NUMBER
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr create --head H --title T [--body B] [--base main] [--ready]
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr ready  NUMBER
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr review NUMBER --approve|--request-changes|--comment --body B
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr merge  NUMBER --squash|--merge|--rebase [--title T]
 *   github_app.ts [--app APP] [--repo OWNER/NAME] pr comment NUMBER --body B
 *   github_app.ts [--app APP] [--repo OWNER/NAME] issue list
 *   github_app.ts [--app APP] [--repo OWNER/NAME] issue create --title T [--body B] [--labels L1 L2 ...]
 */

import fs from "node:fs";

import {
  APPS,
  APP_NAMES,
  DEFAULT_APP,
  detectRepo,
  getToken,
  isAppName,
  issueCreate,
  issueList,
  prComment,
  prCreate,
  prList,
  prMerge,
  prReady,
  prReview,
  prView,
  repoInfo,
  type AppName,
  type PrMergeMethod,
  type PrReviewEvent,
} from "./github_app_lib.ts";

const HELP = `usage: github_app.ts [--app APP] [--repo OWNER/NAME] <command> ...

Commands:
  token                  Print installation token (for GH_TOKEN)
  repo                   Show repo summary
  pr list                List open PRs
  pr view NUMBER         View PR details (JSON)
  pr create --head H --title T [--body B] [--base main] [--ready]
                         Opens a DRAFT PR by default; pass --ready to open ready-for-review
  pr ready NUMBER        Mark a draft PR ready-for-review (un-draft)
  pr review NUMBER --approve|--request-changes|--comment [--body B]
  pr merge NUMBER --squash|--merge|--rebase [--title T]
  pr comment NUMBER --body B
  issue list             List open issues
  issue create --title T [--body B] [--labels L1 L2 ...]

Options:
  --app APP              ${Object.keys(APPS).join(" | ")} (default: ${DEFAULT_APP})
  --repo OWNER/NAME      Override repo (default: auto-detect from git remote)
  -h, --help             Show this help
`;

export interface Parsed {
  app: AppName;
  repo: string | null;
  flags: Map<string, true>;
  options: Map<string, string>;
  multi: Map<string, string[]>;
  positional: string[];
}

const KNOWN_VALUE_OPTS = new Set([
  "app",
  "repo",
  "body",
  "head",
  "title",
  "base",
]);
const MULTI_VALUE_OPTS = new Set(["labels"]);
const KNOWN_FLAGS = new Set([
  "draft", // retained for back-compat; draft is now the default (no-op)
  "ready", // open the PR ready-for-review (opt out of draft default)
  "no-draft", // alias for --ready
  "approve",
  "request-changes",
  "comment",
  "squash",
  "merge",
  "rebase",
]);

/**
 * `pr create` draft resolution. Draft-by-default: a PR is created as a draft
 * unless the operator opts out with --ready / --no-draft. (The legacy --draft
 * flag stays accepted as an explicit, now-redundant, opt-in.)
 */
export function draftFromFlags(flags: Map<string, true>): boolean {
  return !flags.has("ready") && !flags.has("no-draft");
}

/** `pr review` flag → GitHub review event. Defaults to `COMMENT`. */
export function reviewEventFromFlags(
  flags: Map<string, true>,
): PrReviewEvent {
  if (flags.has("approve")) return "APPROVE";
  if (flags.has("request-changes")) return "REQUEST_CHANGES";
  return "COMMENT";
}

/** `pr merge` flag → API merge method. Defaults to `squash`. */
export function mergeMethodFromFlags(
  flags: Map<string, true>,
): PrMergeMethod {
  if (flags.has("rebase")) return "rebase";
  if (flags.has("merge")) return "merge";
  return "squash";
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    app: DEFAULT_APP,
    repo: null,
    flags: new Map(),
    options: new Map(),
    multi: new Map(),
    positional: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.flags.set("help", true);
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (KNOWN_FLAGS.has(name)) {
        out.flags.set(name, true);
        i++;
        continue;
      }
      if (MULTI_VALUE_OPTS.has(name)) {
        const values: string[] = [];
        i++;
        while (i < argv.length && !argv[i]!.startsWith("--")) {
          values.push(argv[i]!);
          i++;
        }
        out.multi.set(name, values);
        continue;
      }
      if (KNOWN_VALUE_OPTS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`Missing value for --${name}`);
        }
        if (name === "app") {
          if (!isAppName(value)) {
            throw new Error(
              `Unknown app '${value}'. Available: ${APP_NAMES.join(", ")}`,
            );
          }
          out.app = value;
        } else if (name === "repo") out.repo = value;
        else out.options.set(name, value);
        i += 2;
        continue;
      }
      throw new Error(`Unknown option: --${name}`);
    }
    out.positional.push(a);
    i++;
  }
  return out;
}

function resolveRepo(parsed: Parsed): string {
  if (parsed.repo) return parsed.repo;
  const detected = detectRepo();
  if (!detected) {
    throw new Error(
      "Could not detect repo. Use --repo or run from inside a git repo.",
    );
  }
  return detected;
}

function jsonOut(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function runToken(parsed: Parsed): Promise<void> {
  // Honour the Python's per-owner installation routing: derive owner from
  // --repo or git remote so a token for the right installation is returned.
  const repoStr = parsed.repo ?? detectRepo();
  const owner =
    repoStr && repoStr.includes("/") ? repoStr.split("/")[0] : undefined;
  const token = await getToken({ app: parsed.app, owner });
  process.stdout.write(`${token}\n`);
}

async function runRepo(parsed: Parsed): Promise<void> {
  const repo = resolveRepo(parsed);
  const info = (await repoInfo(repo, parsed.app)) as {
    full_name: string;
    default_branch: string;
    private: boolean;
    open_issues_count: number;
  };
  process.stdout.write(
    `${info.full_name} | default: ${info.default_branch} | private: ${info.private}\n`,
  );
  process.stdout.write(`Open issues: ${info.open_issues_count}\n`);
}

async function runPr(parsed: Parsed): Promise<void> {
  const [, action, ...rest] = parsed.positional;
  const repo = resolveRepo(parsed);

  if (action === "list") {
    const prs = (await prList(repo, "open", parsed.app)) as Array<{
      number: number;
      title: string;
      user: { login: string };
      head: { ref: string };
    }>;
    for (const pr of prs) {
      process.stdout.write(
        `  #${pr.number}: ${pr.title} (${pr.user.login}) [${pr.head.ref}]\n`,
      );
    }
    return;
  }
  if (action === "view") {
    const number = Number(rest[0]);
    if (!Number.isFinite(number)) throw new Error("pr view: missing NUMBER");
    jsonOut(await prView(repo, number, parsed.app));
    return;
  }
  if (action === "create") {
    const head = parsed.options.get("head");
    const title = parsed.options.get("title");
    if (!head || !title) {
      throw new Error("pr create: --head and --title are required");
    }
    const draft = draftFromFlags(parsed.flags);
    const result = (await prCreate(repo, {
      head,
      title,
      body: parsed.options.get("body") ?? "",
      base: parsed.options.get("base") ?? "main",
      draft,
      app: parsed.app,
    })) as { number: number; html_url: string };
    process.stdout.write(
      `Created ${draft ? "draft " : ""}PR #${result.number}: ${result.html_url}\n`,
    );
    return;
  }
  if (action === "ready") {
    const number = Number(rest[0]);
    if (!Number.isFinite(number)) throw new Error("pr ready: missing NUMBER");
    await prReady(repo, number, parsed.app);
    process.stdout.write(`Marked PR #${number} ready-for-review\n`);
    return;
  }
  if (action === "review") {
    const number = Number(rest[0]);
    if (!Number.isFinite(number)) throw new Error("pr review: missing NUMBER");
    const event = reviewEventFromFlags(parsed.flags);
    const body = parsed.options.get("body") ?? "";
    await prReview(repo, number, event, body, parsed.app);
    process.stdout.write(`Review submitted: ${event}\n`);
    return;
  }
  if (action === "merge") {
    const number = Number(rest[0]);
    if (!Number.isFinite(number)) throw new Error("pr merge: missing NUMBER");
    const method = mergeMethodFromFlags(parsed.flags);
    await prMerge(
      repo,
      number,
      method,
      parsed.options.get("title") ?? "",
      parsed.app,
    );
    process.stdout.write(`Merged PR #${number} via ${method}\n`);
    return;
  }
  if (action === "comment") {
    const number = Number(rest[0]);
    if (!Number.isFinite(number))
      throw new Error("pr comment: missing NUMBER");
    const body = parsed.options.get("body");
    if (body === undefined) throw new Error("pr comment: --body required");
    await prComment(repo, number, body, parsed.app);
    process.stdout.write(`Commented on PR #${number}\n`);
    return;
  }
  throw new Error(`pr: unknown action '${action ?? ""}'`);
}

async function runIssue(parsed: Parsed): Promise<void> {
  const [, action] = parsed.positional;
  const repo = resolveRepo(parsed);

  if (action === "list") {
    const issues = (await issueList(repo, "open", parsed.app)) as Array<{
      number: number;
      title: string;
      labels?: Array<{ name: string }>;
    }>;
    for (const issue of issues) {
      const labels = (issue.labels ?? []).map((l) => l.name).join(", ");
      const extra = labels ? ` [${labels}]` : "";
      process.stdout.write(`  #${issue.number}: ${issue.title}${extra}\n`);
    }
    return;
  }
  if (action === "create") {
    const title = parsed.options.get("title");
    if (!title) throw new Error("issue create: --title required");
    const result = (await issueCreate(repo, {
      title,
      body: parsed.options.get("body") ?? "",
      labels: parsed.multi.get("labels") ?? [],
      app: parsed.app,
    })) as { number: number; html_url: string };
    process.stdout.write(
      `Created issue #${result.number}: ${result.html_url}\n`,
    );
    return;
  }
  throw new Error(`issue: unknown action '${action ?? ""}'`);
}

async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (parsed.flags.has("help") || parsed.positional.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = parsed.positional[0];
  try {
    if (command === "token") await runToken(parsed);
    else if (command === "repo") await runRepo(parsed);
    else if (command === "pr") await runPr(parsed);
    else if (command === "issue") await runIssue(parsed);
    else {
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
    }
  } catch (err) {
    process.stderr.write(`github_app: ${(err as Error).message}\n`);
    return 1;
  }
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
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`github_app: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
