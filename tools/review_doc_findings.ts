#!/usr/bin/env -S node --experimental-strip-types
/**
 * review_doc_findings — post every doc-review finding to a PR as its own
 * resolvable review thread, and resolve each thread once the finding is fixed.
 *
 * Backs the "every finding posted + fixed + resolved" contract of
 * /stark-review-spec and /stark-review-plan. The dispatcher
 * (stark_review_doc.ts) reviews + auto-fixes and emits a receipt; this tool:
 *
 *   post     — for every distinct finding in the receipt, open a file-level
 *              (resolvable) review thread on the doc; findings the wing already
 *              fixed are replied-to + resolved immediately. Writes a map file
 *              (finding id → thread/comment) and prints the still-open findings.
 *              Idempotent: re-runs skip findings already posted (HTML marker).
 *   resolve  — reply to a finding's thread with the fix summary and mark the
 *              thread resolved. Used by the skill after it fixes a finding.
 *   list     — print the open (not-yet-resolved) findings from a map file.
 *
 * File-level review threads (`subject_type: "file"`) are resolvable and don't
 * require a valid diff line, so they survive even when a finding's section
 * isn't inside a changed hunk. On the rare case the file isn't in the PR diff,
 * we fall back to a (non-resolvable) issue comment so nothing is dropped.
 *
 * stdout: a single JSON object. stderr: human progress.
 * Exit: 0 ok, 1 partial/terminal failure, 2 bad args.
 */
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  apiGet,
  apiPost,
  graphql,
  prComment,
  prView,
  resolveAppName,
  type AppName,
} from "./github_app_lib.ts";
import {
  type CollectedFinding,
  collectFindings,
  findingMarker,
  openFindings,
  parseFindingMarker,
  type Receipt,
  renderAutofixReply,
  renderFindingComment,
  renderManualFixReply,
  anchorLine,
} from "./review_doc_findings_lib.ts";

// ─── Reviewer-agent → GitHub App ───────────────────────────────────────────

// Each finding thread is authored by the App of the LLM that produced the
// finding (the lead reviewer), so PR comment authorship attributes findings to
// the reviewing model for analytics. codex→stark-codex, claude→stark-claude,
// gemini→stark-gemini. Unknown agents fall back to the run-level --app.
const AGENT_APP: Record<string, AppName> = {
  codex: "stark-codex",
  claude: "stark-claude",
  gemini: "stark-gemini",
};

function agentApp(agent: string, fallback: AppName): AppName {
  return AGENT_APP[agent] ?? fallback;
}

// ─── Map file schema ─────────────────────────────────────────────────────

interface MapEntry {
  comment_id: number | null; // review-comment databaseId (null when issue-comment fallback)
  node_id: string | null;
  path: string;
  resolvable: boolean; // review thread (true) vs issue comment fallback (false)
  resolved: boolean;
  /** Reviewing LLM that raised the finding (from the receipt). */
  agent: string;
  /** GitHub App that authored this thread — the reviewer's App. `resolve`
   *  replies + resolves under the same App so the thread stays single-author. */
  app: AppName;
  status: CollectedFinding["status"];
  severity: string;
  domain: string;
  title: string;
  section: string;
  description: string;
  suggestion: string;
}

interface MapFile {
  repo: string;
  pr: number;
  app: AppName;
  doc: string;
  findings: Record<string, MapEntry>;
}

function readMap(pathStr: string): MapFile {
  const raw = fs.readFileSync(pathStr, "utf-8");
  return JSON.parse(raw) as MapFile;
}

function writeMap(pathStr: string, map: MapFile): void {
  fs.writeFileSync(pathStr, JSON.stringify(map, null, 2) + "\n");
}

function log(msg: string): void {
  process.stderr.write(`review_doc_findings: ${msg}\n`);
}

// ─── GitHub round-trips ────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Head commit sha of the PR (review comments must anchor to a commit). */
async function prHeadSha(repo: string, pr: number, app: AppName): Promise<string> {
  const view = await prView(repo, pr, app);
  const head = isObj(view) ? view["head"] : undefined;
  const sha = isObj(head) ? head["sha"] : undefined;
  if (typeof sha !== "string" || !sha) throw new Error(`could not resolve head sha for PR #${pr}`);
  return sha;
}

/** All existing review comments on the PR (paginated), for idempotent re-runs. */
async function existingReviewComments(
  repo: string,
  pr: number,
  app: AppName,
): Promise<Array<{ id: number; node_id: string; body: string; path: string }>> {
  const out: Array<{ id: number; node_id: string; body: string; path: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const batch = (await apiGet(
      `/repos/${repo}/pulls/${pr}/comments`,
      { per_page: 100, page },
      app,
    )) as Array<Record<string, unknown>>;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      out.push({
        id: Number(c["id"]),
        node_id: String(c["node_id"] ?? ""),
        body: String(c["body"] ?? ""),
        path: String(c["path"] ?? ""),
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Create a file-level (resolvable) review thread; fall back to issue comment. */
async function postFindingThread(opts: {
  repo: string;
  pr: number;
  app: AppName;
  commitSha: string;
  path: string;
  body: string;
}): Promise<{ comment_id: number | null; node_id: string | null; resolvable: boolean }> {
  try {
    const c = (await apiPost(
      `/repos/${opts.repo}/pulls/${opts.pr}/comments`,
      { commit_id: opts.commitSha, path: opts.path, subject_type: "file", body: opts.body },
      opts.app,
    )) as Record<string, unknown>;
    return {
      comment_id: Number(c["id"]),
      node_id: String(c["node_id"] ?? ""),
      resolvable: true,
    };
  } catch (err) {
    log(`file-level comment failed (${(err as Error).message}); falling back to issue comment`);
    await prComment(opts.repo, opts.pr, opts.body, opts.app);
    return { comment_id: null, node_id: null, resolvable: false };
  }
}

/** Reply to a review comment (creates a threaded reply). */
async function replyToComment(opts: {
  repo: string;
  pr: number;
  app: AppName;
  commentId: number;
  body: string;
}): Promise<void> {
  await apiPost(
    `/repos/${opts.repo}/pulls/${opts.pr}/comments/${opts.commentId}/replies`,
    { body: opts.body },
    opts.app,
  );
}

/** Find the review-thread node id whose first comment is `commentDatabaseId`. */
async function threadIdForComment(opts: {
  repo: string;
  pr: number;
  app: AppName;
  commentDatabaseId: number;
}): Promise<string | null> {
  const [owner, name] = opts.repo.split("/");
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query = `
      query($owner:String!,$name:String!,$number:Int!,$cursor:String){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            reviewThreads(first:100,after:$cursor){
              pageInfo{ hasNextPage endCursor }
              nodes{ id isResolved comments(first:20){ nodes{ databaseId } } }
            }
          }
        }
      }`;
    const data = (await graphql(query, {
      app: opts.app,
      variables: { owner, name, number: opts.pr, cursor },
    })) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
              nodes?: Array<{ id: string; comments?: { nodes?: Array<{ databaseId?: number }> } }>;
            };
          };
        };
      };
    };
    const threads = data.data?.repository?.pullRequest?.reviewThreads;
    for (const t of threads?.nodes ?? []) {
      if ((t.comments?.nodes ?? []).some((c) => c.databaseId === opts.commentDatabaseId)) {
        return t.id;
      }
    }
    if (!threads?.pageInfo?.hasNextPage) break;
    cursor = threads.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }
  return null;
}

/**
 * Resolve a review thread by its node id.
 *
 * GitHub App installation tokens get "Resource not accessible by integration"
 * on `resolveReviewThread` even with `pull_requests: write` — the mutation
 * isn't available to Apps. So resolve through the operator's `gh` user (which
 * owns the repo and can resolve), and fall back to the App token only if `gh`
 * is unavailable (e.g. a headless context) — that fallback will no-op-fail
 * cleanly rather than throw.
 */
async function resolveThread(threadId: string, app: AppName): Promise<boolean> {
  const mutation =
    "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}";

  // 1) operator's gh user (the reliable path).
  try {
    const res = spawnSync(
      "gh",
      ["api", "graphql", "-f", `query=${mutation}`, "-f", `threadId=${threadId}`],
      { encoding: "utf-8" },
    );
    if (res.status === 0 && res.stdout) {
      const data = JSON.parse(res.stdout) as {
        data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } };
      };
      if (data.data?.resolveReviewThread?.thread?.isResolved === true) return true;
    } else if (res.status !== 0) {
      log(`gh resolve failed (${res.status}): ${(res.stderr ?? "").trim()}`);
    }
  } catch (err) {
    log(`gh unavailable for resolve: ${(err as Error).message}`);
  }

  // 2) App-token fallback (usually blocked, but try so headless callers still
  //    have a chance if the App ever gains the capability).
  try {
    const data = (await graphql(mutation, { app, variables: { threadId } })) as {
      data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } };
    };
    return data.data?.resolveReviewThread?.thread?.isResolved === true;
  } catch (err) {
    log(`app-token resolve failed: ${(err as Error).message}`);
    return false;
  }
}

/** Reply-and-resolve a finding's thread. Returns whether it ended resolved. */
async function replyAndResolve(opts: {
  repo: string;
  pr: number;
  app: AppName;
  commentId: number;
  reply: string;
}): Promise<boolean> {
  await replyToComment({
    repo: opts.repo,
    pr: opts.pr,
    app: opts.app,
    commentId: opts.commentId,
    body: opts.reply,
  });
  const threadId = await threadIdForComment({
    repo: opts.repo,
    pr: opts.pr,
    app: opts.app,
    commentDatabaseId: opts.commentId,
  });
  if (!threadId) {
    log(`could not locate thread for comment ${opts.commentId}; reply posted but not resolved`);
    return false;
  }
  return resolveThread(threadId, opts.app);
}

// ─── Subcommand: post ──────────────────────────────────────────────────────

async function cmdPost(args: PostArgs): Promise<number> {
  const receipt = JSON.parse(
    args.receipt === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(args.receipt, "utf-8"),
  ) as Receipt;
  const findings = collectFindings(receipt);
  if (findings.length === 0) {
    log("no findings in receipt — nothing to post");
    process.stdout.write(JSON.stringify({ posted: 0, autoresolved: 0, skipped_existing: 0, open: [] }, null, 2) + "\n");
    return 0;
  }

  const docText = fs.existsSync(args.doc) ? fs.readFileSync(args.doc, "utf-8") : "";
  const commitSha = await prHeadSha(args.repo, args.pr, args.app);
  const existing = await existingReviewComments(args.repo, args.pr, args.app);
  const existingByFinding = new Map<string, { id: number; node_id: string }>();
  for (const c of existing) {
    const id = parseFindingMarker(c.body);
    if (id) existingByFinding.set(id, { id: c.id, node_id: c.node_id });
  }

  const map: MapFile = { repo: args.repo, pr: args.pr, app: args.app, doc: args.doc, findings: {} };
  let posted = 0;
  let skippedExisting = 0;
  let autoresolved = 0;

  for (const f of findings) {
    // Author this finding's thread as the reviewing LLM's App (analytics).
    const findingApp = agentApp(f.agent, args.app);
    const entryBase = {
      path: args.doc,
      agent: f.agent,
      app: findingApp,
      status: f.status,
      severity: f.severity,
      domain: f.domain,
      title: f.title,
      section: f.section,
      description: f.description,
      suggestion: f.suggestion,
    };

    const already = existingByFinding.get(f.id);
    if (already) {
      skippedExisting++;
      map.findings[f.id] = {
        ...entryBase,
        comment_id: already.id,
        node_id: already.node_id,
        resolvable: true,
        resolved: false,
      };
      continue;
    }

    const line = anchorLine(docText, f.section);
    const body = renderFindingComment(f, { line });
    const res = await postFindingThread({
      repo: args.repo,
      pr: args.pr,
      app: findingApp,
      commitSha,
      path: args.doc,
      body,
    });
    posted++;
    const entry: MapEntry = {
      ...entryBase,
      comment_id: res.comment_id,
      node_id: res.node_id,
      resolvable: res.resolvable,
      resolved: false,
    };

    // Findings the wing already fixed: reply + resolve immediately (same App
    // as the thread author, so each thread stays single-author).
    if (f.status === "autofixed" && res.resolvable && res.comment_id !== null) {
      try {
        const ok = await replyAndResolve({
          repo: args.repo,
          pr: args.pr,
          app: findingApp,
          commentId: res.comment_id,
          reply: renderAutofixReply(args.commitSha),
        });
        entry.resolved = ok;
        if (ok) autoresolved++;
      } catch (err) {
        log(`auto-resolve failed for ${f.id}: ${(err as Error).message}`);
      }
    }
    map.findings[f.id] = entry;
    log(`posted ${f.id} [${f.status}]${entry.resolved ? " (auto-resolved)" : ""}`);
  }

  writeMap(args.map, map);

  const open = openFindings(findings)
    .filter((f) => !(map.findings[f.id]?.resolved))
    .map((f) => ({
      id: f.id,
      status: f.status,
      severity: f.severity,
      domain: f.domain,
      title: f.title,
      section: f.section,
      description: f.description,
      suggestion: f.suggestion,
      comment_id: map.findings[f.id]?.comment_id ?? null,
      resolvable: map.findings[f.id]?.resolvable ?? false,
    }));

  process.stdout.write(
    JSON.stringify(
      { posted, skipped_existing: skippedExisting, autoresolved, total: findings.length, open_count: open.length, map: args.map, open },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

// ─── Subcommand: resolve ───────────────────────────────────────────────────

async function cmdResolve(args: ResolveArgs): Promise<number> {
  const map = readMap(args.map);
  const entry = map.findings[args.findingId];
  if (!entry) {
    log(`finding ${args.findingId} not in map ${args.map}`);
    process.stdout.write(JSON.stringify({ ok: false, error: "finding_not_in_map", finding_id: args.findingId }) + "\n");
    return 1;
  }
  const reply = renderManualFixReply({ summary: args.reply, commitSha: args.commitSha });
  // Reply + resolve under the App that authored the thread (the reviewer's),
  // so each finding thread stays single-author. Older maps without a per-entry
  // app fall back to the run-level map.app.
  const entryApp: AppName = entry.app ?? map.app;

  if (!entry.resolvable || entry.comment_id === null) {
    // Issue-comment fallback: no resolvable thread — post a follow-up note.
    await prComment(map.repo, map.pr, `${reply}\n\n${findingMarker(args.findingId)}`, entryApp);
    entry.resolved = true;
    writeMap(args.map, map);
    process.stdout.write(JSON.stringify({ ok: true, resolved: false, note_posted: true, finding_id: args.findingId }) + "\n");
    return 0;
  }

  const ok = await replyAndResolve({
    repo: map.repo,
    pr: map.pr,
    app: entryApp,
    commentId: entry.comment_id,
    reply,
  });
  entry.resolved = ok;
  writeMap(args.map, map);
  process.stdout.write(JSON.stringify({ ok: true, resolved: ok, finding_id: args.findingId }) + "\n");
  return ok ? 0 : 1;
}

// ─── Subcommand: list ──────────────────────────────────────────────────────

function cmdList(args: ListArgs): number {
  const map = readMap(args.map);
  const rows = Object.entries(map.findings)
    .filter(([, e]) => (args.status === "all" ? true : !e.resolved))
    .map(([id, e]) => ({
      id,
      status: e.status,
      severity: e.severity,
      domain: e.domain,
      title: e.title,
      section: e.section,
      description: e.description,
      suggestion: e.suggestion,
      resolved: e.resolved,
      resolvable: e.resolvable,
      comment_id: e.comment_id,
    }));
  process.stdout.write(JSON.stringify({ count: rows.length, findings: rows }, null, 2) + "\n");
  return 0;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

interface PostArgs {
  receipt: string;
  doc: string;
  repo: string;
  pr: number;
  app: AppName;
  map: string;
  commitSha: string | null;
}
interface ResolveArgs {
  map: string;
  findingId: string;
  reply: string;
  commitSha: string | null;
}
interface ListArgs {
  map: string;
  status: "open" | "all";
}

function usage(): string {
  return [
    "Usage: review_doc_findings.ts <post|resolve|list> [options]",
    "",
    "post    — post every receipt finding as a resolvable review thread; auto-resolve wing-fixed ones",
    "  --receipt PATH|-   dispatcher receipt JSON (- for stdin)   [required]",
    "  --doc PATH         repo-relative doc path                  [required]",
    "  --repo OWNER/NAME  target repo                             [required]",
    "  --pr N             PR number                               [required]",
    "  --map PATH         map file to write                       [required]",
    "  --app NAME         fallback GitHub App for reads + unmapped agents (default: stark-claude);",
    "                     each finding thread is authored by the reviewing LLM's App",
    "                     (codex→stark-codex, claude→stark-claude, gemini→stark-gemini)",
    "  --commit-sha SHA   commit to cite in auto-resolve replies",
    "",
    "resolve — reply with the fix summary and resolve a finding's thread",
    "  --map PATH         map file from `post`                    [required]",
    "  --finding-id ID    finding id                              [required]",
    "  --reply TEXT       what was fixed                          [required]",
    "  --commit-sha SHA   commit that carried the fix",
    "",
    "list    — print open (or all) findings from a map file",
    "  --map PATH         map file from `post`                    [required]",
    "  --status open|all  default: open",
  ].join("\n");
}

function need(argv: readonly string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub === "-h" || sub === "--help" || sub === undefined) {
    process.stdout.write(usage() + "\n");
    return sub === undefined ? 2 : 0;
  }

  try {
    if (sub === "post") {
      const a: PostArgs = { receipt: "", doc: "", repo: "", pr: 0, app: "stark-claude", map: "", commitSha: null };
      for (let i = 1; i < argv.length; i++) {
        const f = argv[i]!;
        switch (f) {
          case "--receipt": a.receipt = need(argv, i, f); i++; break;
          case "--doc": a.doc = need(argv, i, f); i++; break;
          case "--repo": a.repo = need(argv, i, f); i++; break;
          case "--pr": a.pr = Number.parseInt(need(argv, i, f), 10); i++; break;
          case "--map": a.map = need(argv, i, f); i++; break;
          case "--app": a.app = resolveAppName(need(argv, i, f)); i++; break;
          case "--commit-sha": a.commitSha = need(argv, i, f); i++; break;
          default: throw new Error(`unknown arg: ${f}`);
        }
      }
      if (!a.receipt || !a.doc || !a.repo || !a.pr || !a.map) {
        throw new Error("post requires --receipt --doc --repo --pr --map");
      }
      return await cmdPost(a);
    }

    if (sub === "resolve") {
      const a: ResolveArgs = { map: "", findingId: "", reply: "", commitSha: null };
      for (let i = 1; i < argv.length; i++) {
        const f = argv[i]!;
        switch (f) {
          case "--map": a.map = need(argv, i, f); i++; break;
          case "--finding-id": a.findingId = need(argv, i, f); i++; break;
          case "--reply": a.reply = need(argv, i, f); i++; break;
          case "--commit-sha": a.commitSha = need(argv, i, f); i++; break;
          default: throw new Error(`unknown arg: ${f}`);
        }
      }
      if (!a.map || !a.findingId || !a.reply) {
        throw new Error("resolve requires --map --finding-id --reply");
      }
      return await cmdResolve(a);
    }

    if (sub === "list") {
      const a: ListArgs = { map: "", status: "open" };
      for (let i = 1; i < argv.length; i++) {
        const f = argv[i]!;
        switch (f) {
          case "--map": a.map = need(argv, i, f); i++; break;
          case "--status": {
            const v = need(argv, i, f); i++;
            if (v !== "open" && v !== "all") throw new Error("--status must be open|all");
            a.status = v;
            break;
          }
          default: throw new Error(`unknown arg: ${f}`);
        }
      }
      if (!a.map) throw new Error("list requires --map");
      return cmdList(a);
    }

    throw new Error(`unknown subcommand: ${sub}`);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${usage()}\n`);
    return 2;
  }
}

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
