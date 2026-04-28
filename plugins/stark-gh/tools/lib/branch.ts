const SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9/_.#+-]*$/;
const FORBIDDEN_SUBSTRINGS = ["..", "//", "@{"];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateBranchName(name: string): ValidationResult {
  if (!name) return { ok: false, reason: "empty branch name" };
  if (/[\x00-\x1f\x7f]/.test(name)) return { ok: false, reason: "control character" };
  if (name.startsWith("-")) return { ok: false, reason: "leading dash" };
  if (name.endsWith(".lock")) return { ok: false, reason: "trailing .lock" };
  for (const s of FORBIDDEN_SUBSTRINGS) {
    if (name.includes(s)) return { ok: false, reason: `forbidden substring '${s}'` };
  }
  if (!SHAPE.test(name)) {
    return { ok: false, reason: "must match /^[a-zA-Z0-9][a-zA-Z0-9/_.#+-]*$/" };
  }
  return { ok: true };
}
