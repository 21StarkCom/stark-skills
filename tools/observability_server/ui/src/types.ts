/** HTTP + WebSocket shapes mirrored from `server/runs_api.ts` and
 *  `server/websocket_hub.ts`. The server is the source of truth — if a
 *  shape drifts, fix it here. */

export interface Run {
  run_id: string;
  dispatcher: string;
  repo: string | null;
  branch: string | null;
  pr_number: number | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  last_heartbeat_at: string | null;
  total_subagents: number;
  total_findings: number;
  crashed_reason: string | null;
  parent_pid: number | null;
  writer_daemon_pid: number | null;
  host_boot_id: string | null;
  last_seq: number;
  bytes_written: number;
}

export interface Subagent {
  subagent_id: string;
  agent: string;
  model: string | null;
  task: string;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  duration_ms: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  last_output_at: string | null;
  finding_count: number;
}

export interface RunListResponse {
  items: Run[];
  next_cursor: string | null;
}

export interface RunDetailResponse {
  run: Run;
  subagents: Subagent[];
}

export interface Truncation {
  seq: number;
  ts: string;
  bytes_dropped: number;
  stream: "stdout" | "stderr";
}

export interface SubagentDetailResponse {
  subagent: Subagent;
  summary: unknown;
  truncations: Truncation[];
}

export interface Finding {
  domain?: string;
  severity?: string;
  message?: string;
  [k: string]: unknown;
}

export type StreamKind = "stdout" | "stderr";

export interface ChunkEvent {
  kind: "chunk";
  seq: number;
  ts: string;
  stream: StreamKind;
  encoding: string;
  /** Either a UTF-8 string (encoding == "utf8") or base64 of the bytes. */
  chunk: string;
  subagent_id: string | null;
}

export interface GapEvent {
  kind: "gap";
  seq: number;
  reason: "retention_gap" | "file_missing" | "parse_error" | "synthesis_corrupt";
  bytes_dropped?: number;
  stream?: StreamKind;
  subagent_id?: string | null;
}

export interface FindingEvent {
  kind: "finding";
  seq: number;
  ts: string;
  subagent_id: string | null;
  payload: Finding;
}

export interface LifecycleEvent {
  kind: "lifecycle";
  seq: number;
  ts: string;
  subagent_id: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export type LogEvent = ChunkEvent | GapEvent | FindingEvent | LifecycleEvent;

export interface TreeNode {
  id: string;
  kind: "repo" | "branch" | "pr" | "run" | "subagent";
  label: string;
  ariaLabel?: string;
  status?: string | null;
  children: TreeNode[];
  run?: Run;
  subagent?: Subagent;
  isLive?: boolean;
}
