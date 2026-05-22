// Detect whether a file is natural language (compressible) or code/config (skip).

import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export type FileType = "natural_language" | "code" | "config" | "unknown";

// Extensions that are natural language and compressible.
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".md", ".txt", ".markdown", ".rst", ".typ", ".typst", ".tex",
]);

// Extensions that are code/config and should be skipped.
const SKIP_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".env", ".lock", ".css", ".scss", ".html", ".xml",
  ".sql", ".sh", ".bash", ".zsh", ".go", ".rs", ".java", ".c",
  ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt", ".lua",
  ".dockerfile", ".makefile", ".csv", ".ini", ".cfg",
]);

// Subset of SKIP_EXTENSIONS that classify as config rather than code.
const CONFIG_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
]);

// Patterns that indicate a line is code.
const CODE_PATTERNS: RegExp[] = [
  /^\s*(import |from .+ import |require\(|const |let |var )/,
  /^\s*(def |class |function |async function |export )/,
  /^\s*(if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{)/,
  /^\s*[\}\]\);]+\s*$/, // closing braces/brackets
  /^\s*@\w+/, // decorators/annotations
  /^\s*"[^"]+"\s*:\s*/, // JSON-like key-value
  /^\s*\w+\s*=\s*[{\[("']/, // assignment with literal
];

function isCodeLine(line: string): boolean {
  return CODE_PATTERNS.some((p) => p.test(line));
}

function isJsonContent(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Heuristic: check if content looks like YAML.
function isYamlContent(lines: string[]): boolean {
  const head = lines.slice(0, 30);
  let yamlIndicators = 0;
  for (const line of head) {
    const stripped = line.trim();
    if (stripped.startsWith("---")) {
      yamlIndicators++;
    } else if (/^\w[\w\s]*:\s/.test(stripped)) {
      yamlIndicators++;
    } else if (stripped.startsWith("- ") && stripped.includes(":")) {
      yamlIndicators++;
    }
  }
  const nonEmpty = head.filter((l) => l.trim()).length;
  return nonEmpty > 0 && yamlIndicators / nonEmpty > 0.6;
}

// Classify a file as natural_language, code, config, or unknown.
export function detectFileType(filepath: string): FileType {
  const ext = extname(filepath).toLowerCase();

  if (COMPRESSIBLE_EXTENSIONS.has(ext)) return "natural_language";
  if (SKIP_EXTENSIONS.has(ext)) {
    return CONFIG_EXTENSIONS.has(ext) ? "config" : "code";
  }

  // Extensionless files (like CLAUDE.md without extension, TODO) — check content.
  if (ext === "") {
    let text: string;
    try {
      text = readFileSync(filepath, "utf8");
    } catch {
      return "unknown";
    }

    const lines = text.split(/\r?\n/).slice(0, 50);

    if (isJsonContent(text.slice(0, 10000))) return "config";
    if (isYamlContent(lines)) return "config";

    const codeLines = lines.filter((l) => l.trim() && isCodeLine(l)).length;
    const nonEmpty = lines.filter((l) => l.trim()).length;
    if (nonEmpty > 0 && codeLines / nonEmpty > 0.4) return "code";

    return "natural_language";
  }

  return "unknown";
}

// Return true if the file is natural language and should be compressed.
export function shouldCompress(filepath: string): boolean {
  try {
    if (!statSync(filepath).isFile()) return false;
  } catch {
    return false;
  }
  // Skip backup files.
  if (basename(filepath).endsWith(".original.md")) return false;
  return detectFileType(filepath) === "natural_language";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: node --experimental-strip-types detect.ts <file1> [file2] ...");
    process.exit(1);
  }
  for (const pathStr of args) {
    const fileType = detectFileType(pathStr);
    const compress = shouldCompress(pathStr);
    console.log(`  ${basename(pathStr).padEnd(30)} type=${fileType.padEnd(20)} compress=${compress}`);
  }
}
