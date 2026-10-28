// Analyze selection: one path from "the user picked this position" to everything
// that describes it — the board, the caption, the move-list highlight, the saved
// session, the Coach's context and the engine card.
//
// Mainline plies and off-mainline branches differ only in how the node is FOUND,
// never in what is then applied. That split is what let a variation show one
// position on the board while the caption, the Coach or the engine still described
// the mainline move of the same number: `showAnalysisPly` re-checked a source token
// after its board read while the variation branch of `selectAnalysisNode` painted
// unconditionally, and the board's direction hint came from comparing plies — which
// a variation does not have (`analysisPly` is -1 there).
//
// The session owns the state; this module owns the rule that the selected node is
// the single fact every one of those readers is told about.

import { analysisNodeIdFromPath, analysisPathOf } from "../analyze-node-path.js";
import { clearPeek } from "../line-preview.js";

export function createAnalysisSelection(deps) {
  const {
    appState, START_FEN, boardInfo, boards, classBadgeSymbol, setPositionCaption,
    highlightCurrentMove, persistAnalysisSession, syncViewHeads, syncWorkspaceUrl,
    refreshAnalysisExplain, engineWidget, analysisVariationLabel, ensureAnalyzeView,
    boardAfterMove, syncPgnFromTree, setStatusError,
    // The source epoch: bumped whenever the loaded game/owner changes. A board read
    // started for one source must not paint after another source was loaded — even
    // when the analysis object and the selected node id happen to be unchanged (a
    // recall of the same game, an account switch during a read).
    analysisSourceSeq = () => 0, currentOwnerId = () => null, ownerGeneration = () => 0,
  } = deps;

  // Bumped by every selection intent. A continuation that resolves after a newer
  // selection (a board read, a lazy view load) compares this and stops, so it can
  // never paint over the position the user actually chose.
  let selectionSeq = 0;

  // Everything a continuation must still match to be allowed to paint: the
  // selection it was started for, the node, the analysis object, and the source
  // epoch (game + owner) it belongs to.
  function selectionIsCurrent(token, nodeId, analysis, source) {
    return token === selectionSeq &&
      appState.analysisCurrentNodeId === nodeId &&
      analysis === appState.analysis &&
      source.isCurrent();
  }

  function captureSource() {
    const seq = analysisSourceSeq();
    const owner = currentOwnerId();
    const generation = ownerGeneration();
    return {
      seq,
      isCurrent: () => seq === analysisSourceSeq() && owner === currentOwnerId() &&
        generation === ownerGeneration(),
    };
  }

  // The persisted/URL identity of the selected node: its root-to-node UCI path.
  // Read from the node the selection last applied (not the tree map), so a branch
  // created a moment ago has an identity before the move list re-renders.
  let appliedNode = null;
  function selectedNodePath() {
    return analysisPathOf(appliedNode);
  }

  // The mainline node for a ply: the tree's own node when the move list has been
  // rendered, else one built from the flat moves array (a fresh load navigates the
  // board before the list exists).
  function analysisNodeForPly(ply) {
    const moves = appState.analysis ? appState.analysis.moves || [] : [];
    const bounded = Math.max(0, Math.min(Number(ply) || 0, moves.length));
    const id = bounded === 0 ? "root" : `m${bounded}`;
    const tree = appState.analysisTree;
    const treeNode = tree && tree.byId.get(id);
    if (treeNode) return treeNode;
    const move = bounded > 0 ? moves[bounded - 1] : null;
    return {
      id,
      ply: bounded,
      isMainline: true,
      isVariation: false,
      // The fallback node's identity without the tree: the mainline's first
      // `bounded` ucis, in order (same `-` separator as analyze-node-path.js).
      path: moves.slice(0, bounded).map((m) => m.uci).join("-") || "root",
      san: move ? move.san : null,
      uci: move ? move.uci : null,
      fenBefore: move ? move.fen_before : null,
      fenAfter: move ? move.fen_after : null,
      moveNumber: move ? move.move_number : null,
      side: move ? move.side : null,
      classification: move ? move.classification : null,
      parent: null,
      children: [],
    };
  }

  // Whether the board travels backwards: the target is where the current node came
  // from (a parent, or any ancestor — a jump from a variation onto its mainline
  // trunk). Direction is the tree's, not a ply comparison: an off-mainline node has
  // no ply, so a ply comparison called every step out of a variation a forward move
  // and replayed the undone piece instead of sending it home.
  function selectionMovesBack(fromId, targetId) {
    const tree = appState.analysisTree;
    if (!tree || !fromId || fromId === targetId) return false;
    let node = tree.byId.get(fromId);
    while (node && node.parent) {
      if (node.parent.id === targetId) return true;
      node = node.parent;
    }
    return false;
  }

  async function applyAnalysisNode(node) {
    const analysis = appState.analysis;
    const moves = analysis && analysis.moves ? analysis.moves : [];
    const back = selectionMovesBack(appState.analysisCurrentNodeId || "root", node.id);
    const token = (selectionSeq += 1);
    const source = captureSource();
    const mainline = !!node.isMainline;
    appState.analysisCurrentNodeId = node.id;
    // Mainline plies keep their number (the coach resolves the saved verdict by
    // index); an off-mainline node has none and keeps the -1 sentinel every
    // numeric consumer already understands.
    appState.analysisPly = mainline ? Number(node.ply) || 0 : -1;
    appliedNode = node;
    // The URL's identity for this position (workspace-url reads it). A mainline
    // position is named by its ply alone, so it carries no path and an ordinary
    // `#/analyze?ply=5` link keeps its shape; only a branch needs one.
    appState.analysisNodePath = mainline ? null : analysisPathOf(node);
    const move = node.id === "root" ? null : node;
    const fen = move ? move.fenAfter : moves[0]?.fen_before || analysis?.initialFen || START_FEN;
    const info = await boardInfo(fen);
    if (!selectionIsCurrent(token, node.id, analysis, source)) return;
    appState.analysisBoardFen = fen;
    clearPeek();
    boards.analysis.setPosition({ fen, legalMoves: info.legal_moves, lastMove: move ? move.uci : null, back });
    // Only an analysed move gets a badge; an unclassified one (a pasted PGN, a game
    // sent from Train) shows none instead of an empty placeholder dot.
    const badge = move && move.classification ? classBadgeSymbol(move.classification) : "";
    boards.analysis.setMoveBadge(badge ? move.uci.slice(2, 4) : null, badge ? move.classification : null, badge);
    // Which position is on the board is a phone fact: its eval row says it, because
    // the thumb bar has no room and the bar under the board names the game. On a
    // desktop the board itself shows the position and the moves list marks it.
    setPositionCaption(
      move
        ? mainline
          ? `${move.moveNumber}${move.side === "black" ? "..." : "."} ${move.san}`
          : analysisVariationLabel(move.moveNumber, move.side, move.san)
        : "",
    );
    highlightCurrentMove();
    persistAnalysisSession();
    syncWorkspaceUrl();
    syncViewHeads();
    refreshAnalysisExplain({
      fen,
      lastUci: move ? move.uci : null,
      lastSan: move ? move.san : null,
      prevFen: move ? move.fenBefore : null,
      // Mainline ply (1-based) so the coach can resolve the saved verdict by index
      // rather than by fen-key. Omitted for the initial position (no move) and for a
      // variation, whose position is not on the saved mainline at all.
      ply: mainline && move ? appState.analysisPly : null,
      nodeId: node.id,
    });
    if (engineWidget) engineWidget.onBoardChanged();
  }

  async function showAnalysisPly(ply) {
    await applyAnalysisNode(analysisNodeForPly(ply));
  }

  // Any tree node (mainline `m<ply>`, a variation `v<seq>`, or `root`) goes through
  // the same application path as a ply step, so a branch jump and a mainline step
  // cannot disagree about which position the board, Coach and engine describe.
  async function selectAnalysisNode(nodeId) {
    const tree = appState.analysisTree;
    const node = tree ? tree.byId.get(nodeId) : null;
    if (!node) return false;
    await applyAnalysisNode(node);
    return true;
  }

  // Restore a persisted selection by its stable identity (the root-to-node UCI
  // path). A path the current tree no longer has is NOT resolved to some other
  // node: the caller keeps the position it has and can say the branch is gone.
  async function selectAnalysisNodePath(path) {
    // The tree is built lazily on render; a rebuild of the branches (a recalled
    // review, a finished run) drops it until then, so build it here too.
    if (!appState.analysisTree && appState.analysis) {
      const analysis = appState.analysis;
      const view = await ensureAnalyzeView();
      if (analysis !== appState.analysis) return false;
      appState.analysisTree ||= view.buildAnalysisTree(analysis.moves || []);
    }
    const tree = appState.analysisTree;
    const nodeId = tree ? analysisNodeIdFromPath(path, tree) : null;
    if (!nodeId) return false;
    return selectAnalysisNode(nodeId);
  }

  // Tree-aware navigation (start/prev/next/end). Works for both the analysed
  // mainline and free-exploration variations, because it walks the live node tree
  // by id rather than a flat ply index. `next` follows the mainline child.
  async function analysisTreeNav(kind) {
    // Read the starting node BEFORE the await: the step is relative to where the
    // user pressed the key, not to wherever a lazy view load happened to leave the
    // tree. A variation click landing first used to make Prev step back from the
    // variation (landing on its parent's parent) instead of from the move the user
    // was on.
    const fromId = appState.analysisCurrentNodeId || "root";
    const analysis = appState.analysis;
    const source = captureSource();
    const view = await ensureAnalyzeView();
    // A newer selection (a click, a jump) or a new source supersedes this step.
    if (!source.isCurrent() || analysis !== appState.analysis) return;
    if ((appState.analysisCurrentNodeId || "root") !== fromId) return;
    const tree =
      appState.analysisTree ||
      view.buildAnalysisTree(appState.analysis ? appState.analysis.moves : []);
    appState.analysisTree = tree;
    let node = tree.byId.get(fromId) || tree.root;
    if (kind === "start") node = tree.root;
    else if (kind === "prev") node = node.parent || node;
    else if (kind === "next") node = (node.children && node.children[0]) || node;
    else if (kind === "end") {
      while (node.children && node.children[0]) node = node.children[0];
    }
    // Boundary navigation must not redraw the board or rerun the coach, which
    // clears the engine arrow even though the widget's FEN has not changed.
    if (node.id === appState.analysisCurrentNodeId) return;
    await selectAnalysisNode(node.id);
  }

  async function onAnalysisBoardMove(moveUci, fen) {
    const fromId =
      appState.analysisCurrentNodeId ||
      (appState.analysisPly > 0 ? `m${appState.analysisPly}` : "root");
    // The move is played against the position on the board; if the user has already
    // moved on by the time the board confirms it, the branch belongs to a position
    // nobody is looking at any more — and a new source (a reload of another game, an
    // account switch) makes the whole branch meaningless.
    const token = selectionSeq;
    const analysis = appState.analysis;
    const source = captureSource();
    try {
      const tree = appState.analysisTree;
      const currentNode = tree ? tree.byId.get(fromId) : null;
      // Replaying the existing continuation (mainline or a known variation) just
      // steps forward instead of forking a duplicate line.
      const existing = currentNode && currentNode.children.find((child) => child.uci === moveUci);
      if (existing) {
        await selectAnalysisNode(existing.id);
        return;
      }
      // New move from here → record it as a study variation branching off the
      // current node.
      const payload = await boardAfterMove(fen, moveUci);
      if (token !== selectionSeq || (appState.analysisCurrentNodeId || "root") !== fromId) return;
      if (!source.isCurrent() || analysis !== appState.analysis) return;
      const parts = fen.split(" ");
      const side = parts[1] === "b" ? "black" : "white";
      const moveNumber = Number(parts[5]) || 1;
      const seq = (appState.analysisVarCounter = (appState.analysisVarCounter || 0) + 1);
      const id = `v${seq}`;
      appState.analysisVarNodes.set(id, {
        id,
        seq,
        parentId: fromId,
        uci: moveUci,
        san: payload.move.san,
        fenBefore: fen,
        fenAfter: payload.board.fen,
        moveNumber,
        side,
      });
      await applyAnalysisNode({
        id,
        ply: -1,
        isMainline: false,
        isVariation: true,
        uci: moveUci,
        san: payload.move.san,
        fenBefore: fen,
        fenAfter: payload.board.fen,
        moveNumber,
        side,
        classification: null,
        // The parent node itself, so the new branch's root-to-node path is
        // available before the move list re-renders its tree.
        parent: currentNode || null,
      });
      // New branch on the board → mirror it into the PGN box. Mark the box stale
      // first: the box is the only place a reload can find this branch, so the
      // serialization must also land while the textarea is focused.
      appState.analysisPgnStale = true;
      void syncPgnFromTree().catch(() => {});
    } catch (error) {
      setStatusError(error.message);
    }
  }

  return {
    analysisTreeNav,
    onAnalysisBoardMove,
    selectAnalysisNode,
    selectAnalysisNodePath,
    selectedNodePath,
    showAnalysisPly,
  };
}
