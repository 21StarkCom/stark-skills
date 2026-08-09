// Ticket-scoped PR titles.
//
// STARK-229 made the squash subject inherit the PR title's `type(TICKET-<n>):`
// prefix — but only when the title had one. Nothing required it to, so a
// `feat: ...` title still merged prefix-less onto main with a green check.
// This module supplies the missing half: resolving the ticket a PR belongs to,
// and deciding whether a title carries it.
//
// Enforcement is PER REPO and opt-in (`.stark-gh.json`). stark-gh also runs
// against Evinced and third-party repos where `STARK-` means nothing, so a
// global default would block merges everywhere the convention does not exist.

import * as fs from "node:fs";
import * as path from "node:path";
import { extractTicketPrefix } from "./draft_schema.ts";

export interface TicketPolicy {
  // Enforce a ticket-scoped title. Default false — see the note above.
  requireTicketScope: boolean;
  // The project key (e.g. "STARK"). REQUIRED when requireTicketScope is true:
  // enforcement needs a key to anchor on, and a keyless generic scan would
  // fabricate tickets out of version tokens like AWS-2 or UTF-8. A branch is
  // scanned for THIS key case-insensitively, which is what lets
  // `stark-229-retro` resolve to STARK-229.
  ticketKey: string | null;
}

export const DEFAULT_TICKET_POLICY: TicketPolicy = {
  requireTicketScope: false,
  ticketKey: null,
};

export const REPO_CONFIG_BASENAME = ".stark-gh.json";

export interface PolicyLoad {
  policy: TicketPolicy;
  // Non-fatal note (e.g. an unknown key). Printed to stderr.
  warning: string | null;
  // Fatal: the config is PRESENT but unusable. A gate that has been opted into
  // must fail CLOSED on a broken config, never silently revert to off — so the
  // caller turns this into a hard refusal, not a warning.
  error: string | null;
}

// Reads <repoRoot>/.stark-gh.json. A MISSING file is off (the convention was
// never opted into). A PRESENT file that is malformed, wrong-shaped, or enables
// enforcement without a ticketKey is a fatal config error — a broken gate must
// block, not silently disappear.
export function loadTicketPolicy(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  exists: (p: string) => boolean = fs.existsSync,
): PolicyLoad {
  const cfgPath = path.join(repoRoot, REPO_CONFIG_BASENAME);
  if (!exists(cfgPath)) return { policy: DEFAULT_TICKET_POLICY, warning: null, error: null };
  const fatal = (msg: string): PolicyLoad => ({ policy: DEFAULT_TICKET_POLICY, warning: null, error: `${REPO_CONFIG_BASENAME}: ${msg}` });

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(cfgPath));
  } catch (err) {
    return fatal(`not valid JSON (${(err as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fatal("must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  if (o.requireTicketScope !== undefined && typeof o.requireTicketScope !== "boolean") {
    return fatal("requireTicketScope must be a boolean");
  }
  const requireTicketScope = o.requireTicketScope === true;

  let ticketKey: string | null = null;
  if (o.ticketKey !== undefined) {
    if (typeof o.ticketKey === "string" && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(o.ticketKey)) {
      ticketKey = o.ticketKey.toUpperCase();
    } else {
      return fatal("ticketKey must be a 2-10 char alphanumeric project key");
    }
  }
  // Enforcement without a key would fall back to a generic scan that fabricates
  // tickets from version tokens — refuse rather than guess.
  if (requireTicketScope && !ticketKey) {
    return fatal('requireTicketScope needs a "ticketKey" (e.g. "STARK") to anchor on');
  }

  const known = new Set(["requireTicketScope", "ticketKey"]);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  const warning = unknown.length ? `${REPO_CONFIG_BASENAME}: ignoring unknown key(s) ${unknown.join(", ")}` : null;
  return { policy: { requireTicketScope, ticketKey }, warning, error: null };
}

// A boundary that, unlike `\b`, treats `_` as a separator (so `feature_STARK-1`
// resolves) while still refusing a key glued to another alphanumeric
// (`XSTARK-1` must not match STARK-1).
const SEP_BEFORE = "(?<![A-Za-z0-9])";
const SEP_AFTER = "(?![A-Za-z0-9])";

// Resolves the ticket a branch belongs to against the configured key, e.g.
// "worktree-STARK-229", "stark-229-retro" and "feature_STARK-229" all ->
// "STARK-229". Returns null when the key is absent from the branch.
//
// A ticketKey is REQUIRED — there is no keyless mode. Passing null returns null
// (nothing to anchor on), which callers treat as unresolved rather than as a
// green light: enforcement paths never reach here without a key (loadTicketPolicy
// makes that a fatal config error).
export function extractTicketFromBranch(branch: string, ticketKey: string | null): string | null {
  if (!ticketKey) return null;
  const re = new RegExp(`${SEP_BEFORE}(${ticketKey})-(\\d+)${SEP_AFTER}`, "i");
  const m = re.exec(branch);
  return m ? `${ticketKey.toUpperCase()}-${m[2]}` : null;
}

// The ticket a title carries, via the same parser the merge side uses
// (draft_schema owns the canonical uppercase `type(TICKET-<n>):` shape — one
// definition, not two). Strict: an uppercase key only, matching what the merge
// side will later require of the squash subject.
export function extractTicketFromTitle(title: string): string | null {
  const prefix = extractTicketPrefix(title);
  if (!prefix) return null;
  const inner = /\(([^)]+)\)/.exec(prefix);
  return inner ? inner[1]! : null;
}

// Returns null when the title satisfies the policy, else the rejection reason.
// `ticket` is the expected key when one could be resolved; when it is null the
// title merely has to carry SOME (uppercase-canonical) ticket scope.
export function checkTitleTicket(title: string, ticket: string | null): string | null {
  const found = extractTicketFromTitle(title);
  if (!found) {
    // Distinguish "no ticket at all" from "right ticket, wrong case" so the
    // message names the actual problem instead of claiming the scope is absent.
    if (ticket) {
      const ci = new RegExp(`\\(\\s*${ticket}\\s*\\)`, "i");
      if (ci.test(title)) {
        return `title ticket must be upper-case ${JSON.stringify(ticket)} — the canonical form the merge step requires (got ${JSON.stringify(title)})`;
      }
    }
    const want = ticket ? `${ticket}` : "<TICKET-n>";
    return `title must carry a ticket scope — "type(${want}): subject" (got ${JSON.stringify(title)})`;
  }
  if (ticket && found !== ticket) {
    return `title ticket ${JSON.stringify(found)} does not match the branch's ticket ${JSON.stringify(ticket)} (got ${JSON.stringify(title)})`;
  }
  return null;
}
