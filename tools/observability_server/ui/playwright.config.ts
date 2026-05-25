import { defineConfig } from "@playwright/test";

/**
 * Playwright E2E config for the UI. Tests assume:
 *   - The stack is up (loopback) — `docker compose up -d`
 *   - The bootstrap helper has been run once so the operator's
 *     Keychain holds `stark-observability-bootstrap-token`. The
 *     fixtures in `test/e2e/_fixtures.ts` mint a fresh code per test
 *     via `POST /api/auth/bootstrap`.
 *   - A synthetic run from `tools/observability_emit_harness.ts` is
 *     running in the background. The CI invocation in
 *     `test/e2e/_fixtures.ts` spawns it.
 *
 * Override the base URL via OBSERVABILITY_E2E_BASE_URL when the
 * default port is in use.
 */
const baseURL =
  process.env.OBSERVABILITY_E2E_BASE_URL ?? "http://127.0.0.1:7700";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    headless: true,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  reporter: [["list"]],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
