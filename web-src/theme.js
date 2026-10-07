export const THEME_MODES = Object.freeze(["system", "light", "dark"]);

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
