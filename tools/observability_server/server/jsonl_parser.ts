/**
 * Pure JSONL line buffer + parser used by the tailer.
 *
 * The tailer reads a 256-KB buffer from the spool file and feeds the
 * raw bytes to `LineBuffer.push()`. The buffer splits on `\n`, holds
 * any partial trailing line for the next push, and yields
 * `{ line, byteStart, byteEnd }` triples that the tailer parses +
 * emits to the event bus.
 *
 * `byteStart` / `byteEnd` are ABSOLUTE file offsets. The buffer is
 * seeded with the file offset that corresponds to its first byte
 * (`initialOffset`); every subsequent push is assumed to be a
 * contiguous read from where the previous push left off. The tailer
 * enforces this by always reading from `tail_offsets.offset`.
 *
 * Both this module and `parseLine()` are pure (no I/O), keeping the
 * tailer's host logic small + the unit-test surface broad.
 */

export interface RawLine {
  /** UTF-8 contents of the line (no trailing `\n`). */
  line: string;
  /** Absolute file offset of the first byte of `line`. */
  byteStart: number;
  /** Absolute file offset of the trailing newline + 1 (= next-read offset). */
  byteEnd: number;
}

/**
 * Stateful line buffer. Holds a partial trailing line across pushes so
 * a chunk boundary mid-JSON does not split a record.
 */
export class LineBuffer {
  private carry = "";
  /** Absolute file offset that `carry[0]` corresponds to. */
  private carryOffset: number;

  constructor(initialOffset = 0) {
    this.carryOffset = initialOffset;
  }

  /**
   * Feed a chunk of UTF-8 text that is a contiguous read from the file
   * starting where the previous push ended. Returns every complete
   * line discovered, with absolute byte ranges.
   */
  push(chunk: string): RawLine[] {
    this.carry += chunk;
    const out: RawLine[] = [];
    let consumedBytes = 0;
    let i = 0;
    while (true) {
      const nl = this.carry.indexOf("\n", i);
      if (nl === -1) break;
      const line = this.carry.slice(i, nl);
      const lineBytes = Buffer.byteLength(line, "utf8");
      const startOffset = this.carryOffset + consumedBytes;
      out.push({
        line,
        byteStart: startOffset,
        byteEnd: startOffset + lineBytes + 1,
      });
      consumedBytes += lineBytes + 1;
      i = nl + 1;
    }
    if (i > 0) {
      this.carry = this.carry.slice(i);
      this.carryOffset += consumedBytes;
    }
    return out;
  }

  /** Reset state to seek to a new absolute offset (used on in-place
   * rewrite detection: the file shrank or its mtime regressed). */
  reset(absOffset: number): void {
    this.carry = "";
    this.carryOffset = absOffset;
  }

  /** Current absolute file offset of the first carry byte (i.e. the
   * next byte the tailer would read from disk). */
  get nextReadOffset(): number {
    return this.carryOffset + Buffer.byteLength(this.carry, "utf8");
  }

  /** Number of bytes currently held in the partial trailing line. */
  get partialBytes(): number {
    return Buffer.byteLength(this.carry, "utf8");
  }
}

/**
 * Parse a single JSONL line into a record. Returns `null` on parse
 * error so the caller can increment the malformed-JSON counter +
 * surface a `parse_error` event.
 */
export function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a `events-NNNN.jsonl` filename into its rotation index. Returns
 * `null` if the basename does not match the expected pattern. Used by
 * the tailer to extract `rotation_index` from a path observed via
 * chokidar.
 */
export function rotationIndexFromBasename(basename: string): number | null {
  const m = basename.match(/^events-(\d{4,})\.jsonl$/);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
