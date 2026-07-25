/**
 * plan-to-tasks issue-creation dedup — the BLOCKING BUILD GATE closing the
 * duplicate-issue crash window (`/stark-forge` reconciles a crashed
 * `plan-to-tasks` stage by re-invoking it; without dedup, resume creates a
 * second copy of every issue already created before the crash).
 *
 * Identity is **plan-scoped**, never repository-wide: a task is considered
 * "already created" only when an existing issue carries an exact
 * `<!-- stark-task: {plan_slug}/{task_id} -->` marker for THIS plan's slug.
 * A same-titled task belonging to a different plan must never be suppressed
 * — see `computePlanToTasksDedup`'s doc comment and its test file for the
 * false-positive guard this exists to satisfy.
 *
 * Pure, no network — the caller (`skill/stark-plan-to-tasks/SKILL.md`)
 * fetches this plan's existing issues ONCE via
 * `gh issue list --label "plan:{plan_slug}" --state all --json number,title,body`
 * and passes them in; this module only decides, it never calls `gh`.
 */

// ── Marker ───────────────────────────────────────────────────────────────

/**
 * Build the exact HTML-comment marker stamped into a task issue's body.
 *
 * The marker renders as `{plan_slug}/{task_id}` joined by a literal `/`.
 * The forge token grammar `^[A-Za-z0-9._:=/][A-Za-z0-9._:=/-]*$` permits `/`
 * *inside* both `plan_slug` and `task_id` individually — which means a plain
 * concatenation is NOT injective: `("team", "x/y")` and `("team/x", "y")`
 * both render `team/x/y`, so a marker match could silently attribute one
 * plan's task to a different plan's already-created issue (or vice versa).
 * That is exactly the ambiguity this dedup gate exists to rule out, so `/`
 * is rejected here rather than merely documented as "shouldn't happen" —
 * the field itself must not contain the join delimiter. Reject fails
 * closed (throws) rather than silently escaping, since a silently-escaped
 * marker would still need every past-written issue body to agree on the
 * escaping scheme.
 */
export function buildTaskMarker(planSlug: string, taskId: string): string {
  assertNoDelimiterAmbiguity("plan_slug", planSlug);
  assertNoDelimiterAmbiguity("task_id", taskId);
  return `<!-- stark-task: ${planSlug}/${taskId} -->`;
}

/**
 * Reject a `/` anywhere in a field destined for the `{plan_slug}/{task_id}`
 * marker join — the one character that would make the join ambiguous given
 * the forge grammar allows `/` inside either field. Throws rather than
 * escaping/stripping: silent mutation would let two distinct inputs still
 * collide (or diverge from what the caller believes it stamped).
 */
function assertNoDelimiterAmbiguity(fieldName: "plan_slug" | "task_id", value: string): void {
  if (value.includes("/")) {
    throw new Error(
      `buildTaskMarker: ${fieldName} ${JSON.stringify(value)} contains "/", which is ambiguous in the ` +
        `"{plan_slug}/{task_id}" marker join (e.g. plan_slug="team", task_id="x/y" would render identically ` +
        `to plan_slug="team/x", task_id="y"). Reject or re-slug the value before calling buildTaskMarker.`,
    );
  }
}

/**
 * True iff `body` contains the EXACT marker for `(planSlug, taskId)`.
 * Deliberately a plain substring check on the exact rendered marker string
 * — never a title comparison, never a fuzzy/partial match. This is the one
 * thing standing between a resumed run and duplicate issues, so it must fail
 * closed toward "not a match" rather than toward "looks similar enough".
 */
export function hasTaskMarker(body: string | null | undefined, planSlug: string, taskId: string): boolean {
  if (!body) return false;
  return body.includes(buildTaskMarker(planSlug, taskId));
}

// ── Types ────────────────────────────────────────────────────────────────

/** One row from `gh issue list --label "plan:{plan_slug}" --state all --json number,title,body`. */
export interface ExistingIssueRecord {
  number: number;
  title: string;
  body: string | null;
}

/** One task from the Phase 3 decomposition breakdown, as relevant to dedup. */
export interface PlannedTaskInput {
  task_id: string;
  title: string;
  phase_id?: string;
}

export interface SkippedTask {
  task_id: string;
  title: string;
  issue_number: number;
}

export interface PlanToTasksDedupResult {
  /** Tasks with no existing marker for this plan_slug — must be created. */
  toCreate: PlannedTaskInput[];
  /** Tasks whose marker was already found among this plan's existing issues. */
  toSkip: SkippedTask[];
  /** Issue numbers of every task already present for this plan (the `toSkip` numbers), for merging into the completion-line `issue_numbers` array alongside newly-created numbers. */
  issueNumbers: number[];
}

// ── Decision ─────────────────────────────────────────────────────────────

/**
 * Decide, for each planned task, whether it needs to be created or was
 * already created in a prior (crashed) run of this exact plan.
 *
 * `existingIssues` is expected to already be scoped to this plan via the
 * `plan:{plan_slug}` label query (Phase 1.7 / Phase 5 pre-check) — but this
 * function does NOT rely on that pre-filtering for correctness: it always
 * re-checks the exact `(plan_slug, task_id)` marker itself, so an
 * incorrectly-scoped `existingIssues` list (e.g. a caller bug, or a stray
 * issue from another plan that happens to carry the same label) still can't
 * produce a false positive.
 */
export function computePlanToTasksDedup(
  planSlug: string,
  plannedTasks: readonly PlannedTaskInput[],
  existingIssues: readonly ExistingIssueRecord[],
): PlanToTasksDedupResult {
  const toCreate: PlannedTaskInput[] = [];
  const toSkip: SkippedTask[] = [];

  for (const task of plannedTasks) {
    const match = existingIssues.find((issue) => hasTaskMarker(issue.body, planSlug, task.task_id));
    if (match) {
      toSkip.push({ task_id: task.task_id, title: task.title, issue_number: match.number });
    } else {
      toCreate.push(task);
    }
  }

  return {
    toCreate,
    toSkip,
    issueNumbers: toSkip.map((s) => s.issue_number),
  };
}

/**
 * Merge the dedup's already-present issue numbers with the numbers of
 * issues actually created this run, for the completion-line `issue_numbers`
 * field (`standards/stage-completion-line.md`) — "every issue this plan now
 * has: created this run plus those the dedup pre-check found already
 * present". Order: pre-existing first (stable across resumed runs), then
 * newly created; de-duplicated defensively.
 */
export function mergeIssueNumbers(preExisting: readonly number[], createdThisRun: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of [...preExisting, ...createdThisRun]) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}
