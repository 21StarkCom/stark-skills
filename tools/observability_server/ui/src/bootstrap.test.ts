/**
 * Verify the bootstrap module's address-bar strip + framing refusal.
 * Loads bootstrap.ts dynamically per case so we exercise the
 * module-init side effect with a fresh `window.location` each time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalReplaceState: typeof window.history.replaceState;

beforeEach(() => {
  originalReplaceState = window.history.replaceState.bind(window.history);
});

afterEach(() => {
  window.history.replaceState = originalReplaceState;
  vi.resetModules();
  Object.defineProperty(window, "top", { value: window, configurable: true });
});

async function reloadBootstrap(): Promise<typeof import("./bootstrap")> {
  vi.resetModules();
  return await import("./bootstrap");
}

describe("bootstrap", () => {
  it("captures the code from #b=… and strips the fragment", async () => {
    window.history.replaceState({}, "", "/#b=abc.def");
    const spy = vi.fn(originalReplaceState);
    window.history.replaceState = spy;
    const mod = await reloadBootstrap();
    expect(mod.bootstrap.code).toBe("abc.def");
    expect(mod.bootstrap.framed).toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it("returns code=null when there's no fragment", async () => {
    window.history.replaceState({}, "", "/");
    const mod = await reloadBootstrap();
    expect(mod.bootstrap.code).toBeNull();
  });

  it("refuses to read the fragment when framed", async () => {
    window.history.replaceState({}, "", "/#b=stolen");
    // Pretend we're inside a frame.
    Object.defineProperty(window, "top", {
      value: {} as Window,
      configurable: true,
    });
    const mod = await reloadBootstrap();
    expect(mod.bootstrap.framed).toBe(true);
    expect(mod.bootstrap.code).toBeNull();
  });

  it("ignores garbage fragments without throwing", async () => {
    window.history.replaceState({}, "", "/#nothingmatches");
    const mod = await reloadBootstrap();
    expect(mod.bootstrap.code).toBeNull();
    expect(mod.bootstrap.framed).toBe(false);
  });
});
