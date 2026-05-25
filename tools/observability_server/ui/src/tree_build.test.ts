import { describe, expect, it } from "vitest";

import {
  buildTree,
  flattenTree,
  shortRunId,
  shortSubagentId,
} from "./tree_build";
import type { Run, Subagent } from "./types";

function run(over: Partial<Run>): Run {
  return {
    run_id: "r1",
    dispatcher: "multi_review",
    repo: "evinced/stark-skills",
    branch: "main",
    pr_number: 42,
    started_at: "2026-05-25T10:00:00.000Z",
    ended_at: null,
    status: "running",
    last_heartbeat_at: null,
    total_subagents: 0,
    total_findings: 0,
    crashed_reason: null,
    parent_pid: null,
    writer_daemon_pid: null,
    host_boot_id: null,
    last_seq: 0,
    bytes_written: 0,
    ...over,
  };
}

describe("buildTree", () => {
  it("groups runs under repo → branch → PR → run", () => {
    const tree = buildTree({
      runs: [
        run({ run_id: "a" }),
        run({ run_id: "b", pr_number: 99 }),
        run({ run_id: "c", branch: "feat/x" }),
        run({ run_id: "d", repo: "evinced/other" }),
      ],
    });
    expect(tree.length).toBe(2); // two repos
    const stark = tree.find((n) => n.label === "evinced/stark-skills")!;
    expect(stark.children.length).toBe(2); // main + feat/x
    const main = stark.children.find((n) => n.label === "main")!;
    expect(main.children.length).toBe(2); // PR #42 + PR #99
  });

  it("falls back to <no repo> / <no branch> / <no PR>", () => {
    const tree = buildTree({
      runs: [run({ repo: null, branch: null, pr_number: null })],
    });
    expect(tree[0]!.label).toBe("<no repo>");
    expect(tree[0]!.children[0]!.label).toBe("<no branch>");
    expect(tree[0]!.children[0]!.children[0]!.label).toBe("<no PR>");
  });

  it("isLive is driven by livePulse, not by stored run/subagent status", () => {
    const sa = (over: Partial<Subagent>): Subagent => ({
      subagent_id: "sa-1",
      agent: "claude",
      model: "opus-4-7",
      task: "review",
      started_at: "2026-05-25T10:00:00.000Z",
      ended_at: null,
      status: "running",
      duration_ms: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      last_output_at: null,
      finding_count: 0,
      ...over,
    });
    const subagentsByRun = {
      a: [sa({ subagent_id: "sa-emit" }), sa({ subagent_id: "sa-quiet" })],
      b: [sa({ subagent_id: "sa-ended", status: "ok" })],
    };

    // Without livePulse: nothing pulses, even for status=running rows.
    const noPulseTree = buildTree({
      runs: [run({ run_id: "a", status: "running" }), run({ run_id: "b", status: "ok" })],
      subagentsByRun,
    });
    const noPulseRunNodes = noPulseTree[0]!.children[0]!.children[0]!.children;
    expect(noPulseRunNodes.every((n) => n.isLive === false)).toBe(true);
    for (const r of noPulseRunNodes) {
      for (const c of r.children) expect(c.isLive).toBe(false);
    }

    // With livePulse: only the listed sub-agent pulses; its parent run pulses too.
    const pulseTree = buildTree({
      runs: [run({ run_id: "a", status: "running" }), run({ run_id: "b", status: "ok" })],
      subagentsByRun,
      livePulse: new Set(["sa-emit"]),
    });
    const runNodes = pulseTree[0]!.children[0]!.children[0]!.children;
    const liveRuns = runNodes.filter((n) => n.isLive === true);
    expect(liveRuns.length).toBe(1);
    const liveSas = liveRuns[0]!.children.filter((n) => n.isLive === true);
    expect(liveSas.length).toBe(1);
    expect(liveSas[0]!.subagent!.subagent_id).toBe("sa-emit");
  });
});

describe("flattenTree", () => {
  it("includes only visible rows", () => {
    const tree = buildTree({
      runs: [run({ run_id: "a" }), run({ run_id: "b", branch: "feat/x" })],
    });
    const collapsed = flattenTree(tree, new Set());
    expect(collapsed.length).toBe(1); // just repo
    const expanded = flattenTree(tree, new Set([tree[0]!.id]));
    expect(expanded.length).toBe(3); // repo + 2 branches
  });
});

describe("shortRunId", () => {
  it("preserves short ids", () => {
    expect(shortRunId("abc")).toBe("abc");
  });
  it("ellipsizes long ids", () => {
    const id = "abcdef1234567890";
    const out = shortRunId(id);
    expect(out.length).toBeLessThan(id.length);
    expect(out).toContain("…");
  });
});

describe("shortSubagentId", () => {
  it("returns the input verbatim when shorter than 8 chars", () => {
    expect(shortSubagentId("abcd")).toBe("abcd");
  });
  it("truncates long ids to the first 8 chars (E2E selector key)", () => {
    expect(shortSubagentId("abcdef1234567890")).toBe("abcdef12");
  });
});

describe("subagent ariaLabel", () => {
  it("includes the short subagent id so the Phase 5 E2E selector matches", () => {
    const subagentId = "deadbeef-cafe-1234";
    const sa = {
      subagent_id: subagentId,
      agent: "claude",
      model: "opus-4-7",
      task: "review",
      started_at: "2026-05-25T10:00:00.000Z",
      ended_at: null,
      status: "running" as const,
      duration_ms: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      last_output_at: null,
      finding_count: 0,
    };
    const tree = buildTree({
      runs: [run({ run_id: "r1" })],
      subagentsByRun: { r1: [sa] },
    });
    const saNode = tree[0]!.children[0]!.children[0]!.children[0]!.children[0]!;
    expect(saNode.kind).toBe("subagent");
    expect(saNode.ariaLabel).toContain(shortSubagentId(subagentId));
  });
});
