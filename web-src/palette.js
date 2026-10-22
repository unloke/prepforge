import { html } from "./html.js";
import { appState } from "./core/state.js";
import { activeViewName, api } from "./core/api.js";
import { isBuildReadOnly } from "./build-entry.js";
import { activateModal } from "./core/modals.js";
import { buildPaletteItems, filterPaletteItems, paletteScrollTop, renderPaletteItems } from "./command-palette.js";

// The command palette (Ctrl/Cmd-K): the item list, its highlight and scrolling,
// and the actions an item runs. The shell opens it from the keyboard and from
// the phone sheet, so every entry point is exported.

let paletteItems = [];
let paletteActive = 0;
let paletteA11yCleanup = null;

// What an item runs: navigation, a repertoire, a training start, the theme.
// These are the shell's (and its views'), so they arrive once at bind time.
let switchView, setReplaySection, loadSettings, editRepertoire, createRepertoirePrompt,
  requireSignIn, showConfirmModal, goToSmartTraining, startTraining, onFeelingLucky,
  toggleTheme, editBuildNote;

export function createPalette(deps) {
  ({ switchView, setReplaySection, loadSettings, editRepertoire, createRepertoirePrompt,
    requireSignIn, showConfirmModal, goToSmartTraining, startTraining, onFeelingLucky,
    toggleTheme, editBuildNote } = deps);
  return { paletteIsOpen, closePalette, openPalette, bindCommandPalette };
}
// "Add note" acts on the shown move of a repertoire open for editing in Repertoire.
function noteTarget() {
  if (activeViewName() !== "build" || isBuildReadOnly()) return null;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  return node?.parent_id ? node : null;
}

function paletteItemsNow(repertoires) {
  return buildPaletteItems({ repertoires: repertoires || [], noteMove: noteTarget() });
}

export function paletteIsOpen() {
  const el = document.getElementById("command-palette");
  return !!(el && !el.hidden);
}

export function closePalette() {
  const el = document.getElementById("command-palette");
  if (el) {
    el.hidden = true;
    document.getElementById("palette-input")?.setAttribute("aria-expanded", "false");
  }
  if (paletteA11yCleanup) paletteA11yCleanup();
  paletteA11yCleanup = null;
}

function paintPalette() {
  const box = document.getElementById("palette-results");
  if (!box) return;
  box.innerHTML = renderPaletteItems(paletteItems, paletteActive);
  const input = document.getElementById("palette-input");
  const active = box.querySelector('[aria-selected="true"]');
  if (input) {
    if (active) input.setAttribute("aria-activedescendant", active.id);
    else input.removeAttribute("aria-activedescendant");
  }
  // Arrow keys move the highlight; the list must follow it.
  if (active) {
    const boxRect = box.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    box.scrollTop = paletteScrollTop({
      boxTop: boxRect.top,
      boxHeight: boxRect.height,
      itemTop: itemRect.top,
      itemHeight: itemRect.height,
      scrollTop: box.scrollTop,
    });
  }
}

export function openPalette() {
  const el = document.getElementById("command-palette");
  if (!el) return;
  // Open from what is already here: the keypress must not wait on a network
  // round trip. Repertoires arrive (or stay missing) behind it.
  paletteItems = filterPaletteItems(paletteItemsNow(appState.repertoireList), "");
  paletteActive = 0;
  el.hidden = false;
  const input = document.getElementById("palette-input");
  if (input) {
    input.value = "";
    input.setAttribute("aria-expanded", "true");
  }
  paintPalette();
  paletteA11yCleanup = activateModal(el, { initialFocus: input });
  void refreshPaletteRepertoires();
}

// The palette opens with whatever the library cache holds. A signed-in user's
// list is refreshed in the background once; a slower response only means the
// repertoire rows appear a beat later, never that Ctrl+K waited for them.
async function refreshPaletteRepertoires() {
  if (!appState.signedIn) return;
  try {
    const payload = await api("/api/repertoires");
    const repertoires = payload.repertoires || [];
    appState.repertoireList = repertoires;
    if (!paletteIsOpen()) return;
    // A query typed while the fetch was in flight must survive the refresh.
    const input = document.getElementById("palette-input");
    const query = input?.value || "";
    paletteItems = filterPaletteItems(paletteItemsNow(repertoires), query);
    paletteActive = 0;
    paintPalette();
  } catch (_) {
    /* keep the last cached list */
  }
}

export function dismissTransientOverlays() {
  // Tab/command-palette navigation always wins over transient overlays: the
  // overlay click / Escape paths share this teardown so no orphaned keydown
  // listener survives a navigation-driven dismissal.
  const overlay = document.querySelector(".modal-overlay.auth-overlay");
  if (overlay) {
    if (typeof overlay._closeAuthModal === "function") overlay._closeAuthModal();
    else overlay.remove();
  }
  if (paletteIsOpen()) closePalette();
}

async function runPaletteItem(item) {
  closePalette();
  if (!item) return;
  if (item.kind === "view") {
    dismissTransientOverlays();
    switchView(item.view);
    if (item.section) setReplaySection(item.section);
    if (item.view === "settings") loadSettings();
    return;
  }
  if (item.kind === "repertoire" && item.repertoireId) {
    editRepertoire(item.repertoireId);
    return;
  }
  if (item.action === "add-note") {
    // The palette's "Add note": the move menu's note dialog, for the shown move.
    const node = noteTarget();
    if (node) await editBuildNote(node.id);
    return;
  }
  if (item.action === "new-repertoire") {
    createRepertoirePrompt();
    return;
  }
  if (item.action === "start-training") {
    switchView("train");
    // A guest gets the sign-in gate only; a live game on the board stays as it is.
    if (!appState.signedIn) {
      requireSignIn("Sign in to start training", "train");
      return;
    }
    const livePlay = appState.play && appState.play.active && (appState.play.history || []).length > 0;
    if (livePlay) {
      const ok = await showConfirmModal({
        title: "Leave this game?",
        body: "The current game will be abandoned.",
        okLabel: "Start training",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
    }
    if (appState.trainMode === "play") goToSmartTraining();
    else startTraining();
    return;
  }
  if (item.action === "play-human") {
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    document.getElementById("start-play")?.click();
    return;
  }
  if (item.action === "feeling-lucky") {
    dismissTransientOverlays();
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    onFeelingLucky();
    return;
  }
  if (item.action === "analyze") {
    switchView("analyze");
    return;
  }
  if (item.action === "toggle-theme") toggleTheme();
}

export function bindCommandPalette() {
  const root = document.getElementById("command-palette");
  const input = document.getElementById("palette-input");
  const results = document.getElementById("palette-results");
  const opener = document.getElementById("open-palette");
  if (opener) opener.addEventListener("click", () => openPalette());
  if (root) {
    root.addEventListener("click", (event) => {
      if (event.target === root) closePalette();
    });
  }
  if (input) {
    input.addEventListener("input", () => {
      paletteItems = filterPaletteItems(
        paletteItemsNow(appState.repertoireList),
        input.value,
      );
      paletteActive = 0;
      paintPalette();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        paletteActive = Math.min(paletteItems.length - 1, paletteActive + 1);
        paintPalette();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        paletteActive = Math.max(0, paletteActive - 1);
        paintPalette();
      } else if (event.key === "Enter") {
        event.preventDefault();
        // The item may open a dialog with its own document keydown handler
        // (sign-in submits on Enter); this keystroke must not reach it.
        event.stopPropagation();
        runPaletteItem(paletteItems[paletteActive]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    });
  }
  if (results) {
    results.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-index]");
      if (!btn) return;
      runPaletteItem(paletteItems[Number(btn.dataset.index)]);
    });
  }
}

