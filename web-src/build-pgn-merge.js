// Add a PGN's moves (mainline and variations) to the open repertoire. This is
// the pure half: given the tree's nodes and the PGN text it works out which
// moves are new, in the order the Build outbox must queue them (a parent
// before its children). Nothing here touches the DOM, the outbox or the network.
import { parsePgn } from "./analyze-pgn.js";
import { localBoardAfterMove } from "./chess-local.js";
import { normalizeUci, sameFenPosition } from "./build-entry.js";
import { START_FEN } from "./core/board-constants.js";
import { countOf } from "./plural.js";
import { MAX_PLAN_CHANGES, MAX_PLAN_DEPTH } from "./generated/shared-constants.js";

const isLocalOnly = (node) => String(node.id).startsWith("tmp-");

// The node the PGN's first move hangs from: the root when the PGN starts from
// the start of the repertoire, else the shallowest node in the same position.
function findAnchor(nodes, startFen) {
  const root = nodes.find((node) => node.depth === 0) || nodes[0];
  if (root && sameFenPosition(root.fen, startFen)) return root;
  let best = null;
  for (const node of nodes) {
    if (sameFenPosition(node.fen, startFen) && (!best || (node.depth || 0) < (best.depth || 0))) best = node;
  }
  return best;
}

function countMoves(pgnNode) {
  let count = 0;
  const stack = [pgnNode];
  while (stack.length) {
    const node = stack.pop();
    count += 1;
    stack.push(...(node.children || []));
  }
  return count;
}

// The server refuses a batch whose new moves run more than MAX_PLAN_DEPTH plies
// below a node it already has. Moves still waiting in the outbox are new to it
// too, so they count toward the run.
function pendingRun(node, byId) {
  let run = 0;
  for (let at = node; at && isLocalOnly(at); at = byId.get(at.parent_id)) run += 1;
  return run;
}

// → { ok: true, anchor, moves: [{ parentId, parentIndex, uci, after }], existing, skipped }
//   or { ok: false, error }. A move's parent is an existing node (parentId) or an
//   earlier entry of `moves` (parentIndex). `existing` counts the PGN's moves the
//   tree already has; `skipped` the new moves left out for running too deep.
export function planPgnMerge(nodes, pgnText, { maxMoves = MAX_PLAN_CHANGES, maxDepth = MAX_PLAN_DEPTH } = {}) {
  const parsed = parsePgn(pgnText);
  if (!parsed.ok) return { ok: false, error: `Couldn't read this PGN: ${parsed.error}` };
  if (!parsed.root.children.length) return { ok: false, error: "This PGN has no moves" };
  const startFen = parsed.headers?.FEN || START_FEN;
  const anchor = findAnchor(nodes, startFen);
  if (!anchor) return { ok: false, error: "This PGN starts from a position that isn't in the repertoire" };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const existingKids = new Map();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    if (!existingKids.has(node.parent_id)) existingKids.set(node.parent_id, []);
    existingKids.get(node.parent_id).push(node);
  }
  // Moves already planned under a parent, so a line the PGN repeats in two
  // variations is added once.
  const plannedKids = new Map();
  const moves = [];
  let existing = 0;
  let skipped = 0;

  // Depth-first, pre-order: every parent is queued before its children.
  const stack = [];
  const pushChildren = (pgnNode, parent) => {
    const kids = pgnNode.children || [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ pgn: kids[i], parent });
  };
  pushChildren(parsed.root, { node: anchor, fen: anchor.fen, run: pendingRun(anchor, byId) });
  while (stack.length) {
    const { pgn, parent } = stack.pop();
    const uci = normalizeUci(pgn.uci);
    const key = parent.node ? `n:${parent.node.id}` : `p:${parent.index}`;
    const known = parent.node
      && (existingKids.get(parent.node.id) || []).find((child) => normalizeUci(child.uci) === uci);
    if (known) {
      existing += 1;
      pushChildren(pgn, { node: known, fen: known.fen, run: isLocalOnly(known) ? parent.run + 1 : 0 });
      continue;
    }
    const planned = plannedKids.get(key)?.get(uci);
    if (planned) {
      pushChildren(pgn, planned);
      continue;
    }
    const run = parent.run + 1;
    if (run > maxDepth) {
      skipped += countMoves(pgn);
      continue;
    }
    let after;
    try {
      after = localBoardAfterMove(parent.fen, uci);
    } catch {
      return { ok: false, error: `Couldn't play ${pgn.san} from the repertoire's position` };
    }
    if (moves.length >= maxMoves) {
      return { ok: false, error: `This PGN would add more than ${maxMoves} moves. Split it and add it in parts.` };
    }
    moves.push({
      parentId: parent.node ? parent.node.id : null,
      parentIndex: parent.node ? null : parent.index,
      uci: after.move.uci,
      after,
    });
    const target = { index: moves.length - 1, fen: after.board.fen, run };
    if (!plannedKids.has(key)) plannedKids.set(key, new Map());
    plannedKids.get(key).set(uci, target);
    pushChildren(pgn, target);
  }
  return { ok: true, anchor, moves, existing, skipped };
}

// One line for the status bar once the plan is queued.
export function pgnMergeSummary({ moves, existing, skipped }) {
  const tooDeep = skipped
    ? ` · ${countOf(skipped, "move")} skipped: more than ${MAX_PLAN_DEPTH} new moves in a row`
    : "";
  if (!moves.length) {
    return skipped
      ? `Nothing added${tooDeep}`
      : "Everything in this PGN is already in the repertoire";
  }
  const already = existing ? ` (${existing} already in the repertoire)` : "";
  return `Added ${countOf(moves.length, "move")} from PGN${already}${tooDeep}`;
}
