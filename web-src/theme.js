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

export function applyTheme(value, { root = document.documentElement, matchMedia = globalThis.matchMedia } = {}) {
  const theme = normalizeTheme(value);
  root.dataset.themePreference = theme;
  root.dataset.theme = effectiveTheme(theme, matchMedia);
  root.style.colorScheme = theme === "system" ? "light dark" : root.dataset.theme;
  return theme;
}

export function nextTheme(value) {
  const theme = normalizeTheme(value);
  return theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
}

export function themeLabel(value) {
  const theme = normalizeTheme(value);
  return theme[0].toUpperCase() + theme.slice(1);
}
