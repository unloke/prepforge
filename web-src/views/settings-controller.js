import { START_FEN, appState } from "../core/state.js";
import { activeViewName, api, currentOwnerId, postJson, setStatus, setStatusError } from "../core/api.js";
import { hooks } from "../core/hooks.js";
import { effectiveMaiaRating, pref, setPref } from "../core/prefs.js";
import { showConfirmModal } from "../core/modals.js";
import { engineWidget, applyServerEngineGating } from "../core/engine.js";

// Settings: the lazy view chunk, its readiness gate (two tab clicks can start
// two loads), the section deep link, and the settings actions module that owns
// every read/write of /api/settings. The shell imports the wrappers because
// boot loads settings and the palette opens a section.

let switchView, accountEntry, refreshLichessStatus, startLichessOAuth;
let explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel;

export function createSettingsController(deps) {
  ({ switchView, accountEntry, refreshLichessStatus, startLichessOAuth,
    explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel } = deps);
  // The functions below are module-level and hoisted; the factory only binds
  // the state they share.
  return { preloadSettingsView, ensureSettingsView, loadSettings, whenSettingsReady,
    openSettingsSection, loadSettingsOnce, loadSettingsActions, applySettingsPayload, saveSettings,
    // The view owns both controls; the shell's theme toggle and the account
    // controller repaint them without knowing which view is loaded.
    renderThemeControl: () => settingsView?.renderThemeControl?.(),
    renderStrengthControls: () => settingsView?.renderStrengthControls?.() };
}

// ----- Settings tab — lazy view chunk -----------------------------------------
let settingsModulePromise = null;
export let settingsView = null;

export function preloadSettingsView() {
  if (!settingsModulePromise) {
    settingsModulePromise = import("./settings.js").catch((err) => {
      settingsModulePromise = null;
      throw err;
    });
  }
  return settingsModulePromise;
}

export async function ensureSettingsView() {
  const mod = await preloadSettingsView();
  if (!settingsView) {
    settingsView = mod.createSettingsView({
      appState,
      setStatus,
      saveSettings,
      loadSettings,
      pref,
      setPref,
      effectiveMaiaRating,
      showConfirmModal,
      api,
      postJson,
      startLichessOAuth,
      onAccountsChanged: () => {
        void refreshLichessStatus();
      },
      signOut: () => accountEntry.accountService().signOut(),
      openAuthModal: (mode, options) => accountEntry.openAuthModal(mode, options),
      refreshAuthStatus: () => accountEntry.refreshAuthStatus(),
    });
    settingsView.bind();
  }
  return settingsView;
}

// Every in-flight loadSettings() (a tab click can start two). whenSettingsReady()
// waits until none remain, i.e. the Settings view is bound and fully rendered.
export const settingsLoads = new Set();

export function loadSettings() {
  const load = loadSettingsOnce().finally(() => settingsLoads.delete(load));
  settingsLoads.add(load);
  return load;
}

export async function whenSettingsReady() {
  const view = await ensureSettingsView();
  while (settingsLoads.size) await Promise.allSettled([...settingsLoads]);
  return view;
}

// Open Settings through its tab (same path as a rail click) and jump to a
// section once the view is ready — no fixed delay.
export async function openSettingsSection(sectionId) {
  const tab = document.querySelector('.tab[data-view="settings"]');
  if (tab) tab.click();
  else switchView("settings");
  await whenSettingsReady();
  const link = document.querySelector(`.settings-nav-link[href="#${sectionId}"]`);
  if (link) {
    link.click();
    return;
  }
  // A block inside a card (Chess accounts lives in Account): open that card.
  // Scrolling the block itself to the top pushed the card's own top off the
  // screen, and the strip's scroll spy then marked the next card down (the
  // deep link said Account, the strip said Board).
  const card = document.getElementById(sectionId)?.closest(".card[id]");
  if (card) document.querySelector(`.settings-nav-link[href="#${card.id}"]`)?.click();
}

let settingsActionsPromise = null;
function loadSettingsActions() {
  settingsActionsPromise ||= import("../settings-actions.js").then(({ createSettingsActions }) => createSettingsActions({
    appState, currentOwnerId, ensureSettingsView, api, applySettingsPayload,
    applyServerEngineGating, setStatusError, getPositionCoach: () => hooks.analyzeSession?.()?.positionCoach, engineWidget,
    activeViewName, explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
  })).catch((error) => { settingsActionsPromise = null; throw error; });
  return settingsActionsPromise;
}

export async function loadSettingsOnce() {
  return (await loadSettingsActions()).loadSettingsOnce();
}

// Fold a /api/settings payload into state: the blob itself, the server-engine flag,
// and the pinned Maia rating (null = AUTO). Shared by init, loadSettings and saves.
export function applySettingsPayload(payload) {
  appState.settings = payload;
  appState.maiaRatingPinned = Number.isFinite(payload.maia_rating) ? payload.maia_rating : null;
  settingsView?.renderStrengthControls();
}

// Persist a partial settings patch ({stockfish_depth} / {maia_rating}) and re-render.
export async function saveSettings(patch) {
  return (await loadSettingsActions()).saveSettings(patch);
}

