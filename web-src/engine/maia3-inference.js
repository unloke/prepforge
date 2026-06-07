// Maia3 inference math — PURE functions over raw model logits + a FEN.
//
// Split out of the worker so the policy/value post-processing is unit-testable in
// node (vitest) without onnxruntime-web or a Web Worker: the worker runs the ONNX
// session and hands the raw output arrays here. Faithful to the Python adapter
// (src/prepforge_chess/services/maia.py) and maia3.uci:
//   - legal-masked softmax over the policy logits (Build Generate's distribution),
//   - the side-to-move (mirrored) move frame for human-probability lookup,
//   - the WDL value transform (wdl_from_value_logits / invert_wdl, largest-remainder
//     permille rounding) → win_chance_after for the mover.
import { Chess } from "chess.js";

import {
  NUM_SQUARES,
  TOKEN_DIM,
  MOVE_TO_INDEX,
  mirrorMove,
  legalMoveIndices,
  moveFromIndex,
} from "./maia3-tokenizer.js";

// Tokens are (NUM_SQUARES × TOKEN_DIM) per position; re-exported so the worker can
// size its batch tensor without re-deriving the layout.
export const TOKENS_PER_POSITION = NUM_SQUARES * TOKEN_DIM;

// Legal-masked softmax over ONLY the legal logit indices → Map<index, prob>. Identical
// to masking the full vector to -inf and softmaxing, but over the known legal set so
// we never re-derive the move mapping. Empty legal set → empty map (NOT a degenerate
// softmax that would yield -Infinity/0/NaN).
export function legalMaskedProbs(logitsMove, legalIndices) {
  const probByIndex = new Map();
  if (legalIndices.length === 0) return probByIndex;
  let max = -Infinity;
  for (const i of legalIndices) if (logitsMove[i] > max) max = logitsMove[i];
  const ex = new Array(legalIndices.length);
  let sum = 0;
  for (let k = 0; k < legalIndices.length; k++) {
    const e = Math.exp(logitsMove[legalIndices[k]] - max);
    ex[k] = e;
    sum += e;
  }
  for (let k = 0; k < legalIndices.length; k++) probByIndex.set(legalIndices[k], ex[k] / sum);
  return probByIndex;
}

// predictions(): the legal moves sorted by human probability (desc), each with a
// 1-based rank. Returns [] when the position has NO legal moves (checkmate/stalemate)
// — the terminal contract: short-circuits BEFORE any softmax. `topN` (optional) caps
// the list the way the Python adapter's multipv does.
export function buildPredictions(logitsMove, fen, { topN } = {}) {
  const legal = legalMoveIndices(fen);
  if (legal.length === 0) return []; // terminal position — nothing to predict
  const probByIndex = legalMaskedProbs(logitsMove, legal);
  const rows = [];
  for (const idx of legal) {
    const uci = moveFromIndex(idx, fen); // real (un-mirrored) move for this position
    if (uci === null) continue; // defensive: legal indices map back by construction
    rows.push({ move_uci: uci, probability: probByIndex.get(idx) ?? 0 });
  }
  // Sort by prob desc, then uci asc as a deterministic tiebreak (topk order is
  // otherwise arbitrary for equal probabilities).
  rows.sort((a, b) => b.probability - a.probability || (a.move_uci < b.move_uci ? -1 : 1));
  const limit = topN && topN > 0 ? Math.min(topN, rows.length) : rows.length;
  return rows.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}

// A reusable lookup: given the current-position policy logits + fen, return prob-of(uci)
// in the legal-masked distribution (0 if the move isn't legal / isn't in vocab). Built
// once so a batch of candidate moves shares one softmax. The move is mapped INTO the
// model's side-to-move frame (mirrored for black) before the vocab lookup — a naive
// un-mirrored lookup returns ~0 for black to move (see brilliant-search-cap memory).
export function makeHumanProbabilityLookup(logitsMove, fen) {
  const blackToMove = new Chess(fen).turn() === "b";
  const probByIndex = legalMaskedProbs(logitsMove, legalMoveIndices(fen));
  return (moveUci) => {
    const vocabUci = blackToMove ? mirrorMove(moveUci) : moveUci;
    const idx = MOVE_TO_INDEX.get(vocabUci);
    if (idx === undefined) return 0;
    return probByIndex.get(idx) ?? 0;
  };
}

export function humanProbability(logitsMove, fen, moveUci) {
  return makeHumanProbabilityLookup(logitsMove, fen)(moveUci);
}

// Softmax over a 3-vector (value head: [loss, draw, win] for the side to move).
export function softmax3(v) {
  const m = Math.max(v[0], v[1], v[2]);
  const e0 = Math.exp(v[0] - m);
  const e1 = Math.exp(v[1] - m);
  const e2 = Math.exp(v[2] - m);
  const s = e0 + e1 + e2;
  return [e0 / s, e1 / s, e2 / s];
}

// Largest-remainder rounding of probabilities to integer permille summing to 1000.
// Port of maia3.uci._probabilities_to_permille (so win_chance matches torch to the
// manifest's winchance tolerance). int() truncates toward zero; inputs are >= 0.
export function probabilitiesToPermille(probs) {
  const scaled = probs.map((p) => Math.max(0, p) * 1000);
  const ints = scaled.map((v) => Math.trunc(v));
  const remainder = 1000 - ints.reduce((a, b) => a + b, 0);
  // Distribute the leftover to the largest fractional remainders first. Array.sort is
  // stable (ES2019+), so ties keep input order — matching Python's stable sorted().
  const order = scaled.map((_, i) => i).sort((a, b) => scaled[b] - ints[b] - (scaled[a] - ints[a]));
  for (let k = 0; k < Math.max(0, remainder); k++) ints[order[k]] += 1;
  return ints;
}

// win_chance_after for the MOVER, from the after-move value logits ([loss, draw, win]
// in the OPPONENT-to-move perspective, since it's the resulting position). Mirrors
// maia.py:  win, draw, loss = invert_wdl(wdl_from_value_logits(value_logits[0]))
//           win_chance = (win + 0.5 * draw) / 1000
// wdl_from_value_logits softmaxes then permille-rounds (win, draw, loss); invert_wdl
// swaps win<->loss back to the mover. Net: mover-win = permille of the LOSS prob,
// draw unchanged.
export function winChanceAfter(valueLogits) {
  const [pLoss, pDraw, pWin] = softmax3(valueLogits);
  const [, permDraw, permLoss] = probabilitiesToPermille([pWin, pDraw, pLoss]);
  return (permLoss + 0.5 * permDraw) / 1000;
}
