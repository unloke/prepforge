// Restoring the Analyze position a link or a session names.
//
// Analyze keeps the loaded game in a session slot (controllers/analyze-session.js
// persistAnalysisSession), so a reload puts the move list and the board back
// together instead of a PGN box whose game the board never loaded. The URL's
// ?ply= wins when it names a move: a shared/returned link is about that ply.
// A ?node= names a position off the mainline, which no ply can describe — restoring
// only the ply turned the user's variation into a mainline move of the same number.
// The node wins over the ply when both are present.
//
// Both values are stable identities: the node is a root-to-node UCI path
// (analyze-node-path.js), so it resolves to the same position after the PGN is
// re-parsed. A path this game no longer has selects nothing (and says so) instead
// of silently landing on an unrelated position.

import { ANALYSIS_ROOT_PATH } from "../analyze-node-path.js";
import { parsePgn } from "../analyze-pgn.js";

export function createAnalyzeRestore(deps) {
  const {
    appState, loadReturnState, loadPgnIntoAnalyze, showAnalysisPly,
    selectAnalysisNodePath, setStatus, recallAnalysis, rebuildAnalysisVariations,
  } = deps;

  // A saved review comes back by id (grades, eval chart, report), with the
  // branches the session's PGN added on top of it. A review deleted meanwhile
  // falls back to the bare PGN.
  async function recallSavedReview(gameId, pgn) {
    const headers = parsePgn(pgn).headers || {};
    const names = { white: headers.White, black: headers.Black, result: headers.Result };
    if (!(await recallAnalysis(gameId, names, { quiet: true }).catch(() => false))) return false;
    await rebuildAnalysisVariations(pgn);
    const input = document.getElementById("pgn-input");
    if (input) input.value = pgn;
    return true;
  }

  // Put the board on the position a node path names, or report that this game no
  // longer has it (the branch was edited away) and stay where we are.
  async function restoreAnalysisNodePath(path) {
    if (await selectAnalysisNodePath(path)) return;
    setStatus("That line is not in this game any more", { severity: "warning" });
  }

  async function restoreAnalyzeSession(urlPly, urlNode = null) {
    if (appState.analysis) {
      if (urlNode) await restoreAnalysisNodePath(urlNode);
      else if (urlPly) await showAnalysisPly(urlPly);
      return;
    }
    const saved = loadReturnState("analyze");
    const pgn = typeof saved?.pgn === "string" ? saved.pgn : "";
    if (!pgn.trim()) return;
    const recalled = saved?.gameId ? await recallSavedReview(saved.gameId, pgn) : false;
    if (!recalled) {
      const input = document.getElementById("pgn-input");
      if (input) input.value = pgn;
      const loaded = await loadPgnIntoAnalyze(pgn, { goToEnd: false, quiet: true }).catch(() => false);
      if (!loaded) return;
    }
    const node = urlNode || saved?.node;
    if (node && node !== ANALYSIS_ROOT_PATH) {
      await restoreAnalysisNodePath(node);
      return;
    }
    const ply = urlPly || saved?.ply;
    // A recalled review repaints its move list with the restored branches here.
    if (ply || recalled) await showAnalysisPly(ply || 0);
  }

  return { restoreAnalyzeSession, restoreAnalysisNodePath };
}
