export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

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
