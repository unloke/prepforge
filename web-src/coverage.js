// Human-weighted repertoire coverage: at every position in MY tree where the
// OPPONENT is to move, ask Maia3 (in the browser, at the player's chosen rating)
// what humans actually play there — then measure how much of that probability
// mass my prepared replies cover, and which likely move has no answer yet.
//
// "Coverage" is reach-weighted: a hole on move 3 of their main line matters far
// more than one in a sideline nobody enters. Reach = product of the human
// probabilities of the opponent moves on the path (my own moves count as
// certain — it's my repertoire).
//
// The scan is the only feature here that costs compute, and ALL of it runs on
// the user's machine: one Maia forward per scanned node, bounded by maxNodes,
// maxDepth and reach pruning. Pure planning/scoring logic lives in functions an
// injected fake provider can drive in unit tests.

import { Chess } from "chess.js";

export const DEFAULT_MAX_DEPTH = 16; // plies — opening prep, not a full game
export const DEFAULT_MAX_NODES = 200; // Maia forwards cap (~seconds on WASM)
export const DEFAULT_MIN_REACH = 0.005; // prune lines under 0.5% of games

// Flat /api/build/load nodes -> a walkable shape: children per node id, fen +
// side-to-move per node. Disabled nodes are invisible (they're not prep).
export function buildWalk(nodes) {
  const byId = new Map();
  const children = new Map();
  let rootId = null;
  for (const node of nodes || []) {
    if (node.is_enabled === false) continue;
    byId.set(node.id, node);
    if (node.depth === 0) {
      rootId = node.id;
      continue;
    }
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node);
  }
  return { rootId, byId, children };
}

function sideToMove(fen) {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function sanFor(fen, uci) {
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move ? move.san : uci;
  } catch (_) {
    return uci;
  }
}

// Walk the tree with Maia, breadth-first by reach so the most relevant positions
// are scanned first and a node cap degrades gracefully.
//
// provider.predictions({fen, rating}) -> [{move_uci, probability}] (the shared
// Maia3 provider's surface; tests inject a stub).
export async function runCoverageScan({
  nodes,
  myColor,
  rating,
  provider,
  onProgress,
  signal,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxNodes = DEFAULT_MAX_NODES,
  minReach = DEFAULT_MIN_REACH,
}) {
  const walk = buildWalk(nodes);
  if (!walk.rootId) throw new Error("repertoire has no root");

  // Frontier of positions to examine: {nodeId, reach}. A node is *scanned* (costs
  // a Maia forward) when the opponent is to move there and I have a reply
  // prepared for at least one continuation.
  const queue = [{ nodeId: walk.rootId, reach: 1 }];
  const scanned = [];
  const gaps = [];
  let weightedCovered = 0;
  let weightTotal = 0;

  while (queue.length && scanned.length < maxNodes) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    // Highest reach first.
    queue.sort((a, b) => b.reach - a.reach);
    const { nodeId, reach } = queue.shift();
    const node = walk.byId.get(nodeId);
    const kids = walk.children.get(nodeId) || [];
    const depth = node.depth || 0;
    if (depth >= maxDepth) continue;
    const opponentToMove = sideToMove(node.fen) !== myColor;

    if (!opponentToMove) {
      // My move: deterministic — follow every prepared branch at full reach.
      for (const kid of kids) queue.push({ nodeId: kid.id, reach });
      continue;
    }
    if (!kids.length) continue; // leaf on opponent's turn: nothing prepared past here

    const preds = await provider.predictions({ fen: node.fen, rating });
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    const probByUci = new Map(
      (preds || []).map((p) => [p.move_uci, Number(p.probability) || 0]),
    );
    const prepared = new Set(kids.map((k) => k.uci));
    let covered = 0;
    let bestGap = null;
    for (const [uci, prob] of probByUci) {
      if (prepared.has(uci)) covered += prob;
      else if (!bestGap || prob > bestGap.prob) bestGap = { uci, prob };
    }
    scanned.push(nodeId);
    weightedCovered += reach * covered;
    weightTotal += reach;
    if (bestGap && bestGap.prob > 0.05) {
      gaps.push({
        nodeId,
        fen: node.fen,
        depth,
        reach,
        moveUci: bestGap.uci,
        moveSan: sanFor(node.fen, bestGap.uci),
        prob: bestGap.prob,
        impact: reach * bestGap.prob, // share of THEIR games that walk into this hole
      });
    }
    if (onProgress) onProgress({ scanned: scanned.length, max: maxNodes });

    // Descend along prepared opponent moves, discounting reach by how often
    // humans actually play them.
    for (const kid of kids) {
      const prob = probByUci.get(kid.uci) || 0;
      const childReach = reach * prob;
      if (childReach >= minReach) queue.push({ nodeId: kid.id, reach: childReach });
    }
  }

  gaps.sort((a, b) => b.impact - a.impact);
  return {
    coverage: weightTotal > 0 ? weightedCovered / weightTotal : 0,
    scannedNodes: scanned.length,
    truncated: queue.length > 0 && scanned.length >= maxNodes,
    gaps: gaps.slice(0, 10),
  };
}
