import { pickBoardArrowColors } from "./board-arrow-colors.js";
import { gradeSquareTones } from "./board-grade-colors.js";

export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

export const DEFAULT_ACCENT = "blue";
export const DEFAULT_BOARD_THEME = "slate";

// The accent presets. Blue is the default and carries no override in
// styles.css; every other name here must have a `:root[data-accent="…"]` block
// (light) and a dark counterpart, each measured to 4.5:1.
export const ACCENT_MODES = Object.freeze([DEFAULT_ACCENT, "amber", "orange"]);

// The board's square colours. Slate is the default and carries no override;
// every other name has a `:root[data-board="…"]` block in styles.css.
export const BOARD_MODES = Object.freeze([DEFAULT_BOARD_THEME, "wood", "classic", "green", "walnut"]);

// The persisted color theme, kept in the shared prefs blob. Writing the blob
// rewrites every other pref as well, so a first paint reads it without writing
// (a never-written blob is the defaults, not an edit), while a user choice
// stores the pick. Read-modify-write keeps the prefs that outlive a reset.
export const PREFS_KEY = "prepforge.prefs";

export function readStoredTheme(storage = globalThis.localStorage) {
  return normalizeTheme(readStoredPrefs(storage).theme);
}

export function readStoredPrefs(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage?.getItem(PREFS_KEY) || "{}") || {};
  } catch (_) {
    return {};
  }
}

// The stored blob is read, not the in-memory prefs, so one pref write keeps
// every other pref that outlives a reset.
export function storeTheme(value, storage = globalThis.localStorage) {
  const theme = normalizeTheme(value);
  try {
    storage.setItem(PREFS_KEY, JSON.stringify({ ...readStoredPrefs(storage), theme }));
  } catch (_) {
    /* storage unavailable: the theme still applies for this session */
  }
  return theme;
}

export function normalizeTheme(value) {
  return THEME_MODES.includes(value) ? value : "system";
}

export function normalizeAccent(value) {
  return ACCENT_MODES.includes(value) ? value : DEFAULT_ACCENT;
}

export function readStoredAccent(storage = globalThis.localStorage) {
  return normalizeAccent(readStoredPrefs(storage).accent);
}

export function systemPrefersDark(matchMedia = globalThis.matchMedia) {
  try {
    return typeof matchMedia === "function" && !!matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (_) {
    return false;
  }
}

export function effectiveTheme(value, matchMedia = globalThis.matchMedia) {
  const theme = normalizeTheme(value);
  return theme === "system" ? (systemPrefersDark(matchMedia) ? "dark" : "light") : theme;
}


const GRADE_TOKEN_OF = Object.freeze({
  good: "--good",
  great: "--great",
  brilliant: "--brilliant",
  inaccuracy: "--inaccuracy",
  mistake: "--warn",
  blunder: "--danger",
  missed: "--missed",
});

function fallbackReadStyles(el) {
  return globalThis.getComputedStyle?.(el) || { getPropertyValue: () => "" };
}

// Derive the two opaque last-move square tones for every semantic grade from
// the active board and theme. No accent token participates in this calculation.
export function applyGradeTones(root, readStyles = fallbackReadStyles) {
  const styles = readStyles(root);
  const light = (styles.getPropertyValue("--square-light") || "").trim();
  const dark = (styles.getPropertyValue("--square-dark") || "").trim();
  const hex = (value) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
  const clear = (group) => {
    root.style.removeProperty?.(`--grade-${group}-light`);
    root.style.removeProperty?.(`--grade-${group}-dark`);
  };
  if (!hex(light) || !hex(dark)) {
    for (const group of Object.keys(GRADE_TOKEN_OF)) clear(group);
    return false;
  }
  let wrote = false;
  for (const [group, token] of Object.entries(GRADE_TOKEN_OF)) {
    const ink = (styles.getPropertyValue(token) || "").trim();
    if (!hex(ink)) {
      clear(group);
      continue;
    }
    const tones = gradeSquareTones(light, dark, ink);
    root.style.setProperty(`--grade-${group}-light`, tones.light);
    root.style.setProperty(`--grade-${group}-dark`, tones.dark);
    wrote = true;
  }
  return wrote;
}

// Undoes the current "system" subscription, if any.
let unfollowSystem = null;

export function applyTheme(value, { root = document.documentElement, matchMedia = globalThis.matchMedia, readStyles = fallbackReadStyles } = {}) {
  const theme = normalizeTheme(value);
  unfollowSystem?.();
  unfollowSystem = null;
  root.dataset.theme = effectiveTheme(theme, matchMedia);
  root.style.colorScheme = theme === "system" ? "light dark" : root.dataset.theme;
  applyGradeTones(root, readStyles);
  if (theme === "system") {
    try {
      const media = matchMedia("(prefers-color-scheme: dark)");
      const update = (event) => {
        root.dataset.theme = event.matches ? "dark" : "light";
        applyGradeTones(root, readStyles);
      };
      media.addEventListener("change", update);
      unfollowSystem = () => media.removeEventListener("change", update);
    } catch (_) {
      /* no matchMedia: stay on the resolved theme */
    }
  }
  return theme;
}

// Applies the accent preset the same way the theme is applied: one attribute
// on <html>, read by the `:root[data-accent="…"]` blocks in styles.css. The
// default writes no attribute, so a user who never picked one keeps the CSS
// default (and a browser with the attribute set by hand cannot get stuck on a
// preset the app does not know).
export function applyAccent(value, { root = document.documentElement } = {}) {
  const accent = normalizeAccent(value);
  if (accent === DEFAULT_ACCENT) delete root.dataset.accent;
  else root.dataset.accent = accent;
  return accent;
}

// Board colours: one attribute on <html>, like the accent. Unknown names fall
// back to the default, so a hand-edited pref cannot leave the board unpainted.
export function applyBoardTheme(value, { root = document.documentElement, readStyles = fallbackReadStyles } = {}) {
  const board = BOARD_MODES.includes(value) ? value : DEFAULT_BOARD_THEME;
  if (board === DEFAULT_BOARD_THEME) delete root.dataset.board;
  else root.dataset.board = board;
  const styles = readStyles(root);
  const light = (styles.getPropertyValue("--square-light") || "").trim();
  const dark = (styles.getPropertyValue("--square-dark") || "").trim();
  if (!light || !dark) return board;
  const alpha = Number.parseFloat(styles.getPropertyValue("--board-arrow-opacity"));
  for (const [role, color] of Object.entries(pickBoardArrowColors(light, dark, Number.isFinite(alpha) ? alpha : 0.56))) {
    root.style.setProperty(`--arrow-${role}`, color);
  }
  applyGradeTones(root, readStyles);
  return board;
}

// The one call the Settings picker makes next round: setAccent("orange").
// Writes the pref (through the shared blob, so the theme and every other pref
// survive) and applies it. The storage and root are injectable for tests.
export function setAccent(value, { storage = globalThis.localStorage, root } = {}) {
  const accent = normalizeAccent(value);
  try {
    storage.setItem(PREFS_KEY, JSON.stringify({ ...readStoredPrefs(storage), accent }));
  } catch (_) {
    /* storage unavailable: the accent still applies for this session */
  }
  return root ? applyAccent(accent, { root }) : applyAccent(accent);
}
