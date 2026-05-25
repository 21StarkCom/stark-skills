/**
 * History tab. WAI-ARIA `role="tablist"` shared with the Live tab.
 * Renders a paginated table of historical runs, filtered by repo +
 * dispatcher + status. Cursor pagination uses the `next_cursor` field
 * the server already emits.
 *
 * Clicking a row opens the run in the Live pane (the parent owns the
 * selection state; the click callback is `onSelectRun(runId)`).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listRuns, type ListRunsOpts } from "../api";
import type { Run, RunListResponse } from "../types";

interface Props {
  onSelectRun(runId: string): void;
}

export function HistoryTab({ onSelectRun }: Props): JSX.Element {
  const [filters, setFilters] = useState<ListRunsOpts>({ limit: 50 });
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const current = cursorStack[cursorStack.length - 1];
  const reqOpts = { ...filters, cursor: current };

  const q = useQuery<RunListResponse>({
    queryKey: ["history", reqOpts],
    queryFn: () => listRuns(reqOpts),
  });

  return (
    <section aria-labelledby="history-heading" className="history">
      <h2 id="history-heading">History</h2>
      <form
        className="history__filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursorStack([undefined]);
        }}
      >
        <label>
          <span>Status</span>
          <select
            value={filters.status ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value === "" ? undefined : e.target.value,
              }))
            }
          >
            <option value="">Any</option>
            <option value="running">Running</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
            <option value="timeout">Timeout</option>
            <option value="crashed">Crashed</option>
          </select>
        </label>
        <label>
          <span>Dispatcher</span>
          <select
            value={filters.dispatcher ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                dispatcher: e.target.value === "" ? undefined : e.target.value,
              }))
            }
          >
            <option value="">Any</option>
            <option value="multi_review">multi_review</option>
            <option value="copilot_dispatch">copilot_dispatch</option>
            <option value="plan_dispatch">plan_dispatch</option>
            <option value="red_team">red_team</option>
            <option value="stark_review_doc">stark_review_doc</option>
            <option value="stark_review">stark_review</option>
            <option value="plan_to_tasks_validate">plan_to_tasks_validate</option>
            <option value="stark-phase-execute">stark-phase-execute</option>
          </select>
        </label>
        <label>
          <span>Repo</span>
          <input
            type="text"
            value={filters.repo ?? ""}
            placeholder="org/repo"
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                repo: e.target.value === "" ? undefined : e.target.value,
              }))
            }
          />
        </label>
        <button type="submit">Apply</button>
      </form>

      {q.isPending ? (
        <p>Loading…</p>
      ) : q.isError || !q.data ? (
        <p>Failed to load history.</p>
      ) : (
        <>
          <table className="history__table" aria-label="Historical runs">
            <thead>
              <tr>
                <th scope="col">Dispatcher</th>
                <th scope="col">Repo</th>
                <th scope="col">PR</th>
                <th scope="col">Started</th>
                <th scope="col">Ended</th>
                <th scope="col">Status</th>
                <th scope="col">Sub-agents</th>
                <th scope="col">Findings</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.length === 0 ? (
                <tr>
                  <td colSpan={8}>No matching runs.</td>
                </tr>
              ) : null}
              {q.data.items.map((r: Run) => (
                <tr
                  key={r.run_id}
                  onClick={() => onSelectRun(r.run_id)}
                  className="history__row"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRun(r.run_id);
                    }
                  }}
                  aria-label={`Open run ${r.run_id}`}
                >
                  <td>{r.dispatcher}</td>
                  <td>{r.repo ?? "—"}</td>
                  <td>{r.pr_number !== null ? `#${r.pr_number}` : "—"}</td>
                  <td>{r.started_at}</td>
                  <td>{r.ended_at ?? "—"}</td>
                  <td>{r.status ?? "—"}</td>
                  <td>{r.total_subagents}</td>
                  <td>{r.total_findings}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav aria-label="History pagination" className="history__pager">
            <button
              type="button"
              disabled={cursorStack.length <= 1}
              onClick={() =>
                setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
              }
            >
              ← Newer
            </button>
            <button
              type="button"
              disabled={q.data.next_cursor === null}
              onClick={() => {
                if (q.data && q.data.next_cursor !== null) {
                  setCursorStack((s) => s.concat(q.data!.next_cursor!));
                }
              }}
            >
              Older →
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
