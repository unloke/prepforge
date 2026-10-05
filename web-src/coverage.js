import { Chess } from "chess.js";

export const COVERAGE_ALGORITHM_VERSION = "coverage-first-gap-v2";
export const DEFAULT_MAX_DEPTH = 16;
export const DEFAULT_MAX_NODES = 200;
export const DEFAULT_MIN_REACH = 0.005;

export function buildWalk(nodes) {
  const byId = new Map();
  const children = new Map();
  let rootId = null;
  for (const node of nodes || []) {
    if (node.is_enabled === false) continue;
    if (byId.has(node.id)) throw new Error("Duplicate repertoire node");
    byId.set(node.id, node);
    if (node.depth === 0) {
      if (rootId !== null) throw new Error("Multiple repertoire roots");
      rootId = node.id;
    } else {
      if (!children.has(node.parent_id)) children.set(node.parent_id, []);
      children.get(node.parent_id).push(node);
    }
  }
  return { rootId, byId, children };
}

function abortError() {
  return new DOMException("Coverage stopped", "AbortError");
}

// Cancels this wait, not the shared provider. Late replies remain observed.
export function waitForCoverageRead(read, signal) {
  if (!signal) return Promise.resolve(read);
  if (signal.aborted) {
    Promise.resolve(read).catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(read).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function validateChild(parent, child) {
  const chess = new Chess(parent.fen);
  const uci = String(child.uci || "");
  try {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch (_) { throw new Error("Repertoire contains an illegal move"); }
  if (new Chess(child.fen).fen() !== chess.fen()) {
    throw new Error("Repertoire move and position disagree");
  }
}

function ownReply(walk, nodeId) {
  const replies = (walk.children.get(nodeId) || []).filter((n) => n.is_prepared === true);
  const reply = replies.find((n) => n.is_mainline) || replies[0] || null;
  if (reply) validateChild(walk.byId.get(nodeId), reply);
  return reply;
}

function pathTo(walk, nodeId) {
  const path = [];
  const seen = new Set();
  let node = walk.byId.get(nodeId);
  while (node) {
    if (seen.has(node.id)) throw new Error("Repertoire contains a cycle");
    seen.add(node.id);
    if (node.uci) path.push(node);
    node = walk.byId.get(node.parent_id);
  }
  return path.reverse();
}

// Structural identity includes optimistic edits, not just the server revision.
// Mastery, comments and arrows do not change chess coverage.
export function coverageTreeKey(nodes) {
  return JSON.stringify((nodes || []).map((n) => [
    n.id, n.parent_id, n.uci, n.fen, n.is_enabled, n.is_prepared, n.is_mainline,
  ]));
}

export async function runCoverageScan({
  nodes, myColor, rating, provider, onProgress, signal, rootNodeId = null,
  maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES,
  minReach = DEFAULT_MIN_REACH, maxGaps = 50,
}) {
  const walk = buildWalk(nodes);
  const root = walk.byId.get(rootNodeId ?? walk.rootId);
  if (!root) throw new Error("Repertoire has no enabled scan root");
  // Verify the scope is reachable, including every ancestor.
  let ancestor = root;
  const ancestors = new Set();
  while (ancestor.parent_id != null) {
    if (ancestors.has(ancestor.id)) throw new Error("Repertoire contains a cycle");
    ancestors.add(ancestor.id);
    ancestor = walk.byId.get(ancestor.parent_id);
    if (!ancestor) throw new Error("Scan root is in a disabled or disconnected branch");
  }

  const queue = [{ nodeId: root.id, reach: 1, ply: 0 }];
  const gaps = [];
  const reasons = new Set();
  let coveredMass = 0;
  let unknownMass = 0;
  let gapMass = 0;
  let scannedNodes = 0;
  const visited = new Set();

  while (queue.length) {
    if (signal?.aborted) throw abortError();
    queue.sort((a, b) => b.reach - a.reach);
    const { nodeId, reach, ply } = queue.shift();
    if (visited.has(nodeId)) throw new Error("Repertoire contains repeated or cyclic branches");
    visited.add(nodeId);
    const node = walk.byId.get(nodeId);
    const chess = new Chess(node.fen);
    if (chess.isGameOver() || ply >= maxDepth) {
      coveredMass += reach;
      continue;
    }
    if (reach < minReach) {
      unknownMass += reach;
      reasons.add("reach");
      continue;
    }
    if ((chess.turn() === "w" ? "white" : "black") === myColor) {
      const reply = ownReply(walk, nodeId);
      if (reply) queue.push({ nodeId: reply.id, reach, ply: ply + 1 });
      else {
        unknownMass += reach;
        reasons.add("no-own-policy");
      }
      continue;
    }
    if (scannedNodes >= maxNodes) {
      unknownMass += reach;
      reasons.add("nodes");
      continue;
    }
    const predictions = await waitForCoverageRead(provider.predictions({ fen: node.fen, rating }), signal);
    if (signal?.aborted) throw abortError();
    const legal = new Map(chess.moves({ verbose: true }).map((m) => [m.from + m.to + (m.promotion || ""), m.san]));
    const probabilities = new Map();
    let total = 0;
    for (const p of predictions || []) {
      const prob = p.probability;
      if (!legal.has(p.move_uci) || probabilities.has(p.move_uci) ||
          typeof prob !== "number" || !Number.isFinite(prob) || prob < 0 || prob > 1) {
        throw new Error("Maia returned an invalid probability distribution");
      }
      probabilities.set(p.move_uci, prob);
      total += prob;
    }
    if (total > 1.00001) throw new Error("Maia probabilities exceed 100%");
    // Tiny floating-point excess is normalized; missing probability is unknown.
    const scale = total > 1 ? 1 / total : 1;
    unknownMass += reach * Math.max(0, 1 - total);
    if (total < 0.99999) reasons.add("model-mass");
    const kids = walk.children.get(nodeId) || [];
    const path = pathTo(walk, nodeId);
    for (const [uci, rawProb] of probabilities) {
      const prob = rawProb * scale;
      if (!prob) continue;
      const child = kids.find((n) => n.uci === uci);
      let answered = false;
      if (child) {
        validateChild(node, child);
        const after = new Chess(child.fen);
        answered = after.isGameOver() || !!ownReply(walk, child.id);
      }
      const impact = reach * prob;
      if (!answered) {
        gapMass += impact;
        gaps.push({
          gapId: `${nodeId}:${uci}`, nodeId, fen: node.fen, depth: node.depth || 0,
          existingOpponentNodeId: child?.id ?? null,
          kind: child ? "missing_reply" : "missing_branch",
          reach, prob, impact, moveUci: uci, moveSan: legal.get(uci),
          pathUcis: path.map((n) => n.uci), pathSans: path.map((n) => n.san || n.uci),
        });
      } else {
        queue.push({ nodeId: child.id, reach: impact, ply: ply + 1 });
      }
    }
    scannedNodes += 1;
    onProgress?.({ scanned: scannedNodes, max: maxNodes });
  }
  gaps.sort((a, b) => b.impact - a.impact || a.gapId.localeCompare(b.gapId));
  return {
    algorithmVersion: COVERAGE_ALGORITHM_VERSION,
    ownPolicy: "prepared-mainline", rootNodeId: root.id, maxDepth,
    coverage: coveredMass, coveredMass, gapMass, unknownMass, scannedNodes,
    status: unknownMass > 0.00001 ? "partial" : "complete",
    truncated: unknownMass > 0.00001, stopReasons: [...reasons],
    totalGapCount: gaps.length, omittedGapCount: Math.max(0, gaps.length - maxGaps),
    gaps: gaps.slice(0, maxGaps),
  };
}
