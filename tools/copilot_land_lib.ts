/**
 * copilot_land_lib.ts — pure, individually-testable helpers for the
 * `/stark-copilot` create-or-adopt impl-PR landing flow (#773, the copilot
 * slice of #772). `copilot` is the merge point for the
 * `impl` artifact — it cannot reach `done` without a non-empty
 * `artifact_prs.impl`, so this is a blocking channel.
 *
 * Mirrors the shape established by `write_spec_land_lib.ts`
 * (branch adopt-or-create, never force-push, find-by-branch adopt-or-create
 * PR, draft-by-default) and `red_team_fold_lib.ts::openOrEditFoldPr`
 * (injectable PR side effects so the decision logic is testable without
 * network). Unlike write-spec, copilot's lead roster includes `gemini`, so
 * the lead→App mapping here is its own (write-spec's `appForLead` is total
 * only over `{claude, codex}` — see its own doc comment for why it isn't a
 * shared export).
 *
 * The CLI (`copilot_land.ts`) owns every real git/gh side effect; this module
 * owns the decisions that make the flow idempotent and provable.
 */
import type { AppName } from "./github_app_lib.ts";

// ── Lead → App identity ─────────────────────────────────────────────────────

/**
 * The GitHub App that authors the impl PR/comment for a given copilot lead.
 * Mirrors the table already documented in SKILL.md §4b (`claude`→stark-claude,
 * `codex`→stark-codex, `gemini`→stark-gemini). An unrecognized lead fails
 * closed to `stark-claude` rather than throwing — the landing flow must not
 * crash the run over an already-validated `--lead` value.
 */
export function appForLead(lead: string): AppName {
  if (lead === "codex") return "stark-codex";
  if (lead === "gemini") return "stark-gemini";
  return "stark-claude";
}

// ── Branch naming ────────────────────────────────────────────────────────────

/**
 * Deterministic impl-branch name — no timestamp/random component, so a bare
 * re-invocation with the same inputs always names the SAME branch and can
 * adopt it. Prefers the recorded plan slug (issue-driven / plan-file mode);
 * `fallbackSlug` covers inline mode, where the skill derives a slug from the
 * task description itself.
 */
export function deriveImplBranch(planSlug: string | null | undefined, fallbackSlug: string): string {
  const slug = planSlug && planSlug.trim() ? planSlug.trim() : fallbackSlug;
  return `copilot/${slug}`;
}

// ── Push args (never force) ─────────────────────────────────────────────────

/**
 * The exact `git` argv for landing the impl branch. NEVER includes a force
 * flag — a re-run commits on top (§2g already does this per step) and pushes
 * plain; review threads on an already-open PR must survive. `hasUpstream`
 * selects `-u` (first push) vs a plain push (branch already tracks origin).
 */
export function buildPushArgs(branch: string, hasUpstream: boolean): string[] {
  return hasUpstream ? ["push", "origin", branch] : ["push", "-u", "origin", branch];
}

// ── PR adoption ──────────────────────────────────────────────────────────────

/** The subset of an open-PR object this module reads. */
export interface OpenPr {
  number: number;
  head?: { ref?: string };
  html_url?: string;
  draft?: boolean;
}

/**
 * Pick the open PR whose head branch is `headRef`, or null if none matches.
 * First match wins (GitHub allows only one open PR per head ref). Tolerant of
 * malformed entries (missing `head`/`ref`).
 */
export function pickPrForHead(openPrs: readonly OpenPr[], headRef: string): OpenPr | null {
  for (const pr of openPrs) {
    if (pr && pr.head && pr.head.ref === headRef) return pr;
  }
  return null;
}

// ── Multi-PR union (the `impl` artifact's incremental registry) ─────────────

/**
 * `impl` is the one artifact allowed to accumulate MULTIPLE
 * PRs (copilot may open PR 1, be checkpointed, then later land PR 2 on a
 * different branch/wave). Union, de-duplicated, first-seen order — mirrors
 * `plan_to_tasks_dedup_lib.ts::mergeIssueNumbers` exactly. Re-reporting an
 * already-known number is a harmless no-op, never a conflict or duplicate.
 */
export function mergePrNumbers(known: readonly number[], landed: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of [...known, ...landed]) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ── landImpl: the injectable create-or-adopt decision core ──────────────────

/** One landed/adopted PR. */
export interface LandedPr {
  number: number;
  url: string;
  app: AppName;
  adopted: boolean;
}

export interface LandInput {
  branch: string;
  base: string;
  title: string;
  body: string;
  /** Copilot's `--lead` value (`claude` | `codex` | `gemini`). */
  lead: string;
  /** `--ready`/`--no-draft` — false opens/keeps a draft PR (repo default). */
  ready: boolean;
  /** Whether `branch` already tracks an origin ref (selects push argv). */
  hasUpstream: boolean;
  /** PR numbers already known for this `impl` artifact (from a prior run). */
  knownPrs: readonly number[];
}

export interface LandResult {
  pr: LandedPr;
  /** `mergePrNumbers(knownPrs, [pr.number])` — the complete impl-PR set. */
  prs: number[];
}

/** Injected side effects — the CLI supplies real git/gh; tests stub these. */
export interface LandDeps {
  /** Push the impl branch. NEVER passes a force flag (see `buildPushArgs`). */
  push: () => { ok: boolean; stderr?: string };
  /** List open PRs for the target repo. Auth only — NOT scoped to any one App's authored PRs. */
  listOpenPrs: () => Promise<readonly OpenPr[]>;
  /** Open a fresh PR (only called when no open PR targets `branch`). */
  createPr: (opts: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
    app: AppName;
  }) => Promise<{ number: number; html_url?: string }>;
  /**
   * Mark an adopted PR ready-for-review. Only called on the adopt path when
   * `input.ready` is set AND the adopted PR is currently a draft — mirrors
   * `write_spec_land.ts`'s `gh pr ready` fallback (App tokens cannot call the
   * GraphQL un-draft mutation). Optional so existing stubs/tests that never
   * exercise this branch don't need to supply it.
   */
  markReady?: (prNumber: number) => Promise<{ ok: boolean; stderr?: string }>;
}

/**
 * Create-or-adopt the impl PR for `input.branch`, idempotently:
 *
 *  1. Push (never force — a re-run's new commits go on top of what's already
 *     pushed; a rejected non-ff push is surfaced as a thrown error, never
 *     silently forced).
 *  2. List open PRs and adopt one whose head is `input.branch` if it exists
 *     — `createPr` is NOT called in this path, so a bare re-invocation never
 *     opens a duplicate. When `input.ready` is set and the adopted PR is
 *     still a draft, mark it ready via `deps.markReady` (mirrors
 *     `write_spec_land.ts`'s `gh pr ready` fallback — App tokens cannot
 *     un-draft via the GraphQL mutation). Adopting an already-ready PR with
 *     `--ready` is a harmless no-op (`markReady` is not called); adopting a
 *     draft WITHOUT `--ready` leaves it a draft.
 *  3. Otherwise open a fresh PR, draft by default (`draft: !input.ready`),
 *     authored by the lead's App.
 *  4. Union `input.knownPrs` with the landed/adopted number — re-reporting a
 *     known number is a no-op, never a conflict.
 */
export async function landImpl(input: LandInput, deps: LandDeps): Promise<LandResult> {
  const pushed = deps.push();
  if (!pushed.ok) {
    throw new Error(`copilot_land: push failed: ${pushed.stderr ?? "unknown error"}`);
  }

  const app = appForLead(input.lead);
  const openPrs = await deps.listOpenPrs();
  const existing = pickPrForHead(openPrs, input.branch);

  let pr: LandedPr;
  if (existing) {
    if (input.ready && existing.draft === true) {
      if (!deps.markReady) {
        throw new Error("copilot_land: --ready requires deps.markReady to un-draft the adopted PR");
      }
      const readied = await deps.markReady(existing.number);
      if (!readied.ok) {
        throw new Error(`copilot_land: mark ready failed: ${readied.stderr ?? "unknown error"}`);
      }
    }
    pr = {
      number: existing.number,
      url: existing.html_url ?? "",
      app,
      adopted: true,
    };
  } else {
    const created = await deps.createPr({
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: !input.ready,
      app,
    });
    pr = {
      number: created.number,
      url: created.html_url ?? "",
      app,
      adopted: false,
    };
  }

  return { pr, prs: mergePrNumbers(input.knownPrs, [pr.number]) };
}
