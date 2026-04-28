const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function withinBudget(estimated: number, cap: number): boolean {
  return estimated <= cap;
}

export function summarizeDiff(diff: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  const buckets = new Map<string, { plus: number; minus: number }>();
  let currentFile: string | null = null;
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) {
      currentFile = m[2]!;
      buckets.set(currentFile, { plus: 0, minus: 0 });
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) buckets.get(currentFile)!.plus++;
    else if (line.startsWith("-") && !line.startsWith("---")) buckets.get(currentFile)!.minus++;
  }
  return [...buckets.entries()].map(([f, { plus, minus }]) => `${f}: +${plus} -${minus}`).join("\n");
}

export function truncateDiffByFile(diff: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= maxBytes) return { text: diff, truncated: false };
  const lines = diff.split("\n");
  let bytes = 0;
  let lastBoundary = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i]! + "\n", "utf8");
    if (bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    if (lines[i]!.startsWith("diff --git")) lastBoundary = i;
  }
  const kept = lines.slice(0, lastBoundary).join("\n");
  const dropped = lines.slice(lastBoundary).filter(l => l.startsWith("diff --git")).length;
  return { text: kept + `\n[... truncated, ${dropped} more files]`, truncated: true };
}

export function truncateLeading(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const slice = buf.subarray(buf.length - maxBytes);
  return "[... truncated]\n" + slice.toString("utf8");
}
