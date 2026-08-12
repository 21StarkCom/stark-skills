import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMergePrByNumber, fetchMergePrForCurrentBranch } from "../lib/gh.ts";

// `gh pr view --json` rejects the WHOLE call on one unknown field name, and
// fetchMergePrForCurrentBranch swallows that into `null` — reported upstream as
// "no PR for current branch; pass --pr N". A `nameWithOwner` (a `gh repo view`
// field) sat in that list and made the bare `/stark-gh:pr-merge` invocation
// fail on every branch, with no test able to see it because the payload field
// it fed was never read.

// Fields that belong to `gh repo view`, not `gh pr view`. Any of these in the
// pr-view arg list is the same bug again.
const REPO_ONLY_FIELDS = ["nameWithOwner", "defaultBranchRef", "owner", "isPrivate"];

function capture(): { args: string[][]; exec: (cmd: string, args: string[]) => Buffer } {
  const args: string[][] = [];
  return {
    args,
    exec: (_cmd, a) => {
      args.push(a);
      return Buffer.from(JSON.stringify({ number: 1, labels: [] }));
    },
  };
}

function jsonFields(argv: string[]): string[] {
  const i = argv.indexOf("--json");
  assert.notEqual(i, -1, "expected a --json flag");
  return argv[i + 1]!.split(",");
}

test("fetchMergePrForCurrentBranch requests no repo-only --json fields", () => {
  const c = capture();
  fetchMergePrForCurrentBranch({ exec: c.exec });
  const fields = jsonFields(c.args[0]!);
  for (const f of REPO_ONLY_FIELDS) {
    assert.ok(!fields.includes(f), `${f} is a gh repo view field, not a gh pr view one`);
  }
});

test("fetchMergePrByNumber requests no repo-only --json fields", () => {
  const c = capture();
  fetchMergePrByNumber(42, "o/r", { exec: c.exec });
  const fields = jsonFields(c.args[0]!);
  for (const f of REPO_ONLY_FIELDS) {
    assert.ok(!fields.includes(f), `${f} is a gh repo view field, not a gh pr view one`);
  }
});

test("both merge PR fetchers request the same field list", () => {
  const byNumber = capture();
  fetchMergePrByNumber(42, "o/r", { exec: byNumber.exec });
  const current = capture();
  fetchMergePrForCurrentBranch({ exec: current.exec });
  assert.deepEqual(jsonFields(byNumber.args[0]!), jsonFields(current.args[0]!));
});

test("fetchMergePrForCurrentBranch returns null when gh fails", () => {
  const r = fetchMergePrForCurrentBranch({
    exec: () => { throw new Error("gh: no pull requests found"); },
  });
  assert.equal(r, null);
});
