import { appState, boards } from "./state.js";
import { hooks } from "./hooks.js";
import { PREFS_KEY, applyTheme, readStoredPrefs, readStoredTheme, storeTheme } from "../theme.js";
import { fetchLichessProfile } from "../lichess-profile.js";

const DEFAULT_PREFS = {
  theme: "system",
  coordinates: true,
  lastMovePulse: true,
  flipAnim: true,
  moveAnim: true,
  sounds: true,
  bestArrow: true,
  // Live engine on/off, remembered per view: Build shows it inside the
  // Explorer (an eval per candidate), Analyze inside the Evaluation card.
  engineBuild: false,
  engineAnalyze: false,
  // Analysis-layer gate for the Maia3 human model. OFF by default: the Analyze
  // pipeline skips its Maia pass (classifier / human probability / coach
  // intuition / brilliant signals) and no analysis-layer Maia inference runs —
  // Stockfish analysis runs either way. Independent product capabilities that
  // ARE Maia by design (Train Play opponent fallback, Build human-like
  // branches) keep their existing behavior and never consult this.
  // Replaces the old "Detect brilliant moves" toggle: with Maia analysis ON,
  // brilliant signals ride the analysis pipeline.
  maiaAnalysis: false,
  // A guest's pinned Maia rating (a signed-in pin is a server setting).
  maiaRating: null,
};
export const PREF_LABELS = {
  coordinates: "Board coordinates",
  lastMovePulse: "Last-move pulse",
  flipAnim: "Flip animation",
  moveAnim: "Move animation",
  sounds: "Sound effects",
  bestArrow: "Engine best-move arrow",
};

// The stored blob is merged over the defaults, and the theme is normalized in
// place: a hand-written or unknown theme must not survive as `undefined` and
// then fail to match the Settings control it is painted next to.
export function loadPrefs(storage = globalThis.localStorage) {
  return { ...DEFAULT_PREFS, ...readStoredPrefs(storage), theme: readStoredTheme(storage) };
}

export function pref(name) {
  return appState.prefs ? appState.prefs[name] : DEFAULT_PREFS[name];
}

// Analysis-layer gate for the Maia3 human model. When OFF, the Analyze
// pipeline skips its Maia pass and no analysis-layer caller (classifier /
// human probability / coach intuition / brilliant signals) initializes the
// provider or runs inference. Independent product capabilities that ARE Maia
// by design (Train Play opponent fallback, Build human-like branches) keep
// their existing behavior. Stockfish paths never consult this.
export function maiaAnalysisEnabled() {
  return !!pref("maiaAnalysis");
}

export function setPref(name, value) {
  appState.prefs[name] = value;
  if (name === "theme") {
    // One writer for the persisted theme, shared with the rail toggle.
    appState.prefs.theme = storeTheme(value, localStorage);
  } else {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(appState.prefs));
    } catch (_) {
      // ignore storage errors
    }
  }
  applyPref(name);
}

export function applyPref(name) {
  if (name === "theme") {
    applyTheme(pref("theme"));
    syncThemeToggle();
    // Settings owns the full System / Light / Dark control; it must show the
    // rail toggle's pick, whichever control made it.
    hooks.settingsPainted?.();
  }
  if (name === "coordinates") {
    Object.values(boards).forEach((b) => b && b.applyCoordinates && b.applyCoordinates());
  }
  if (name === "bestArrow" && !pref("bestArrow")) {
    Object.values(boards).forEach((b) => {
      if (b && b.setEngineArrow) b.setEngineArrow(null);
      if (b && b.setBetterArrow) b.setBetterArrow(null);
    });
  }
  // Build repaints its inspector when the Maia gate changes; it owns the
  // decision (the coverage tab is the only one that reads this pref).
  hooks.prefApplied?.(name);
}

// Rail (and phone More sheet) theme toggle: flips the effective theme (an
// explicit light/dark choice). Settings keeps the full System / Light / Dark control.
export function syncThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

export function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  setPref("theme", dark ? "light" : "dark");
  hooks.settingsPainted?.();
}

// ---- Maia3 strength resolution ---------------------------------------------------
// A pinned Settings value wins; otherwise AUTO matches the player's own Lichess
// rating (public profile, cached locally for a day); otherwise the model default.
// Personalizes the coach's human-feel reads and the Build → Generate default.
const MAIA_FALLBACK_RATING = 1500; // mirrors engine/maia3-provider DEFAULT_RATING
const MAIA_AUTO_CACHE_KEY = "prepforge.maia_auto_rating";
const MAIA_AUTO_TTL_MS = 24 * 60 * 60 * 1000;

export function effectiveMaiaRating() {
  if (Number.isFinite(appState.maiaRatingPinned)) return appState.maiaRatingPinned;
  if (!appState.signedIn && Number.isFinite(pref("maiaRating"))) return pref("maiaRating");
  if (Number.isFinite(appState.maiaAutoRating)) return appState.maiaAutoRating;
  return MAIA_FALLBACK_RATING;
}

// ---- Stockfish depth resolution -------------------------------------------------
// Settings is the single source of truth for how deep each browser-Stockfish search
// runs — the PER-POSITION search depth, NOT the Build tree's ply depth. Every local
// Stockfish consumer (Engine widget, Position coach, Build → Generate, Coverage
// complete) reads this so the slider in Settings actually steers them. Mirrors the
// Settings slider clamp (1-30) and falls back to 16 when unset.
const STOCKFISH_FALLBACK_DEPTH = 16;
export const STOCKFISH_MIN_DEPTH = 1;
export const STOCKFISH_MAX_DEPTH = 30;

export function effectiveStockfishDepth() {
  const raw = appState.settings && Number(appState.settings.stockfish_depth);
  const depth = Number.isFinite(raw) ? raw : STOCKFISH_FALLBACK_DEPTH;
  return Math.max(STOCKFISH_MIN_DEPTH, Math.min(STOCKFISH_MAX_DEPTH, Math.round(depth)));
}

// Best-effort: resolve the player's strength from the linked Lichess account's public
// profile (CORS-open, no token, one tiny GET a day thanks to the cache). Uses the
// most-played live perf so a blitz player gets their blitz number, not a provisional
// classical one. Failure just leaves AUTO at the fallback — never throws.
export async function refreshAutoMaiaRating() {
  const username = appState.lichessUsername;
  if (!username) {
    appState.maiaAutoRating = null;
    return;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(MAIA_AUTO_CACHE_KEY) || "null");
    if (cached && cached.username === username && Date.now() - cached.at < MAIA_AUTO_TTL_MS) {
      appState.maiaAutoRating = cached.rating;
      hooks.strengthPainted?.();
      return;
    }
  } catch (_) { /* corrupt cache — refetch */ }
  try {
    const profile = await fetchLichessProfile(username);
    if (!Number.isFinite(profile.maiaRating)) return;
    appState.maiaAutoRating = profile.maiaRating;
    try {
      localStorage.setItem(
        MAIA_AUTO_CACHE_KEY,
        JSON.stringify({ username, rating: profile.maiaRating, at: Date.now() }),
      );
    } catch (_) { /* storage full — fine, refetch next time */ }
    hooks.strengthPainted?.();
  } catch (_) { /* offline or blocked — AUTO falls back silently */ }
}
