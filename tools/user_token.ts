#!/usr/bin/env node
/**
 * user_token CLI — print a GitHub PAT for the active user identity.
 * TypeScript port of `scripts/user_token.py`.
 *
 * Usage:
 *   export GH_TOKEN=$(user_token.ts)
 *   export GH_TOKEN=$(user_token.ts --user secondary)
 *   export GH_TOKEN=$(user_token.ts --user secondary --kind classic)
 *   eval "$(user_token.ts --swap)"
 */

import fs from "node:fs";
import {
  getUserToken,
  resolveKind,
  resolveUser,
  type UserId,
} from "./user_token_lib.ts";

const HELP = `Print a GitHub PAT for the active user identity.

Usage: user_token.ts [--user primary|secondary] [--kind fine|classic|auto] [--swap]

Options:
  --user U     Identity (primary|secondary). Default: STARK_GH_USER or primary
  --kind K     Token kind (fine|classic|auto). Default: STARK_GH_TOKEN_KIND or auto
  --swap       Print export lines that swap STARK_GH_USER (primary↔secondary)
  --help       Show this help
`;

function main(argv: string[]): number {
  let user: string | null = null;
  let kind: string | null = null;
  let swap = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "--swap") {
      swap = true;
    } else if (arg === "--user") {
      user = argv[++i];
    } else if (arg.startsWith("--user=")) {
      user = arg.slice("--user=".length);
    } else if (arg === "--kind") {
      kind = argv[++i];
    } else if (arg.startsWith("--kind=")) {
      kind = arg.slice("--kind=".length);
    } else {
      process.stderr.write(`Error: unknown argument: ${arg}\n`);
      return 2;
    }
  }

  if (swap) {
    const current = resolveUser(null);
    const next: UserId = current === "primary" ? "secondary" : "primary";
    const token = getUserToken(next, resolveKind(kind));
    process.stdout.write(`export STARK_GH_USER=${next}\n`);
    process.stdout.write(`export GH_TOKEN=${token}\n`);
    process.stdout.write(`export GITHUB_TOKEN=${token}\n`);
    process.stderr.write(`# swapped: ${current} -> ${next}\n`);
    return 0;
  }

  process.stdout.write(`${getUserToken(resolveUser(user), resolveKind(kind))}\n`);
  return 0;
}

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(argv1) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
