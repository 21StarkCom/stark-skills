#!/usr/bin/env -S node --experimental-strip-types
/**
 * fact-routing fold (STARK-1785) — read the routing queue and list the candidates
 * to route, deduped by file (latest flag wins), grouped by destination. This is
 * the CHEAP incremental fold that replaces the expensive memory sweep: it only
 * ever shows the freshly-queued candidates, never re-reads transcripts.
 *
 *   node --experimental-strip-types tools/fact_routing_fold.ts [--clear]
 *
 * With --clear, truncates the queue after listing (once the candidates are
 * routed into the corpus / a repo CLAUDE.md).
 */
import fs from "node:fs";
import { defaultQueuePath, type QueueEntry } from "./fact_routing_hook_lib.ts";

function main(): void {
  const queue = defaultQueuePath();
  let lines: string[];
  try {
    lines = fs.readFileSync(queue, "utf8").split("\n").filter(Boolean);
  } catch {
    console.log("fact-routing queue is empty — nothing to fold.");
    return;
  }

  // Dedup by file, latest wins.
  const byFile = new Map<string, QueueEntry>();
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as QueueEntry;
      byFile.set(e.file, e);
    } catch {
      /* skip a malformed line */
    }
  }
  const entries = [...byFile.values()];
  if (entries.length === 0) {
    console.log("fact-routing queue is empty — nothing to fold.");
    return;
  }

  for (const route of ["corpus", "repo-claude"] as const) {
    const group = entries.filter((e) => e.route === route);
    if (group.length === 0) continue;
    const dest = route === "corpus" ? "→ vault-ecosystem corpus" : "→ the repo's own CLAUDE.md";
    console.log(`\n${dest}  (${group.length})`);
    for (const e of group) {
      console.log(`  • [${e.project}] ${e.file.replace(/^.*\/memory\//, "…/memory/")}`);
      console.log(`    ${e.reason}`);
      console.log(`    "${e.snippet}"`);
    }
  }

  if (process.argv.includes("--clear")) {
    fs.writeFileSync(queue, "", "utf8");
    console.log("\n(queue cleared)");
  } else {
    console.log(`\n${entries.length} candidate(s). Route them, then re-run with --clear.`);
  }
}

main();
