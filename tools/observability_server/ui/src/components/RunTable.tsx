/**
 * Sortable run-detail table. Columns per plan §9:
 *   sub-agent, agent, model, task, started_at, ended_at, status,
 *   duration, stdout/stderr bytes, finding count.
 *
 * Accessibility: every sortable `<th>` carries `aria-sort` matching the
 * current sort state; the column header itself is a `<button>` so the
 * click target is announced as interactive to ATs.
 */
import { useMemo, useState } from "react";

import type { Subagent } from "../types";

interface Props {
  subagents: Subagent[];
  selectedId: string | null;
  onSelectSubagent(sa: Subagent): void;
}

type SortKey =
  | "agent"
  | "model"
  | "task"
  | "started_at"
  | "ended_at"
  | "status"
  | "duration_ms"
  | "stdout_bytes"
  | "stderr_bytes"
  | "finding_count";

interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "agent", label: "Agent" },
  { key: "model", label: "Model" },
  { key: "task", label: "Task" },
  { key: "started_at", label: "Started" },
  { key: "ended_at", label: "Ended" },
  { key: "status", label: "Status" },
  { key: "duration_ms", label: "Duration" },
  { key: "stdout_bytes", label: "Stdout" },
  { key: "stderr_bytes", label: "Stderr" },
  { key: "finding_count", label: "Findings" },
];

export function RunTable(props: Props): JSX.Element {
  const { subagents, selectedId, onSelectSubagent } = props;
  const [sort, setSort] = useState<SortState>({ key: "started_at", dir: "asc" });

  const sorted = useMemo(() => sortSubagents(subagents, sort), [subagents, sort]);

  function toggle(key: SortKey): void {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  return (
    <table className="run-table" aria-label="Sub-agents in this run">
      <thead>
        <tr>
          <th scope="col">
            <span>Sub-agent</span>
          </th>
          {COLUMNS.map((c) => {
            const isActive = sort.key === c.key;
            return (
              <th
                key={c.key}
                scope="col"
                aria-sort={
                  isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                }
              >
                <button
                  type="button"
                  className="run-table__sort-btn"
                  onClick={() => toggle(c.key)}
                >
                  {c.label}
                  <span className="run-table__sort-ind" aria-hidden="true">
                    {isActive ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </span>
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={COLUMNS.length + 1}>No sub-agents yet.</td>
          </tr>
        ) : null}
        {sorted.map((sa) => {
          const isSel = sa.subagent_id === selectedId;
          return (
            <tr
              key={sa.subagent_id}
              aria-selected={isSel ? true : undefined}
              className={isSel ? "run-table__row--selected" : ""}
              onClick={() => onSelectSubagent(sa)}
            >
              <th scope="row" className="run-table__rowhead">
                <button
                  type="button"
                  className="run-table__sa-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSubagent(sa);
                  }}
                >
                  {shortId(sa.subagent_id)}
                </button>
              </th>
              <td>{sa.agent}</td>
              <td>{sa.model ?? "—"}</td>
              <td>{sa.task}</td>
              <td>{fmtTime(sa.started_at)}</td>
              <td>{sa.ended_at !== null ? fmtTime(sa.ended_at) : "—"}</td>
              <td>{sa.status ?? "—"}</td>
              <td>{sa.duration_ms !== null ? `${sa.duration_ms} ms` : "—"}</td>
              <td>{fmtBytes(sa.stdout_bytes)}</td>
              <td>{fmtBytes(sa.stderr_bytes)}</td>
              <td>{sa.finding_count}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function sortSubagents(rows: Subagent[], sort: SortState): Subagent[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const key = sort.key;
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
  return copy;
}

function fmtTime(iso: string): string {
  return iso.slice(11, 23); // HH:MM:SS.sss
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function shortId(id: string): string {
  if (id.length <= 14) return id;
  return id.slice(0, 6) + "…" + id.slice(-4);
}
