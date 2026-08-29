import { execFileSync } from "node:child_process";

// Desktop notification on a terminal watcher result. macOS-only (osascript);
// best-effort — a missing osascript or a headless box is silently a no-op.
// Isolated here so the loops can stub it in tests.
export function notifyDone(summary: { success: number; failure: number; cancelled: number }, pr: number): void {
  try {
    const msg = `PR #${pr}: ${summary.success} success, ${summary.failure} failure, ${summary.cancelled} cancelled`;
    execFileSync("osascript", ["-e", `display notification "${msg.replace(/"/g, "")}" with title "stark-gh"`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best effort only.
  }
}
