/**
 * ticket_fields_lib.ts — write the ticket custom fields a PR-opening path is
 * the authority for, through `alfred task edit --field`.
 *
 * Spec: alfred `docs/specs/2026-09-18-ticket-custom-fields-spec.md` (STARK-6093),
 * node T7 (STARK-6108). Alfred owns the ClickUp field schema; every fleet path
 * that opens a PR stamps the two fields it — and only it — knows at that moment:
 * `pr_url` and `pr_state=open`. Nothing here talks to ClickUp: the whole
 * interface is the `alfred` CLI, which journals the write and delivers it.
 *
 * TWO RULES SHAPE EVERY FUNCTION HERE, and both are the spec's:
 *
 *  1. **A field write never fails the PR verb.** Opening a PR is the caller's
 *     job; stamping a ticket is a courtesy on top of it. So nothing in this
 *     module throws, every failure degrades to a skip, and the caller's exit
 *     code is untouched. A thrown error here would turn "the ticket is missing
 *     a URL" into "the PR was never opened", which is strictly worse.
 *  2. **A skip is VISIBLE.** Every outcome — written, skipped, refused —
 *     renders as exactly one `ticket fields: …` line the caller prints. A
 *     silent skip is indistinguishable from a successful write to everyone
 *     downstream, which is how a whole plane of ticket state quietly stays
 *     empty. (The same wording idun's `gh pr-open`/`pr-merge` half prints, so
 *     one grep finds both repos' skips.)
 *
 * Ticket resolution mirrors the spec's "dependent halves" rule — the identical
 * ladder every caller in every repo runs, so a ticket found by one path is
 * found by all of them:
 *
 *     explicit (`--ticket`) → the branch name → alfred's bound ticket → none
 *
 * Each repo owns its own copy of this rule rather than importing a sibling's:
 * stark-skills and idun do not depend on each other, and the spec chose
 * behavioral equivalence over a shared package.
 */

// ── The injected subprocess seam ────────────────────────────────────────────

/** One finished subprocess. `code` is the exit status; -1 for a spawn failure. */
export interface FieldRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `cmd` with `args` and return its result. NEVER throws — a spawn failure
 * (no `alfred` on PATH, which is the common case on a machine that has not
 * installed it) is reported as a non-zero `code`, because rule 1 above means a
 * missing CLI must degrade to a skip rather than an exception.
 */
export type FieldRun = (cmd: string, args: string[]) => FieldRunResult;

// ── Ticket resolution ───────────────────────────────────────────────────────

/** Where a resolved ticket came from, or why there is none. */
export type TicketSource = "explicit" | "branch" | "repo-info" | "none";

export interface TicketResolution {
  /** `STARK-<n>`, upper-cased, or null when the ladder found nothing. */
  ticket: string | null;
  source: TicketSource;
  /** Present only when `ticket` is null: the one-line why, for the skip line. */
  reason?: string;
}

// Not a module-level /g regex: a global regex carries `lastIndex` across calls,
// so the second caller in a process silently gets a different answer than the
// first. Built per call instead.
function matchTicket(text: string): string | null {
  const m = text.match(/STARK-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * The ticket a branch name declares, or null.
 *
 * `copilot/STARK-6108-fields` → `STARK-6108`. Case-insensitive (a slug may be
 * lower-cased by the caller that derived it) and normalized to upper case,
 * because that is the handle form alfred's custom-id prefix rule matches.
 *
 * FIRST match wins on a branch naming two tickets (`.../STARK-1-and-STARK-2`).
 * That is a deliberate arbitrary choice, not an inferred one: there is no
 * evidence in a branch name for which ticket owns the PR, and refusing would
 * cost the write on a branch that is perfectly workable. Pass `--ticket` to
 * say which.
 */
export function ticketFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return matchTicket(branch);
}

/**
 * The ticket alfred has bound to this session, from `alfred repo info --json`.
 *
 * Reads git, config and the local session record only — never the provider —
 * so it is cheap and offline. Null on every failure shape: alfred absent, a
 * non-zero exit, unparseable stdout, or a `.ticket` that is absent/blank/not a
 * string. Each of those is "no ticket", never an exception.
 */
export function ticketFromRepoInfo(run: FieldRun): string | null {
  let result: FieldRunResult;
  try {
    result = run("alfred", ["repo", "info", "--json"]);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const ticket = (parsed as { ticket?: unknown }).ticket;
  if (typeof ticket !== "string") return null;
  const trimmed = ticket.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export interface ResolveInput {
  /** `--ticket`, when the caller was told outright. Wins over everything. */
  explicit?: string | null;
  /** The PR's head branch, when the caller knows it. */
  branch?: string | null;
  run: FieldRun;
}

/**
 * Walk the ladder: explicit → branch → alfred's bound ticket → none.
 *
 * An explicit value is taken VERBATIM (upper-cased, trimmed) rather than
 * regex-matched: the flag is the operator saying which ticket this is, and
 * silently dropping a handle this module does not recognize would write the
 * fields onto whatever the next rung found instead — the wrong ticket, with no
 * sign anything was overridden. A present-but-blank `--ticket` (an unset shell
 * variable) is treated as absent, since blank is not a claim.
 */
export function resolveTicketForFields(input: ResolveInput): TicketResolution {
  const explicit = (input.explicit ?? "").trim();
  if (explicit) return { ticket: explicit.toUpperCase(), source: "explicit" };

  const fromBranch = ticketFromBranch(input.branch);
  if (fromBranch) return { ticket: fromBranch, source: "branch" };

  const bound = ticketFromRepoInfo(input.run);
  if (bound) return { ticket: bound, source: "repo-info" };

  const branchNote = input.branch ? `branch ${input.branch} names none` : "no branch given";
  return {
    ticket: null,
    source: "none",
    reason: `no ticket (${branchNote}, and alfred reports no bound ticket)`,
  };
}

// ── The write ───────────────────────────────────────────────────────────────

/** One `name=value` pair for `alfred task edit --field`. */
export interface TicketField {
  name: string;
  value: string;
}

export interface WriteResult {
  ok: boolean;
  /** Present when `ok` is false: the one-line why. */
  error?: string;
  /** alfred's own stdout, kept so a caller can report its `fields_skipped`. */
  stdout?: string;
}

/**
 * `alfred task edit --field name=value … --json <ticket>`.
 *
 * Refuses an empty field VALUE before spawning rather than letting alfred
 * refuse it: `--field pr_url=` is exit 2 there, and the interesting case —
 * `landImpl` handing back an empty `html_url` for an adopted PR — deserves a
 * skip line naming the field, not a generic CLI refusal. An empty NAME is
 * refused for the same reason.
 *
 * Never throws. Alfred's own non-zero exits — the `pr_state` ladder refusing a
 * backwards move, a Jira handle, an unknown field — all come back as
 * `ok: false` with alfred's first stderr line, and the caller prints it and
 * carries on.
 */
export function writeTicketFields(
  ticket: string,
  fields: readonly TicketField[],
  run: FieldRun,
): WriteResult {
  if (fields.length === 0) return { ok: false, error: "no fields to write" };
  for (const field of fields) {
    if (!field.name.trim()) return { ok: false, error: "a field name was empty" };
    if (!field.value.trim()) return { ok: false, error: `${field.name} has no value` };
  }

  const args = ["task", "edit"];
  for (const field of fields) args.push("--field", `${field.name}=${field.value}`);
  args.push("--json", ticket);

  let result: FieldRunResult;
  try {
    result = run("alfred", args);
  } catch (err) {
    return { ok: false, error: `alfred task edit could not run: ${(err as Error).message}` };
  }
  if (result.code !== 0) {
    // First non-empty line only: alfred's refusals lead with the actionable
    // sentence, and this lands inside a single-line report.
    const detail =
      (result.stderr || result.stdout)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "no output";
    return { ok: false, error: `alfred task edit exited ${result.code}: ${detail}` };
  }
  return { ok: true, stdout: result.stdout };
}

// ── The one entry point a PR-opening caller uses ────────────────────────────

export interface PrOpenFieldsInput {
  /** `--ticket`, when supplied. */
  explicit?: string | null;
  /** The PR's head branch. */
  branch?: string | null;
  /** The PR's `html_url`, exactly as the create/adopt call reported it. */
  prUrl: string | null | undefined;
  run: FieldRun;
}

export interface PrOpenFieldsReport {
  /** True only when alfred accepted the write. A skip is `false`. */
  wrote: boolean;
  ticket: string | null;
  source: TicketSource;
  /** The field names offered to alfred (`[]` on a skip before the write). */
  fields: string[];
  /** The single line the caller prints. Always starts `ticket fields: `. */
  line: string;
}

/**
 * Resolve the ticket, then stamp `pr_url` and `pr_state=open` on it.
 *
 * Called on BOTH the create and the adopt path of a landing, deliberately.
 * The PR is open either way, so both fields are true either way; alfred
 * journals nothing for a same-value write, so adopting is free; and a re-run
 * repairs a first run whose write failed. Restricting the write to `create`
 * would make the repair impossible — the second run always adopts.
 *
 * Never throws and never signals failure to the caller through anything but
 * the report: the PR verb's exit code is not this function's to move.
 */
export function writePrOpenFields(input: PrOpenFieldsInput): PrOpenFieldsReport {
  const resolution = resolveTicketForFields({
    explicit: input.explicit,
    branch: input.branch,
    run: input.run,
  });
  if (!resolution.ticket) {
    return {
      wrote: false,
      ticket: null,
      source: resolution.source,
      fields: [],
      line: `ticket fields: skipped (${resolution.reason ?? "no ticket"}) — pr_url, pr_state`,
    };
  }

  const prUrl = (input.prUrl ?? "").trim();
  if (!prUrl) {
    // The adopt path hands back `html_url ?? ""`. Writing `pr_url=` would be an
    // alfred exit 2; writing `pr_state=open` alone would leave the ticket
    // claiming an open PR it cannot name, which is worse than no claim at all.
    return {
      wrote: false,
      ticket: resolution.ticket,
      source: resolution.source,
      fields: [],
      line:
        `ticket fields: skipped (the PR reported no URL) — pr_url, pr_state ` +
        `on ${resolution.ticket}`,
    };
  }

  const fields: TicketField[] = [
    { name: "pr_url", value: prUrl },
    { name: "pr_state", value: "open" },
  ];
  const written = writeTicketFields(resolution.ticket, fields, input.run);
  const names = fields.map((f) => f.name);
  if (!written.ok) {
    return {
      wrote: false,
      ticket: resolution.ticket,
      source: resolution.source,
      fields: names,
      line:
        `ticket fields: skipped (${written.error ?? "unknown error"}) — ` +
        `${names.join(", ")} on ${resolution.ticket}`,
    };
  }
  return {
    wrote: true,
    ticket: resolution.ticket,
    source: resolution.source,
    fields: names,
    line:
      `ticket fields: wrote pr_url=${prUrl} pr_state=open on ${resolution.ticket} ` +
      `(ticket from ${resolution.source})`,
  };
}
