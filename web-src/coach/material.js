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

export function advantageSide(balance) {
  if (balance > 0.5) return "white";
  if (balance < -0.5) return "black";
  return "none";
}

// Static exchange evaluation on a SINGLE square — the honest "who comes out ahead once
// the trade on this square plays itself out" number, in White-POV pawns.
//
// This is the antidote to the "phantom pawns" bug: a PV (or the position right after a
// capture) often stops mid-exchange — you've taken on d5 but the recapture hasn't been
// played yet — so a naive piece count reads you a whole pawn (or piece) up when the
// position is dead level. We resolve ONLY the capture battle on `square`: each side, in
// turn, may recapture with its cheapest attacker or decline (stand pat) if continuing
// would lose material. Crucially we never touch captures elsewhere on the board, so we
// never "win" a pawn the engine's line deliberately left alone (e.g. a poisoned pawn the
// PV declined for tactical reasons). It finishes the trade in front of us, nothing more.
//
// `chess` is mutated and restored (move/undo); the caller's position is left intact.
export function squareExchange(chess, square) {
  const standPat = materialBalance(chess); // White-POV, "if I don't capture here"
  let caps;
  try {
    caps = chess.moves({ verbose: true });
  } catch (_) {
    return standPat;
  }
  // Only recaptures that land ON the contested square, cheapest attacker first (SEE).
  caps = caps
    .filter((m) => m.to === square && m.captured)
    .sort((a, b) => (PIECE_VALUE[a.piece] || 0) - (PIECE_VALUE[b.piece] || 0));
  if (!caps.length) return standPat;
  const white = chess.turn() === "w";
  const m = caps[0];
  let resolved;
  try {
    chess.move(m);
    resolved = squareExchange(chess, square);
    chess.undo();
  } catch (_) {
    return standPat;
  }
  // The side to move keeps the better of "capture and play on" vs "stand pat". White
  // wants the balance high, Black wants it low.
  return white ? Math.max(standPat, resolved) : Math.min(standPat, resolved);
}

// The board once the capture battle on `square` settles under optimal SEE play, returned
// as a fresh Chess (the caller's position is left untouched). Mirrors squareExchange's
// decisions but APPLIES the chosen recaptures, so callers can read the resulting piece
// COMPOSITION — which is what tells "up the exchange" (a rook for a minor) apart from "up
// two pawns": both are +2 in raw value, but only the composition knows which it is.
export function squareExchangeBoard(chess, square) {
  let work;
  try {
    work = new Chess(chess.fen());
  } catch (_) {
    return chess;
  }
  for (;;) {
    const standPat = materialBalance(work);
    let caps;
    try {
      caps = work.moves({ verbose: true });
    } catch (_) {
      break;
    }
    caps = caps
      .filter((m) => m.to === square && m.captured)
      .sort((a, b) => (PIECE_VALUE[a.piece] || 0) - (PIECE_VALUE[b.piece] || 0));
    if (!caps.length) break;
    const white = work.turn() === "w";
    let resolved;
    try {
      work.move(caps[0]);
      resolved = squareExchange(work, square); // best play from here, with the capture made
    } catch (_) {
      break;
    }
    // Keep the capture only if it strictly improves the side-to-move's settled balance —
    // SEE never makes a losing capture, and a value-neutral recapture would only distort
    // the resulting composition (and could loop). Otherwise undo it and stand pat.
    const improves = white ? resolved > standPat : resolved < standPat;
    if (!improves) {
      try {
        work.undo();
      } catch (_) {
        /* leave the position as-is */
      }
      break;
    }
  }
  return work;
}

// Settle the contested square left by `move` (a chess.js move object) in `chess`, if and
// only if that move was a capture. A capture leaves an exchange that may still be
// unresolved (the recapture); a quiet move does not, and we must NOT invent captures the
// engine's line chose to forgo. Returns the White-POV balance after settling.
export function settledBalanceAfter(chess, move) {
  const raw = materialBalance(chess);
  if (!move || !move.captured || !move.to) return raw;
  return squareExchange(chess, move.to);
}

// Flip the side to move in a FEN (and void en-passant), so SEE can evaluate a capture
// initiated by a side that isn't currently to move — the "what this move now threatens"
// read, where the mover has just moved and it is the opponent's turn on the board.
function fenWithTurn(fen, color) {
  const parts = (fen || "").split(" ");
  if (parts.length < 2) return null;
  parts[1] = color;
  if (parts.length >= 4) parts[3] = "-"; // an en-passant right can't survive a turn flip
  return parts.join(" ");
}

// Static exchange evaluation of GRABBING a square: the mover-POV net pawns if `byColor`
// initiates the capture battle on `targetSq` with its cheapest attacker, under optimal
// SEE play by both sides afterwards. > 0 means the target is genuinely winnable; <= 0
// means it only LOOKS free — it's defended enough that taking it loses material. This is
// the antidote to the "cheapest attacker is worth less than the victim" heuristic, which
// flags an adequately-defended piece as hanging (the fake "eyes the knight" / fake fork).
//
// Works even when `byColor` is not the side to move (it flips the turn to ask "what does
// this side now threaten"). Returns null when it can't be evaluated — an illegal turn
// flip (e.g. the move gave check), or no capturing attacker — so callers fall back to
// their existing cheap heuristic rather than silently dropping a real threat.
export function seeCapture(chess, targetSq, byColor) {
  let work;
  try {
    work = chess.turn() === byColor ? new Chess(chess.fen()) : null;
    if (!work) {
      const flipped = fenWithTurn(chess.fen(), byColor);
      if (!flipped) return null;
      work = new Chess(flipped);
    }
  } catch (_) {
    return null;
  }
  const before = materialBalance(work); // White-POV
  let caps;
  try {
    caps = work.moves({ verbose: true });
  } catch (_) {
    return null;
  }
  caps = caps
    .filter((m) => m.to === targetSq && m.captured)
    .sort((a, b) => (PIECE_VALUE[a.piece] || 0) - (PIECE_VALUE[b.piece] || 0));
  if (!caps.length) return null;
  let settled;
  try {
    work.move(caps[0]); // cheapest attacker initiates, then both sides play optimally
    settled = squareExchange(work, targetSq);
  } catch (_) {
    return null;
  }
  const deltaWhite = settled - before;
  return byColor === "w" ? deltaWhite : -deltaWhite;
}

const COUNT_WORD = { 2: "two", 3: "three", 4: "four" };

function diffMinus(a, b) {
  const out = {};
  for (const t of ["p", "n", "b", "r", "q"]) out[t] = (a?.[t] || 0) - (b?.[t] || 0);
  return out;
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
  let firstMove = null;
  let lastMove = null;
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
    if (!firstMove) firstMove = move;
    lastMove = move;
    sanSeq.push(move.san);
    if (move.captured) {
      const bin = move.color === "w" ? byWhite : byBlack;
      bin[move.captured] = (bin[move.captured] || 0) + 1;
    }
    plies += 1;
  }
  const endBalance = materialBalance(chess);
  // Settle the trades at BOTH ends so the swing is honest even when the line (or its
  // start position) stops mid-exchange. We resolve only the square each end's capture
  // landed on, so the count reflects "once the trade finishes", not "mid-recapture".
  const settledEndBalance = settledBalanceAfter(chess, lastMove);
  let settledStartBalance = startBalance;
  let settledEndDiff = perPieceDiff(chess);
  let settledStartDiff;
  try {
    settledStartDiff = perPieceDiff(new Chess(fenStart));
  } catch (_) {
    settledStartDiff = null;
  }
  if (firstMove && firstMove.captured) {
    let startChess;
    try {
      startChess = new Chess(fenStart);
      settledStartBalance = squareExchange(startChess, firstMove.to);
      settledStartDiff = perPieceDiff(squareExchangeBoard(new Chess(fenStart), firstMove.to));
    } catch (_) {
      settledStartBalance = startBalance;
    }
  }
  if (lastMove && lastMove.captured) {
    try {
      settledEndDiff = perPieceDiff(squareExchangeBoard(new Chess(chess.fen()), lastMove.to));
    } catch (_) {
      settledEndDiff = perPieceDiff(chess);
    }
  }
  return {
    endFen: chess.fen(),
    startBalance,
    endBalance,
    swing: endBalance - startBalance, // White-POV material change over the line
    settledStartBalance,
    settledEndBalance,
    settledSwing: settledEndBalance - settledStartBalance, // honest, exchange-resolved
    settledStartDiff,
    settledEndDiff,
    settledDiffSwing: settledStartDiff ? diffMinus(settledEndDiff, settledStartDiff) : null,
    byWhite,
    byBlack,
    insufficient: chess.isInsufficientMaterial(),
    advantage: advantageSide(endBalance),
    perPieceDiff: perPieceDiff(chess),
    sanSeq,
    plies,
  };
}

// Game phase, ported from lichess/scalachess `Divider` so it matches the phase labels our
// sharpness thresholds were calibrated against (scripts/maia3_sharpness_probe.py). The
// move number is NOT used — phase is read purely from the board, which is what makes a
// transposition or an early queen trade land in the right phase. Drives tone (opening:
// develop / endgame: the extra pawn tells) AND the phase-relative sharpness band.
//
//   endgame   when majors+minors <= 6
//   middlegame when majors+minors <= 10, OR a back rank is sparse, OR mixedness > 150
//   opening   otherwise
// "majors and minors" = every piece that isn't a king or a pawn. "back rank sparse" =
// fewer than 4 pieces left on White's first / Black's last rank (development has begun).
// "mixedness" sums a small lookup over every 2x2 window: it rises as the two armies
// interpenetrate (the hallmark of a middlegame) and stays low while the camps are apart.
const MIXEDNESS_SCORE = {
  "0,0": 0, "1,0": 1, "2,0": 2, "3,0": 3, "4,0": 3,
  "0,1": 1, "1,1": 5, "2,1": 4, "3,1": 3,
  "0,2": 2, "1,2": 4, "2,2": 7,
  "0,3": 3, "1,3": 3,
  "0,4": 3,
};

// board[r][f]: r=0 is rank 8 .. r=7 is rank 1; f=0 is file a. Square (file x, 0-indexed
// rank y from the bottom) is board[7 - y][x].
function mixedness(board) {
  let total = 0;
  for (let y = 0; y <= 6; y++) {
    for (let x = 0; x <= 6; x++) {
      let w = 0;
      let b = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const piece = board[7 - (y + dy)][x + dx];
          if (piece) (piece.color === "w" ? (w += 1) : (b += 1));
        }
      }
      total += MIXEDNESS_SCORE[`${w},${b}`] || 0;
    }
  }
  return total;
}

export function gamePhase(fen) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return "middlegame";
  }
  const board = chess.board();
  let majorsMinors = 0;
  let whiteOnFirst = 0; // White pieces still on rank 1
  let blackOnLast = 0; // Black pieces still on rank 8
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      if (piece.type !== "k" && piece.type !== "p") majorsMinors += 1;
      if (r === 7 && piece.color === "w") whiteOnFirst += 1;
      if (r === 0 && piece.color === "b") blackOnLast += 1;
    }
  }
  if (majorsMinors <= 6) return "endgame";
  const backrankSparse = whiteOnFirst < 4 || blackOnLast < 4;
  if (majorsMinors <= 10 || backrankSparse || mixedness(board) > 150) return "middlegame";
  return "opening";
}
