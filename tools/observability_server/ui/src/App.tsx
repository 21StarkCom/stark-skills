/**
 * Top-level app shell. Wires the Live tab (Tree + DetailPane) and the
 * History tab via a WAI-ARIA tablist. Owns the cross-pane selection
 * state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { getRun, listRuns } from "./api";
import { buildTree } from "./tree_build";
import type { Run, RunDetailResponse, Subagent, TreeNode } from "./types";
import { Tree } from "./components/Tree";
import { DetailPane } from "./components/DetailPane";
import { HistoryTab } from "./components/HistoryTab";
import { LiveRegionProvider, useLiveRegion } from "./components/LiveRegion";
import { useLivePulse } from "./useLivePulse";

type Selection =
  | { kind: "run"; runId: string }
  | { kind: "subagent"; runId: string; subagentId: string }
  | null;

type Tab = "live" | "history";

export function App(): JSX.Element {
  return (
    <LiveRegionProvider>
      <AppShell />
    </LiveRegionProvider>
  );
}

const ACTIVE_ONLY_LS_KEY = "stark-obs:tree-active-only";

function readActiveOnlyPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(ACTIVE_ONLY_LS_KEY);
    if (v === null) return true; // default ON
    return v === "1";
  } catch {
    return true;
  }
}

function AppShell(): JSX.Element {
  const [tab, setTab] = useState<Tab>("live");
  const [selection, setSelection] = useState<Selection>(null);
  const [activeOnly, setActiveOnly] = useState<boolean>(() => readActiveOnlyPref());
  const live = useLiveRegion();

  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_ONLY_LS_KEY, activeOnly ? "1" : "0");
    } catch {
      // localStorage disabled — fall through, in-memory state still works
    }
  }, [activeOnly]);

  // Active runs refetch on a 5 s cadence; history (limit=50) refetches
  // on a 30 s cadence so a finished run shows up in the rail.
  const activeQ = useQuery<{ items: Run[]; next_cursor: string | null }>({
    queryKey: ["runs", "running"],
    queryFn: () => listRuns({ status: "running" }),
    refetchInterval: 5_000,
  });
  const historyQ = useQuery<{ items: Run[]; next_cursor: string | null }>({
    queryKey: ["runs", "recent"],
    queryFn: () => listRuns({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const runs = useMemo(() => {
    const seen = new Map<string, Run>();
    for (const r of activeQ.data?.items ?? []) seen.set(r.run_id, r);
    for (const r of historyQ.data?.items ?? []) {
      if (!seen.has(r.run_id)) seen.set(r.run_id, r);
    }
    return Array.from(seen.values());
  }, [activeQ.data, historyQ.data]);

  // Per-run detail fetch so the tree can show sub-agent rows.
  // `GET /api/runs` returns runs only — without these the tree would
  // never expose any `treeitem--subagent`. Live runs refetch fast (so
  // newly-started sub-agents appear); terminal runs refetch slowly.
  const detailQueries = useQueries({
    queries: runs.map((r) => ({
      queryKey: ["run-detail", r.run_id],
      queryFn: () => getRun(r.run_id),
      refetchInterval: r.status === "running" ? 5_000 : 60_000,
      staleTime: 2_000,
    })),
  });

  const subagentsByRun = useMemo<Record<string, Subagent[]>>(() => {
    const out: Record<string, Subagent[]> = {};
    for (let i = 0; i < runs.length; i++) {
      const q = detailQueries[i];
      const data = q?.data as RunDetailResponse | undefined;
      if (data && Array.isArray(data.subagents)) {
        out[runs[i]!.run_id] = data.subagents;
      }
    }
    return out;
  }, [runs, detailQueries]);

  const runningRunIds = useMemo(
    () => runs.filter((r) => r.status === "running").map((r) => r.run_id),
    [runs],
  );
  const livePulse = useLivePulse(runningRunIds);

  // Active-only filter: keep a run when its own status is "running" OR
  // any of its known sub-agents is "running". Sub-agents are pulled
  // from the per-run detail load (subagentsByRun); a run whose detail
  // hasn't landed yet falls back to its top-level status (so brand-new
  // runs aren't hidden during the detail fetch).
  const visibleRuns = useMemo(() => {
    if (!activeOnly) return runs;
    return runs.filter((r) => {
      if (r.status === "running") return true;
      const sas = subagentsByRun[r.run_id];
      if (sas && sas.some((sa) => sa.status === "running")) return true;
      return false;
    });
  }, [runs, subagentsByRun, activeOnly]);

  const tree = useMemo<TreeNode[]>(
    () => buildTree({ runs: visibleRuns, subagentsByRun, livePulse }),
    [visibleRuns, subagentsByRun, livePulse],
  );
  const hiddenCount = runs.length - visibleRuns.length;

  // Announce when a new run starts.
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    let newCount = 0;
    for (const r of runs) {
      if (!knownIds.current.has(r.run_id)) {
        knownIds.current.add(r.run_id);
        if (knownIds.current.size > 1) newCount += 1;
      }
    }
    if (newCount > 0) {
      live.announce(`${newCount} new run${newCount === 1 ? "" : "s"}`);
    }
  }, [runs, live]);

  const onSelectFromTree = useCallback((node: TreeNode) => {
    if (node.kind === "run" && node.run) {
      setSelection({ kind: "run", runId: node.run.run_id });
      setTab("live");
      return;
    }
    if (node.kind === "subagent" && node.subagent) {
      // The tree only carries sub-agents for runs whose detail was
      // already fetched; we know its parent run_id from the row.
      const sa: Subagent = node.subagent;
      const parentRun = node.id.split(":")[1];
      if (parentRun !== undefined) {
        setSelection({
          kind: "subagent",
          runId: parentRun,
          subagentId: sa.subagent_id,
        });
        setTab("live");
      }
    }
  }, []);

  const onSelectFromHistory = useCallback((runId: string) => {
    setSelection({ kind: "run", runId });
    setTab("live");
  }, []);

  const onSelectSubagentFromTable = useCallback(
    (runId: string, subagentId: string) => {
      setSelection({ kind: "subagent", runId, subagentId });
    },
    [],
  );

  const onTabKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setTab(tab === "live" ? "history" : "live");
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setTab(tab === "live" ? "history" : "live");
      } else if (e.key === "Home") {
        e.preventDefault();
        setTab("live");
      } else if (e.key === "End") {
        e.preventDefault();
        setTab("history");
      }
    },
    [tab],
  );

  const selectedRunId = selection ? selection.runId : null;
  const selectedSubagentId =
    selection && selection.kind === "subagent" ? selection.subagentId : null;
  const treeSelectedId = selectedSubagentId
    ? `sa:${selectedRunId}:${selectedSubagentId}`
    : selectedRunId
      ? `run:${selectedRunId}`
      : null;

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <header className="app__header" role="banner">
        <h1>stark-observability</h1>
        <QuietToggle />
      </header>
      <div
        role="tablist"
        aria-label="Views"
        className="app__tablist"
        onKeyDown={onTabKey}
      >
        <button
          type="button"
          role="tab"
          id="tab-live"
          aria-controls="panel-live"
          aria-selected={tab === "live"}
          tabIndex={tab === "live" ? 0 : -1}
          onClick={() => setTab("live")}
        >
          Live
        </button>
        <button
          type="button"
          role="tab"
          id="tab-history"
          aria-controls="panel-history"
          aria-selected={tab === "history"}
          tabIndex={tab === "history" ? 0 : -1}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>
      <main id="main-content" className="app__main">
        <div
          id="panel-live"
          role="tabpanel"
          aria-labelledby="tab-live"
          hidden={tab !== "live"}
          className="app__panel"
        >
          <aside className="app__rail" aria-label="Run tree">
            <div className="app__rail-filter">
              <label className="active-only-toggle">
                <input
                  type="checkbox"
                  checked={activeOnly}
                  onChange={(e) => setActiveOnly(e.target.checked)}
                  aria-describedby="active-only-help"
                />
                <span>Show only active runs</span>
              </label>
              <p id="active-only-help" className="active-only-help">
                {activeOnly
                  ? hiddenCount > 0
                    ? `${hiddenCount} finished run${hiddenCount === 1 ? "" : "s"} hidden`
                    : "All runs match — nothing hidden"
                  : "Showing every run; toggle on to hide finished runs"}
              </p>
            </div>
            <Tree
              roots={tree}
              selectedId={treeSelectedId}
              onSelect={onSelectFromTree}
            />
          </aside>
          <div className="app__detail">
            <DetailPane
              selection={selection}
              onSelectSubagent={onSelectSubagentFromTable}
            />
          </div>
        </div>
        <div
          id="panel-history"
          role="tabpanel"
          aria-labelledby="tab-history"
          hidden={tab !== "history"}
          className="app__panel"
        >
          <HistoryTab onSelectRun={onSelectFromHistory} />
        </div>
      </main>
    </div>
  );
}

function QuietToggle(): JSX.Element {
  const live = useLiveRegion();
  return (
    <label className="quiet-toggle">
      <input
        type="checkbox"
        checked={live.quiet}
        onChange={(e) => live.setQuiet(e.target.checked)}
      />
      <span>Quiet announcements</span>
    </label>
  );
}
