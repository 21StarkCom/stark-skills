import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/marketplace-sync.yml", import.meta.url), "utf8");
const filter = workflow.match(/review_filter='([^']+)'/)?.[1];
assert.ok(filter, "exercise the actual publisher review predicate");
const head = "a".repeat(40);
const completed = () => ({ id: 1, user: { login: "aryeh-stark" }, commit_id: head,
  state: "COMMENTED", submitted_at: "2026-09-15T12:00:00Z",
  body: "<!-- stark-code-review:complete -->\n/code-review xhigh --fix completed; findings fixed or answered." });

function accepted(pages: unknown[][], expected: boolean): void {
  const result = spawnSync("jq", ["-e", "--arg", "head", head, filter!], {
    input: JSON.stringify(pages), encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected ? 0 : 1, result.stderr || result.stdout);
}

test("publisher requires the operator's explicit completed review on the current head", () => {
  accepted([[completed()]], true);
  accepted([[{ ...completed(), state: "APPROVED" }]], true);
  accepted([[]], false);
  for (const change of [
    { user: { login: "stark-meridian-ci[bot]" } },
    { commit_id: "b".repeat(40) },
    { submitted_at: null },
    { state: "PENDING" },
    { state: "CHANGES_REQUESTED" },
    { state: "DISMISSED" },
    { body: "/code-review xhigh --fix is still running." },
    { body: "Example marker:\n" + completed().body },
    { body: "<!-- stark-code-review:complete -->\nAn unrelated review passed." },
    { body: null },
  ]) accepted([[{ ...completed(), ...change }]], false);
});

test("publisher keeps all review pages and honors the latest operator verdict", () => {
  const later = { ...completed(), id: 2, submitted_at: "2026-09-15T12:01:00Z" };
  accepted([[completed()], [{ ...later, state: "CHANGES_REQUESTED" }]], false);
  accepted([[completed()], [{ ...later, state: "DISMISSED" }]], false);
  accepted([[{ ...completed(), state: "CHANGES_REQUESTED" }], [later]], true);
  accepted([[completed()], [{ ...later, commit_id: "b".repeat(40), state: "CHANGES_REQUESTED" }]], true);
  accepted([[completed()], [{ ...later, user: { login: "unrelated-bot" }, state: "COMMENTED", body: "FYI" }]], true);
  // Equal timestamps use monotonically increasing review ids, not page order.
  accepted([[{ ...completed(), id: 2, state: "DISMISSED" }], [completed()]], false);
});
