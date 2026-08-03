/**
 * Panel spec parsing + validation for `/stark-jury`.
 *
 * A panel is the set of seats a jury run fans out to, written as a
 * comma-separated list of `seat=model[:effort]` entries:
 *
 *   claude=claude-opus-5:max,codex=gpt-5.6-sol:xhigh,gemini=gemini-3.1-pro-preview
 *
 * Validation is deliberately STRICT and deliberately cheap — it runs before a
 * dispatch that costs dollars and minutes per seat, so a typo must die here
 * rather than after three vendors have billed for it:
 *
 *   - every model id must be present in BOTH config tables
 *     (`DEFAULT_MODEL_RATES` and `DEFAULT_MODEL_LIMITS`, merged with the
 *     global config). An id missing from either is a parse error: the rates
 *     table is what makes the manifest's cost column real and the limits table
 *     is what makes truncation detection real, so a half-known id is a run
 *     that silently reports less than it claims.
 *   - `_fallback` is a table sentinel, not a model — naming it is an error.
 *   - effort is per-vendor. gemini-cli exposes no reasoning-effort knob, so a
 *     gemini seat takes no effort field at all and the manifest records
 *     `effort: n/a` (see `effortForManifest`). Passing one is an error rather
 *     than a silent drop, because a silently-dropped effort makes a run look
 *     controlled when it was not.
 *
 * Every error is collected before throwing: one run of the CLI names every
 * problem in the spec, not just the first.
 *
 * Pure except for the config-table read, which is injectable (`PanelDeps`).
 */

import { getModelLimits, getModelRates } from "./stark_config_lib.ts";

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** Canonical seat order — the order the manifest and reports use, regardless
 *  of the order the seats appear in the spec string. */
export const SEAT_IDS = ["claude", "codex", "gemini"] as const;

export type SeatId = (typeof SEAT_IDS)[number];

/**
 * Per-vendor reasoning-effort surface. `null` = the vendor has no knob.
 *
 *   claude — `--effort <low|medium|high|xhigh|max>` (claude CLI 2.1.220).
 *   codex  — `-c model_reasoning_effort="…"`, one of
 *            minimal|low|medium|high|xhigh (developers.openai.com/codex/
 *            config-reference); codex-cli 0.128.0+ removed the flag form.
 *   gemini — no reasoning-effort knob on gemini-cli.
 */
export const SEAT_EFFORT_LEVELS: Record<SeatId, readonly string[] | null> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  gemini: null,
};

/** What a seat with no effort knob records in the manifest. */
export const EFFORT_NOT_APPLICABLE = "n/a";

/** The table sentinel key — a fallback row, never a dispatchable model. */
const TABLE_FALLBACK_KEY = "_fallback";

/**
 * The default panel (spec decision 2026-08-03: no cheap models — the smoke
 * runs the panel that actually runs). `gemini-3.1-pro-preview` is why T3 adds
 * the gemini rows to both config tables: without them the DEFAULT panel would
 * fail its own validation.
 */
export const DEFAULT_PANEL_SPEC =
  "claude=claude-opus-5:max,codex=gpt-5.6-sol:xhigh,gemini=gemini-3.1-pro-preview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelSeat {
  seat: SeatId;
  model: string;
  /** Resolved effort, or `null` when the vendor has no knob. */
  effort: string | null;
}

export interface Panel {
  seats: PanelSeat[];
}

/** Injectable config tables — tests pin their own without touching `$HOME`. */
export interface PanelDeps {
  rates?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

/** Thrown by `parsePanel`; `errors` carries EVERY problem found, in order. */
export class PanelError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`invalid panel spec:\n  - ${errors.join("\n  - ")}`);
    this.name = "PanelError";
    this.errors = errors;
  }
}

export type PanelResult =
  | { ok: true; panel: Panel }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isSeatId(value: string): value is SeatId {
  return (SEAT_IDS as readonly string[]).includes(value);
}

function knownModelIds(table: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(table).filter((k) => k !== TABLE_FALLBACK_KEY));
}

/** Split one `seat=model[:effort]` entry. The colon binds to the LAST one so a
 *  model id containing a colon would still parse its own way — no current id
 *  does, but the split must be unambiguous either way. */
function splitEntry(value: string): { model: string; effort: string | null } {
  const idx = value.lastIndexOf(":");
  if (idx === -1) return { model: value.trim(), effort: null };
  return {
    model: value.slice(0, idx).trim(),
    effort: value.slice(idx + 1).trim(),
  };
}

/**
 * Parse + validate a panel spec. `spec` empty/absent resolves to
 * `DEFAULT_PANEL_SPEC`. Returns a result object; `parsePanel` is the throwing
 * variant.
 *
 * Seats are returned in canonical `SEAT_IDS` order so the manifest is stable
 * across spec orderings. A panel may name a subset of the seats (a two-seat
 * run when a vendor is down is legitimate). A successful result always carries
 * at least one seat by construction: an empty spec resolves to the default,
 * and every non-empty segment either yields a seat or an error.
 */
export function validatePanelSpec(
  spec?: string | null,
  deps: PanelDeps = {},
): PanelResult {
  const raw = (spec ?? "").trim() === "" ? DEFAULT_PANEL_SPEC : (spec as string).trim();
  const rates = knownModelIds(deps.rates ?? getModelRates());
  const limits = knownModelIds(deps.limits ?? getModelLimits());

  const errors: string[] = [];
  const seen = new Map<SeatId, PanelSeat>();

  for (const segment of raw.split(",")) {
    const entry = segment.trim();
    if (entry === "") {
      errors.push("empty seat entry (stray comma)");
      continue;
    }

    const eq = entry.indexOf("=");
    if (eq === -1) {
      errors.push(`"${entry}": expected seat=model[:effort]`);
      continue;
    }

    const seatRaw = entry.slice(0, eq).trim();
    if (!isSeatId(seatRaw)) {
      errors.push(`"${seatRaw}": unknown seat (expected one of ${SEAT_IDS.join(", ")})`);
      continue;
    }
    const seat: SeatId = seatRaw;
    if (seen.has(seat)) {
      errors.push(`"${seat}": seat named more than once`);
      continue;
    }

    const { model, effort } = splitEntry(entry.slice(eq + 1));
    if (model === "") {
      errors.push(`"${seat}": missing model id`);
      continue;
    }

    // Strict, and it checks BOTH tables: an id present in only one still costs
    // the run either its cost column or its truncation ceiling.
    const missing: string[] = [];
    if (!rates.has(model)) missing.push("model_rates");
    if (!limits.has(model)) missing.push("model_limits");
    if (missing.length > 0) {
      errors.push(
        `"${seat}": unknown model "${model}" — absent from ${missing.join(" and ")} ` +
          `in stark_config_lib.ts (add a sourced row, do not guess)`,
      );
      continue;
    }

    const levels = SEAT_EFFORT_LEVELS[seat];
    if (levels === null) {
      if (effort !== null) {
        errors.push(
          `"${seat}": takes no effort ("${effort}") — the ${seat} CLI exposes no ` +
            `reasoning-effort knob; the manifest records effort: ${EFFORT_NOT_APPLICABLE}`,
        );
        continue;
      }
    } else if (effort !== null) {
      if (effort === "") {
        errors.push(`"${seat}": empty effort after ":" (expected ${levels.join("|")})`);
        continue;
      }
      if (!levels.includes(effort)) {
        errors.push(
          `"${seat}": unknown effort "${effort}" (expected one of ${levels.join(", ")})`,
        );
        continue;
      }
    }

    seen.set(seat, { seat, model, effort });
  }

  if (errors.length > 0) return { ok: false, errors };

  const seats = SEAT_IDS.filter((s) => seen.has(s)).map((s) => seen.get(s) as PanelSeat);
  return { ok: true, panel: { seats } };
}

/** Throwing variant of `validatePanelSpec` — raises `PanelError` carrying
 *  every collected problem. */
export function parsePanel(spec?: string | null, deps: PanelDeps = {}): Panel {
  const result = validatePanelSpec(spec, deps);
  if (!result.ok) throw new PanelError(result.errors);
  return result.panel;
}

/** What the manifest records for a seat's effort: what actually RUNS, not
 *  what the spec string said. An omitted codex effort still dispatches with
 *  the builder's pinned "high" (agent_codex DEFAULT_REASONING_EFFORT — kept in
 *  lockstep by test, not import, to preserve the module boundary); an omitted
 *  claude effort adds no --effort flag, so the CLI's own default applies;
 *  gemini has no knob at all. */
export const CODEX_BUILDER_DEFAULT_EFFORT = "high";
export const EFFORT_CLI_DEFAULT = "cli-default";

export function effortForManifest(seat: PanelSeat): string {
  if (seat.effort !== null) return seat.effort;
  if (seat.seat === "codex") return CODEX_BUILDER_DEFAULT_EFFORT;
  if (seat.seat === "claude") return EFFORT_CLI_DEFAULT;
  return EFFORT_NOT_APPLICABLE;
}

/** Canonical spec string for a panel — round-trips through `parsePanel`. */
export function formatPanel(panel: Panel): string {
  return panel.seats
    .map((s) => `${s.seat}=${s.model}${s.effort === null ? "" : `:${s.effort}`}`)
    .join(",");
}
