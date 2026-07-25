import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  appForLead,
  buildPushArgs,
  deriveImplBranch,
  landImpl,
  mergePrNumbers,
  type LandDeps,
} from "./copilot_land_lib.ts";

// --- appForLead --------------------------------------------------------------

describe("appForLead", () => {
  test("maps each copilot lead to its GitHub App identity (mirrors §4b's table)", () => {
    assert.equal(appForLead("claude"), "stark-claude");
    assert.equal(appForLead("codex"), "stark-codex");
    assert.equal(appForLead("gemini"), "stark-gemini");
  });

  test("unknown lead fails closed to stark-claude", () => {
    assert.equal(appForLead("unknown-agent"), "stark-claude");
  });
});

// --- buildPushArgs -----------------------------------------------------------

describe("buildPushArgs", () => {
  test("no upstream yet: sets upstream, never forces", () => {
    const args = buildPushArgs("copilot/demo-plan", false);
    assert.deepEqual(args, ["push", "-u", "origin", "copilot/demo-plan"]);
    assert.equal(args.includes("--force"), false);
    assert.equal(args.includes("-f"), false);
    assert.equal(args.includes("--force-with-lease"), false);
  });

  test("upstream already tracked: plain push, never forces", () => {
    const args = buildPushArgs("copilot/demo-plan", true);
    assert.deepEqual(args, ["push", "origin", "copilot/demo-plan"]);
    assert.equal(args.includes("--force"), false);
    assert.equal(args.includes("-f"), false);
    assert.equal(args.includes("--force-with-lease"), false);
  });
});

// --- deriveImplBranch ---------------------------------------------------------

describe("deriveImplBranch", () => {
  test("prefers the plan slug when present", () => {
    assert.equal(deriveImplBranch("widget-system", "fallback-slug"), "copilot/widget-system");
  });

  test("falls back when plan slug is null/undefined/blank", () => {
    assert.equal(deriveImplBranch(null, "fallback-slug"), "copilot/fallback-slug");
    assert.equal(deriveImplBranch(undefined, "fallback-slug"), "copilot/fallback-slug");
    assert.equal(deriveImplBranch("   ", "fallback-slug"), "copilot/fallback-slug");
  });

  test("is deterministic across repeated calls (no timestamp/random component)", () => {
    assert.equal(deriveImplBranch("widget-system", "x"), deriveImplBranch("widget-system", "x"));
  });
});

// --- mergePrNumbers -----------------------------------------------------------

describe("mergePrNumbers", () => {
  test("re-reporting a known PR alongside a new one yields the union, not a duplicate", () => {
    assert.deepEqual(mergePrNumbers([812], [812, 819]), [812, 819]);
  });

  test("combines pre-existing and newly-landed numbers, de-duplicated, first-seen order", () => {
    assert.deepEqual(mergePrNumbers([101, 102], [104, 105]), [101, 102, 104, 105]);
    assert.deepEqual(mergePrNumbers([101, 102], [102, 103]), [101, 102, 103]);
  });

  test("handles empty inputs", () => {
    assert.deepEqual(mergePrNumbers([], []), []);
    assert.deepEqual(mergePrNumbers([101], []), [101]);
    assert.deepEqual(mergePrNumbers([], [101]), [101]);
  });
});

// --- landImpl: the BLOCKING BUILD GATE tests --------------------------------

function makeDeps(overrides: Partial<LandDeps> = {}): { deps: LandDeps; calls: { push: number; list: number; create: number } } {
  const calls = { push: 0, list: 0, create: 0 };
  const deps: LandDeps = {
    push: () => {
      calls.push++;
      return { ok: true };
    },
    listOpenPrs: async () => {
      calls.list++;
      return [];
    },
    createPr: async () => {
      calls.create++;
      return { number: 900, html_url: "https://github.com/o/r/pull/900" };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("landImpl — idempotent create-or-adopt", () => {
  test("bare re-invocation after the branch+PR already exist adopts it and opens NO duplicate PR", async () => {
    const { deps, calls } = makeDeps({
      listOpenPrs: async () => {
        calls.list++;
        return [{ number: 812, head: { ref: "copilot/widget-system" }, html_url: "https://github.com/o/r/pull/812" }];
      },
    });

    const result = await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "impl: widget-system",
        body: "body",
        lead: "claude",
        ready: false,
        hasUpstream: true,
        knownPrs: [],
      },
      deps,
    );

    assert.equal(calls.create, 0, "adopting an existing PR must never call createPr again");
    assert.equal(result.pr.number, 812);
    assert.equal(result.pr.adopted, true);
    assert.deepEqual(result.prs, [812]);
  });

  test("no existing PR for the branch: opens exactly one, draft by default, authored by the lead's App", async () => {
    const { deps, calls } = makeDeps();

    const result = await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "impl: widget-system",
        body: "body",
        lead: "codex",
        ready: false,
        hasUpstream: false,
        knownPrs: [],
      },
      deps,
    );

    assert.equal(calls.create, 1);
    assert.equal(result.pr.adopted, false);
    assert.equal(result.pr.app, "stark-codex");
    assert.equal(result.pr.number, 900);
    assert.deepEqual(result.prs, [900]);
  });

  test("never force-pushes: the push step is invoked exactly once per landImpl call", async () => {
    const { deps, calls } = makeDeps();
    await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "t",
        body: "b",
        lead: "claude",
        ready: false,
        hasUpstream: false,
        knownPrs: [],
      },
      deps,
    );
    assert.equal(calls.push, 1);
  });

  test("multi-PR union: re-reporting a known impl PR alongside a newly-adopted one yields the union", async () => {
    const { deps } = makeDeps({
      listOpenPrs: async () => [{ number: 819, head: { ref: "copilot/widget-system" }, html_url: "" }],
    });

    const result = await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "t",
        body: "b",
        lead: "claude",
        ready: false,
        hasUpstream: true,
        knownPrs: [812],
      },
      deps,
    );

    assert.deepEqual(result.prs, [812, 819]);
  });

  test("push failure aborts before any PR call", async () => {
    const { deps, calls } = makeDeps({
      push: () => {
        calls.push++;
        return { ok: false, stderr: "non-fast-forward" };
      },
    });
    await assert.rejects(() =>
      landImpl(
        {
          branch: "copilot/widget-system",
          base: "main",
          title: "t",
          body: "b",
          lead: "claude",
          ready: false,
          hasUpstream: true,
          knownPrs: [],
        },
        deps,
      ),
    );
    assert.equal(calls.list, 0);
    assert.equal(calls.create, 0);
  });
});

describe("landImpl — adopt path un-drafts on --ready (Important finding fix)", () => {
  test("adopting a DRAFT PR with --ready marks it ready via deps.markReady", async () => {
    const markReadyCalls: number[] = [];
    const { deps } = makeDeps({
      listOpenPrs: async () => [
        { number: 812, head: { ref: "copilot/widget-system" }, html_url: "https://github.com/o/r/pull/812", draft: true },
      ],
      markReady: async (n) => {
        markReadyCalls.push(n);
        return { ok: true };
      },
    });

    const result = await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "impl: widget-system",
        body: "body",
        lead: "claude",
        ready: true,
        hasUpstream: true,
        knownPrs: [],
      },
      deps,
    );

    assert.deepEqual(markReadyCalls, [812], "markReady must be called exactly once for the adopted draft PR");
    assert.equal(result.pr.adopted, true);
    assert.equal(result.pr.number, 812);
  });

  test("adopting a DRAFT PR WITHOUT --ready never calls markReady, leaves it a draft", async () => {
    const markReadyCalls: number[] = [];
    const { deps } = makeDeps({
      listOpenPrs: async () => [
        { number: 812, head: { ref: "copilot/widget-system" }, html_url: "https://github.com/o/r/pull/812", draft: true },
      ],
      markReady: async (n) => {
        markReadyCalls.push(n);
        return { ok: true };
      },
    });

    await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "impl: widget-system",
        body: "body",
        lead: "claude",
        ready: false,
        hasUpstream: true,
        knownPrs: [],
      },
      deps,
    );

    assert.deepEqual(markReadyCalls, [], "markReady must not be called when --ready was not passed");
  });

  test("adopting an ALREADY-READY PR with --ready is a harmless no-op: markReady is not called", async () => {
    const markReadyCalls: number[] = [];
    const { deps } = makeDeps({
      listOpenPrs: async () => [
        { number: 812, head: { ref: "copilot/widget-system" }, html_url: "https://github.com/o/r/pull/812", draft: false },
      ],
      markReady: async (n) => {
        markReadyCalls.push(n);
        return { ok: true };
      },
    });

    const result = await landImpl(
      {
        branch: "copilot/widget-system",
        base: "main",
        title: "impl: widget-system",
        body: "body",
        lead: "claude",
        ready: true,
        hasUpstream: true,
        knownPrs: [],
      },
      deps,
    );

    assert.deepEqual(markReadyCalls, [], "markReady must not be called when the adopted PR is already ready");
    assert.equal(result.pr.adopted, true);
  });

  test("markReady failure surfaces as a rejection (never silently swallowed)", async () => {
    const { deps } = makeDeps({
      listOpenPrs: async () => [
        { number: 812, head: { ref: "copilot/widget-system" }, html_url: "https://github.com/o/r/pull/812", draft: true },
      ],
      markReady: async () => ({ ok: false, stderr: "gh: pull request already merged" }),
    });

    await assert.rejects(() =>
      landImpl(
        {
          branch: "copilot/widget-system",
          base: "main",
          title: "t",
          body: "b",
          lead: "claude",
          ready: true,
          hasUpstream: true,
          knownPrs: [],
        },
        deps,
      ),
    );
  });
});
