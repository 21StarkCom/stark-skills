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
 * async `spawn` has no such cap and omits it.
 */
export function explainTermination(
  cmd: string,
  sp: TerminationInfo,
  ownStderr: string,
  maxBuffer?: number,
): string {
  if (sp.status !== null) return ownStderr;
  const err = sp.error as NodeJS.ErrnoException | undefined;
  const why = err?.code === "ENOBUFS"
    ? `output exceeded maxBuffer${maxBuffer === undefined ? "" : ` (${maxBuffer} bytes)`}`
    : err?.message ?? `killed by signal ${sp.signal ?? "unknown"}`;
  const own = ownStderr.trim();
  return own
    ? `${cmd} was terminated: ${why}; its own stderr follows: ${own.slice(0, TERMINATION_STDERR_TAIL)}`
    : `${cmd} produced no stderr and was terminated: ${why}`;
}
