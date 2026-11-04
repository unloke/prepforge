import { Chess } from "chess.js";

export const ATLAS_QUALITY_VERSION = "stored-route-preparation-v1";

// Opening identity: legal en passant and castling rights matter; clocks do not.
const boardKey = (board) => board.fen().split(" ").slice(0, 4).join(" ");
const priority = (node) => node.is_prepared === true
  ? (node.is_mainline ? 0 : 1) : (node.is_mainline ? 2 : 3);
const compareEdges = (a, b) => a.priority - b.priority || (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0);

/** Move-only preparation index, not validated strategic quality.
 * Own policy: prepared mainline, prepared, mainline, then lexicographic UCI.
 * Same-position outgoing edges are unioned ONLY inside the enabled scope.
 * Opponent choices split equally over distinct stored moves, not real players.
 * Survival credits a stored move unless it repeats a position on that route;
 * repetition stops before that edge earns depth. Mate/stalemate absorb success,
 * regardless of winner. No clock/repetition-based game adjudication is inferred.
 * Move orders intersects distinct occurrence reply sets, including empty sets.
 * Groups need two canonical incoming edges OR two reply sets; identical copies
 * add neither arrivals nor sets. The scoped root has its own arrival token.
 */
export function atlasPreparation({ nodes = [], myColor, rootNodeId = null, horizon = 16 }) {
  if (!["white", "black"].includes(myColor)) throw new Error("Invalid Atlas color");
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error("Invalid Atlas horizon");
  const ownTurn = myColor === "white" ? "w" : "b";
  const byId = new Map(), children = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error("Duplicate repertoire node");
    byId.set(node.id, node);
    if (node.parent_id != null) {
      if (!children.has(node.parent_id)) children.set(node.parent_id, []);
      children.get(node.parent_id).push(node);
    }
  }
  const roots = nodes.filter((n) => n.parent_id == null);
  if (rootNodeId == null && roots.length > 1) throw new Error("Multiple repertoire roots");
  const root = byId.get(rootNodeId ?? roots[0]?.id);
  if (!root && (rootNodeId != null || nodes.length)) throw new Error("Unknown Atlas root");
  const graph = new Map(), occurrences = new Map();
  let occurrenceCount = 0;
  let rootKey = null;
  if (root) {
    const ancestors = new Set();
    let ancestor = root;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) throw new Error("Repertoire contains a cycle");
      ancestors.add(ancestor.id);
      if (ancestor.is_enabled === false) throw new Error("Atlas root has a disabled ancestor");
      if (ancestor.parent_id == null) break;
      ancestor = byId.get(ancestor.parent_id);
      if (!ancestor) throw new Error("Disconnected Atlas root");
    }
    const seen = new Set(), stack = [{ node: root, arrival: "scope-root" }];
    while (stack.length) {
      const { node, arrival } = stack.pop();
      if (seen.has(node.id)) throw new Error("Repertoire contains a cycle");
      seen.add(node.id);
      occurrenceCount++;
      const board = new Chess(node.fen), key = boardKey(board);
      if (node.id === root.id) rootKey = key;
      if (!graph.has(key)) graph.set(key, {
        turn: board.turn(), terminal: board.isCheckmate() || board.isStalemate(),
        edges: new Map(), arrivals: new Set(),
      });
      const position = graph.get(key);
      position.arrivals.add(arrival);
      const next = (children.get(node.id) || []).filter((n) => n.is_enabled !== false);
      const replies = new Set();
      for (const child of next) {
        if (typeof child.uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(child.uci)) {
          throw new Error("Invalid repertoire move");
        }
        const after = new Chess(node.fen);
        try {
          after.move({ from: child.uci.slice(0, 2), to: child.uci.slice(2, 4), promotion: child.uci[4] });
        } catch { throw new Error("Repertoire contains an illegal move"); }
        const target = boardKey(after);
        if (target !== boardKey(new Chess(child.fen))) throw new Error("Repertoire move and position disagree");
        const edge = { uci: child.uci, target, priority: priority(child) };
        const existing = position.edges.get(edge.uci);
        if (!existing || edge.priority < existing.priority) position.edges.set(edge.uci, edge);
        replies.add(child.uci);
        stack.push({ node: child, arrival: `${key}:${child.uci}` });
      }
      if (position.turn === ownTurn && !position.terminal) {
        if (!occurrences.has(key)) occurrences.set(key, new Map());
        occurrences.get(key).set([...replies].sort().join(","), replies);
      }
    }
  }

  let edges = 0, ownPositions = 0, answeredPositions = 0, repeatedGroups = 0, commonGroups = 0;
  for (const position of graph.values()) {
    edges += position.edges.size;
    if (position.turn === ownTurn && !position.terminal) {
      ownPositions++;
      if (position.edges.size) answeredPositions++;
    }
    position.ordered = [...position.edges.values()].sort(compareEdges);
  }
  for (const [key, sets] of occurrences) {
    if (sets.size < 2 && graph.get(key).arrivals.size < 2) continue;
    repeatedGroups++;
    const [first, ...rest] = sets.values();
    if ([...first].some((uci) => rest.every((set) => set.has(uci)))) commonGroups++;
  }

  const survival = Array(horizon + 1).fill(0), reasons = new Set();
  const visit = (key, depth, mass, path) => {
    const position = graph.get(key);
    if (position.terminal) {
      for (let h = depth + 1; h <= horizon; h++) survival[h] += mass;
      reasons.add("terminal");
      return;
    }
    if (depth === horizon) { reasons.add("horizon"); return; }
    if (!position.ordered.length) { reasons.add("missing-continuation"); return; }
    const choices = position.turn === ownTurn ? position.ordered.slice(0, 1) : position.ordered;
    const share = mass / choices.length;
    for (const edge of choices) {
      if (path.has(edge.target)) { reasons.add("repetition"); continue; }
      survival[depth + 1] += share;
      path.add(edge.target);
      visit(edge.target, depth + 1, share, path);
      path.delete(edge.target);
    }
  };
  if (rootKey && edges) {
    survival[0] = 1;
    visit(rootKey, 0, 1, new Set([rootKey]));
  }
  // Clamp floating overshoot only; no redistribution of stopped route mass.
  const unit = (value) => Math.max(0, Math.min(1, value));
  const reach = unit(survival[horizon]);
  const depth = survival.slice(1).reduce((sum, value) => sum + unit(value), 0);
  const reference = "Stored-route reference: own deterministic selected move; opponent uniform over distinct stored moves; scoped position continuations unioned. Not empirical coverage or move quality.";
  const facet = (key, label, numerator, denominator, definition) => ({
    key, label, numerator: edges ? numerator : 0, denominator: edges ? denominator : 0,
    value: edges && denominator ? 100 * numerator / denominator : null,
    definition,
  });
  const facets = [
    facet("replies", "Replies", answeredPositions, ownPositions,
      "Unique nonterminal own-to-move positions with a legal stored reply / all such positions, including frontier positions."),
    facet("reach", "Reach", reach, 1,
      "Stored-route mass reaching the horizon or checkmate/stalemate. Missing continuations and repetition stop; opponent branches have equal stored-move weight."),
    facet("depth", "Depth", depth, horizon,
      "Mean stored-route survival over plies 1 through the horizon; terminal positions absorb success. Repetition earns no additional depth."),
    facet("moveOrders", "Move orders", commonGroups, repeatedGroups,
      "Own-position groups whose reply sets share a move / groups with at least two distinct canonical arrivals or reply sets. Empty sets participate; identical copies collapse."),
  ];
  const applicable = facets.filter((f) => f.value !== null);
  return {
    score: applicable.length ? applicable.reduce((sum, f) => sum + f.value, 0) / applicable.length : null,
    facets,
    counts: { positions: graph.size, occurrences: occurrenceCount, moves: edges,
      ownPositions, answeredPositions, repeatedGroups, commonGroups },
    algorithmVersion: ATLAS_QUALITY_VERSION, horizon,
    stopReasons: [...reasons].sort(), reference,
  };
}
