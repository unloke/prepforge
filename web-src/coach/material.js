// Material bookkeeping for the coach — pure chess.js, no engine, no DOM.
//
// Everything here answers "who has what, and who's winning the trade count", which
// is the factual backbone the commentary layer leans on ("your line drops a knight",
// "this stays a clean pawn up", "it liquidates into a dead-drawn ending").
import { Chess } from "chess.js";

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
const PLURAL = {
  pawn: "pawns",
  knight: "knights",
  bishop: "bishops",
  rook: "rooks",
  queen: "queens",
};

// A full starting army, used to derive "what has each side captured" from a FEN.
const FULL_ARMY = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export function countPieces(chess) {
  const out = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece) out[piece.color][piece.type] += 1;
    }
  }
  return out;
}

// White-perspective material in pawns (+ favours White).
export function materialBalance(chess) {
  const c = countPieces(chess);
  let bal = 0;
  for (const t of Object.keys(PIECE_VALUE)) {
    bal += (c.w[t] - c.b[t]) * PIECE_VALUE[t];
  }
  return bal;
}

// Per-piece count difference, White minus Black: { p, n, b, r, q }. Promotions can
// push a value above the starting count; that's fine, we only ever read the sign.
export function perPieceDiff(chess) {
  const c = countPieces(chess);
  const out = {};
  for (const t of ["p", "n", "b", "r", "q"]) out[t] = c.w[t] - c.b[t];
  return out;
}

// Pieces each side has captured, inferred from what's missing vs a full army.
// captured-by-White = Black's missing men, and vice-versa. Approximate under heavy
// promotion, but accurate for the trade-counting the coach actually narrates.
export function capturedLists(chess) {
  const c = countPieces(chess);
  const byWhite = {}; // black pieces White removed
  const byBlack = {};
  for (const t of ["p", "n", "b", "r", "q"]) {
    const missingBlack = Math.max(0, FULL_ARMY[t] - c.b[t]);
    const missingWhite = Math.max(0, FULL_ARMY[t] - c.w[t]);
    if (missingBlack) byWhite[t] = missingBlack;
    if (missingWhite) byBlack[t] = missingWhite;
  }
  return { byWhite, byBlack };
}

export function advantageSide(balance) {
  if (balance > 0.5) return "white";
  if (balance < -0.5) return "black";
  return "none";
}

// "a pawn", "two pawns", "a knight", "the exchange", "a piece and a pawn"... a human
// summary of a White-perspective pawn delta. Returns "" when level.
export function materialPhrase(balance) {
  const abs = Math.round(Math.abs(balance));
  if (abs < 1) return "";
  if (abs === 1) return "a pawn";
  if (abs === 2) return "two pawns";
  if (abs === 3) return "a piece";
  if (abs === 4) return "a piece and a pawn";
  if (abs === 5) return "a rook";
  if (abs === 6) return "a rook and a pawn";
  if (abs < 9) return "a rook or more";
  if (abs === 9) return "a queen";
  return "decisive material";
}

// Name a single captured piece type with the right article/plural.
export function pieceListPhrase(list) {
  const parts = [];
  for (const t of ["q", "r", "b", "n", "p"]) {
    const n = list[t];
    if (!n) continue;
    const name = PIECE_NAME[t];
    parts.push(n === 1 ? `a ${name}` : `${n} ${PLURAL[name] || name + "s"}`);
  }
  return parts.join(", ");
}

// Replay a line of UCI moves from `fenStart` and report the material story: where it
// ends, the running trade tally, and whether it dries up into a dead draw. Capped so
// a noisy PV tail can't run away. Both the played line and the engine line are walked
// from the SAME start FEN so their end-balances compare apples to apples.
export function walkLine(fenStart, uciMoves, cap = 12) {
  let chess;
  try {
    chess = new Chess(fenStart);
  } catch (_) {
    return null;
  }
  const startBalance = materialBalance(chess);
  const byWhite = {};
  const byBlack = {};
  const sanSeq = [];
  let plies = 0;
  for (const uci of (uciMoves || []).slice(0, cap)) {
    let move;
    try {
      move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
    } catch (_) {
      break;
    }
    if (!move) break;
    sanSeq.push(move.san);
    if (move.captured) {
      const bin = move.color === "w" ? byWhite : byBlack;
      bin[move.captured] = (bin[move.captured] || 0) + 1;
    }
    plies += 1;
  }
  const endBalance = materialBalance(chess);
  return {
    endFen: chess.fen(),
    startBalance,
    endBalance,
    swing: endBalance - startBalance, // White-POV material change over the line
    byWhite,
    byBlack,
    insufficient: chess.isInsufficientMaterial(),
    advantage: advantageSide(endBalance),
    perPieceDiff: perPieceDiff(chess),
    sanSeq,
    plies,
  };
}

// Rough game phase from the non-pawn material left on the board (and the move number
// for the opening cutoff). Drives tone ("in the opening, develop" vs "in the endgame,
// the extra pawn tells").
export function gamePhase(fen) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return "middlegame";
  }
  const c = countPieces(chess);
  let nonPawn = 0;
  for (const t of ["n", "b", "r", "q"]) nonPawn += (c.w[t] + c.b[t]) * PIECE_VALUE[t];
  const fullmove = Number(fen.split(" ")[5]) || 1;
  if (nonPawn <= 14) return "endgame"; // ~ a rook + minor per side or less
  if (fullmove <= 10) return "opening";
  return "middlegame";
}
