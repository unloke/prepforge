// Critical-position scorer for I'm Feeling Lucky. Pure: chess.js features in,
// one number out. No DOM, no network, no engine — the async picker
// (train-lucky-db.js) adds explorer/Maia/Stockfish evidence on top.

import { Chess } from "chess.js";

export const CRITICAL_THRESHOLD = 5.0;
export const SHARP_THRESHOLD = 7.0;

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function extractLocalFeatures(fen, ply = 0) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  const squares = chess.board().flat().filter(Boolean);
  let whiteMat = 0;
  let blackMat = 0;
  let nonPawnMat = 0;
  let queens = 0;
  for (const sq of squares) {
    const type = String(sq.type || "").toLowerCase();
    const value = PIECE_VALUES[type] || 0;
    if (sq.color === "w") whiteMat += value;
    else blackMat += value;
    if (type !== "p" && type !== "k") nonPawnMat += value;
    if (type === "q") queens += 1;
  }
  let captures = 0;
  let pawnBreaks = 0;
  let checks = 0;
  let promotions = 0;
  for (const move of moves) {
    const flags = String(move.flags || "");
    if (flags.includes("c") || flags.includes("e")) captures += 1;
    if (move.piece === "p" && (flags.includes("b") || flags.includes("c"))) pawnBreaks += 1;
    if (String(move.san || "").includes("+")) checks += 1;
    if (flags.includes("p")) promotions += 1;
  }
  let hanging = 0;
  try {
    const own = chess.turn();
    const enemy = own === "w" ? "b" : "w";
    let probed = 0;
    for (const move of moves) {
      if (hanging >= 4 || probed >= 10) break;
      const flags = String(move.flags || "");
      if (!flags.includes("c") && !flags.includes("e")) continue;
      probed += 1;
      const hitByEnemy = chess.attackers(move.to, enemy).length > 0;
      const defended = chess.attackers(move.to, own).some((sq) => sq !== move.from);
      if (hitByEnemy && !defended) hanging += 1;
    }
  } catch (_) {
    hanging = 0;
  }
  return {
    ply,
    nLegal: moves.length,
    nCaptures: captures,
    nChecks: checks,
    nPromotions: promotions,
    nPawnBreaks: pawnBreaks,
    nHanging: hanging,
    nPieces: squares.length,
    nonPawnMat,
    matDiff: Math.abs(whiteMat - blackMat),
    queensOff: queens < 2,
    inCheck: chess.isCheck(),
  };
}

export const PHASES = ["opening", "middlegame", "endgame"];

// Game-phase division ported from lichess-org/scalachess Divider.scala
// (core/src/main/scala/Divider.scala). Lichess computes this per GAME from the
// board sequence — not per position — and uses it for the Opening/Middlegame/
// Endgame accuracy split in computer analysis:
//
//   middlegame starts at the first board where any of:
//     - majorsAndMinors <= 10  (queens+rooks+bishops+knights of both sides)
//     - backrankSparse         (< 4 of your own pieces still on your back rank,
//                               i.e. the army has developed out)
//     - mixedness > 150        (both colors intermingled in sliding 2x2
//                               regions — real contact, not just trades)
//   endgame starts (only searched AFTER middlegame) at the first board where
//     majorsAndMinors <= 6.
//
// Deliberately: no queen rule, no ply rule, no raw piece count. A queenless
// middlegame with full armies stays middlegame; an early mass-simplification
// can end the opening on ply 12. Faithful port, bitboards replaced by square
// counting (chess.js `board()` gives {type, color, square} per occupied cell).
//
// boards: array of square lists, one per ply — each entry is the occupied
// squares of one position as {type, color, square} (chess.js `board()` rows
// flattened). Returns {middle, end} as ply indices (null when the game never
// gets there), matching lichess Division(middle, end).

const MAJORS_AND_MINORS = new Set(["q", "r", "b", "n"]);
const BACKRANK = { w: new Set(["a1", "b1", "c1", "d1", "e1", "f1", "g1", "h1"]) };
BACKRANK.b = new Set(["a8", "b8", "c8", "d8", "e8", "f8", "g8", "h8"]);

function squareIndex(square) {
  const file = String(square || "").charCodeAt(0) - 97;
  const rank = Number(String(square || "")[1]) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

export function majorsAndMinors(squares) {
  let count = 0;
  for (const sq of squares || []) {
    if (MAJORS_AND_MINORS.has(String(sq.type || "").toLowerCase())) count += 1;
  }
  return count;
}

// Sparse back-rank indicates that pieces have been developed: fewer than 4 of
// your own pieces still sitting on your first rank.
export function backrankSparse(squares) {
  let white = 0;
  let black = 0;
  for (const sq of squares || []) {
    const square = sq.square;
    if (sq.color === "w" && BACKRANK.w.has(square)) white += 1;
    else if (sq.color === "b" && BACKRANK.b.has(square)) black += 1;
  }
  return white < 4 || black < 4;
}

// Per-2x2-region intermingling score, verbatim from Divider.score: rows are
// scored by rank band y (1..7 from White's side) and the (white, black) piece
// counts inside the region. Sliding the 2x2 window over all 7x7 origins and
// summing gives mixedness; contact positions score high, home armies score 0.
export function regionScore(y, white, black) {
  switch (white) {
    case 0:
      switch (black) {
        case 1: return 1 + y;
        case 2: return y < 6 ? 2 + (6 - y) : 0;
        case 3: return y < 7 ? 3 + (7 - y) : 0;
        case 4: return y < 7 ? 3 + (7 - y) : 0;
        default: return 0;
      }
    case 1:
      switch (black) {
        case 0: return 1 + (8 - y);
        case 1: return 5 + Math.abs(4 - y);
        case 2: return 4 + (7 - y);
        case 3: return 5 + (7 - y);
        default: return 0;
      }
    case 2:
      switch (black) {
        case 0: return y > 2 ? 2 + (y - 2) : 0;
        case 1: return 4 + (y - 1);
        case 2: return 7;
        default: return 0;
      }
    case 3:
      switch (black) {
        case 0: return y > 1 ? 3 + (y - 1) : 0;
        case 1: return 5 + (y - 1);
        default: return 0;
      }
    case 4:
      switch (black) {
        case 0: return y > 1 ? 3 + (y - 1) : 0;
        default: return 0;
      }
    default: return 0;
  }
}

export function mixedness(squares) {
  const whiteAt = new Set();
  const blackAt = new Set();
  for (const sq of squares || []) {
    const index = squareIndex(sq.square);
    if (index < 0) continue;
    if (sq.color === "w") whiteAt.add(index);
    else if (sq.color === "b") blackAt.add(index);
  }
  let acc = 0;
  for (let oy = 0; oy <= 6; oy++) {
    for (let ox = 0; ox <= 6; ox++) {
      let white = 0;
      let black = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const index = (oy + dy) * 8 + (ox + dx);
          if (whiteAt.has(index)) white += 1;
          else if (blackAt.has(index)) black += 1;
        }
      }
      // y is 1-based from White's side, matching `i / 7 + 1` in the Scala.
      acc += regionScore(oy + 1, white, black);
    }
  }
  return acc;
}

/** lichess Divider.apply over a game's square lists. */
export function divideGame(boards) {
  const list = Array.isArray(boards) ? boards : [];
  let middle = null;
  for (let index = 0; index < list.length; index++) {
    const board = list[index];
    if (
      majorsAndMinors(board) <= 10 ||
      backrankSparse(board) ||
      mixedness(board) > 150
    ) {
      middle = index;
      break;
    }
  }
  let end = null;
  if (middle !== null) {
    for (let index = 0; index < list.length; index++) {
      if (majorsAndMinors(list[index]) <= 6) {
        end = index;
        break;
      }
    }
    if (end !== null && !(middle < end)) middle = null;
  }
  return { middle, end };
}

/** Snapshot one FEN into the square list divideGame consumes. */
export function boardSnapshot(fen) {
  try {
    return new Chess(fen).board().flat().filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** Phase of one ply given its game's division (null-safe). */
export function phaseAt(ply, division) {
  const middle = division && division.middle;
  const end = division && division.end;
  if (middle != null && ply < middle) return "opening";
  if (middle == null) return "opening";
  if (end != null && ply >= end) return "endgame";
  return "middlegame";
}

// Back-compat single-position helper kept for the scorer tests: classifies by
// the position's own material only, WITHOUT queensOff/ply shortcuts. Prefer
// divideGame + phaseAt for real games (per-position votes misclassify, e.g. an
// early queen trade is not an endgame).
export function phaseOf({ nPieces = 32, nonPawnMat = 62 } = {}) {
  const pieces = Math.max(0, Math.min(32, Number(nPieces) || 0));
  const firepower = Math.max(0, Math.min(62, Number(nonPawnMat) || 0));
  if (pieces <= 14 || firepower <= 14) return "endgame";
  if (pieces <= 20 && firepower <= 24) return "endgame";
  if (pieces >= 28 && firepower >= 46) return "opening";
  return "middlegame";
}

export function explorerBonus({ totalGames = 0, moves = [] } = {}) {
  const list = Array.isArray(moves) ? moves : [];
  const total = Number(totalGames) || 0;
  const nBook = list.length;
  if (total < 200 || nBook < 2) return 0;
  let topShare = 0;
  let entropy = 0;
  for (const row of list) {
    const share = Number(row.share);
    const safe = Number.isFinite(share) && share > 0 ? share : 0;
    if (safe > topShare) topShare = safe;
    if (safe > 0) entropy -= safe * Math.log(safe);
  }
  if (total >= 500 && nBook >= 3 && topShare > 0 && topShare < 0.55 && entropy > 0.9) return 2;
  return 1;
}

export function scorePosition(features = {}, evidence = {}) {
  const f = features || {};
  const nCaps = Number(f.nCaptures) || 0;
  const nLegal = Number(f.nLegal) || 0;
  const matDiff = Number(f.matDiff) || 0;
  let score = Math.min(2, nCaps * 0.5);
  if (f.nChecks > 0) score += 1.5;
  if (f.nPromotions > 0) score += 1;
  score += Math.max(0, Math.min(2, (nLegal - 24) * 0.15));
  if (matDiff >= 2 && matDiff <= 5) score += 1;
  score += Math.min(1, (Number(f.nPawnBreaks) || 0) * 0.5);
  score += Math.min(2, (Number(f.nHanging) || 0) * 0.5);
  if (f.inCheck) score += 0.5;
  score += explorerBonus(evidence.explorer);
  const maiaTop = evidence.maiaTop ? String(evidence.maiaTop).toLowerCase() : null;
  const engineBest = evidence.engineBest ? String(evidence.engineBest).toLowerCase() : null;
  const explorerTop = evidence.explorerTop ? String(evidence.explorerTop).toLowerCase() : null;
  if (maiaTop && engineBest && maiaTop !== engineBest) score += 2.5;
  else if (!engineBest && maiaTop && explorerTop && maiaTop !== explorerTop) score += 1.5;
  else if (!maiaTop && engineBest && explorerTop && engineBest !== explorerTop) score += 1.5;
  const swing = Number(evidence.swingPawns);
  if (Number.isFinite(swing) && swing > 0) score += Math.min(3, swing * 1.2);
  return score;
}

export function isCritical(features, evidence, threshold = CRITICAL_THRESHOLD) {
  return scorePosition(features, evidence) >= threshold;
}

export function pickKeyIndex(scores, { rng = Math.random, exclude = new Set() } = {}) {
  const list = Array.isArray(scores) ? scores : [];
  const banned = exclude instanceof Set ? exclude : new Set(exclude || []);
  const open = list.filter((row) => row && !banned.has(row.index));
  const pool = open.length ? open : list.filter(Boolean);
  if (!pool.length) return -1;
  let best = pool[0];
  for (const row of pool) {
    if (row.score > best.score) best = row;
  }
  const elites = pool.filter((row) => row.score >= best.score - 0.75);
  const roll = typeof rng === "function" ? rng() : Math.random();
  const safe = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  return elites[Math.min(elites.length - 1, Math.floor(safe * elites.length))].index;
}
