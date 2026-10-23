export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

// The accent presets. `blue` is the default and carries no override in
// styles.css; every other name here must have a `:root[data-accent="…"]` block
// (light) and a dark counterpart, each measured to 4.5:1.
export const ACCENT_MODES = Object.freeze(["blue", "orange"]);

// The board's square colours. `slate` is the default and carries no override;
// every other name has a `:root[data-board="…"]` block in styles.css.
export const BOARD_MODES = Object.freeze(["slate", "classic", "green", "walnut"]);

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
  return ACCENT_MODES.includes(value) ? value : "blue";
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

// Undoes the current "system" subscription, if any.
let unfollowSystem = null;

export function applyTheme(value, { root = document.documentElement, matchMedia = globalThis.matchMedia } = {}) {
  const theme = normalizeTheme(value);
  unfollowSystem?.();
  unfollowSystem = null;
  root.dataset.theme = effectiveTheme(theme, matchMedia);
  root.style.colorScheme = theme === "system" ? "light dark" : root.dataset.theme;
  if (theme === "system") {
    try {
      const media = matchMedia("(prefers-color-scheme: dark)");
      const update = (event) => { root.dataset.theme = event.matches ? "dark" : "light"; };
      media.addEventListener("change", update);
      unfollowSystem = () => media.removeEventListener("change", update);
    } catch (_) {
      /* no matchMedia: stay on the resolved theme */
    }
  }
  return theme;
}

// Applies the accent preset the same way the theme is applied: one attribute
// on <html>, read by the `:root[data-accent="…"]` blocks in styles.css. Blue is
// the default and writes no attribute, so a user who never picked one keeps the
// CSS default (and a browser with the attribute set by hand cannot get stuck
// on a preset the app does not know).
export function applyAccent(value, { root = document.documentElement } = {}) {
  const accent = normalizeAccent(value);
  if (accent === "blue") delete root.dataset.accent;
  else root.dataset.accent = accent;
  return accent;
}

// Board colours: one attribute on <html>, like the accent. Unknown names fall
// back to the default, so a hand-edited pref cannot leave the board unpainted.
export function applyBoardTheme(value, { root = document.documentElement } = {}) {
  const board = BOARD_MODES.includes(value) ? value : "slate";
  if (board === "slate") delete root.dataset.board;
  else root.dataset.board = board;
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
