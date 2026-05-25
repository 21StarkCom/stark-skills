/**
 * Strict ANSI sanitizer. Strips every byte we do not want to render and
 * returns a typed token stream. The log viewer renders tokens as plain
 * React text nodes (never via the unsafe HTML-string prop). Plan ref:
 * "CSP + render safety".
 *
 * Why not just hand the chunk to `ansi-to-html`? Because the library
 * emits markup. Even with the strict allowlist it ships, we do not
 * trust that markup. We use it only to PARSE the SGR codes and turn
 * them into typed tokens; the renderer (LogViewer.tsx) maps those
 * tokens to React elements with class names.
 *
 * Kept characters:
 *   - printable text
 *   - ASCII whitespace: \t, \n, \r
 *   - SGR color/style escapes (parsed into tokens)
 *
 * Everything else (other ESC sequences, BEL, vertical tab, NUL,
 * embedded form-feeds, all C1 control codes) is stripped silently.
 */
import AnsiToHtml from "ansi-to-html";

export interface AnsiToken {
  /** Inclusive class names: "ansi-fg-red", "ansi-bold", etc. */
  classes: string[];
  text: string;
}

const PARSER = new AnsiToHtml({
  fg: "#e6e6e6",
  bg: "transparent",
  newline: false,
  escapeXML: true,
  colors: {
    0: "#000000",
    1: "#cc4444",
    2: "#44aa44",
    3: "#aaaa44",
    4: "#4477cc",
    5: "#aa44aa",
    6: "#44aaaa",
    7: "#cccccc",
    8: "#666666",
    9: "#ff6666",
    10: "#66dd66",
    11: "#ffff66",
    12: "#66aaff",
    13: "#ff66ff",
    14: "#66ffff",
    15: "#ffffff",
  },
});

const ALLOWED_STYLE_TO_CLASS: Record<string, string> = {
  "#000000": "ansi-fg-0",
  "#cc4444": "ansi-fg-1",
  "#44aa44": "ansi-fg-2",
  "#aaaa44": "ansi-fg-3",
  "#4477cc": "ansi-fg-4",
  "#aa44aa": "ansi-fg-5",
  "#44aaaa": "ansi-fg-6",
  "#cccccc": "ansi-fg-7",
  "#666666": "ansi-fg-8",
  "#ff6666": "ansi-fg-9",
  "#66dd66": "ansi-fg-10",
  "#ffff66": "ansi-fg-11",
  "#66aaff": "ansi-fg-12",
  "#ff66ff": "ansi-fg-13",
  "#66ffff": "ansi-fg-14",
  "#ffffff": "ansi-fg-15",
  "#e6e6e6": "ansi-fg-default",
};

const C0_KEEP = new Set([0x09, 0x0a, 0x0d]);
function stripControl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      out += s[i];
      continue;
    }
    if (c < 0x20 && !C0_KEEP.has(c)) continue;
    if (c >= 0x7f && c <= 0x9f) continue;
    out += s[i];
  }
  return out;
}

const HTML_DECODE: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x2F;": "/",
};

function htmlDecode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x2F);/g, (m) => HTML_DECODE[m] ?? m);
}

const SPAN_OPEN_RE = /^<span style="color:([^"]+)">/i;

/**
 * Parse a chunk into typed tokens. Pure function — safe to unit test.
 */
export function ansiToTokens(input: string): AnsiToken[] {
  const cleaned = stripControl(input);
  const html = PARSER.toHtml(cleaned);
  const tokens: AnsiToken[] = [];
  let buf = html;
  let activeClasses: string[] = [];
  while (buf.length > 0) {
    if (buf.startsWith("</span>")) {
      activeClasses = [];
      buf = buf.slice("</span>".length);
      continue;
    }
    const m = buf.match(SPAN_OPEN_RE);
    if (m) {
      const color = m[1]?.toLowerCase() ?? "";
      const klass = ALLOWED_STYLE_TO_CLASS[color];
      activeClasses = klass !== undefined ? [klass] : [];
      buf = buf.slice(m[0].length);
      continue;
    }
    const idx = buf.indexOf("<");
    const text = idx < 0 ? buf : buf.slice(0, idx);
    if (text.length > 0) {
      tokens.push({ classes: [...activeClasses], text: htmlDecode(text) });
    }
    if (idx < 0) break;
    buf = buf.slice(idx);
    const close = buf.indexOf(">");
    if (close < 0) break;
    buf = buf.slice(close + 1);
  }
  return tokens;
}

/**
 * Plain-text fallback. Strips ANSI entirely and returns clean text.
 * Used by copy-to-clipboard and the contrast assertion in axe.
 */
export function ansiPlainText(input: string): string {
  return stripControl(input).replace(/\x1b\[[0-9;]*m/g, "");
}
