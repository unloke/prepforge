import { html } from "../html.js";
import { START_FEN, analysisState, appState, boards } from "../core/state.js";
import { postJson, setStatus, setStatusError } from "../core/api.js";
import { playSound } from "../core/sound.js";
import { syncAnalysisEvalCard } from "../core/engine.js";
import { rememberHandoff } from "../handoff-context.js";
// The report's "left prep at" row walks the repertoire trees the Analyze coach
// already loads, so the view reads that one cache rather than fetching again.
import { ensureBookLoaded, getBookReps } from "../analyze-book-state.js";

// The Analyze view chunk and its move tree: created on first use, then shared
// by every caller (the shell's view switching, the PGN box, the entry points).
// The analysis session is a separate chunk and arrives through hooks.

let analyzeModule = null;
let moveTreeModule = null;
let moveTreeRenderer = null;
export let analyzeView = null;

let loadAnalyzeSession, showAnalysisPly, selectAnalysisNode, revealAnalysisResults, analysisSelfSide = () => null, gradeReviewAttempt = () => {};

export function createAnalyzeView({ loadSession, showPly, selectNode, reveal, selfSide, gradeAttempt = () => {} }) {
  loadAnalyzeSession = loadSession;
  showAnalysisPly = showPly;
  selectAnalysisNode = selectNode;
  revealAnalysisResults = reveal;
  analysisSelfSide = selfSide;
  gradeReviewAttempt = gradeAttempt;
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
      analysisState,
      START_FEN,
      showAnalysisPly,
      selectAnalysisNode,
      revealAnalysisResults,
      onEvalChartRendered: () => syncAnalysisEvalCard(),
      bookReps: getBookReps,
      selfSide: () => analysisSelfSide(),
      peek: (pos) => boards.analysis?.peek(pos),
      gradeAttempt: (fen, ctx) => gradeReviewAttempt(fen, ctx),
      ensureBookLoaded,
      retryHooks: {
        renderBoard: ({ fen, legalMoves = [], lastMove = null, badge = null, cue, back = false }) => {
          const b = boards.analysis;
          if (!b || !fen) return;
          b.setBetterArrow(null);
          b.setPosition({ fen, legalMoves, lastMove, cue, back });
          if (badge?.square) b.setMoveBadge(badge.square, badge.classification, badge.label);
          else b.setMoveBadge(null);
        },
        selectHintSquare: (sq) => boards.analysis?.selectSquare(sq),
        setHintArrow: (uci) => boards.analysis?.setEngineArrow(uci),
        setComparisonArrows: (arrows) => boards.analysis?.setAnnotations(arrows, []),
        getOrientation: () => boards.analysis?.orientation || null,
        setOrientation: (side) => boards.analysis?.setOrientation(side),
        playCue: (kind) => playSound(kind),
        canTrainPrep: () => Boolean(appState.signedIn),
        recordPrepMiss: async (item) => {
          const moves = analysisState.analysis?.moves || [];
          const prefix = moves.filter((m) => Number(m.ply) < item.ply).map((m) => m.uci);
          const first = item.answers?.[0];
          rememberHandoff({
            source: "analyze",
            reason: "practice-missed-move",
            gameId: analysisState.analysis?.game_id || null,
            lineUcis: first ? [...prefix, first.uci] : prefix,
            ply: item.ply,
            anchorFen: item.move?.fen_before || null,
            rootFen: moves[0]?.fen_before || null,
            side: item.side,
            repertoireId: item.repId,
          });
          try {
            await postJson("/api/train/record-miss", {
              repertoire_id: item.repId,
              node_id: item.prescribedNodeId,
            });
            setStatus(`${first?.san || "Move"} will lead your next smart session`);
            return true;
          } catch (error) {
            setStatusError(error.message);
            return false;
          }
        },
      },
    });
  }
  return analyzeView;
}


function analysisTreeHasContent(movesArg) {
  const moves = movesArg || (analysisState.analysis ? analysisState.analysis.moves : []);
  if (moves && moves.length) return true;
  return !!(analysisState.analysisVarNodes && analysisState.analysisVarNodes.size);
}

export function renderAnalysisTreeEmptyState() {
  const container = document.getElementById("analysis-moves");
  if (!container) return;
  analysisState.analysisTree = null;
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
