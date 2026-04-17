import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { SkillBundle } from "./skill_lib.ts";
import {
  assertCrossBundleConsistency,
  decodeRewriteProposal,
  extractOutputText,
  findStaleBundleFile,
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

test("rejects update of a shared ref owned by another un-selected bundle", () => {
  const sharedOwners = new Map<string, string[]>([
    ["standards/observability.md", [bundle.skillPath, "skill/beta/SKILL.md"]],
  ]);
  assert.throws(
    () =>
      validateProposal(
        bundle,
        proposal([
          {
            path: "standards/observability.md",
            action: "update",
            summary: "tweak",
            content: "# observability (edited by alpha only)\n",
          },
        ]),
        bundleFiles,
        sharedOwners,
        new Set([bundle.skillPath]),
      ),
    /Refusing to update standards\/observability\.md: also referenced by skill\/beta\/SKILL\.md/,
  );
});

test("decodeRewriteProposal rejects malformed warnings array", () => {
  const payload = {
    bundle_summary: "x",
    global_notes: [],
    changes: [],
    refs_kept: [],
    refs_removed: [],
    contradictions_resolved: [],
    terminology_normalizations: [],
    warnings: "not-an-array",
  };
  assert.throws(() => decodeRewriteProposal(payload), /warnings must be string\[\]/);
});

test("decodeRewriteProposal rejects change with non-string content", () => {
  const payload = {
    bundle_summary: "x",
    global_notes: [],
    changes: [{ path: "x.md", action: "update", summary: "s", content: 42 }],
    refs_kept: [],
    refs_removed: [],
    contradictions_resolved: [],
    terminology_normalizations: [],
    warnings: [],
  };
  assert.throws(() => decodeRewriteProposal(payload), /content must be a string/);
});

test("decodeRewriteProposal rejects non-object input", () => {
  assert.throws(() => decodeRewriteProposal(null), /not an object/);
  assert.throws(() => decodeRewriteProposal("hello"), /not an object/);
});

test("extractOutputText prefers top-level output_text", () => {
  const text = extractOutputText({ output_text: "hello world", output: [] });
  assert.equal(text, "hello world");
});

test("extractOutputText falls back to output[*].content[*].text", () => {
  const payload = {
    output_text: "",
    output: [
      {
        content: [
          { type: "output_text", text: "part A" },
          { type: "reasoning", text: "skip" },
          { type: "output_text", text: "part B" },
        ],
      },
    ],
  };
  assert.equal(extractOutputText(payload), "part Apart B");
});

test("extractOutputText throws when no text is present", () => {
  assert.throws(
    () => extractOutputText({ output: [{ content: [{ type: "reasoning", text: "x" }] }] }),
    /no output text/,
  );
});

test("extractOutputText throws on non-object input", () => {
  assert.throws(() => extractOutputText(null), /not an object/);
});

test("findStaleBundleFile flags a file modified after the proposal", () => {
  const mtimes = new Map<string, number>([["skill/alpha/SKILL.md", Date.now()]]);
  const result = findStaleBundleFile(
    Date.now() - 60_000,
    ["skill/alpha/SKILL.md"],
    (rel) => mtimes.get(rel) ?? null,
  );
  assert.equal(result.stale, true);
  assert.equal((result as { stale: true; reason: string }).reason, "modified");
});

test("findStaleBundleFile returns not-stale when files are older than proposal", () => {
  const mtimes = new Map<string, number>([["skill/alpha/SKILL.md", Date.now() - 120_000]]);
  const result = findStaleBundleFile(
    Date.now(),
    ["skill/alpha/SKILL.md"],
    (rel) => mtimes.get(rel) ?? null,
  );
  assert.equal(result.stale, false);
});

test("assertCrossBundleConsistency rejects conflicting update content on a shared ref", () => {
  const entries = [
    {
      skillPath: "skill/alpha/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "update", summary: "a", content: "VERSION A\n" },
      ]),
    },
    {
      skillPath: "skill/beta/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "update", summary: "b", content: "VERSION B\n" },
      ]),
    },
  ];
  assert.throws(
    () => assertCrossBundleConsistency(entries),
    /Cross-bundle conflict on standards\/observability\.md/,
  );
});

test("assertCrossBundleConsistency accepts identical update on a shared ref", () => {
  const content = "# observability (agreed rewrite)\n";
  const entries = [
    {
      skillPath: "skill/alpha/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "update", summary: "a", content },
      ]),
    },
    {
      skillPath: "skill/beta/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "update", summary: "b", content },
      ]),
    },
  ];
  assertCrossBundleConsistency(entries);
});

test("assertCrossBundleConsistency rejects update-vs-delete disagreement", () => {
  const entries = [
    {
      skillPath: "skill/alpha/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "update", summary: "a", content: "# keep\n" },
      ]),
    },
    {
      skillPath: "skill/beta/SKILL.md",
      proposal: proposal([
        { path: "standards/observability.md", action: "delete", summary: "b", content: "" },
      ]),
    },
  ];
  assert.throws(() => assertCrossBundleConsistency(entries), /update.*delete|delete.*update/);
});

test("assertCrossBundleConsistency ignores non-overlapping changes", () => {
  const entries = [
    {
      skillPath: "skill/alpha/SKILL.md",
      proposal: proposal([
        { path: "skill/alpha/ref.md", action: "update", summary: "a", content: "A\n" },
      ]),
    },
    {
      skillPath: "skill/beta/SKILL.md",
      proposal: proposal([
        { path: "skill/beta/ref.md", action: "update", summary: "b", content: "B\n" },
      ]),
    },
  ];
  assertCrossBundleConsistency(entries);
});

test("findStaleBundleFile flags deleted files as stale", () => {
  const result = findStaleBundleFile(Date.now(), ["gone.md"], () => null);
  assert.equal(result.stale, true);
  assert.equal((result as { stale: true; reason: string }).reason, "deleted");
});

test("extractOutputText ignores malformed output entries", () => {
  const payload = {
    output: [
      null,
      { content: null },
      { content: [null, { type: "output_text", text: "ok" }] },
    ],
  };
  assert.equal(extractOutputText(payload), "ok");
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
