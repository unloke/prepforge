import { Chess } from "chess.js";
import { atlasEase } from "./atlas-ease.js";
import { gamePhase } from "./coach/material.js";
import { atlasContentFeatures } from "./atlas-content-features.js";
import { calibratedAtlasValue } from "./atlas-calibration.js";

export const ATLAS_QUALITY_VERSION = "content-calibration-v3";

// Opening identity: legal en passant and castling rights matter; clocks do not.
const boardKey = (board) => board.fen().split(" ").slice(0, 4).join(" ");
const priority = (node) => node.is_prepared === true
  ? (node.is_mainline ? 0 : 1) : (node.is_mainline ? 2 : 3);

/** Move-content estimates fitted to frozen qualitative facet judgments.
 * Each occurrence selects its best priority tier; tied chapter plans coexist.
 * Same-position outgoing edges are unioned ONLY inside the enabled scope.
 * Core choices split equally over distinct preferred moves, not real players.
 * Survival credits a stored move unless it repeats a position on that route;
 * repetition stops before that edge earns depth. A stored loss stops depth;
 * winning mate/stalemate absorb survival. No repetition adjudication is inferred.
 * Repeated-choice evidence intersects nonempty reply sets, ignoring endpoints.
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
    corePositions.add(key);
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
  const features = atlasContentFeatures(graph, distances, ownTurn, horizon,
    { depth, corePositions, repeatedGroups, commonGroups, ease });
  const reference = "Move-only estimates calibrated against 225 frozen qualitative facet judgments from 38 studies (45 sides), using opening-family validation. Single reviewer, previously exposed to scores; exploratory development, not independent quality certification. Preferred-tier core routes and stable phase boundaries delimit opening content. Supported opponent alternatives require follow-up beyond one own move. Preparation combines supported breadth and route/deployment adequacy; Consistency and Ease remain learning-load profiles. Missing or illustrative author intent is not inferred.";
  const facet = (key, label, numerator, denominator, definition) => ({
    key, label, numerator: edges ? numerator : 0, denominator: edges ? denominator : 0,
    value: edges && (key === "moveOrders" ? ownPositions > 1 : denominator > 0)
      ? calibratedAtlasValue(key, features) : null,
    definition,
  });
  const facets = [
    facet("replies", "Replies", answeredPositions, ownPositions,
      "Calibrated response preparation: supported opponent alternatives and route/deployment adequacy. A one-move answer supplies less evidence than continued preparation. Unrecorded opponent moves are unknown."),
    facet("reach", "Reach", 1 + answeredAlternatives, 5 + answeredAlternatives,
      `Calibrated breadth of supported opponent plans within ${horizon} plies or opening completion, both across positions and per route. Follow-up support looks ahead at most six plies; a lone own answer adds no support. Not empirical coverage.`),
    facet("depth", "Depth", depth, horizon,
      `Calibrated handover depth: core route completion through ${horizon} plies or stable opening end, plus own development at distinct core endpoints. Short nonpreferred opponent illustrations do not dilute the core. Development is structural, not a safety evaluation.`),
    facet("moveOrders", "Consistency", commonGroups, repeatedGroups,
      "Calibrated plan coherence: early alternative-choice burden, common preferred replies at repeated positions, and pawn-setup reuse. Reconverging move orders receive no choice burden. Intentional systems are legitimate; excluded from Preparation."),
    facet("ease", "Ease", ease.numerator, ease.denominator,
      "Calibrated learning ease: two-action reuse under the same own pawn structure, development stage, material and king/castling phase, similar opponent pawns, quiet-move share and choice burden. No comparable positions = unmeasured. Excluded from Preparation."),
  ];
  return {
    score: edges ? calibratedAtlasValue("overall", features) : null,
    facets,
    features,
    counts: { positions: graph.size, occurrences: occurrenceCount, moves: edges,
      ownPositions, answeredPositions, repeatedGroups, commonGroups, answeredAlternatives,
      easePositions: ease.denominator, easePairs: ease.pairs, identicalPositionPairs: ease.identicalPositionPairs,
      openingBoundaries: [...graph.values()].filter((p) => p.boundary).length },
    algorithmVersion: ATLAS_QUALITY_VERSION, horizon,
    stopReasons: [...reasons].sort(), reference,
  };
}
