import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ACCENT_MODES,
  applyAccent,
  applyBoardTheme,
  applyTheme,
  BOARD_MODES,
  effectiveTheme,
  normalizeAccent,
  normalizeTheme,
  readStoredAccent,
  readStoredPrefs,
  readStoredTheme,
  setAccent,
  storeTheme,
} from "./theme.js";

function fakeStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = String(next); },
    value: () => value,
    parsed: () => JSON.parse(value || "{}"),
  };
}

describe("persisted theme", () => {
  it("reads a stored pick and falls back to system", () => {
    expect(readStoredTheme(fakeStorage(JSON.stringify({ theme: "dark" })))).toBe("dark");
    expect(readStoredTheme(fakeStorage(null))).toBe("system");
    expect(readStoredTheme(fakeStorage("{not json"))).toBe("system");
    expect(readStoredTheme(fakeStorage(JSON.stringify({ theme: "neon" })))).toBe("system");
  });

  it("picker and rail toggle write the one prepforge.prefs theme key", () => {
    const storage = fakeStorage(null);
    expect(storeTheme("light", storage)).toBe("light");
    expect(storage.parsed().theme).toBe("light");
    expect(storeTheme("dark", storage)).toBe("dark");
    expect(storage.parsed().theme).toBe("dark");
    expect(Object.keys(storage.parsed())).toEqual(["theme"]);
  });

  it("keeps the other prefs in the blob", () => {
    const storage = fakeStorage(JSON.stringify({ sounds: false, theme: "system" }));
    storeTheme("dark", storage);
    expect(storage.parsed()).toEqual({ sounds: false, theme: "dark" });
    expect(readStoredPrefs(storage)).toEqual({ sounds: false, theme: "dark" });
  });

  it("normalizes an unknown stored value instead of keeping it", () => {
    const storage = fakeStorage(JSON.stringify({ theme: "neon" }));
    expect(storeTheme("neon", storage)).toBe("system");
    expect(storage.parsed().theme).toBe("system");
  });

  it("still applies a pick when storage is unavailable", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(storeTheme("dark", broken)).toBe("dark");
  });
});

describe("board colour themes", () => {
  it("keeps slate as the default and writes the attribute only for a named board", () => {
    expect(BOARD_MODES).toContain("slate");
    const root = { dataset: {} };
    expect(applyBoardTheme("green", { root })).toBe("green");
    expect(root.dataset.board).toBe("green");
    expect(applyBoardTheme("slate", { root })).toBe("slate");
    expect(root.dataset).not.toHaveProperty("board");
  });

  it("paints the default for an unknown name instead of leaving the board unstyled", () => {
    const root = { dataset: { board: "classic" } };
    expect(applyBoardTheme("violet", { root })).toBe("slate");
    expect(root.dataset).not.toHaveProperty("board");
  });

  it("has a CSS pair for every named board", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    for (const board of BOARD_MODES.filter((name) => name !== "slate")) {
      expect(css).toMatch(new RegExp(`:root\\[data-board="${board}"\\][^{]*\\{[^}]*--square-light`));
    }
  });
});

describe("accent presets", () => {
  it("keeps blue as the default and normalizes an unknown pick", () => {
    expect(ACCENT_MODES).toContain("blue");
    expect(normalizeAccent(undefined)).toBe("blue");
    expect(normalizeAccent("violet")).toBe("blue");
    expect(normalizeAccent("orange")).toBe("orange");
  });

  it("reads the pick from the shared prefs blob", () => {
    expect(readStoredAccent(fakeStorage(JSON.stringify({ accent: "orange" })))).toBe("orange");
    expect(readStoredAccent(fakeStorage(JSON.stringify({ accent: "neon" })))).toBe("blue");
    expect(readStoredAccent(fakeStorage(null))).toBe("blue");
  });

  // Blue is the CSS default, so it writes no attribute: a page that never
  // picked an accent renders exactly as the stylesheet declares it.
  it("writes the attribute only for a non-default pick", () => {
    const root = { dataset: {} };
    expect(applyAccent("orange", { root })).toBe("orange");
    expect(root.dataset.accent).toBe("orange");
    expect(applyAccent("blue", { root })).toBe("blue");
    expect(root.dataset).not.toHaveProperty("accent");
  });

  it("stores the pick beside the theme without dropping the other prefs", () => {
    const storage = fakeStorage(JSON.stringify({ theme: "dark", sounds: false }));
    const root = { dataset: {} };
    expect(setAccent("orange", { storage, root })).toBe("orange");
    expect(storage.parsed()).toEqual({ theme: "dark", sounds: false, accent: "orange" });
    expect(root.dataset.accent).toBe("orange");
    // An unknown value is normalized before it is stored, so a later read
    // matches the control painted next to it.
    expect(setAccent("neon", { storage, root })).toBe("blue");
    expect(storage.parsed().accent).toBe("blue");
    expect(storage.parsed().theme).toBe("dark");
    expect(root.dataset).not.toHaveProperty("accent");
  });

  it("still applies the pick when storage is unavailable", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const root = { dataset: {} };
    expect(setAccent("orange", { storage: broken, root })).toBe("orange");
    expect(root.dataset.accent).toBe("orange");
  });
});

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
