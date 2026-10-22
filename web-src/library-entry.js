import { html } from "./html.js";
import { appState } from "./core/state.js";
import { api, currentOwnerId, postJson, setStatus, setStatusError } from "./core/api.js";
import { normalizeRepertoireColor, repertoireColorField } from "./repertoire-color.js";
import { showInputModal } from "./core/modals.js";
import { localDateString } from "./core/api.js";
import { pgnHeaderTags } from "./analyze-pgn.js";

// The Library (dashboard) page: its lazy chunk, the listing load, and importing
// a PGN as a repertoire. The view itself is views/dashboard.js.

let switchView, hydrateBuild, syncViewHeads, openTrain,
  editRepertoire, openRepertoireContextMenu, createRepertoirePrompt, requireSignIn,
  openAuthModal, openSettingsSection, parseFenBoard, pieceSvg;

export let dashboardView = null;

export function createLibrary(deps) {
  ({ switchView, hydrateBuild, syncViewHeads, openTrain,
    editRepertoire, openRepertoireContextMenu, createRepertoirePrompt, requireSignIn,
    openAuthModal, openSettingsSection, parseFenBoard, pieceSvg } = deps);
  return { preloadDashboardView, ensureDashboardView, loadDashboard, refreshDashboardRepertoires,
    defaultRepertoireNameFromPgn, importRepertoireFromPgnText, promptImportRepertoireFromPgn,
    get dashboardView() { return dashboardView; } };
}

let dashboardModulePromise = null;


export function preloadDashboardView() {
  if (!dashboardModulePromise) {
    dashboardModulePromise = import("./views/dashboard.js").catch((err) => {
      dashboardModulePromise = null;
      throw err;
    });
  }
  return dashboardModulePromise;
}

export async function ensureDashboardView() {
  const mod = await preloadDashboardView();
  if (!dashboardView) {
    dashboardView = mod.createDashboardView({
      appState,
      api,
      postJson,
      setStatus,
      setStatusError,
      localDateString,
      openTrain,
      editRepertoire,
      openRepertoireContextMenu,
      createRepertoirePrompt,
      hydrateBuild,
      showInputModal,
      promptImportRepertoireFromPgn,
      requireSignIn,
      openSignIn: () => openAuthModal("login"),
      onLibraryStateChange: syncViewHeads,
      goToView: switchView,
      openSettingsSection,
      // Library preview mini-board: FEN decode + the product's piece SVGs over
      // the real listing root_fen. Pure DOM helpers — no engine, no board.
      previewRenderers: { parseFenBoard, pieceSvg },
    });
    dashboardView.bind();
  }
  return dashboardView;
}

export async function loadDashboard() {
  let view;
  try {
    view = await ensureDashboardView();
    if (appState.signedIn) await view.loadDashboard();
    else view.renderSignedOut();
  } catch (error) {
    // An import failure happens before the view can clear the initial spinner.
    if (!view) {
      const card = document.querySelector("#view-dashboard .lib-list");
      for (const name of ["is-loading", "is-empty", "is-error"]) {
        card?.classList.toggle(name, name !== "is-loading");
      }
      const host = document.getElementById("dashboard-repertoires");
      if (host) {
        host.innerHTML = html`<div class="empty-state" role="alert"><h3>Could not load your library.</h3><p>${error.message}</p><button type="button" class="btn" data-library-retry>Try again</button></div>`;
        host.querySelector("[data-library-retry]")?.addEventListener("click", loadDashboard);
      }
    }
    setStatusError(error.message);
  }
}

// Refresh the repertoire list only when the dashboard chunk is already loaded —
// never pull the chunk just to update invisible DOM after CRUD elsewhere.
export function refreshDashboardRepertoires() {
  if (!dashboardView) return Promise.resolve();
  return dashboardView.loadDashboardRepertoires();
}

export function defaultRepertoireNameFromPgn(pgnText) {
  const pgn = String(pgnText || "");
  const event = pgn.match(/\[Event\s+"([^"]+)"/i);
  if (event) return event[1].trim().slice(0, 80);
  const white = pgn.match(/\[White\s+"([^"]+)"/i);
  const black = pgn.match(/\[Black\s+"([^"]+)"/i);
  if (white && black) return `${white[1].trim()} vs ${black[1].trim()}`.slice(0, 80);
  return "Imported game";
}

export async function importRepertoireFromPgnText(pgnText, { name, color }) {
  const payload = await postJson("/api/repertoires/import-pgn", {
    pgn: pgnText,
    name,
    color,
  });
  await hydrateBuild(payload, payload.selected_node_id);
  appState.trainingRepertoireId = payload.repertoire_id;
  await refreshDashboardRepertoires();
  return payload;
}

export async function promptImportRepertoireFromPgn(pgnText, { defaultName = "Imported game", switchToBuild = false } = {}) {
  const meta = await showInputModal({
    title: "Import PGN as repertoire",
    okLabel: "Import",
    fields: [
      { name: "name", label: "Name", default: defaultName },
      repertoireColorField("white"),
    ],
  });
  if (!meta) return null;
  const name = (meta.name || "").trim() || "Imported";
  const color = normalizeRepertoireColor(meta.color);
  try {
    const payload = await importRepertoireFromPgnText(pgnText, { name, color });
    if (switchToBuild) switchView("build");
    setStatus(
      switchToBuild
        ? `Repertoire “${payload.name}” created — edit it in Repertoire`
        : `Imported ${payload.name}`,
    );
    return payload;
  } catch (error) {
    setStatusError(error.message);
    throw error;
  }
}

