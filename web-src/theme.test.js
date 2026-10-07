import { describe, expect, it, vi } from "vitest";
import { applyTheme, effectiveTheme, normalizeTheme, } from "./theme.js";

describe("theme preferences", () => {
  it("normalizes unknown values to the safe system default", () => {
    expect(normalizeTheme("neon")).toBe("system");
    expect(normalizeTheme("dark")).toBe("dark");
  });

  it("resolves system preference without touching the DOM", () => {
    const dark = () => ({ matches: true });
    const light = () => ({ matches: false });
    expect(effectiveTheme("system", dark)).toBe("dark");
    expect(effectiveTheme("system", light)).toBe("light");
    expect(effectiveTheme("dark", light)).toBe("dark");
  });

  it("applies a normalized data attribute and color scheme", () => {
    const root = { dataset: {}, style: {} };
    expect(applyTheme("dark", { root })).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(applyTheme("bad", { root })).toBe("system");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light dark");
  });

  it("follows OS changes with one listener and detaches when an explicit theme is selected", () => {
    const root = { dataset: {}, style: {} };
    const listeners = new Set();
    const media = { matches: false,
      addEventListener: vi.fn((_, fn) => listeners.add(fn)),
      removeEventListener: vi.fn((_, fn) => listeners.delete(fn)),
    };
    const matchMedia = () => media;
    applyTheme("system", { root, matchMedia });
    applyTheme("system", { root, matchMedia });
    expect(listeners.size).toBe(1);
    for (const fn of listeners) fn({ matches: true });
    expect(root.dataset.theme).toBe("dark");
    for (const fn of listeners) fn({ matches: false });
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset).not.toHaveProperty("themePreference");
    applyTheme("dark", { root, matchMedia });
    expect(listeners.size).toBe(0);
    applyTheme("system", { root, matchMedia });
    expect(listeners.size).toBe(1);
  });
});
