/**
 * Right pane. Renders run detail (sortable subagent table) when a run
 * is selected, or sub-agent detail (log viewer + findings) when a
 * sub-agent is selected. Focus moves to the heading on selection
 * change so a keyboard user lands inside the new pane.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useQuery } from "@tanstack/react-query";

import { getRun, getSubagent } from "../api";
import type { LogEvent, Subagent, Run, Truncation } from "../types";
import { subscribeLog, type Subscription } from "../ws";
import { LogViewer } from "./LogViewer";
import { RunTable } from "./RunTable";
import { useLiveRegion } from "./LiveRegion";

interface Props {
  selection:
    | { kind: "run"; runId: string }
    | { kind: "subagent"; runId: string; subagentId: string }
    | null;
  onSelectSubagent(runId: string, subagentId: string): void;
}

const MAX_EVENTS_IN_MEMORY = 5_000;

function selectionToKey(s: Props["selection"]): string {
  if (s === null) return "";
  if (s.kind === "run") return `run:${s.runId}`;
  return `sa:${s.runId}:${s.subagentId}`;
}

export function DetailPane({ selection, onSelectSubagent }: Props): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selectionKey = selectionToKey(selection);
  useEffect(() => {
    if (selection !== null) {
      headingRef.current?.focus();
    }
    // selectionKey is a stable string derived from selection, so this
    // effect runs exactly once per selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  if (selection === null) {
    return (
      <section aria-labelledby="empty-heading">
        <h2 id="empty-heading" tabIndex={-1} ref={headingRef}>
          Select a run
        </h2>
        <p>Pick a run from the left rail to see its sub-agents.</p>
      </section>
    );
  }

  if (selection.kind === "run") {
    return (
      <RunDetail
        runId={selection.runId}
        headingRef={headingRef}
        onSelectSubagent={(saId) => onSelectSubagent(selection.runId, saId)}
      />
    );
  }
  return (
    <SubagentDetail
      runId={selection.runId}
      subagentId={selection.subagentId}
      headingRef={headingRef}
    />
  );
}

interface RunDetailProps {
  runId: string;
  headingRef: RefObject<HTMLHeadingElement>;
  onSelectSubagent(subagentId: string): void;
}

function RunDetail(props: RunDetailProps): JSX.Element {
  const { runId, headingRef, onSelectSubagent } = props;
  const q = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: 5_000,
  });

  if (q.isPending) {
    return (
      <section aria-labelledby="run-heading" aria-busy="true">
        <h2 id="run-heading" tabIndex={-1} ref={headingRef}>
          Loading run…
        </h2>
      </section>
    );
  }
  if (q.isError || !q.data) {
    return (
      <section aria-labelledby="run-heading">
        <h2 id="run-heading" tabIndex={-1} ref={headingRef}>
          Run not available
        </h2>
        <p>{q.error ? String(q.error) : "Unknown error."}</p>
      </section>
    );
  }
  const run: Run = q.data.run;
  return (
    <section aria-labelledby="run-heading" className="detail detail--run">
      <h2 id="run-heading" tabIndex={-1} ref={headingRef}>
        {run.dispatcher} — {run.repo ?? "<no repo>"}{" "}
        {run.pr_number !== null ? `PR #${run.pr_number}` : ""}
      </h2>
      <dl className="run-meta">
        <div>
          <dt>Status</dt>
          <dd>{run.status ?? "—"}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{run.branch ?? "—"}</dd>
        </div>
        <div>
          <dt>Worktree</dt>
          <dd title={run.worktree_path ?? undefined}>
            {run.worktree_label ?? "—"}
            {run.worktree_label && run.worktree_label !== "primary" && run.worktree_path
              ? ` · ${run.worktree_path}`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{run.started_at}</dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd>{run.ended_at ?? "—"}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{run.total_findings}</dd>
        </div>
        {run.crashed_reason !== null ? (
          <div>
            <dt>Crashed</dt>
            <dd>{run.crashed_reason}</dd>
          </div>
        ) : null}
      </dl>
      <RunTable
        subagents={q.data.subagents}
        selectedId={null}
        onSelectSubagent={(sa: Subagent) => onSelectSubagent(sa.subagent_id)}
      />
    </section>
  );
}

interface SubagentDetailProps {
  runId: string;
  subagentId: string;
  headingRef: RefObject<HTMLHeadingElement>;
}

function SubagentDetail(props: SubagentDetailProps): JSX.Element {
  const { runId, subagentId, headingRef } = props;
  const live = useLiveRegion();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "disconnected" | "ended">(
    "connecting",
  );
  const subRef = useRef<Subscription | null>(null);

  const detailQ = useQuery({
    queryKey: ["subagent", runId, subagentId],
    queryFn: () => getSubagent(runId, subagentId),
  });

  // Reset and re-subscribe whenever the selected sub-agent changes.
  useEffect(() => {
    setEvents([]);
    setStatus("connecting");
    const s = subscribeLog({
      runId,
      subagentId,
      fromSeq: 0,
      onOpen: () => setStatus("live"),
      onError: (code) => {
        setStatus("disconnected");
        live.announce(`Live tail error: ${code}`, "high");
      },
      onBatch: (batch) => {
        setEvents((prev) => {
          const next = prev.concat(batch);
          if (next.length > MAX_EVENTS_IN_MEMORY) {
            return next.slice(next.length - MAX_EVENTS_IN_MEMORY);
          }
          return next;
        });
        const truncs = batch.filter((e) => e.kind === "gap");
        if (truncs.length > 0) {
          live.announce(
            `${truncs.length} chunk${truncs.length === 1 ? "" : "s"} dropped by retention`,
          );
        }
      },
    });
    subRef.current = s;
    return () => {
      s.close();
      subRef.current = null;
    };
  }, [runId, subagentId, live]);

  const findings = useMemo(
    () => events.filter((e): e is LogEvent & { kind: "finding" } => e.kind === "finding"),
    [events],
  );
  const sa = detailQ.data?.subagent;
  const truncations: Truncation[] = detailQ.data?.truncations ?? [];

  return (
    <section
      aria-labelledby="subagent-heading"
      className="detail detail--subagent"
    >
      <h2 id="subagent-heading" tabIndex={-1} ref={headingRef}>
        {sa ? `${sa.agent}: ${sa.task}` : `Sub-agent ${subagentId}`}
      </h2>
      {sa ? (
        <dl className="sa-meta">
          <div>
            <dt>Status</dt>
            <dd>{sa.status ?? "—"}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{sa.model ?? "—"}</dd>
          </div>
          <div>
            <dt>Stdout</dt>
            <dd>{sa.stdout_bytes} B</dd>
          </div>
          <div>
            <dt>Stderr</dt>
            <dd>{sa.stderr_bytes} B</dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd>{sa.finding_count}</dd>
          </div>
          {truncations.length > 0 ? (
            <div>
              <dt>Truncations</dt>
              <dd>{truncations.length}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <LogViewer events={events} liveStatus={status} />

      <details className="findings-list" open={findings.length > 0}>
        <summary>Findings ({findings.length})</summary>
        <ul>
          {findings.map((f) => (
            <li key={f.seq}>
              <span className="findings-list__sev">
                {String(f.payload.severity ?? "info")}
              </span>{" "}
              <span className="findings-list__dom">
                {String(f.payload.domain ?? "general")}
              </span>{" "}
              <span>
                {typeof f.payload.message === "string"
                  ? f.payload.message
                  : JSON.stringify(f.payload)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
