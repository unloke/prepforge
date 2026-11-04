import { Chess } from "chess.js";
import { atlasEase } from "./atlas-ease.js";
import { gamePhase } from "./coach/material.js";

export const ATLAS_QUALITY_VERSION = "stored-plan-preparation-v2";

// Opening identity: legal en passant and castling rights matter; clocks do not.
const boardKey = (board) => board.fen().split(" ").slice(0, 4).join(" ");
const priority = (node) => node.is_prepared === true
  ? (node.is_mainline ? 0 : 1) : (node.is_mainline ? 2 : 3);

/** Move-only preparation index, not validated strategic quality.
 * Each occurrence selects its best priority tier; tied chapter plans coexist.
 * Same-position outgoing edges are unioned ONLY inside the enabled scope.
 * Core choices split equally over distinct preferred moves, not real players.
 * Survival credits a stored move unless it repeats a position on that route;
 * repetition stops before that edge earns depth. A stored loss stops depth;
 * winning mate/stalemate absorb survival. No repetition adjudication is inferred.
 * Consistency intersects nonempty preferred reply sets, ignoring local endpoints.
 * Groups need two canonical incoming edges OR two reply sets; identical copies
 * add neither arrivals nor sets. The scoped root has its own arrival token.
 */
export function atlasPreparation({ nodes = [], myColor, rootNodeId = null, horizon = 32 }) {
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
    const openingScope = gamePhase(root.fen) === "opening";
    const seen = new Set(), stack = [{ node: root, arrival: "scope-root", eligible: true, previousPhase: "opening", quiet: 0 }];
    while (stack.length) {
      const { node, arrival, eligible, previousPhase, quiet } = stack.pop();
      if (seen.has(node.id)) throw new Error("Repertoire contains a cycle");
      seen.add(node.id);
      occurrenceCount++;
      const board = new Chess(node.fen), key = boardKey(board);
      const phase = eligible ? gamePhase(node.fen) : null;
      const boundary = openingScope && phase !== "opening" && previousPhase !== "opening" && quiet >= 2 && !board.isCheck();
      if (node.id === root.id) rootKey = key;
      if (eligible && !graph.has(key)) graph.set(key, {
        board,
        boundary,
        turn: board.turn(), terminal: board.isCheckmate() || board.isStalemate(),
        edges: new Map(), arrivals: new Set(),
      });
      const position = graph.get(key);
      if (eligible) {
        position.arrivals.add(arrival);
        position.boundary &&= boundary;
      }
      const next = (children.get(node.id) || []).filter((n) => n.is_enabled !== false);
      const best = Math.min(...next.map(priority));
      const replies = new Set();
      for (const child of next) {
        if (typeof child.uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(child.uci)) {
          throw new Error("Invalid repertoire move");
        }
        const after = new Chess(node.fen);
        let move;
        try {
          move = after.move({ from: child.uci.slice(0, 2), to: child.uci.slice(2, 4), promotion: child.uci[4] });
        } catch { throw new Error("Repertoire contains an illegal move"); }
        const target = boardKey(after);
        if (target !== boardKey(new Chess(child.fen))) throw new Error("Repertoire move and position disagree");
        const edge = { uci: child.uci, target, priority: priority(child), core: priority(child) === best };
        const selected = eligible && !boundary && (board.turn() !== ownTurn || edge.priority === best);
        if (selected) {
          const existing = position.edges.get(edge.uci);
          if (existing) { edge.core ||= existing.core; existing.core ||= edge.core; }
          if (!existing || edge.priority <= existing.priority) position.edges.set(edge.uci, edge);
          replies.add(child.uci);
        }
        stack.push({ node: child, arrival: `${key}:${child.uci}`, eligible: selected,
          previousPhase: phase, quiet: !move.captured && !move.promotion && !after.isCheck() ? quiet + 1 : 0 });
      }
      if (eligible && position.turn === ownTurn && !position.terminal && replies.size) {
        if (!occurrences.has(key)) occurrences.set(key, new Map());
        occurrences.get(key).set([...replies].sort().join(","), replies);
      }
    }
  }

  let edges = 0, ownPositions = 0, answeredPositions = 0, repeatedGroups = 0, commonGroups = 0;
  for (const position of graph.values()) {
    edges += position.edges.size;
    // UCI ordering only stabilizes arithmetic; it never chooses one chapter plan.
    position.ordered = [...position.edges.values()].sort((a, b) => a.uci.localeCompare(b.uci));
  }

  const survival = Array(horizon + 1).fill(0), reasons = new Set(), corePositions = new Set();
  const visit = (key, depth, mass, path) => {
    const position = graph.get(key);
    if (depth < horizon) corePositions.add(key);
    if (position.boundary) {
      for (let h = depth + 1; h <= horizon; h++) survival[h] += mass;
      reasons.add("opening-complete");
      return;
    }
    if (position.terminal) {
      if (position.board.isCheckmate() && position.turn === ownTurn) {
        reasons.add("terminal-loss");
        return;
      }
      for (let h = depth + 1; h <= horizon; h++) survival[h] += mass;
      reasons.add("terminal");
      return;
    }
    if (depth === horizon) { reasons.add("horizon"); return; }
    if (!position.ordered.length) { reasons.add("missing-continuation"); return; }
    const choices = position.ordered.filter((edge) => edge.core);
    const share = mass / choices.length;
    for (const edge of choices) {
      if (path.has(edge.target)) { reasons.add("repetition"); continue; }
      const target = graph.get(edge.target);
      if (depth + 1 < horizon && position.turn !== ownTurn && !target.terminal &&
          !target.boundary && !target.edges.size) {
        corePositions.add(edge.target);
        reasons.add("missing-reply");
        continue;
      }
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
  const depth = survival.slice(1).reduce((sum, value) => sum + unit(value), 0);
  const distances = new Map(), queue = rootKey ? [rootKey] : [];
  if (rootKey) distances.set(rootKey, 0);
  let answeredAlternatives = 0;
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i], distance = distances.get(key), position = graph.get(key);
    if (distance >= horizon) continue;
    if (corePositions.has(key) && position.turn === ownTurn && !position.terminal && !position.boundary) {
      ownPositions++;
      if (position.edges.size) answeredPositions++;
    }
    if (position.turn !== ownTurn && distance + 1 < horizon) {
      const answered = position.ordered.filter((edge) => {
        const target = graph.get(edge.target);
        return target.terminal || target.boundary || target.edges.size > 0;
      }).length;
      answeredAlternatives += Math.max(0, answered - 1);
    }
    for (const edge of position.ordered) if (!distances.has(edge.target)) {
      distances.set(edge.target, distance + 1);
      queue.push(edge.target);
    }
  }
  for (const [key, sets] of occurrences) {
    if (!distances.has(key) || distances.get(key) >= horizon) continue;
    if (sets.size < 2 && graph.get(key).arrivals.size < 2) continue;
    repeatedGroups++;
    const [first, ...rest] = sets.values();
    if ([...first].some((uci) => rest.every((set) => set.has(uci)))) commonGroups++;
  }
  const ease = atlasEase(graph, distances, ownTurn, horizon);
  const reference = "Preferred-tier core plans receive equal weights. Replies measures core own-response availability; all eligible stored opponent branches can establish Reach, not core Depth. Opening completion uses the existing phase detector after two quiet plies; scope-relative horizon is a safety limit. Total is sqrt(Reach * Depth), with missing core replies already stopping Depth. Consistency and Ease describe learning load.";
  const facet = (key, label, numerator, denominator, definition) => ({
    key, label, numerator: edges ? numerator : 0, denominator: edges ? denominator : 0,
    value: edges && denominator ? 100 * numerator / denominator : null,
    definition,
  });
  const facets = [
    facet("replies", "Replies", answeredPositions, ownPositions,
      "Unique core-plan own positions with a stored reply / core-plan own positions requiring a reply before the horizon or opening completion. Short nonpreferred side lines are assessed as answered breadth, not required core replies."),
    facet("reach", "Reach", 1 + answeredAlternatives, 5 + answeredAlternatives,
      `Answered opponent alternatives beyond the first at each unique position within ${horizon} plies or opening completion. Score = 100 × (1 + alternatives) / (5 + alternatives); a single route scores 20. Not empirical coverage.`),
    facet("depth", "Depth", depth, horizon,
      `Core-plan completion through ${horizon} plies or opening end. The existing phase detector must leave opening across consecutive positions, with two quiet plies and no check. Winning mate/stalemate also complete; a stored loss or repetition stops. Short nonpreferred opponent side lines do not dilute core Depth.`),
    facet("moveOrders", "Consistency", commonGroups, repeatedGroups,
      "Repeated own positions sharing a preferred reply across nonempty occurrences. Local chapter endpoints ignored. Alternatives can be intentional; excluded from Preparation."),
    facet("ease", "Ease", ease.numerator, ease.denominator,
      "Reuse of the next two own actions in comparable positions: identical own setup, material and king/castling phase; opponent pawn structure differs by at most one relocation; checks excluded. No comparable positions = unmeasured. Excluded from Preparation."),
  ];
  // Missing core replies already stop Depth. Multiplying their availability
  // ratio into the total again rewards hiding newly exposed unanswered leaves.
  const applicable = facets.filter((f) => ["reach", "depth"].includes(f.key) && f.value !== null);
  return {
    score: applicable.length ? Math.pow(applicable.reduce((product, f) => product * f.value, 1), 1 / applicable.length) : null,
    facets,
    counts: { positions: graph.size, occurrences: occurrenceCount, moves: edges,
      ownPositions, answeredPositions, repeatedGroups, commonGroups, answeredAlternatives,
      easePositions: ease.denominator, easePairs: ease.pairs, identicalPositionPairs: ease.identicalPositionPairs,
      openingBoundaries: [...graph.values()].filter((p) => p.boundary).length },
    algorithmVersion: ATLAS_QUALITY_VERSION, horizon,
    stopReasons: [...reasons].sort(), reference,
  };
}
