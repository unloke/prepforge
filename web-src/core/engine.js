import { START_FEN, appState, boards } from "./state.js";
import { hooks } from "./hooks.js";
import { effectiveStockfishDepth, maiaAnalysisEnabled, pref, setPref } from "./prefs.js";
import { BROWSER_ENGINE_UNAVAILABLE, activeBoardController, activeViewName, setStatusError } from "./api.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { localSanLine } from "../chess-local.js";
import { isBrowserEngineAvailable } from "../engine/stockfish-provider.js";
import { engineUnavailableBanner, engineBannerHtml } from "../engine-banner.js";

// One per-position analysis store (engine/position-analysis-store.js) behind the
// Engine panel, the Coach and the whole-game pass.
let analysisStoreReady;
export function analysisStore() {
  return analysisStoreReady ||= import("../engine/position-analysis-store.js")
    .then(({ createPositionAnalysisStore }) => createPositionAnalysisStore({
      getMaia: () => (maiaAnalysisEnabled() ? getSharedMaia3Provider() : null),
      sanLine: sanLineFromUci,
      savedEval: (fen) => appState.analysis?.position_evals?.[fen],
    }));
}

export function createSharedEvaluationProvider(options) {
  let handle = null;
  let seq = 0;
  const select = async (request) => {
    const token = ++seq;
    const store = await analysisStore();
    if (token !== seq) return null;
    handle ||= store.createHandle(options);
    return handle.open(request);
  };
  return {
    open: select, update: select, snapshot: () => handle?.snapshot(),
    // Push every store update for the held position to `fn` (the Engine panel renders
    // as each `info depth` lands rather than sampling on a timer).
    watch: (fn) => handle?.watch?.(fn),
    close: async () => { seq += 1; await handle?.close(); },
  };
}

export function sanLineFromUci(fen, pvUci) {
  return localSanLine(fen, pvUci);
}

// A saved eval's PV in SAN, worked out once per saved entry: stepping through a
// game reads the same entries again and again.
// The Explorer's row-eval worker lives with Build (it belongs to the Explorer
// panel); the widget only ever asks it to repaint its Eval column.
const explorerEvalEngine = { repaint: () => hooks.explorerEvals?.repaint() };

let loadedEngineWidget = null;
let engineWidgetLoading = null;
let engineWidgetOpenSeq = 0;
export function loadEngineWidget() {
  engineWidgetLoading ||= import("../controllers/engine-widget.js").then((mod) => {
    loadedEngineWidget = mod.createEngineWidget({
      effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
      boards, START_FEN, setEngineBestArrow, setStatusError, setEngineOn,
      explorerEvalEngine, getAnalyzeSession: () => hooks.analyzeSession?.() || null,
      analysisStore,
    });
    return loadedEngineWidget;
  }).catch((error) => {
    engineWidgetLoading = null;
    throw error;
  });
  return engineWidgetLoading;
}
export const engineWidget = {
  isOpen: () => loadedEngineWidget?.isOpen() || false,
  get lastSnapshot() { return loadedEngineWidget?.lastSnapshot || null; },
  onBoardChanged: () => loadedEngineWidget?.onBoardChanged(),
  async onDepthSettingChanged() { await loadedEngineWidget?.onDepthSettingChanged(); },
  close() {
    engineWidgetOpenSeq += 1;
    return loadedEngineWidget?.close();
  },
  async openForCurrent() {
    const seq = ++engineWidgetOpenSeq;
    const view = activeViewName();
    let widget = loadedEngineWidget;
    try {
      widget ||= await loadEngineWidget();
    } catch (_) {
      if (seq === engineWidgetOpenSeq) setStatusError("Engine failed to load. Reload the page to try again.");
      return;
    }
    if (seq !== engineWidgetOpenSeq || view !== activeViewName() || !engineWantedIn(view)) return;
    return widget.openForCurrent();
  },
};



// ---- Live engine placement -------------------------------------------------
// The engine never floats over the board: it lives inside the panel that
// already answers "which move?" - Build's Explorer (pinned best line + an Eval
// column per candidate) and Analyze's Evaluation card (game graph + live lines).
export const ENGINE_VIEW_SLOTS = { build: "explorer-engine-slot", analyze: "analysis-engine-slot" };
const ENGINE_VIEW_PREFS = { build: "engineBuild", analyze: "engineAnalyze" };
// Most Explorer rows the eval worker scores (the most-played ones). More lines
// means a shallower search per second, so the rest show a dash.
export const EXPLORER_EVAL_MAX_LINES = 8;

export function dockEngine(slotId) {
  const el = document.getElementById("engine-window");
  const slot = document.getElementById(slotId);
  if (!el || !slot || el.parentNode === slot) return;
  for (const prop of ["left", "top", "right", "width", "height"]) el.style.removeProperty(prop);
  el.classList.add("is-docked");
  slot.appendChild(el);
}

export function engineWantedIn(view) {
  const key = ENGINE_VIEW_PREFS[view];
  return !!key && !!pref(key);
}

export function syncEngineForView(view = activeViewName(), { from = null } = {}) {
  // Leaving the view that owned the engine: the store is a page-wide singleton, so
  // an idle lane keeps its reserved heap (384 MiB on the full net) for the whole
  // idle window with nothing left to answer. Free it on the way out; cached reads
  // stay, so coming back costs one worker boot rather than a re-analysis.
  if (from && from !== view && ENGINE_VIEW_SLOTS[from]) void analysisStore().then((s) => s.releaseWarm());
  const slot = ENGINE_VIEW_SLOTS[view];
  if (slot && engineWantedIn(view)) {
    dockEngine(slot);
    if (engineWidget.isOpen()) void engineWidget.onBoardChanged();
    else void engineWidget.openForCurrent();
  } else {
    void engineWidget.close();
  }
  syncEngineChrome();
  hooks.explorerEvals?.sync();
}

export function setEngineOn(view, on) {
  const key = ENGINE_VIEW_PREFS[view];
  if (!key) return;
  setPref(key, !!on);
  syncEngineForView(view);
}

export function syncEngineChrome() {
  const buildOn = engineWantedIn("build");
  const analyzeOn = engineWantedIn("analyze");
  const toggle = document.getElementById("explorer-engine-toggle");
  if (toggle) {
    toggle.classList.toggle("is-on", buildOn);
    toggle.setAttribute("aria-checked", String(buildOn));
  }
  const analyzeBtn = document.getElementById("open-engine-widget");
  if (analyzeBtn) {
    analyzeBtn.classList.toggle("is-active", analyzeOn);
    analyzeBtn.setAttribute("aria-pressed", String(analyzeOn));
  }
  const rows = document.getElementById("explorer-rows");
  if (rows) rows.classList.toggle("has-eval", buildOn);
  hooks.explorerEvals?.repaint();
  syncAnalysisEvalCard();
}

// The Evaluation card shows when there is a game graph, a number to read or the
// engine is on; the graph itself only once an analysis has plotted points (a
// loaded but not yet analyzed game has nothing to draw, so no empty grey box).
// With nothing loaded the card is empty, so it is not drawn at all.
export function syncAnalysisEvalCard() {
  const card = document.getElementById("analysis-eval-card");
  const graph = document.getElementById("analysis-eval-graph");
  const results = document.getElementById("analysis-results");
  const points = Array.isArray(appState.evalChartPoints) ? appState.evalChartPoints : [];
  const hasGraph = !!results && !results.hidden && points.length > 0;
  if (graph) graph.hidden = !hasGraph;
  const isEngine = engineWantedIn("analyze");
  card?.classList.toggle("is-engine", isEngine);
  const hasNumber = !!(document.getElementById("analysis-chart-caption")?.textContent || "").trim();
  if (card) card.hidden = !hasGraph && !isEngine && !hasNumber;
}


export function setButtonGated(button, gated, message) {
  if (!button) return;
  button.disabled = gated;
  button.classList.toggle("is-coming-soon", gated);
  if (gated) {
    if (!button.dataset.enabledTitle) {
      button.dataset.enabledTitle = button.getAttribute("title") || "";
    }
    button.setAttribute("title", message);
    button.setAttribute("aria-disabled", "true");
  } else {
    button.removeAttribute("aria-disabled");
    if (button.dataset.enabledTitle) {
      button.setAttribute("title", button.dataset.enabledTitle);
    } else {
      button.removeAttribute("title");
    }
  }
}

// Gate compute actions by where the compute can actually run. BOTH whole-game
// Analyze (Phase 2) and Build → Generate (Phase 3c) now run in the BROWSER, so
// each is gated only on the browser engine being available (cross-origin
// isolated) — independent of the server engine, with no server fallback.
export function applyServerEngineGating() {
  const gated = !isBrowserEngineAvailable();
  setButtonGated(
    document.getElementById("run-analysis"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  setButtonGated(
    document.getElementById("build-generate-node"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  paintEngineBanners();
}

// Draw the engine's top move as a green arrow on whichever board is showing
// the analysed position; clear it everywhere else.
export function setEngineBestArrow(uci) {
  const active = activeBoardController();
  Object.values(boards).forEach((b) => {
    if (!b || !b.setEngineArrow) return;
    if (b === active && pref("bestArrow") && uci) b.setEngineArrow(uci);
    else b.setEngineArrow(null);
  });
}

export function paintEngineBanners() {
  const model = engineUnavailableBanner({
    available: isBrowserEngineAvailable(),
    isolated: !!self.crossOriginIsolated,
  });
  const markup = engineBannerHtml(model, {  });
  for (const id of ["analyze-engine-banner", "build-engine-banner"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !model.visible;
    el.innerHTML = markup;
  }
}
