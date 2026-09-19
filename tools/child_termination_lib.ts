/**
 * child_termination_lib.ts — name WHY a child process was terminated.
 *
 * Hoisted out of `findings_review_post.ts` (STARK-371) when the same defect
 * turned up in `review_post_lib.ts`'s posting path (STARK-6112): that file is
 * imported BY `findings_review_post.ts`, so the helper could not stay where it
 * was without a cycle, and a second divergent copy is how the two spawn paths
 * drifted apart in the first place. Pure — no subprocesses, no I/O.
 */

/**
 * How much of a terminated child's own stderr is carried alongside the cause.
 * Callers slice the message to 400 chars anyway; the cap exists so an ENOBUFS
 * on the *stderr* stream cannot make this function allocate a fresh `maxBuffer`
 * sized string that is thrown away one line later.
 */
export const TERMINATION_STDERR_TAIL = 4000;

/**
 * 120 s — the time bound on every `gh` subprocess the posting path spawns
 * (STARK-6113). Without one, a `gh api --paginate` stalled on a hung connection
 * blocks forever: no cause, no output, no exit — the one termination the rest of
 * this file cannot name, because it never happens.
 *
 * Chosen from a measurement, not guessed (2026-09-19, `gh api
 * repos/O/R/pulls/N/files --paginate --slurp`, the heaviest call class here):
 *
 *   - bifrost#264 —  1.35 MB              → 1.4 s
 *   - bifrost#226 — 855 files, 9 pages, 7.1 MB → 6.7 s  (~0.75 s/page)
 *
 * GitHub caps `/pulls/N/files` at 3000 files = 30 pages, so the worst
 * legitimate paginate extrapolates to ~25 s. 120 s is ~5x that: slow-network
 * headroom without making a genuine hang cost more than two minutes. (The
 * sibling runner in `copilot_land.ts` uses 60 s for single, non-paginated calls.)
 */
export const GH_TIMEOUT_MS_DEFAULT = 120_000;

/** Largest delay a Node timer honours (2^31-1 ms, ~24.8 days). */
export const GH_TIMEOUT_MS_MAX = 2_147_483_647;

/** Env override for {@link GH_TIMEOUT_MS_DEFAULT}, in milliseconds. */
export const GH_TIMEOUT_ENV = "STARK_GH_TIMEOUT_MS";

/**
 * The bound to enforce: `STARK_GH_TIMEOUT_MS` when set, else the default.
 *
 * A set-but-unusable value is a hard error, never a fallback and never "no
 * bound": `0`, a negative, `abc` or `1e3junk` silently meaning "unbounded" is
 * how the hang this exists to stop comes back wearing a config typo's hat, and
 * silently meaning "default" hides that the operator's override did nothing.
 */
export function resolveGhTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GH_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return GH_TIMEOUT_MS_DEFAULT;
  // The ceiling is Node's timer limit: `setTimeout` past 2^31-1 ms fires after
  // 1 ms instead, which would turn "effectively unbounded" into "kill at once".
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0 || Number(raw) > GH_TIMEOUT_MS_MAX) {
    throw new Error(
      `${GH_TIMEOUT_ENV} must be an integer of milliseconds in 1..${GH_TIMEOUT_MS_MAX}, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

/** The spawn-result fields the explanation needs — nothing more, so it is testable. */
export interface TerminationInfo {
  /** `null` = the child was terminated (signal kill / spawn failure), never a real exit code. */
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Explain a TERMINATED child, **cause first**, then its own stderr.
 *
 * A signal kill is otherwise indistinguishable from a crash, and ENOBUFS is the
 * one cause we can name precisely — so name it whenever the child was
 * terminated, NOT only when stderr happens to be empty. A child killed for
 * exceeding maxBuffer keeps whatever it already wrote to stderr; gating on an
 * empty stderr let an unrelated `gh` warning swallow the real cause and put the
 * caller back to reporting `failed (exit null): gh: a warning` on exactly the
 * large PRs this buffer exists for.
 *
 * The ORDER is load-bearing, not cosmetic: every caller interpolates this into
 * an error and slices it to 400 chars, so a cause appended AFTER a chatty
 * child's stderr is swallowed by the truncation — the same defect, relocated.
 * A non-terminated child's stderr is returned untouched.
 *
 * `maxBuffer` is only meaningful to a caller that set one (`spawnSync`); an
 * async `spawn` has no such cap and omits it. `timeoutMs` is the bound the
 * caller enforced: a timeout kill (`ETIMEDOUT`) names it and the env var that
 * moves it, because "killed by signal SIGTERM" sends an operator hunting for
 * whoever sent the signal when the sender was this tool.
 */
export function explainTermination(
  cmd: string,
  sp: TerminationInfo,
  ownStderr: string,
  maxBuffer?: number,
  timeoutMs?: number,
): string {
  if (sp.status !== null) return ownStderr;
  const err = sp.error as NodeJS.ErrnoException | undefined;
  const why = err?.code === "ENOBUFS"
    ? `output exceeded maxBuffer${maxBuffer === undefined ? "" : ` (${maxBuffer} bytes)`}`
    : err?.code === "ETIMEDOUT"
    ? `timed out${timeoutMs === undefined ? "" : ` after ${timeoutMs} ms`} (raise ${GH_TIMEOUT_ENV} to allow longer)`
    : err?.message ?? `killed by signal ${sp.signal ?? "unknown"}`;
  const own = ownStderr.trim();
  return own
    ? `${cmd} was terminated: ${why}; its own stderr follows: ${own.slice(0, TERMINATION_STDERR_TAIL)}`
    : `${cmd} produced no stderr and was terminated: ${why}`;
}
