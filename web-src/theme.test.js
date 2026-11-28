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
import { eagerCss } from "./test-styles-source.js";
import { hexSample, pickBoardArrowColors, rgb, sample } from "./board-arrow-colors.js";

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
  const readStyles = (root) => ({
    getPropertyValue: (name) => (root.dataset.board === "wood"
      ? { "--square-light": "#e6dac5", "--square-dark": "#a98b6d", "--board-arrow-opacity": "0.68" }
      : { "--square-light": "#e2eaf4", "--square-dark": "#8ea4c0", "--board-arrow-opacity": "0.68" })[name],
  });

  it("keeps slate as the default and writes the attribute only for a named board", () => {
    expect(BOARD_MODES).toContain("slate");
    const root = { dataset: {}, style: { setProperty: vi.fn() } };
    expect(applyBoardTheme("wood", { root, readStyles })).toBe("wood");
    expect(root.dataset.board).toBe("wood");
    expect(root.style.setProperty).toHaveBeenCalledWith("--arrow-user", pickBoardArrowColors("#e6dac5", "#a98b6d").user);
    root.style.setProperty.mockClear();
    expect(applyBoardTheme("slate", { root, readStyles })).toBe("slate");
    expect(root.dataset).not.toHaveProperty("board");
    expect(root.style.setProperty.mock.calls).toEqual(
      Object.entries(pickBoardArrowColors("#e2eaf4", "#8ea4c0")).map(([role, color]) => [`--arrow-${role}`, color]));
  });

  it("paints the default for an unknown name instead of leaving the board unstyled", () => {
    const root = { dataset: { board: "classic" }, style: { setProperty: vi.fn() } };
    expect(applyBoardTheme("violet", { root, readStyles })).toBe("slate");
    expect(root.dataset).not.toHaveProperty("board");
  });

  it("selects distinct role and 4-brush colors for custom squares, independent of square order", () => {
    const result = pickBoardArrowColors("#f9d", "#173962");
    expect(Object.keys(result)).toEqual(["user", "engine", "better", "line", "g", "r", "b", "y"]);
    expect(new Set([result.user, result.engine, result.better, result.line]).size).toBe(4);
    expect(new Set([result.g, result.r, result.b, result.y]).size).toBe(4);
    for (const color of Object.values(result)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(pickBoardArrowColors("#173962", "#ff99dd")).toEqual(result);
    expect(pickBoardArrowColors("#101010", "#212121")).not.toEqual(result);
  });


  it("chooses a violet engine brush on green and keeps teal on warm boards", () => {
    const green = pickBoardArrowColors("#eeeed2", "#769656");
    expect(green.engine).toBe("#55109a");
    expect(pickBoardArrowColors("#e6dac5", "#a98b6d").engine).toBe("#00846a");
    expect(pickBoardArrowColors("#f0d9b5", "#b58863").engine).toBe("#00846a");

    const composite = (hex, square, alpha = 0.68) => sample(rgb(hex).map((channel, i) => Math.round(alpha * channel + (1 - alpha) * rgb(square)[i])));
    const abDistance = (a, b) => Math.hypot(a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]);
    const labDistance = (a, b) => Math.hypot(...a.lab.map((value, i) => value - b.lab[i]));
    const darkGround = hexSample("#769656");
    const oldComposite = composite("#38cda3", "#769656");
    const newComposite = composite(green.engine, "#769656");
    const oldContrast = abDistance(oldComposite, darkGround);
    const newContrast = abDistance(newComposite, darkGround);
    expect(newContrast).toBeGreaterThanOrEqual(0.14);
    expect(newContrast).toBeGreaterThan(oldContrast);

    const roleHexes = [green.user, green.engine, green.better, green.line];
    for (const square of ["#eeeed2", "#769656"]) {
      const views = roleHexes.map((hex) => composite(hex, square));
      for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
        expect(labDistance(views[i], views[j])).toBeGreaterThanOrEqual(0.1);
      }
    }
  });

  it("honours the shared overlay alpha passed to the brush fit", () => {
    expect(pickBoardArrowColors("#eeeed2", "#769656", 0.68)).toEqual(pickBoardArrowColors("#eeeed2", "#769656"));
    expect(pickBoardArrowColors("#eeeed2", "#769656", 0.4)).toBeDefined();
  });

  it("has a CSS pair for every named board", () => {
    const css = eagerCss;
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
    expect(applyAccent("amber", { root })).toBe("amber");
    expect(root.dataset.accent).toBe("amber");
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


describe("adaptive grade tone integration", () => {
  function gradeStyles() {
    const values = {
      light: {
        "--good": "#1d8a4f", "--great": "#4a7fb5", "--brilliant": "#2f7fe0",
        "--inaccuracy": "#c98a2b", "--warn": "#b26a00", "--danger": "#c73a2c", "--missed": "#7a5fb8",
      },
      dark: {
        "--good": "#45b97a", "--great": "#8db0da", "--brilliant": "#6d9ff0",
        "--inaccuracy": "#e6bc72", "--warn": "#e0a23a", "--danger": "#ef6b5b", "--missed": "#a992ef",
      },
    };
    return {
      getPropertyValue(name) {
        if (name === "--square-light") return "#eeeed2";
        if (name === "--square-dark") return "#769656";
        if (name === "--board-arrow-opacity") return "0.68";
        return values[this.theme || "light"]?.[name] || "";
      },
    };
  }
  function rootWithStyle() {
    const values = new Map();
    return {
      dataset: {},
      values,
      style: {
        setProperty: (name, value) => values.set(name, String(value)),
        removeProperty: (name) => values.delete(name),
      },
    };
  }

  it("recalculates on system theme changes and does not recolor grades for accent changes", () => {
    const root = rootWithStyle();
    const styles = gradeStyles();
    const readStyles = () => {
      styles.theme = root.dataset.theme || "light";
      return styles;
    };
    const listeners = new Set();
    const media = { matches: false,
      addEventListener: vi.fn((_, fn) => listeners.add(fn)),
      removeEventListener: vi.fn((_, fn) => listeners.delete(fn)),
    };
    applyBoardTheme("green", { root, readStyles });
    applyTheme("system", { root, matchMedia: () => media, readStyles });
    const lightGood = root.values.get("--grade-good-light");
    expect(lightGood).toMatch(/^oklab\(/);
    for (const fn of listeners) fn({ matches: true });
    const darkGood = root.values.get("--grade-good-light");
    expect(darkGood).toMatch(/^oklab\(/);
    expect(darkGood).not.toBe(lightGood);
    const grades = [...root.values.entries()].filter(([name]) => name.startsWith("--grade-"));
    applyAccent("orange", { root });
    expect([...root.values.entries()].filter(([name]) => name.startsWith("--grade-"))).toEqual(grades);
    applyTheme("dark", { root, matchMedia: () => media, readStyles });
  });

  it("clears stale tones when a token is absent or not a computable hex color", () => {
    const root = rootWithStyle();
    const styles = gradeStyles();
    const readStyles = () => styles;
    applyBoardTheme("green", { root, readStyles });
    expect(root.values.has("--grade-good-light")).toBe(true);
    const original = styles.getPropertyValue.bind(styles);
    styles.getPropertyValue = (name) => name === "--good" ? "color-mix(in srgb, red, blue)" : original(name);
    applyBoardTheme("green", { root, readStyles });
    expect(root.values.has("--grade-good-light")).toBe(false);
    expect(root.values.has("--grade-great-light")).toBe(true);
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
