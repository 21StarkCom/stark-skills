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
 * **`alfred task edit --field` HAS landed** — spec nodes T0–T5 are all on alfred
 * `main` (verified 2026-09-19 at `e5c403a`, which carries `internal/fieldschema`,
 * `internal/fieldcache` and the `--field` flag). What may be stale is the
 * `alfred` BINARY on a given machine: one built before those merges rejects the
 * flag through `refuseUnknownFlags` with exit 2 and mutates nothing, so this
 * module reports `ticket fields: skipped (alfred task edit exited 2: … unknown
 * flag --field)`. That skip is rule 1 working, and the remedy is reinstalling
 * alfred — NOT a regression here, and not a missing dependency upstream. The
 * distinction matters: "the flag does not exist" would mean the epic is
 * blocked; "this machine's binary predates it" means run the install.
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
 *     empty. An alfred exit 0 that wrote nothing counts as a skip too — see
 *     `alfredSkipReason`. (The wording is the one idun's `gh pr-open`/
 *     `pr-merge` half — spec node T6 — is specified to print, so that once it
 *     lands one grep finds both repos' skips. It did not exist when this was
 *     written, verified at idun `414c0f7`.)
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
//
// The leading `\b` is load-bearing: without it the match runs INSIDE a longer
// word, so `copilot/21stark-6108-fix` resolves to STARK-6108 and stamps a
// ticket the branch never named. A word boundary before `S` keeps
// `copilot/STARK-6108-x` and `build/stark-42-y` (the `/` and `-` are
// non-word) while refusing `21stark-6108` (digit → letter is no boundary).
// No trailing `\b`: `\d+` is greedy, and demanding one would refuse a
// perfectly workable `STARK-6108b`.
function matchTicket(text: string): string | null {
  const m = text.match(/\bSTARK-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

// alfred's work plane accepts exactly two selector shapes, and only ONE of them
// is case-normalizable (`internal/cli/selector.go`):
//
//   - `workCustomIDShape` = `^STARK-[0-9]+$`, matched CASE-SENSITIVELY — its own
//     comment says `stark-42` "has the wrong case", so a lower-cased handle has
//     to be raised or it is refused locally.
//   - `providerIDShape` = `^[A-Za-z0-9]+$`, a raw ClickUp task id. ClickUp mints
//     those lower-case, and `alfred repo info --json`'s `.ticket` IS one
//     whenever the ticket carries no custom id (`cmd_task.go::refLabel` falls
//     back to `r.ID`, and alfred tests the "space that assigns none" case).
//
// A blanket `.toUpperCase()` therefore fixes the first shape and BREAKS the
// second: `z8znm10hn8` → `Z8ZNM10HN8` still passes `providerIDShape`, so the
// refusal arrives from the live ClickUp read as a 404/401 and the skip line
// blames the provider for a selector this module mangled. Scope the raise to
// the shape that needs it; everything else is passed through verbatim.
const CUSTOM_ID_SHAPE = /^[A-Za-z]+-\d+$/;

function normalizeTicket(raw: string): string {
  const trimmed = raw.trim();
  return CUSTOM_ID_SHAPE.test(trimmed) ? trimmed.toUpperCase() : trimmed;
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
 *
 * The answer is alfred's own handle and is passed back VERBATIM apart from the
 * custom-id case raise (`normalizeTicket`) — `.ticket` is `refLabel(bound)`,
 * which is the raw provider id when the ticket has no custom id.
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
  return trimmed ? normalizeTicket(trimmed) : null;
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
 * An explicit value is taken VERBATIM (trimmed, and case-raised only when it is
 * the custom-id shape — see `normalizeTicket`) rather than regex-matched: the
 * flag is the operator saying which ticket this is, and silently dropping a
 * handle this module does not recognize would write the fields onto whatever
 * the next rung found instead — the wrong ticket, with no sign anything was
 * overridden. `--ticket` also accepts alfred's OTHER legal selector, a raw
 * provider id (`<id|STARK-n>`), which is why the raise is shape-scoped. A
 * present-but-blank `--ticket` (an unset shell variable) is treated as absent,
 * since blank is not a claim.
 */
export function resolveTicketForFields(input: ResolveInput): TicketResolution {
  const explicit = (input.explicit ?? "").trim();
  if (explicit) return { ticket: normalizeTicket(explicit), source: "explicit" };

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
  /**
   * Present when alfred exited 0 having written NOTHING, carrying its own
   * reason. `ok` stays true — the process succeeded — but a caller that says
   * "wrote" on this is making a false claim. See `alfredSkipReason`.
   */
  skipped?: string;
}

/**
 * alfred's own "I did not write these fields" answer, or null when its output
 * carries no such claim.
 *
 * **Exit 0 is not a write.** With `clickup.space_id` unset, `alfred task edit
 * --field` prints `fields: skipped (clickup.space_id unset)` and exits 0 —
 * alfred's spec is explicit that "nothing about fields makes an existing config
 * red" (STARK-6093). Reading that as success is how `ticket fields: wrote
 * pr_url=… pr_state=open` lands over a ticket that got nothing, which is rule
 * 2's silent-skip failure one level deeper: the line is printed, and it lies.
 *
 * Two shapes, and BOTH are read off alfred's real emitters rather than guessed
 * (`alfred/internal/cli/task_fields.go`, verified at `e5c403a`):
 *
 *   1. `--json`'s `fields_skipped`, which is a **STRING** — the struct field is
 *      `Skipped string \`json:"fields_skipped,omitempty"\`` (`:174`), set to
 *      `clickup.FieldsSkippedNoSpaceID` (`:212`). It is NOT an array. The
 *      sibling `fields_skipped_same_value` IS an array and means the opposite
 *      (alfred looked and the value already matched), so the key is read
 *      exactly, never by prefix. An array is still accepted here in case a
 *      later alfred widens the field — the cost is one branch, and the cost of
 *      being wrong is a false "wrote".
 *   2. a `fields: skipped (<why>)` line on either stream. It is emitted as
 *      `cwarn(stderr, "alfred: %s\n", …)` (`:213`), so the real line is
 *      **prefixed** — `alfred: fields: skipped (clickup.space_id unset)` — and
 *      `cwarn` renders through `newPalette(w).warn(...)`, which may wrap it in
 *      ANSI. So the match must not be anchored to the start of the line.
 *
 * Both of those defeated the first cut of this function, which looked for an
 * ARRAY and anchored the line at `^[ \t]*`: it returned null for every shape
 * alfred actually produces, so the false "wrote" it was written to prevent
 * survived behind green tests written against the assumed shape.
 *
 * An EMPTY `fields_set` is deliberately NOT a skip signal: the spec says a
 * same-value re-write journals nothing, and `land` re-runs on the adopt path by
 * design, so reading "nothing changed" as "nothing was written" would report a
 * skip on every healthy second landing.
 */
export function alfredSkipReason(stdout: string, stderr = ""): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") {
      const skipped = (parsed as { fields_skipped?: unknown }).fields_skipped;
      // The real shape: a non-empty string. `omitempty` means the key is absent
      // entirely when nothing was skipped, so presence alone is the signal.
      if (typeof skipped === "string" && skipped.trim()) {
        return `alfred skipped the fields: ${skipped.trim()}`;
      }
      if (Array.isArray(skipped) && skipped.length > 0) {
        return `alfred skipped ${skipped.map((entry) => String(entry)).join(", ")}`;
      }
    }
  } catch {
    // Not JSON — fall through to the text form. An unparseable payload is not
    // itself evidence of a skip.
  }
  // Unanchored: the live line carries alfred's own `alfred: ` prefix and may
  // carry ANSI escapes around it.
  const line = `${stdout}\n${stderr}`.match(/fields:[ \t]*skipped[ \t]*\(([^)]*)\)/);
  return line ? `alfred skipped the fields: ${line[1].trim()}` : null;
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
 * carries on. An exit 0 that alfred itself says wrote nothing comes back as
 * `ok: true` plus `skipped`, so the caller can report the truth.
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

  // Trimmed on the way into the argv, not just in the guard above: a validated
  // ` pr_url ` would otherwise reach alfred as the field name ` pr_url ` and be
  // refused as unknown, blaming the schema for this module's whitespace.
  const args = ["task", "edit"];
  for (const field of fields) {
    args.push("--field", `${field.name.trim()}=${field.value.trim()}`);
  }
  args.push("--json", ticket);

  let result: FieldRunResult;
  try {
    result = run("alfred", args);
  } catch (err) {
    return { ok: false, error: `alfred task edit could not run: ${(err as Error).message}` };
  }
  if (result.code !== 0) {
    // First non-empty line only: alfred's refusals lead with the actionable
    // sentence, and this lands inside a single-line report. BOTH streams are
    // scanned in stderr-first order rather than `stderr || stdout`: a stderr
    // that is non-empty but blank is truthy, and that spelling threw away a
    // real stdout message to report "no output".
    const detail =
      [result.stderr, result.stdout]
        .flatMap((stream) => (stream ?? "").split("\n"))
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "no output";
    // `code` is the exit status, and -1 is this module's documented sentinel
    // for a spawn that never happened. "exited -1" names a status no process
    // has; say what actually went wrong, as the sibling throw path does.
    const how = result.code < 0 ? "could not run" : `exited ${result.code}`;
    return { ok: false, error: `alfred task edit ${how}: ${detail}` };
  }
  const skipped = alfredSkipReason(result.stdout, result.stderr);
  return skipped ? { ok: true, stdout: result.stdout, skipped } : { ok: true, stdout: result.stdout };
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
  // `written.skipped` is an exit 0 that wrote nothing — an unset
  // `clickup.space_id` is the documented case. It is a skip, not a write, and
  // reporting it as one is the whole point of rule 2: a `wrote pr_url=…` line
  // over an untouched ticket is a silent skip that has learned to talk.
  if (!written.ok || written.skipped) {
    return {
      wrote: false,
      ticket: resolution.ticket,
      source: resolution.source,
      fields: names,
      line:
        `ticket fields: skipped (${written.skipped ?? written.error ?? "unknown error"}) — ` +
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
