/**
 * Typed fetch helpers for the HTTP API. All requests carry the session
 * cookie via `credentials: "same-origin"`. JSON responses are typed at
 * the call site.
 */
import type {
  RunListResponse,
  RunDetailResponse,
  SubagentDetailResponse,
} from "./types";

class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    let code: string | undefined;
    try {
      const j = (await resp.json()) as { code?: unknown };
      if (typeof j.code === "string") code = j.code;
    } catch {
      // body wasn't JSON
    }
    throw new ApiError(resp.status, code, `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export interface ListRunsOpts {
  limit?: number;
  status?: string;
  repo?: string;
  dispatcher?: string;
  cursor?: string;
}

export function listRuns(opts: ListRunsOpts = {}): Promise<RunListResponse> {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.status !== undefined) qs.set("status", opts.status);
  if (opts.repo !== undefined) qs.set("repo", opts.repo);
  if (opts.dispatcher !== undefined) qs.set("dispatcher", opts.dispatcher);
  if (opts.cursor !== undefined) qs.set("cursor", opts.cursor);
  const q = qs.toString();
  return fetchJson<RunListResponse>(`/api/runs${q ? `?${q}` : ""}`);
}

export function getRun(runId: string): Promise<RunDetailResponse> {
  return fetchJson<RunDetailResponse>(
    `/api/runs/${encodeURIComponent(runId)}`,
  );
}

export function getSubagent(
  runId: string,
  subagentId: string,
): Promise<SubagentDetailResponse> {
  return fetchJson<SubagentDetailResponse>(
    `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(subagentId)}`,
  );
}

export { ApiError };
