// Caveman memory compression orchestrator: compress a markdown file with
// Claude, back up the original, validate, and retry targeted fixes.

import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { shouldCompress } from "./detect.ts";
import { validate } from "./validate.ts";

const MAX_RETRIES = 2;
const MAX_FILE_SIZE = 500_000; // 500KB

// Strips an outer ```markdown ... ``` fence wrapping the entire output.
const OUTER_FENCE_REGEX = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n\1\s*$/;

// Filenames that almost certainly hold secrets or PII. Compressing them ships
// raw bytes to the Anthropic API — a third-party data boundary that developers
// on sensitive codebases cannot cross. detect.ts already skips .env by
// extension, but credentials.md / secrets.txt would slip through the
// natural-language filter. This is a hard refuse before read.
const SENSITIVE_BASENAME_REGEX =
  /^(\.env(\..+)?|\.netrc|credentials(\..+)?|secrets?(\..+)?|passwords?(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|authorized_keys|known_hosts|.*\.(pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg))$/i;

const SENSITIVE_PATH_COMPONENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".docker",
]);

const SENSITIVE_NAME_TOKENS = [
  "secret", "credential", "password", "passwd",
  "apikey", "accesskey", "token", "privatekey",
];

// Heuristic denylist for files that must never be shipped to a third-party API.
function isSensitivePath(filepath: string): boolean {
  const name = basename(filepath);
  if (SENSITIVE_BASENAME_REGEX.test(name)) return true;
  const parts = filepath.split(/[/\\]/).map((p) => p.toLowerCase());
  if (parts.some((p) => SENSITIVE_PATH_COMPONENTS.has(p))) return true;
  // Normalize separators so "api-key" and "api_key" both match "apikey".
  const lower = name.toLowerCase().replace(/[_\-\s.]/g, "");
  return SENSITIVE_NAME_TOKENS.some((tok) => lower.includes(tok));
}

// Strip an outer ```markdown ... ``` fence when it wraps the entire output.
function stripLlmWrapper(text: string): string {
  const m = text.match(OUTER_FENCE_REGEX);
  return m ? m[2] : text;
}

// ---------- Claude calls ----------

async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CAVEMAN_MODEL ?? "claude-sonnet-4-5";

  if (apiKey) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) {
      throw new Error(`Anthropic API call failed: ${resp.status} ${await resp.text()}`);
    }
    const data = (await resp.json()) as { content: Array<{ text?: string }> };
    return stripLlmWrapper((data.content[0]?.text ?? "").trim());
  }

  // Fallback: claude CLI (handles desktop auth). execFileSync uses a fixed
  // argument list with no shell — the prompt is passed via stdin, never
  // interpolated into a command string.
  try {
    const out = execFileSync("claude", ["--print"], {
      input: prompt,
      encoding: "utf8",
    });
    return stripLlmWrapper(out.trim());
  } catch (e) {
    const err = e as { stderr?: string };
    throw new Error(`Claude call failed:\n${err.stderr ?? String(e)}`);
  }
}

function buildCompressPrompt(original: string): string {
  return `
Compress this markdown into caveman format.

STRICT RULES:
- Do NOT modify anything inside \`\`\` code blocks
- Do NOT modify anything inside inline backticks
- Preserve ALL URLs exactly
- Preserve ALL headings exactly
- Preserve file paths and commands
- Return ONLY the compressed markdown body — do NOT wrap the entire output in a \`\`\`markdown fence or any other fence. Inner code blocks from the original stay as-is; do not add a new outer fence around the whole file.

Only compress natural language.

TEXT:
${original}
`;
}

function buildFixPrompt(original: string, compressed: string, errors: string[]): string {
  const errorsStr = errors.map((e) => `- ${e}`).join("\n");
  return `You are fixing a caveman-compressed markdown file. Specific validation errors were found.

CRITICAL RULES:
- DO NOT recompress or rephrase the file
- ONLY fix the listed errors — leave everything else exactly as-is
- The ORIGINAL is provided as reference only (to restore missing content)
- Preserve caveman style in all untouched sections

ERRORS TO FIX:
${errorsStr}

HOW TO FIX:
- Missing URL: find it in ORIGINAL, restore it exactly where it belongs in COMPRESSED
- Code block mismatch: find the exact code block in ORIGINAL, restore it in COMPRESSED
- Heading mismatch: restore the exact heading text from ORIGINAL into COMPRESSED
- Do not touch any section not mentioned in the errors

ORIGINAL (reference only):
${original}

COMPRESSED (fix this):
${compressed}

Return ONLY the fixed compressed file. No explanation.
`;
}

// ---------- Core logic ----------

export async function compressFile(filepathArg: string): Promise<boolean> {
  const filepath = resolve(filepathArg);

  if (!existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }
  if (statSync(filepath).size > MAX_FILE_SIZE) {
    throw new Error(`File too large to compress safely (max 500KB): ${filepath}`);
  }

  // Refuse files that look like they contain secrets or PII. Compression ships
  // the raw bytes to the Anthropic API — a third-party boundary — so we fail
  // loudly rather than silently exfiltrate credentials or keys.
  if (isSensitivePath(filepath)) {
    throw new Error(
      `Refusing to compress ${filepath}: filename looks sensitive ` +
        "(credentials, keys, secrets, or known private paths). " +
        "Compression sends file contents to the Anthropic API. " +
        "Rename the file if this is a false positive.",
    );
  }

  console.log(`Processing: ${filepath}`);

  if (!shouldCompress(filepath)) {
    console.log("Skipping (not natural language)");
    return false;
  }

  const originalText = readFileSync(filepath, "utf8");
  const backupPath = join(
    dirname(filepath),
    `${basename(filepath, extname(filepath))}.original.md`,
  );

  if (!originalText.trim()) {
    console.log("❌ Refusing to compress: file is empty or whitespace-only.");
    return false;
  }

  // Refuse if a backup already exists — it may hold important content.
  if (existsSync(backupPath)) {
    console.log(`⚠️ Backup file already exists: ${backupPath}`);
    console.log("The original backup may contain important content.");
    console.log("Aborting to prevent data loss. Please remove or rename the backup file if you want to proceed.");
    return false;
  }

  // Step 1: Compress.
  console.log("Compressing with Claude...");
  let compressed = await callClaude(buildCompressPrompt(originalText));

  if (!compressed.trim()) {
    console.log("❌ Compression aborted: Claude returned an empty response.");
    console.log("   Original file is untouched (no backup created).");
    return false;
  }

  if (compressed.trim() === originalText.trim()) {
    console.log("❌ Compression aborted: output is identical to input.");
    console.log("   Likely causes: Claude refused, returned the prompt verbatim, or the file is");
    console.log("   already in caveman form. Original file is untouched (no backup created).");
    return false;
  }

  // Save the original as backup, then verify the backup readback before
  // touching the input file. If the filesystem dropped bytes, unlink the bad
  // backup and abort instead of leaving a corrupt backup + compressed primary.
  writeFileSync(backupPath, originalText);
  const backupReadback = readFileSync(backupPath, "utf8");
  if (backupReadback !== originalText) {
    console.log(`❌ Backup write verification failed: ${backupPath}`);
    console.log("   In-memory original differs from on-disk backup. Aborting before touching the input file.");
    try {
      unlinkSync(backupPath);
    } catch {
      /* ignore */
    }
    return false;
  }
  writeFileSync(filepath, compressed);

  // Step 2: Validate + retry.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    console.log(`\nValidation attempt ${attempt + 1}`);

    const result = validate(backupPath, filepath);

    if (result.isValid) {
      console.log("Validation passed");
      break;
    }

    console.log("❌ Validation failed:");
    for (const err of result.errors) console.log(`   - ${err}`);

    if (attempt === MAX_RETRIES - 1) {
      // Restore original on failure.
      writeFileSync(filepath, originalText);
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
      console.log("❌ Failed after retries — original restored");
      return false;
    }

    console.log("Fixing with Claude...");
    compressed = await callClaude(buildFixPrompt(originalText, compressed, result.errors));
    writeFileSync(filepath, compressed);
  }

  return true;
}
