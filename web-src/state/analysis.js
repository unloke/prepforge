import { START_FEN } from "../core/board-constants.js";

// The Analyze view: the analyzed game, its move tree and the board on it.
// Written by the Analyze controllers (controllers/analyze-*.js) and views/analyze*.js.
export const analysisState = {
  analysis: null,
  // Raw PGN from the most recent in-session Analyze run (not history recall):
  // the SELECTED game's own text, never a multi-game paste.
  analysisSourcePgn: null,
  // The paste a multi-game batch imported, kept while its import picker is on
  // screen: switching to another imported game re-posts THIS text, because after
  // a run the box holds only the game that was analyzed. Any new source clears it.
  analysisMultiPgn: null,
  // The move tree holds a branch the PGN box does not (yet). A focused box is the
  // user's, so serialization waits — except while this is set, because a reload
  // would otherwise drop the branch they just played. Any edit clears it.
  analysisPgnStale: false,
  // A finished-but-unsaved analysis held only in memory (device storage
  // refused the checkpoint) so "Retry save" can still reach it.
  analysisUnsavedCheckpoint: null,
  analysisJobId: null,
  analysisPolling: false,
  analysisPly: 0,
  analysisBoardFen: START_FEN,
  // Study variations explored on the Analyze board: a small client-side tree
  // hanging off the analyzed mainline so the player can branch out and compare
  // lines without losing the original game.
  analysisVarNodes: new Map(),
  analysisVarCounter: 0,
  analysisCurrentNodeId: "root",
  // The selected node's stable identity for the URL/session: the root-to-node UCI
  // path (analyze-node-path.js). `null` at the root, where the ply names it.
  analysisNodePath: null,
  analysisTree: null,
  // Last position fed to the coach panel: { fen, lastUci, lastSan }.
  explainContext: { fen: START_FEN, lastUci: null, lastSan: null },
  evalChartPoints: [],
  // Game ids hidden from the Analyze history while their delete-undo window is open.
  pendingAnalysisDeletes: new Set(),
};
