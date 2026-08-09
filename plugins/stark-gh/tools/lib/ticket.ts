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
  // The project key (e.g. "STARK"). When set, a branch is scanned for THIS key
  // case-insensitively, which is what lets `stark-229-retro` resolve. When
  // absent, only an upper-case key is recognised, because a generic
  // any-case scan turns `feat/fix-2-things` into ticket "FIX-2".
  ticketKey: string | null;
}

export const DEFAULT_TICKET_POLICY: TicketPolicy = {
  requireTicketScope: false,
  ticketKey: null,
};

export const REPO_CONFIG_BASENAME = ".stark-gh.json";

// Reads <repoRoot>/.stark-gh.json. A missing file, unreadable file, malformed
// JSON, or wrong-typed field all fall back to the default policy: a broken
// config must not silently start blocking PRs, nor silently stop.
export function loadTicketPolicy(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  exists: (p: string) => boolean = fs.existsSync,
): { policy: TicketPolicy; warning: string | null } {
  const cfgPath = path.join(repoRoot, REPO_CONFIG_BASENAME);
  if (!exists(cfgPath)) return { policy: DEFAULT_TICKET_POLICY, warning: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(cfgPath));
  } catch (err) {
    return {
      policy: DEFAULT_TICKET_POLICY,
      warning: `${REPO_CONFIG_BASENAME} is not valid JSON (${(err as Error).message}); ticket policy defaults to off`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { policy: DEFAULT_TICKET_POLICY, warning: `${REPO_CONFIG_BASENAME} must be a JSON object; ticket policy defaults to off` };
  }
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];
  let requireTicketScope = DEFAULT_TICKET_POLICY.requireTicketScope;
  if (o.requireTicketScope !== undefined) {
    if (typeof o.requireTicketScope === "boolean") requireTicketScope = o.requireTicketScope;
    else warnings.push("requireTicketScope must be a boolean");
  }
  let ticketKey = DEFAULT_TICKET_POLICY.ticketKey;
  if (o.ticketKey !== undefined) {
    if (typeof o.ticketKey === "string" && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(o.ticketKey)) {
      ticketKey = o.ticketKey.toUpperCase();
    } else {
      warnings.push("ticketKey must be a 2-10 char alphanumeric project key");
    }
  }
  return {
    policy: { requireTicketScope, ticketKey },
    warning: warnings.length ? `${REPO_CONFIG_BASENAME}: ${warnings.join("; ")}` : null,
  };
}

// Generic fallback: an UPPER-CASE key only. `feat/fix-2-things` must not
// resolve to FIX-2 and hand the drafter a fabricated ticket.
const GENERIC_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/;

// Resolves the ticket a branch belongs to, e.g. "worktree-STARK-229" and
// "stark-229-retro" both -> "STARK-229" (the latter only when ticketKey is
// configured). Returns null when nothing recognisable is present.
export function extractTicketFromBranch(branch: string, ticketKey: string | null): string | null {
  if (ticketKey) {
    const re = new RegExp(`\\b${ticketKey}-(\\d+)\\b`, "i");
    const m = re.exec(branch);
    return m ? `${ticketKey.toUpperCase()}-${m[1]}` : null;
  }
  const m = GENERIC_KEY_RE.exec(branch);
  return m ? `${m[1]}-${m[2]}` : null;
}

// The ticket a title already carries, via the same parser the merge side uses
// (draft_schema owns the `type(TICKET-<n>):` shape — one definition, not two).
export function extractTicketFromTitle(title: string): string | null {
  const prefix = extractTicketPrefix(title);
  if (!prefix) return null;
  const inner = /\(([^)]+)\)/.exec(prefix);
  return inner ? inner[1]! : null;
}

// Returns null when the title satisfies the policy, else the rejection reason.
// `ticket` is the expected key when one could be resolved; when it is null the
// title merely has to carry SOME ticket scope.
export function checkTitleTicket(title: string, ticket: string | null): string | null {
  const found = extractTicketFromTitle(title);
  if (!found) {
    const want = ticket ? `${ticket}` : "<TICKET-n>";
    return `title must carry a ticket scope — "type(${want}): subject" (got ${JSON.stringify(title)})`;
  }
  if (ticket && found !== ticket) {
    return `title ticket ${JSON.stringify(found)} does not match the branch's ticket ${JSON.stringify(ticket)} (got ${JSON.stringify(title)})`;
  }
  return null;
}
