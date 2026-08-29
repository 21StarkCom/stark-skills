/**
 * fact-routing hook — classifier + queue.
 *
 * A `PostToolUse` hook fires when Claude writes a `<project>/memory/<name>.md` auto-memory
 * file. This lib decides whether that fact was mis-stored: a **product-level
 * fleet fact** belongs in the vault-ecosystem corpus, a **repo
 * implementation/invariant** belongs in that repo's own `CLAUDE.md` — either way
 * it is stranded in per-project private memory. When a memory smells class-1
 * (corpus) or class-2 (repo-CLAUDE) the hook appends it to a routing queue for a
 * cheap incremental fold, instead of leaving it to be recovered by an expensive
 * sweep.
 *
 * Full rule: vault-ecosystem/docs/specs/2026-08-29-fact-routing-and-corpus-intake-spec.md
 * (STARK-1781). This is the STARK-1785 safety net.
 *
 * Pure + injectable so the classifier is unit-tested without a real memory tree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Route = "corpus" | "repo-claude";

export interface RoutingFlag {
  route: Route;
  reason: string;
}

export interface QueueEntry extends RoutingFlag {
  ts: string;
  project: string;
  file: string;
  snippet: string;
}

/** The routing queue: append-only JSONL under the Claude home. */
export function defaultQueuePath(home: string = os.homedir()): string {
  return path.join(home, ".claude", ".fact-routing-queue.jsonl");
}

/** Best-effort frontmatter `type:` read — a line scan, no YAML dependency. */
export function frontmatterType(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const fm = content.slice(3, end);
  const m = fm.match(/^\s*type:\s*(\S+)/m);
  return m ? m[1].trim() : undefined;
}

/** Body below the frontmatter (or the whole thing if none). */
export function bodyOf(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const after = content.indexOf("\n", end + 1);
  return after === -1 ? "" : content.slice(after + 1);
}

// Product-level "which thing / when to reach / how the fleet connects" language.
const PRODUCT_LANG =
  /\b(reach for|when to reach|is the|is a |instead of|\bvs\b|owns |routes? to|which (?:tool|repo|thing)|use .{0,30} for|sibling|superseded|the tool for|product-level|capability)\b/i;

// Repo-internal / implementation markers.
const IMPL_MARKERS =
  /(\b(?:internal|cmd|pkg|tools|src|apps|packages)\/|\.(?:ts|go|py|rs|swift)\b|\bCI\b|\bgate\b|\btest(?:s|ing)?\b|\binvariant\b|\bexit code\b|\benv var\b|\bregex\b|\bfrontmatter\b|\blint\b|\bschema\b|\bstruct\b|\bfunction\b|\bmigration\b|\bcompile)/i;

/** Match whole-word fleet slugs present in the text. */
export function fleetSlugsMentioned(text: string, fleetSlugs: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return fleetSlugs.filter((s) => {
    const re = new RegExp(`(^|[^a-z0-9-])${s.toLowerCase()}([^a-z0-9-]|$)`);
    return re.test(lower);
  });
}

/**
 * Classify a just-written memory file. Returns the flag, or null when the fact
 * legitimately belongs in Claude memory (class 3 process/feedback) or carries no
 * routable signal. Errs toward flagging — the fold curates; a missed fact is the
 * failure mode this exists to prevent.
 */
export function classifyMemory(
  content: string,
  filePath: string,
  fleetSlugs: readonly string[],
): RoutingFlag | null {
  if (path.basename(filePath) === "MEMORY.md") return null;

  const type = frontmatterType(content);
  // feedback = how Claude works; user = who the user is. Both belong in memory.
  if (type === "feedback" || type === "user") return null;

  const body = bodyOf(content);
  const slugs = fleetSlugsMentioned(body, fleetSlugs);

  const productLang = PRODUCT_LANG.test(body);
  const impl = IMPL_MARKERS.test(body);

  // class 1 — product-level fleet fact: names a fleet entity AND reads product-
  // level, OR relates two+ fleet entities (a cross-repo relationship).
  if ((slugs.length >= 1 && productLang) || slugs.length >= 2) {
    return {
      route: "corpus",
      reason: `product-level, mentions ${slugs.slice(0, 4).join("/") || "fleet"}${productLang ? " + when-to-reach language" : " (cross-repo)"}`,
    };
  }

  // class 2 — repo implementation/invariant that ended up in memory.
  if (impl && slugs.length >= 1) {
    return { route: "repo-claude", reason: `implementation detail about ${slugs.slice(0, 3).join("/")} — belongs in its CLAUDE.md` };
  }

  return null;
}

export function makeEntry(flag: RoutingFlag, filePath: string, body: string, now: string): QueueEntry {
  const m = filePath.match(/\/projects\/([^/]+)\/memory\//);
  const project = m ? m[1] : "unknown";
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return { ...flag, ts: now, project, file: filePath, snippet };
}

/** Append one JSONL line. Never throws on a normal FS; caller still guards. */
export function appendToQueue(entry: QueueEntry, queuePath: string): void {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, JSON.stringify(entry) + "\n", "utf8");
}

/** Resolve the fleet slug list from a vault-ecosystem checkout, with a fallback. */
export function resolveFleetSlugs(corpusPath: string): string[] {
  const out: string[] = [];
  for (const sub of ["repos", "systems"]) {
    const dir = path.join(corpusPath, sub);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".md")) out.push(f.slice(0, -3));
      }
    } catch {
      /* corpus not present on this machine — fall through to whatever we found */
    }
  }
  return out;
}
