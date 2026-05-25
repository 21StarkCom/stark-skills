/**
 * End-to-end coverage for plan Phase 5 Task 5 / 4 / 2 / 7:
 *
 *   - Bootstrap-fragment exchange → app mounts.
 *   - Cold load WITHOUT a cookie + WITHOUT a fragment still loads
 *     `/index.html` and the asset bundle (plan §1.5.1 E1).
 *   - Keyboard-only nav reaches the tree + tablist.
 *   - axe scan returns zero violations on the main view.
 *   - `chunk_truncated` records render inline gap markers.
 *   - Sub-agent select → first WebSocket chunk under 2 s.
 *   - 200 % zoom reflows; reduced-motion stops the pulse animation.
 */
import AxeBuilder from "@axe-core/playwright";

import { test, expect } from "./_fixtures";

test("cold load without a cookie or fragment renders the shell + assets", async ({
  page,
  baseURL,
}) => {
  const assetRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith(`${baseURL}/assets/`)) {
      assetRequests.push(req.url());
    }
  });
  const resp = await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  expect(resp).not.toBeNull();
  expect(resp!.status()).toBe(200);
  // The Instructions page is the default fallback when there's no
  // session cookie and no code; that's still a successful shell load
  // — we only assert that the asset bundle didn't 401.
  await page.waitForLoadState("networkidle");
  expect(assetRequests.length).toBeGreaterThan(0);
});

test("bootstrap fragment exchanges + app mounts + axe clean", async ({
  page,
  baseURL,
  bootstrapCode,
}) => {
  await page.goto(`${baseURL}/#b=${bootstrapCode}`);
  // Heading shows up after exchange.
  await expect(page.getByRole("heading", { name: "stark-observability" })).toBeVisible();
  // Fragment stripped from address bar.
  expect(page.url().endsWith("/")).toBeTruthy();
  // axe pass.
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
});

test("keyboard reaches the tree and tablist", async ({ page, baseURL, bootstrapCode }) => {
  await page.goto(`${baseURL}/#b=${bootstrapCode}`);
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // tablist
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  expect(["tab", "treeitem"].includes(focused ?? "")).toBeTruthy();
});

test("subagent select → first WebSocket chunk under 2 s", async ({
  page,
  baseURL,
  bootstrapCode,
  harnessRunId,
  harnessSubagentId,
}) => {
  await page.goto(`${baseURL}/#b=${bootstrapCode}`);
  // Target the harness-seeded run + sub-agent directly so the test is
  // deterministic even when stale historical runs are present in the
  // tree (a bare `.first()` selector would otherwise pick the
  // lexicographically first row with no live emission and never hit
  // the < 2 s latency target).
  const runRow = page.locator(
    `[role="treeitem"].tree-item--run[aria-label*="${harnessRunId.slice(0, 8)}"]`,
  );
  await runRow.first().click();
  const saRow = page.locator(
    `[role="treeitem"].tree-item--subagent[aria-label*="${harnessSubagentId.slice(
      0,
      8,
    )}"]`,
  );
  const start = Date.now();
  await saRow.first().click();
  await page
    .locator(".log-viewer__scroll .log-line, .log-viewer__scroll .gap-marker")
    .first()
    .waitFor();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2_000);
});

test("chunk_truncated renders as a focusable inline gap marker", async ({
  page,
  baseURL,
  bootstrapCode,
  harnessRunId,
  harnessSubagentId,
}) => {
  await page.goto(`${baseURL}/#b=${bootstrapCode}`);
  // Target the harness-seeded run + sub-agent directly so the test is
  // deterministic across parallel runs (the tree may surface multiple
  // historical runs).
  const runRow = page.locator(
    `[role="treeitem"].tree-item--run[aria-label*="${harnessRunId.slice(0, 8)}"]`,
  );
  await runRow.first().click();
  // tree_build.ts encodes a short subagent id into aria-label so the
  // selector matches the exact harness-seeded sub-agent rather than
  // relying on visible text (label is `agent: task` and intentionally
  // omits the id).
  const saRow = page.locator(
    `[role="treeitem"].tree-item--subagent[aria-label*="${harnessSubagentId.slice(
      0,
      8,
    )}"]`,
  );
  await saRow.first().click();
  await page
    .locator('[role="separator"][aria-label*="bytes dropped"]')
    .first()
    .waitFor();
  const marker = page
    .locator('[role="separator"][aria-label*="bytes dropped"]')
    .first();
  await marker.focus();
  expect(await marker.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
});

test("200% zoom reflows and reduced-motion stops the pulse", async ({
  page,
  baseURL,
  bootstrapCode,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 800 });
  await page.goto(`${baseURL}/#b=${bootstrapCode}`);
  await page.waitForLoadState("networkidle");
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(horizontalOverflow).toBe(false);
  // Pulse animation should be `none` under reduced-motion.
  const pulse = page.locator(".pulse").first();
  if (await pulse.count()) {
    const anim = await pulse.evaluate((el) => getComputedStyle(el).animationName);
    expect(anim === "none" || anim === "").toBe(true);
  }
});
