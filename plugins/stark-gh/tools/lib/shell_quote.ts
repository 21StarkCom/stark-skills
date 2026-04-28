// Minimal POSIX-shell tokenizer for --raw-args. It recognizes quoting and
// escaping only; it does not perform expansion, substitution, or globbing.
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;

    let token = "";
    let inSingle = false;
    let inDouble = false;
    while (i < n) {
      const c = input[i]!;
      if (inSingle) {
        if (c === "'") {
          inSingle = false;
          i++;
          continue;
        }
        token += c;
        i++;
        continue;
      }
      if (inDouble) {
        if (c === '"') {
          inDouble = false;
          i++;
          continue;
        }
        if (c === "\\" && i + 1 < n && (input[i + 1] === '"' || input[i + 1] === "\\")) {
          token += input[i + 1]!;
          i += 2;
          continue;
        }
        token += c;
        i++;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === "'") {
        inSingle = true;
        i++;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        token += input[i + 1]!;
        i += 2;
        continue;
      }
      token += c;
      i++;
    }
    if (inSingle || inDouble) {
      throw new Error(`unterminated ${inSingle ? "single" : "double"} quote in --raw-args`);
    }
    out.push(token);
  }
  return out;
}
