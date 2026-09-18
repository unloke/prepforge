import { describe, expect, it } from "vitest";
import { applyTheme, effectiveTheme, nextTheme, normalizeTheme, themeLabel } from "./theme.js";

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

  it("cycles through system, dark, and light", () => {
    expect(nextTheme("system")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("system");
    expect(themeLabel("system")).toBe("System");
  });
});
