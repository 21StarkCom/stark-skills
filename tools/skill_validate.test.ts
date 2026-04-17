import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { SkillBundle } from "./skill_lib.ts";
import {
  validateProposal,
  type RewriteChange,
  type RewriteProposal,
} from "./skill_validate.ts";

const bundle: SkillBundle = {
  skillPath: "skill/alpha/SKILL.md",
  refs: ["skill/alpha/reference.md", "standards/observability.md"],
  missingRefs: [],
  wordCount: 42,
  lineCount: 10,
};

const bundleFiles = [
  { path: "skill/alpha/SKILL.md", content: "# alpha\n" },
  { path: "skill/alpha/reference.md", content: "# reference\n" },
  { path: "standards/observability.md", content: "# observability\n" },
];

function proposal(changes: RewriteChange[], overrides: Partial<RewriteProposal> = {}): RewriteProposal {
  return {
    bundle_summary: "",
    global_notes: [],
    changes,
    refs_kept: [],
    refs_removed: [],
    contradictions_resolved: [],
    terminology_normalizations: [],
    warnings: [],
    ...overrides,
  };
}

test("rejects a change that points outside the bundle", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          { path: "../../etc/passwd", action: "update", summary: "x", content: "hi" },
        ]),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /unexpected path/,
  );
});

test("rejects deleting the main SKILL.md", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([{ path: bundle.skillPath, action: "delete", summary: "x", content: "" }]),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /cannot delete the main SKILL\.md/,
  );
});

test("rejects duplicate changes for the same path", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          { path: "skill/alpha/reference.md", action: "update", summary: "a", content: "x" },
          { path: "skill/alpha/reference.md", action: "keep", summary: "b", content: "# reference\n" },
        ]),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /same path twice/,
  );
});

test("rejects update with empty content", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          { path: "skill/alpha/reference.md", action: "update", summary: "x", content: "" },
        ]),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /missing content/,
  );
});

test("rejects keep when content differs from the current file", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          {
            path: "skill/alpha/reference.md",
            action: "keep",
            summary: "secret edit",
            content: "# reference (edited)\n",
          },
        ]),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /"keep" but supplies different content/,
  );
});

test("accepts keep when content matches current file", () => {
  validateProposal(
    bundle,
    proposal([
      {
        path: "skill/alpha/reference.md",
        action: "keep",
        summary: "no change",
        content: "# reference\n",
      },
    ]),
    bundleFiles,
    new Map(),
    new Set([bundle.skillPath]),
  );
});

test("rejects deleting a ref owned by another un-selected bundle", () => {
  const sharedOwners = new Map<string, string[]>([
    ["standards/observability.md", [bundle.skillPath, "skill/beta/SKILL.md"]],
  ]);
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          { path: "standards/observability.md", action: "delete", summary: "cleanup", content: "" },
        ]),
        bundleFiles,
        sharedOwners,
        new Set([bundle.skillPath]),
      ),
    /also referenced by skill\/beta\/SKILL\.md/,
  );
});

test("permits deleting a shared ref when every owner is in the current run", () => {
  const sharedOwners = new Map<string, string[]>([
    ["standards/observability.md", [bundle.skillPath, "skill/beta/SKILL.md"]],
  ]);
  validateProposal(
    bundle,
    proposal([
      { path: "standards/observability.md", action: "delete", summary: "cleanup", content: "" },
    ]),
    bundleFiles,
    sharedOwners,
    new Set([bundle.skillPath, "skill/beta/SKILL.md"]),
  );
});

test("accepts change with empty content when action is delete", () => {
  validateProposal(
    bundle,
    proposal([
      { path: "skill/alpha/reference.md", action: "delete", summary: "cleanup", content: "" },
    ]),
    bundleFiles,
    new Map(),
    new Set([bundle.skillPath]),
  );
});

test("rejects refs_removed entries that are not in the bundle refs", () => {
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([], { refs_removed: ["standards/nonexistent.md"] }),
        bundleFiles,
        new Map(),
        new Set([bundle.skillPath]),
      ),
    /refs_removed contains a non-reference path/,
  );
});
