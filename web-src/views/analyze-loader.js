import { html } from "../html.js";
import { START_FEN, appState } from "../core/state.js";
import { syncAnalysisEvalCard } from "../core/engine.js";

// The Analyze view chunk and its move tree: created on first use, then shared
// by every caller (the shell's view switching, the PGN box, the entry points).
// The analysis session is a separate chunk and arrives through hooks.

let analyzeModule = null;
let moveTreeModule = null;
let moveTreeRenderer = null;
export let analyzeView = null;

let loadAnalyzeSession, showAnalysisPly, selectAnalysisNode, revealAnalysisResults;

export function createAnalyzeView({ loadSession, showPly, selectNode, reveal }) {
  loadAnalyzeSession = loadSession;
  showAnalysisPly = showPly;
  selectAnalysisNode = selectNode;
  revealAnalysisResults = reveal;
  return { preloadAnalyzeView, ensureAnalyzeView, ensureMoveTreeRenderer,
    renderAnalysisTree, renderAnalysisTreeEmptyState, bindEvalChart,
    get analyzeView() { return analyzeView; },
    get moveTreeRenderer() { return moveTreeRenderer; } };
}


export function preloadAnalyzeView() {
  if (!analyzeModule) {
    analyzeModule = import("./analyze.js").catch((err) => {
      analyzeModule = null;
      throw err;
    });
  }
  loadAnalyzeSession().catch(() => {});
  return analyzeModule;
}
export async function ensureAnalyzeView() {
  // The Analyze module comes with the view, so its handlers call straight through.
  const [mod] = await Promise.all([preloadAnalyzeView(), loadAnalyzeSession()]);
  if (!analyzeView) {
    analyzeView = mod.createAnalyzeView({
      appState,
      START_FEN,
      showAnalysisPly,
      selectAnalysisNode,
      revealAnalysisResults,
      onEvalChartRendered: () => syncAnalysisEvalCard(),
    });
  }
  return analyzeView;
}


function analysisTreeHasContent(movesArg) {
  const moves = movesArg || (appState.analysis ? appState.analysis.moves : []);
  if (moves && moves.length) return true;
  return !!(appState.analysisVarNodes && appState.analysisVarNodes.size);
}

export function renderAnalysisTreeEmptyState() {
  const container = document.getElementById("analysis-moves");
  if (!container) return;
  appState.analysisTree = null;
  container.innerHTML =
    html`<div class="empty-state">Play on the board, or analyze a PGN.</div>`;
}

export function renderAnalysisTree(movesArg) {
  if (!analysisTreeHasContent(movesArg)) {
    renderAnalysisTreeEmptyState();
    return;
  }
  if (analyzeView) return analyzeView.renderAnalysisTree(movesArg);
  void ensureAnalyzeView()
    .then((view) => view.renderAnalysisTree(movesArg))
    .catch(() => {});
}

export function bindEvalChart() {
  // Chart interaction (click / hover tooltip / keyboard) lives with the chart
  // renderer in views/analyze.js (bound on first render); app.js only keeps the
  // viewport resize hook that rescales the key-moment markers.
  // Only a mounted Analyze chart has markers to rescale — a resize on any other
  // page must not pull the Analyze chunk (and its CSS) in.
  window.addEventListener("resize", () => {
    if (analyzeView) analyzeView.rescaleEvalMarkers();
  });
}

export function preloadMoveTreeRenderer() {
  if (!moveTreeModule) {
    moveTreeModule = import("./shared/movetree.js").catch((err) => {
      moveTreeModule = null;
      throw err;
    });
  }
  return moveTreeModule;
}

export async function ensureMoveTreeRenderer() {
  const mod = await preloadMoveTreeRenderer();
  if (!moveTreeRenderer) {
    moveTreeRenderer = mod.createMoveTreeRenderer();
  }
  return moveTreeRenderer;
}
