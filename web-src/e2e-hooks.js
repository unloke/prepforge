import { appState, boards } from "./core/state.js";
import { boardInfo } from "./board/ui.js";

// E2E acceptance hooks. Three deterministic hooks for the Playwright suites:
// Scout (mounted refutation scenarios + captured OAuth popups), Polish (seeded
// linked identities driving the real per-action chooser) and Analyze (a seeded
// finished analysis, no browser engine). Each is gated by a build flag AND a
// query parameter, so a production page never exposes one.

let switchView, ensureScoutView, whenSettingsReady, lichessAccounts, syncReplayControls,
  fetchMyLichessGame, notices, revealAnalysisResults, showAnalysisPly, ensureAnalyzeView,
  appReadyPromise;

export function installE2eHooks(deps) {
  ({ switchView, ensureScoutView, whenSettingsReady, lichessAccounts, syncReplayControls,
    fetchMyLichessGame, notices, revealAnalysisResults, showAnalysisPly, ensureAnalyzeView,
    appReadyPromise } = deps);
  if (SCOUT_E2E_BUILD_ENABLED && new URLSearchParams(location.search).get("scout_e2e") === "1") {
    installScoutE2eHook();
  }
  if (POLISH_E2E_BUILD_ENABLED && new URLSearchParams(location.search).get("polish_e2e") === "1") {
    installPolishE2eHook();
  }
  if (ANALYZE_E2E_BUILD_ENABLED && new URLSearchParams(location.search).get("analyze_e2e") === "1") {
    installAnalyzeE2eHook();
  }
}

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
const POLISH_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_POLISH_E2E === "1";

function installScoutE2eHook() {
  if (window.__prepforgeScoutE2e) return;
  const oauthOpens = [];
  const nativeOpen = window.open.bind(window);
  window.open = function scoutE2eOpen(url, target, features) {
    oauthOpens.push({
      url: String(url ?? ""),
      target: String(target ?? ""),
      features: String(features ?? ""),
      ts: Date.now(),
    });
    try {
      return nativeOpen(url, target, features);
    } catch {
      return null;
    }
  };
  window.__prepforgeScoutE2e = {
    async mountRefutationScenario(scenarioId) {
      switchView("replay");
      const view = await ensureScoutView();
      view.bindControls();
      return view.mountE2eRefutationScenario(scenarioId);
    },
    getOauthOpens() {
      return oauthOpens.map((entry) => ({ ...entry }));
    },
    resetOauthOpens() {
      oauthOpens.length = 0;
    },
  };
}

// Polish acceptance hook: deterministic tests seed linked identities and drive
// the real per-action chooser without OAuth popups. Same gating shape as the
// Scout hook — build flag + query param — so production pages never expose it.
function installPolishE2eHook() {
  if (window.__prepforgePolishE2e) return;
  window.__prepforgePolishE2e = {
    whenSettingsReady,
    async setLichessAccounts(accounts) {
      appState.lichessAccounts = accounts;
      const primary = accounts.find((a) => a.is_primary) || accounts[0] || null;
      appState.lichessUsername = primary ? primary.username : null;
      try {
        const view = await whenSettingsReady().catch(() => null);
        // Seed the connections list directly: the acceptance static server has
        // no /api/lichess backend, so refreshConnections() would keep the last
        // state instead of showing the seeded identities.
        await view?.renderConnections?.();
        view?.renderMaia3Status?.();
      } catch (_) {
        /* settings view may not be loaded yet */
      }
      try {
        syncReplayControls();
      } catch (_) {
        /* controller may not be initialised in a bare acceptance page */
      }
    },
    getLichessAccounts() {
      return lichessAccounts();
    },
    async fetchMyLastGame() {
      await fetchMyLichessGame();
      return notices.statusText();
    },
    async setBoardFen(boardName, fen) {
      const board = boards[boardName] || null;
      if (!board) throw new Error(`unknown board: ${boardName}`);
      const info = await boardInfo(fen);
      board.setPosition({ fen, legalMoves: info.legal_moves, lastMove: null });
      return info.legal_moves;
    },
  };
}

// Analyze E2E hook: deterministic tests seed a finished analysis payload
// (moves + eval graph) without running a browser engine. Same gating shape as
// the Scout/Polish hooks — E2E build flag + query-param opt-in — so production
// pages never expose it. Shares the existing E2E build flags so the CI e2e job's
// build (VITE_ENABLE_SCOUT_E2E=1) carries it.
const ANALYZE_E2E_BUILD_ENABLED = SCOUT_E2E_BUILD_ENABLED || POLISH_E2E_BUILD_ENABLED;

function installAnalyzeE2eHook() {
  if (window.__prepforgeAnalyzeE2e) return;
  window.__prepforgeAnalyzeE2e = {
    async seedAnalysis(payload) {
      // Boot races the seed: init()'s restoreWorkspaceLocation() switches to the
      // default view after this hook is installed. Await boot so the seeded
      // Analyze view (and its reveal) isn't switched away underneath us.
      if (appReadyPromise) await appReadyPromise;
      switchView("analyze");
      appState.analysis = payload;
      appState.analysisVarNodes = new Map();
      appState.analysisVarCounter = 0;
      appState.analysisCurrentNodeId = "root";
      appState.analysisTree = null;
      appState.analysisPly = 0;
      const view = await ensureAnalyzeView();
      view.renderAnalysis(payload);
      revealAnalysisResults();
      await showAnalysisPly(0);
      return true;
    },
    // The user's Lichess name, so a loaded PGN has a known side ("you") and the coach
    // reads the other side's moves as the opponent's.
    setSelfName(name) {
      appState.lichessUsername = name || null;
      return true;
    },
    getCoachProse: () => (document.getElementById("coach-prose") || {}).textContent || "",
    getPly: () => appState.analysisPly,
    getBoardLabel: () =>
      (document.getElementById("analysis-board-label") || {}).textContent || "",
  };
}
