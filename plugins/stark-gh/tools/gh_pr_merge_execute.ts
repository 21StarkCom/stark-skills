#!/usr/bin/env node
// Stage 3 / Execute for /stark-gh:pr-merge.
//
// Sequence (--no-watch path; default-watch path delegated to Phase 7):
//   1. Read plan, re-fetch base/head, verify OIDs unchanged
//   2. Pre-commit secret scan + redaction (BEFORE CHANGELOG.md write)
//   3. Apply changelog edit via lib/changelog.ts
//   4. Origin URL match (exit 31 on mismatch)
//   5. Capture pushedHeadOid pre-push, atomic-update plan-file
//   6. Force-push with explicit-OID lease (rollback on rejection)
//   7. --no-watch: verify_oids + GraphQL bake gate + mergeSquashPr
//   8. default-watch: spawn watcher (Phase 7)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { spawn } from "node:child_process";
import { MergeExit } from "./lib/exit.ts";
import { die } from "./lib/output.ts";
import { readPrMergePlan, writePrMergePlan, type PrMergePlan } from "./lib/plan.ts";
import * as gitLib from "./lib/git.ts";
import * as ghLib from "./lib/gh.ts";
import { scanSecrets } from "./lib/secret.ts";
import { redactSecrets } from "./lib/redact.ts";
import { updateUnreleasedChangelog } from "./lib/changelog.ts";
import { fetchRequiredCheckRollup, summarizeVerdict } from "./lib/checks_graphql.ts";
import { verifyMergeOids } from "./lib/verify_oids.ts";
import { appendPrMergeOverride } from "./lib/audit.ts";
import { ensureRuntimeDirs } from "./lib/runtime.ts";

export interface ExecuteResult {
  prUrl: string;
  pushedHeadOid: string;
  mergeSha?: string;                  // set on --no-watch success
  watcherStateFile?: string;          // set on default-watch
  watcherPid?: number;
  pushed: boolean;
}

// =============================================================================
// Helpers (pure-ish; ExecFn injectable for tests)
// =============================================================================

// Compute and apply pre-commit redaction. Returns whether any redaction happened.
export function redactProseInPlace(args: {
  subjectFile: string;
  bodyFile: string;
  bulletFile: string;
}): { redacted: boolean; categories: string[] } {
  const subject = fs.readFileSync(args.subjectFile, "utf8");
  const body = fs.readFileSync(args.bodyFile, "utf8");
  const bullet = fs.readFileSync(args.bulletFile, "utf8");
  const all = [subject, body, bullet].join("\n");
  const hits = scanSecrets(all);
  if (hits.length === 0) return { redacted: false, categories: [] };

  // Redact each file independently. redactSecrets returns RedactionResult; pull .text.
  const newSubject = redactSecrets(subject).text;
  const newBody = redactSecrets(body).text;
  const newBullet = redactSecrets(bullet).text;
  fs.writeFileSync(args.subjectFile, newSubject, { mode: 0o600 });
  fs.writeFileSync(args.bodyFile, newBody, { mode: 0o600 });
  fs.writeFileSync(args.bulletFile, newBullet, { mode: 0o600 });
  return { redacted: true, categories: Array.from(new Set(hits.map(h => h.category))) };
}

// Strip leading "- " from bullet text for use as commit subject (per plan note).
export function bulletToSubject(bullet: string): string {
  return bullet.replace(/^- /, "").trim();
}

// Normalize SSH/HTTPS origin URL to "owner/repo" for comparison with
// nameWithOwner. Rejects (returns null) any host other than github.com so a
// remote like `https://attacker.example/Evinced/stark-skills.git` cannot pass
// the owner/repo check and receive a force-push before the GitHub-side SHA
// fence in `gh pr merge --match-head-commit` rejects the merge.
export function normalizeOriginUrl(originUrl: string): string | null {
  const cleaned = originUrl.replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    if (httpsMatch[1].toLowerCase() !== "github.com") return null;
    return httpsMatch[2];
  }
  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    if (sshMatch[1].toLowerCase() !== "github.com") return null;
    return sshMatch[2];
  }
  return null;
}

// =============================================================================
// CLI
// =============================================================================

async function main(argv: string[]): Promise<number> {
  let planFile: string | null = null;
  let resumeFromSpawn = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--plan-file") {
      if (i + 1 >= argv.length) die(MergeExit.BAD_ARGS, "--plan-file requires a value");
      planFile = argv[++i]!;
    } else if (t === "--resume-from-spawn") {
      resumeFromSpawn = true;
    }
  }
  if (planFile === null) die(MergeExit.BAD_ARGS, "--plan-file is required");

  let plan = readPrMergePlan(planFile);

  // Resume mode: skip everything up to spawn.
  if (resumeFromSpawn) {
    if (!plan.pushedHeadOid) {
      die(MergeExit.BAD_ARGS, "--resume-from-spawn but plan.pushedHeadOid is null");
    }
    return spawnWatcher(plan, planFile);
  }

  // Step 1: re-verify OIDs (sanity, before any mutation)
  gitLib.fetchRefs("origin", [plan.pr.baseRef, plan.pr.headRef]);
  const baseOidNow = gitLib.revParse(`refs/remotes/origin/${plan.pr.baseRef}`);
  const headOidNow = gitLib.revParse(`refs/remotes/origin/${plan.pr.headRef}`);
  if (baseOidNow !== plan.baseOid || headOidNow !== plan.originalHeadOid) {
    die(MergeExit.OID_DRIFT,
      `OID drift: base ${plan.baseOid}→${baseOidNow}, head ${plan.originalHeadOid}→${headOidNow}; rerun preflight`);
  }
  const localHead = gitLib.headOid();
  if (localHead !== plan.rebasedHeadOid) {
    die(MergeExit.OID_DRIFT,
      `local HEAD ${localHead} != plan.rebasedHeadOid ${plan.rebasedHeadOid}; rerun preflight`);
  }

  // Step 2: pre-commit secret scan (BEFORE CHANGELOG.md write)
  if (!plan.stage2.subjectFile || !plan.stage2.bodyFile || !plan.stage2.changelogBulletFile) {
    die(MergeExit.BAD_ARGS, "plan stage2 missing prose tempfile paths; rerun draft stage");
  }
  const initial = redactProseInPlace({
    subjectFile: plan.stage2.subjectFile,
    bodyFile: plan.stage2.bodyFile,
    bulletFile: plan.stage2.changelogBulletFile,
  });
  if (initial.redacted) {
    if (!plan.execute.secretOverrides.commit) {
      die(MergeExit.SECRET_COMMIT,
        `secrets detected pre-commit (${initial.categories.join(", ")}); pass --allow-secret-commit to override`);
    }
    // Audit + stderr diff hint per PR4-claude H30.
    appendPrMergeOverride({
      timestamp: new Date().toISOString(),
      runId: plan.runId,
      pr: plan.pr.number,
      flag: "--allow-secret-commit",
      user: process.env.USER || "unknown",
      hostname: os.hostname(),
      reason: `redacted spans in ${initial.categories.join(", ")}`,
    });
    process.stderr.write(`pre-commit secret scan: redacted ${initial.categories.join(", ")} in subject/body/bullet\n`);
  }

  // Step 3: apply changelog edit
  const bulletText = fs.readFileSync(plan.stage2.changelogBulletFile, "utf8").replace(/\n+$/, "");
  const changelogContent = fs.readFileSync(plan.changelog.filePath, "utf8");
  const updated = updateUnreleasedChangelog({
    content: changelogContent,
    pr: plan.pr.number,
    runId: plan.runId,
    section: plan.changelog.section,
    bullet: bulletText,
  });

  let changelogCommitOid: string | null = null;
  if (updated.changed) {
    fs.writeFileSync(plan.changelog.filePath, updated.content);
    gitLib.add([plan.changelog.filePath]);
    if (gitLib.diffCachedEmpty()) {
      // Race condition: file content rolled back between read and stage.
      // Skip commit; nothing to commit.
    } else {
      gitLib.commitWithSubject(`chore(changelog): ${bulletToSubject(bulletText)}`);
      changelogCommitOid = gitLib.headOid();
    }
  } else {
    // Byte-identical no-op rerun. Try to reuse previous changelogCommitOid;
    // else use rebasedHeadOid as the rollback anchor.
    changelogCommitOid = plan.changelogCommitOid ?? plan.rebasedHeadOid;
  }

  // Step 4: origin URL match
  const origin = gitLib.originUrl();
  const normalized = origin ? normalizeOriginUrl(origin) : null;
  if (normalized !== plan.pr.nameWithOwner) {
    // Roll back the changelog commit (if any) and exit.
    if (changelogCommitOid && changelogCommitOid !== plan.rebasedHeadOid) {
      gitLib.resetHard(plan.rebasedHeadOid);
      fs.writeFileSync(plan.changelog.filePath, fs.readFileSync(plan.originalChangelogPath));
    }
    die(MergeExit.PUSH_REJECTED, `origin URL ${origin} does not match PR repo ${plan.pr.nameWithOwner}`);
  }

  // Step 5: plan-file pre-push reconciliation (PR4-claude H23)
  // Capture pushedHeadOid BEFORE the push; local SHA equals the about-to-push SHA.
  const aboutToPushSha = gitLib.headOid();
  plan = { ...plan, changelogCommitOid, pushedHeadOid: aboutToPushSha };
  writePrMergePlan(planFile, plan);

  // Step 6: force-push with explicit-OID lease + rollback on rejection
  try {
    gitLib.forcePushWithLease({
      remote: "origin",
      headRef: plan.pr.headRef,
      expectedRemoteOid: plan.originalHeadOid,
    });
  } catch (err) {
    // Roll back: reset to rebasedHeadOid + restore CHANGELOG.md from durable tempfile.
    try { gitLib.resetHard(plan.rebasedHeadOid); } catch { /* best-effort */ }
    try {
      fs.writeFileSync(plan.changelog.filePath, fs.readFileSync(plan.originalChangelogPath));
    } catch { /* best-effort */ }
    // Clear pushedHeadOid in the retained plan so resume can't pick it up.
    plan = { ...plan, pushedHeadOid: null };
    writePrMergePlan(planFile, plan);
    die(MergeExit.PUSH_REJECTED, `force-push rejected: ${(err as Error).message}; local rolled back`);
  }

  // Force-push succeeded. Emit a sentinel marker immediately so the slash
  // wrapper can disarm the restore trap even if a later step (HEAD-drift
  // sanity check, --no-watch verify/merge, watcher spawn) dies — the remote
  // has already moved and `restore_branch` would only roll back local state,
  // re-creating divergence the user has to clean up by hand.
  process.stdout.write(JSON.stringify({
    event: "pushed",
    pushedHeadOid: aboutToPushSha,
  }) + "\n");

  // Sanity: HEAD should still match what we recorded as pushedHeadOid.
  const headAfterPush = gitLib.headOid();
  if (headAfterPush !== aboutToPushSha) {
    die(MergeExit.OID_DRIFT,
      `HEAD ${headAfterPush} drifted from pre-push ${aboutToPushSha} during push (concurrent local mutation)`);
  }

  // Draft-by-default policy: un-draft the PR NOW — after the final head is
  // pushed — so the target-repo CI (guarded on `draft == false`, fired by the
  // `ready_for_review` event) runs on the pushed head. The watcher below then
  // waits for it to go green before merging. Idempotent if already ready.
  if (plan.pr.wasDraft) {
    ghLib.markPrReady(plan.pr.number, { repoSlug: plan.pr.nameWithOwner });
    process.stdout.write(JSON.stringify({
      event: "marked-ready",
      prNumber: plan.pr.number,
    }) + "\n");
  }

  // Step 7+: branch on watch mode
  if (!plan.execute.watch) {
    return await runNoWatch(plan, planFile);
  }
  return spawnWatcher(plan, planFile);
}

async function runNoWatch(plan: PrMergePlan, planFile: string): Promise<number> {
  // Re-verify OIDs immediately before merge.
  const v = await verifyMergeOids(plan);
  if (!v.ok) {
    die(MergeExit.OID_DRIFT, `OID drift before --no-watch merge: ${v.kind} expected=${v.expected} actual=${v.actual}`);
  }

  // GraphQL rollup + bake/soak gate + isCheckPassing predicate.
  const rollup = await fetchRequiredCheckRollup({
    owner: plan.pr.headRepositoryOwner,
    repo: plan.pr.headRepositoryName,
    prNumber: plan.pr.number,
    expectedHeadOid: plan.pushedHeadOid!,
  });
  if (rollup.mismatch) {
    die(MergeExit.OID_DRIFT, `head_moved during --no-watch: actual=${rollup.headRefOid}`);
  }
  const verdict = summarizeVerdict(rollup.contexts!);
  if (verdict.vacuous && !plan.execute.allowNoRequiredChecks) {
    if (plan.pr.wasDraft) {
      die(MergeExit.CHECK_FAIL,
        `PR was just un-drafted; its CI (fired by the ready_for_review event) has not registered yet, so --no-watch sees a vacuous rollup. Re-run with default-watch (drop --no-watch) so the merge waits for the now-triggered checks, or pass --allow-no-required-checks if the target repo genuinely has none.`);
    }
    die(MergeExit.CHECK_FAIL,
      `no required checks observed on pushedHeadOid; --no-watch refuses vacuous pass. Pass --allow-no-required-checks (audited) or use default-watch.`);
  }
  if (!verdict.allPassing) {
    die(MergeExit.CHECK_FAIL,
      `--no-watch: required checks not all passing (passing=${verdict.passing}, pending=${verdict.pending}, failing=${verdict.failing})`);
  }

  // Merge.
  const { mergeSha } = ghLib.mergeSquashPr({
    prNumber: plan.pr.number,
    subjectFile: plan.stage2.subjectFile!,
    bodyFile: plan.stage2.bodyFile!,
    expectedHeadOid: plan.pushedHeadOid!,
    repoSlug: plan.pr.nameWithOwner,
  });

  // Print result and clean up.
  process.stdout.write(JSON.stringify({
    prUrl: plan.pr.url,
    pushedHeadOid: plan.pushedHeadOid,
    mergeSha,
    pushed: true,
  }) + "\n");

  // Unlink plan + prose tempfiles + originalChangelog tempfile on success.
  try { fs.unlinkSync(planFile); } catch { /* nothing */ }
  try { fs.unlinkSync(plan.stage2.subjectFile!); } catch { /* nothing */ }
  try { fs.unlinkSync(plan.stage2.bodyFile!); } catch { /* nothing */ }
  try { fs.unlinkSync(plan.stage2.changelogBulletFile!); } catch { /* nothing */ }
  try { fs.unlinkSync(plan.originalChangelogPath); } catch { /* nothing */ }

  return 0;
}

function spawnWatcher(plan: PrMergePlan, planFile: string): number {
  ensureRuntimeDirs();
  // Resolve gh_watch_runs.ts path relative to this tool.
  const here = url.fileURLToPath(import.meta.url);
  const watcherPath = path.join(path.dirname(here), "gh_watch_runs.ts");
  if (!fs.existsSync(watcherPath)) {
    die(MergeExit.SPAWN_FAILED, `watcher tool not found at ${watcherPath}`);
  }

  const argv = [
    "--experimental-strip-types", watcherPath,
    "--on-green", "pr-merge-complete",
    "--plan-file", planFile,
    "--watch-timeout", String(plan.execute.watchTimeoutHours),
  ];
  let child;
  try {
    child = spawn("node", argv, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    die(MergeExit.SPAWN_FAILED,
      `watcher spawn failed: ${(err as Error).message}; rerun /stark-gh:pr-merge --pr ${plan.pr.number} to resume from spawn`);
  }
  // Compute deterministic watcher state-file path (same as callback's).
  const dirs = ensureRuntimeDirs();
  const stateFilePath = path.join(
    dirs.watchers,
    "github.com",
    plan.pr.headRepositoryOwner,
    plan.pr.headRepositoryName,
    `pr-${plan.pr.number}`,
    `${plan.pushedHeadOid}.json`,
  );
  process.stdout.write(JSON.stringify({
    prUrl: plan.pr.url,
    pushedHeadOid: plan.pushedHeadOid,
    pushed: true,
    watcherPid: child.pid,
    watcherStateFile: stateFilePath,
    watchTimeoutHours: plan.execute.watchTimeoutHours,
  }) + "\n");
  return 0;
}

if (process.argv[1]?.endsWith("gh_pr_merge_execute.ts")) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(err => {
    process.stderr.write(`execute: ${err?.message || err}\n`);
    process.exit(1);
  });
}
