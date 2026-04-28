import type { ExitCode, MergeExitCode } from "./exit.ts";

export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function printErr(msg: string): void {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
}

export function die(code: ExitCode | MergeExitCode | number, message: string): never {
  printErr(message);
  process.exit(code);
  // unreachable; satisfy TS
  throw new Error("unreachable");
}
