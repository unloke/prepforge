// The app's side of move links (line-preview.js): what a token does on Build and
// Analyze, and which existing move controls get a hover peek.
//
// Click on a token: a line the tree already has (the repertoire on Build, the game
// and its variations on Analyze) is selected there, as clicking it in the move list
// would. Any other line is walked on the board like an engine line, so a note or a
// coach sentence never adds a move. Every other view only peeks.
import { appState, boards } from "./core/state.js";
import { activeBoardController, activeViewName } from "./core/api.js";
import { boardLine, initMoveLinks, peekPosition, registerPeekSource } from "./line-preview.js";
import { plyOfFen, walkLine } from "./move-text.js";

const samePosition = (a, b) => !!a && !!b && a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
const numbered = (moveNumber, side, san) => `${moveNumber}${side === "black" ? "..." : "."}${san}`;

/**
 * The node a line ends on in a tree: followed move by move from a node at the line's
 * start (the current node first), or else any node with the end position (a
 * transposition). `nodes`, `fenOf`, `childrenOf` adapt Build's and Analyze's trees.
 */
export function treeNodeForLine(line, ply, { nodes, fenOf, childrenOf, currentId }) {
  if (!line || !nodes.length) return null;
  const target = line.plies[ply - 1]?.fen;
  if (!target) return null;
  const starts = nodes.filter((n) => samePosition(fenOf(n), line.baseFen));
  starts.sort((a, b) => (b.id === currentId) - (a.id === currentId));
  for (const start of starts) {
    let node = start;
    for (let i = 0; node && i < ply; i += 1) {
      node = childrenOf(node).find((c) => samePosition(fenOf(c), line.plies[i].fen));
    }
    if (node) return node;
  }
  return nodes.find((n) => samePosition(fenOf(n), target)) || null;
}

function buildTree() {
  const nodes = appState.build?.nodes || [];
  return {
    nodes,
    fenOf: (n) => n.fen,
    childrenOf: (n) => nodes.filter((c) => c.parent_id === n.id),
    currentId: appState.buildCurrentNodeId,
  };
}

function analysisTree() {
  const tree = appState.analysisTree;
  return {
    nodes: tree ? Array.from(tree.byId.values()) : [],
    fenOf: (n) => n.fenAfter,
    childrenOf: (n) => n.children || [],
    currentId: appState.analysisCurrentNodeId,
  };
}

/**
 * Where the Analyze coach's words are read from: the move it talks about is played
 * from `prevFen`, and a numbered move from that ply on the path to the selected node
 * (the game's mainline before the first move).
 */
export function analysisTextContext() {
  const ctx = appState.explainContext || {};
  const tree = appState.analysisTree;
  const path = [];
  for (let n = tree?.byId.get(appState.analysisCurrentNodeId || "root"); n; n = n.parent) path.push(n.fenAfter);
  return {
    fen: ctx.prevFen || ctx.fen,
    at: (ply) => path.find((fen) => plyOfFen(fen) === ply) || tree?.byId.get(ply ? `m${ply}` : "root")?.fenAfter,
  };
}

export function installMoveLinks({ selectBuildNode, selectAnalysisNode }) {
  initMoveLinks({
    orientation: () => activeBoardController()?.orientation || "white",
    apply(token, probe) {
      const view = activeViewName();
      const board = view === "build" ? boards.build : view === "analyze" ? boards.analysis : null;
      if (!board) return null;
      if (probe) return () => {};
      const pos = peekPosition(token);
      if (!pos?.line) return null;
      return () => {
        const build = view === "build";
        const node = treeNodeForLine(pos.line, pos.ply, build ? buildTree() : analysisTree());
        if (node) void (build ? selectBuildNode(node.id) : selectAnalysisNode(node.id)).catch(() => {});
        else boardLine.open({ board, view, line: pos.line, ply: pos.ply });
      };
    },
  });
  for (const id of ["analysis-pv-exit", "build-pv-exit"]) document.getElementById(id)?.addEventListener("click", () => boardLine.exit());
  registerPeekSource("#view-build [data-node-id]:is(.mtree-move, .mtree-crumb, .fork-chip)", (el) => {
    const node = appState.buildNodeById.get(el.dataset.nodeId);
    if (!node) return null;
    return { fen: node.fen, lastMove: node.uci || null, label: node.depth ? numbered(node.move_number, node.move_side, node.san) : "Start" };
  });
  registerPeekSource("#view-analyze .mtree-move[data-node-id]", (el) => {
    const node = appState.analysisTree?.byId.get(el.dataset.nodeId);
    if (!node || !node.uci) return null;
    return { fen: node.fenAfter, lastMove: node.uci, label: numbered(node.moveNumber, node.side, node.san) };
  });
  registerPeekSource(".explorer-row[data-uci]", (el) => {
    const line = walkLine(el.closest("[data-fen]")?.dataset.fen, [el.dataset.uci]);
    return line ? { fen: line.plies[0].fen, lastMove: line.plies[0].uci, label: line.plies[0].label } : null;
  });
}
