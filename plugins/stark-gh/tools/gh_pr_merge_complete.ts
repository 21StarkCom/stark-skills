#!/usr/bin/env node
// Watcher --on-green callback for /stark-gh:pr-merge.
// Invoked by gh_watch_runs.ts (pr-merge mode) when checks reach green
// (debounced) on pushedHeadOid. Owns these terminal states:
//   - merged
//   - merge_failed
//   - base_moved
//   - secret_in_prose
// (head_moved is owned by the watcher itself.)

import * as fs from "node:fs";
import * as path from "node:path";
import { MergeExit } from "./lib/exit.ts";
import { die } from "./lib/output.ts";
import { readPrMergePlan, type PrMergePlan } from "./lib/plan.ts";
import * as ghLib from "./lib/gh.ts";
import { scanSecrets } from "./lib/secret.ts";
import { verifyMergeOids } from "./lib/verify_oids.ts";
import { ensureRuntimeDirs } from "./lib/runtime.ts";

interface OperatorRunbook {
  remote_was_force_pushed: boolean;
  original_head_oid: string;
  current_remote_head_oid: string;
  cleanup_command: string;
  branch_recovery_window: string;
}

function buildRunbook(plan: PrMergePlan): OperatorRunbook {
  return {
    remote_was_force_pushed: true,
    original_head_oid: plan.originalHeadOid,
    current_remote_head_oid: plan.pushedHeadOid ?? "<unknown>",
    cleanup_command: `/stark-gh:cleanup --pr ${plan.pr.number}`,
    branch_recovery_window: "until /stark-gh:cleanup runs (then GC window)",
  };
}

function watcherStatePathForPlan(plan: PrMergePlan): string {
  const dirs = ensureRuntimeDirs();
  return path.join(
    dirs.watchers,
    "github.com",
    plan.pr.headRepositoryOwner,
    plan.pr.headRepositoryName,
    `pr-${plan.pr.number}`,
    `${plan.pushedHeadOid}.json`,
  );
}

function writeTerminalState(plan: PrMergePlan, status: string, extras: Record<string, unknown>): void {
  const sf = watcherStatePathForPlan(plan);
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { /* fresh */ }
  const next = {
    ...cur,
    status,
    runbook: buildRunbook(plan),
    finishedAt: new Date().toISOString(),
    ...extras,
  };
  fs.mkdirSync(path.dirname(sf), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sf, JSON.stringify(next, null, 2));
}

async function main(argv: string[]): Promise<number> {
  let planFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan-file") {
      if (i + 1 >= argv.length) die(MergeExit.BAD_ARGS, "--plan-file requires a value");
      planFile = argv[++i]!;
    }
  }
  if (planFile === null) die(MergeExit.BAD_ARGS, "--plan-file is required");

  const plan = readPrMergePlan(planFile);
  if (!plan.pushedHeadOid) {
    die(MergeExit.BAD_ARGS, "callback invoked but plan.pushedHeadOid is null");
  }

  // Step 1: OID re-verify
  const v = await verifyMergeOids(plan);
  if (!v.ok) {
    if (v.kind === "base_moved") {
      writeTerminalState(plan, "base_moved", { expected: v.expected, actual: v.actual });
    } else {
      // head_moved is normally caught by watcher; defensive duplicate.
      writeTerminalState(plan, "head_moved", { expected: v.expected, actual: v.actual });
    }
    return 0;
  }

  // Step 2: pre-merge secret rescan over prose tempfiles
  if (plan.stage2.subjectFile && plan.stage2.bodyFile) {
    const subject = fs.readFileSync(plan.stage2.subjectFile, "utf8");
    const body = fs.readFileSync(plan.stage2.bodyFile, "utf8");
    const hits = scanSecrets(subject + "\n" + body);
    if (hits.length > 0 && !plan.execute.secretOverrides.commit) {
      writeTerminalState(plan, "secret_in_prose", {
        categories: Array.from(new Set(hits.map(h => h.category))),
      });
      return 0;
    }
  }

  // Step 3: merge via shared helper (atomic --match-head-commit).
  // Defense-in-depth: execute already un-drafted a wasDraft PR before spawning
  // the watcher, but re-assert readiness here so a draft can never reach the
  // merge call (a draft merge would hard-fail). Idempotent no-op if ready.
  if (plan.pr.wasDraft) {
    ghLib.markPrReady(plan.pr.number, { repoSlug: plan.pr.nameWithOwner });
  }
  let mergeSha = "";
  try {
    const r = ghLib.mergeSquashPr({
      prNumber: plan.pr.number,
      subjectFile: plan.stage2.subjectFile!,
      bodyFile: plan.stage2.bodyFile!,
      expectedHeadOid: plan.pushedHeadOid,
      repoSlug: plan.pr.nameWithOwner,
    });
    mergeSha = r.mergeSha;
  } catch (err) {
    writeTerminalState(plan, "merge_failed", {
      error: (err as Error).message,
      // Plan + tempfiles retained for diagnosis.
    });
    return 0;
  }

  // Step 4: success — write terminal state, clean up tempfiles, retain
  // remote branch (recovery anchor). Plan-file unlinked; the watcher
  // state remains as audit trail.
  writeTerminalState(plan, "merged", {
    mergeSha,
    cleanupHint: `Run: /stark-gh:cleanup --pr ${plan.pr.number}`,
  });
  try { fs.unlinkSync(planFile); } catch { /* nothing */ }
  for (const f of [plan.stage2.subjectFile, plan.stage2.bodyFile, plan.stage2.changelogBulletFile, plan.originalChangelogPath]) {
    if (f) try { fs.unlinkSync(f); } catch { /* nothing */ }
  }
  return 0;
}

// Exports for tests
export { buildRunbook, watcherStatePathForPlan };

if (process.argv[1]?.endsWith("gh_pr_merge_complete.ts")) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(err => {
    process.stderr.write(`callback: ${err?.message || err}\n`);
    process.exit(1);
  });
}
