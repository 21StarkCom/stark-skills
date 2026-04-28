import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mergeSquashPr } from "../lib/gh.ts";
import { forcePushWithLease } from "../lib/git.ts";

// =============================================================================
// F15: mergeSquashPr argv contract
//
// Pinning the gh argv shape so a future refactor cannot silently drop
// --match-head-commit (the SHA fence) or add --delete-branch (which would
// remove the recovery anchor before /stark-gh:cleanup runs).
// =============================================================================

test("mergeSquashPr argv: includes --squash, --subject, --body-file, --match-head-commit; omits --delete-branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-argv-"));
  const subjectFile = path.join(tmpDir, "subject.txt");
  const bodyFile = path.join(tmpDir, "body.md");
  fs.writeFileSync(subjectFile, "feat(x): a subject\n");
  fs.writeFileSync(bodyFile, "Body\n");

  const calls: { cmd: string; args: readonly string[] }[] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args: [...args] });
    // Simulate gh pr merge succeeding (no useful stdout) AND the subsequent
    // gh pr view fetch returning a mergeable record with mergeCommit.
    if (args[0] === "pr" && args[1] === "merge") return Buffer.from("");
    if (args[0] === "pr" && args[1] === "view") {
      return Buffer.from(JSON.stringify({ mergeCommit: { oid: "MERGE_SHA_42" } }));
    }
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;

  const result = mergeSquashPr({
    prNumber: 7,
    subjectFile,
    bodyFile,
    expectedHeadOid: "PUSHED_HEAD_OID",
    repoSlug: "o/r",
  }, { exec });

  // Find the merge call.
  const mergeCall = calls.find(c => c.args[0] === "pr" && c.args[1] === "merge");
  assert.ok(mergeCall, "mergeSquashPr should call gh pr merge");
  const a = mergeCall.args;

  assert.equal(a[0], "pr");
  assert.equal(a[1], "merge");
  assert.equal(a[2], "7", "PR number passed as positional arg");
  assert.ok(a.includes("--squash"), "must use --squash strategy");
  assert.ok(a.includes("--match-head-commit"),
    "must pin SHA via --match-head-commit so a head moved between watcher-green and merge is rejected");
  const matchIdx = a.indexOf("--match-head-commit");
  assert.equal(a[matchIdx + 1], "PUSHED_HEAD_OID",
    "--match-head-commit value must be the planned pushedHeadOid");
  assert.ok(a.includes("--subject"), "must use --subject (no shell interpolation of subject text)");
  const subjectIdx = a.indexOf("--subject");
  assert.equal(a[subjectIdx + 1], "feat(x): a subject",
    "subject text is read from tempfile and passed as a single argv slot");
  assert.ok(a.includes("--body-file"), "must use --body-file (no body shelled in)");
  const bodyIdx = a.indexOf("--body-file");
  assert.equal(a[bodyIdx + 1], bodyFile);
  assert.ok(a.includes("--repo"), "must scope to PR repo");
  const repoIdx = a.indexOf("--repo");
  assert.equal(a[repoIdx + 1], "o/r");

  assert.equal(a.includes("--delete-branch"), false,
    "must NOT pass --delete-branch — branch is the recovery anchor; deletion is deferred to /stark-gh:cleanup");
  assert.equal(a.includes("--auto"), false, "must NOT auto-merge");

  assert.equal(result.mergeSha, "MERGE_SHA_42");
});

// =============================================================================
// F14: force-push rejection rollback
//
// When `git push --force-with-lease` fails (e.g. lease violated by a concurrent
// remote update), execute must roll back the local rebase and CHANGELOG edit
// AND clear pushedHeadOid in the retained plan-file. We cover the lib-level
// guarantee (forcePushWithLease throws on rejection) plus the rollback shape.
// =============================================================================

test("forcePushWithLease throws on push rejection (rollback prerequisite)", () => {
  const exec = ((cmd: string, args: readonly string[]) => {
    if (cmd === "git" && args[0] === "push") {
      const e = new Error(
        "stale info\n  ! [rejected]  feat/x -> feat/x (stale info)\nerror: failed to push some refs",
      );
      throw e;
    }
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;

  assert.throws(
    () => forcePushWithLease(
      { remote: "origin", headRef: "feat/x", expectedRemoteOid: "ORIGINAL_HEAD" },
      { exec },
    ),
    /stale info|rejected|failed to push/,
    "rejected push must throw so the execute layer triggers rollback",
  );
});

test("forcePushWithLease argv: explicit-OID lease bound to expectedRemoteOid", () => {
  let captured: { cmd: string; args: readonly string[] } | null = null;
  const exec = ((cmd: string, args: readonly string[]) => {
    captured = { cmd, args: [...args] };
    return Buffer.from("");
  }) as never;

  forcePushWithLease(
    { remote: "origin", headRef: "feat/x", expectedRemoteOid: "EXPECTED_OID" },
    { exec },
  );

  assert.ok(captured, "forcePushWithLease must call git");
  const a = captured!.args;
  assert.equal(a[0], "push");
  assert.ok(
    a.some(x => x === "--force-with-lease=refs/heads/feat/x:EXPECTED_OID"),
    "lease must use the explicit-OID form bound to the original remote head — not bare --force or value-less --force-with-lease",
  );
  assert.equal(a.includes("--force"), false,
    "must not use bare --force which would skip the OID check entirely");
});
