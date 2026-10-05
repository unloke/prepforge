// Scout v12 — interpretable (position, move) features for policy-bias regression.
// Pure: chess.js only. Relative coordinates are always from the mover's perspective.

import { Chess } from "chess.js";

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Ordered feature ids — index aligns with Float64Array from featureVector(). */
export const FEATURE_IDS = [
  "isCapture", // capture of any enemy piece
  "capturesPawn", // capture whose victim is a pawn
  "capturesUndefendedPawn", // capture of a pawn on a square with no enemy defender
  "capturesDefendedPiece", // capture on a square defended by the enemy
  "seeLiteLoss", // naive one-shot exchange loss in pawns when capturing on a defended square
  "capturesQueen", // capture whose victim is a queen
  "captureWhenAhead", // capture while mover is ≥2 pawns up in material
  "captureWhenBehind", // capture while mover is ≥2 pawns down in material
  "isPromotion", // pawn promotion
  "isCastle", // kingside or queenside castle
  "kingMoveNonCastle", // king move that is not castling
  "pawnPushOwnKingWing", // pawn advance on the wing where the own king sits
  "checkResponseBlock", // while in check: interpose/block (not capture, not king move)
  "checkResponseCapture", // while in check: capture the checking piece or cover
  "checkResponseKingMove", // while in check: king move
  "givesCheck", // move gives check to the enemy king
  "movesTowardEnemyKing", // non-pawn/non-king move reduces Chebyshev distance to enemy king
  "pawnAdvancePastMidline", // pawn lands on relative rank ≥ 5
  "centralPawnPush", // d- or e-pawn advances (pawn push on central files)
  "pieceRetreat", // non-pawn/non-king moves to a lower relative rank
  "fianchetto", // bishop to the long-diagonal corner square (b2/g2 or b7/g7 relative)
  "resolvesPawnTension", // pawn capture that relieves mutual pawn tension
  "rookLift", // rook from own back two ranks to the third/fourth on the same file
  "knightToRim", // knight to the a/h file or the back/outer relative rank
  "developsMinorFromHome", // knight or bishop leaves its game-start home square for the first time
  "movesSamePieceAgain", // moves the same piece that moved on the mover's previous turn
  "quietPawnPush", // non-capturing pawn advance
  "minorPieceToCenter", // knight or bishop lands on a central d4/e4/d5/e5 square (relative)
  "queenMove", // queen relocation
  "pawnCapture", // any pawn capture
  "createsPassedPawn", // pawn push leaves a passed pawn on the destination
  "attacksCenter", // move lands on or captures on a central square (relative d/e × ranks 4–5)
  "hangingPieceCapture", // capture of an undefended non-pawn piece
  "defendsOwnPiece", // after the move, an own piece on the destination was undefended before
];

const N_FEATURES = FEATURE_IDS.length;

const FILES = "abcdefgh";

function fileIdx(sq) {
  return sq.charCodeAt(0) - 97;
}

function rankIdx(sq) {
  return Number(sq[1]) - 1;
}

function sqFromRankIdx(file, rankIdx0) {
  return `${FILES[file]}${rankIdx0 + 1}`;
}

function uciOf(move) {
  return move.from + move.to + (move.promotion || "");
}

function relFile(square) {
  return fileIdx(square);
}

function relRank(square, mover) {
  const r = rankIdx(square);
  return mover === "w" ? r + 1 : 8 - r;
}

function chebyshev(a, b) {
  return Math.max(Math.abs(fileIdx(a) - fileIdx(b)), Math.abs(rankIdx(a) - rankIdx(b)));
}

function isCentralSquare(square, mover) {
  const rf = relFile(square);
  const rr = relRank(square, mover);
  return (rf === 3 || rf === 4) && (rr === 4 || rr === 5);
}

function isMinorHomeSquare(piece, square) {
  if (!piece || (piece.type !== "n" && piece.type !== "b")) return false;
  const f = fileIdx(square);
  const r = rankIdx(square);
  if (piece.color === "w") {
    if (piece.type === "n") return r === 0 && (f === 1 || f === 6);
    return r === 0 && (f === 2 || f === 5);
  }
  if (piece.type === "n") return r === 7 && (f === 1 || f === 6);
  return r === 7 && (f === 2 || f === 5);
}

function fianchettoTargets(mover) {
  return mover === "w" ? ["b2", "g2"] : ["b7", "g7"];
}

function materialOf(chess) {
  const board = chess.board();
  const out = { w: 0, b: 0 };
  for (const row of board) {
    for (const piece of row) {
      if (!piece || piece.type === "k") continue;
      out[piece.color] += PIECE_VALUE[piece.type] || 0;
    }
  }
  return out;
}

function kingsOf(chess) {
  let own = null;
  let enemy = null;
  const mover = chess.turn();
  const enemyColor = mover === "w" ? "b" : "w";
  for (let rankIdx0 = 0; rankIdx0 < 8; rankIdx0 += 1) {
    for (let f = 0; f < 8; f += 1) {
      const square = sqFromRankIdx(f, rankIdx0);
      const piece = chess.get(square);
      if (!piece || piece.type !== "k") continue;
      if (piece.color === mover) own = square;
      else enemy = square;
    }
  }
  return { own, enemy, mover, enemyColor };
}

function queenPresent(chess, color) {
  const board = chess.board();
  for (const row of board) {
    for (const piece of row) {
      if (piece && piece.color === color && piece.type === "q") return true;
    }
  }
  return false;
}

function pawnTensionPairs(chess) {
  const pairs = new Set();
  const pawns = [];
  for (let rankIdx0 = 0; rankIdx0 < 8; rankIdx0 += 1) {
    for (let f = 0; f < 8; f += 1) {
      const square = sqFromRankIdx(f, rankIdx0);
      const piece = chess.get(square);
      if (piece && piece.type === "p") pawns.push({ square, color: piece.color });
    }
  }
  for (const a of pawns) {
    for (const b of pawns) {
      if (a.color === b.color) continue;
      const df = Math.abs(fileIdx(a.square) - fileIdx(b.square));
      if (df !== 1) continue;
      const dr = rankIdx(b.square) - rankIdx(a.square);
      if (a.color === "w" && dr === 1) pairs.add(`${a.square}|${b.square}`);
      if (a.color === "b" && dr === -1) pairs.add(`${a.square}|${b.square}`);
    }
  }
  return pairs;
}

// Home squares of the non-pawn, non-king pieces at game start (both colors).
const HOME_SQUARES = new Map([
  ["a1", "r"], ["b1", "n"], ["c1", "b"], ["d1", "q"], ["f1", "b"], ["g1", "n"], ["h1", "r"],
  ["a8", "r"], ["b8", "n"], ["c8", "b"], ["d8", "q"], ["f8", "b"], ["g8", "n"], ["h8", "r"],
]);

function phaseOf(chess) {
  const board = chess.board();
  let majorsMinors = 0;
  let onHome = 0;
  for (let r = 0; r < 8; r += 1) {
    for (let f = 0; f < 8; f += 1) {
      const piece = board[r][f];
      if (!piece || piece.type === "k" || piece.type === "p") continue;
      majorsMinors += 1;
      // board[0] is rank 8, board[7] is rank 1
      const square = `${FILES[f]}${8 - r}`;
      if (HOME_SQUARES.get(square) === piece.type) onHome += 1;
    }
  }
  if (majorsMinors <= 6) return "endgame";
  // Opening = most of both armies still undeployed; development, not move number,
  // is what the phase-conditioned bias features care about.
  if (majorsMinors > 10 && onHome >= 8) return "opening";
  return "middlegame";
}

function kingWing(relKingFile) {
  if (relKingFile >= 5) return "kingside";
  if (relKingFile <= 2) return "queenside";
  return "center";
}

function wingFiles(wing) {
  if (wing === "kingside") return new Set([5, 6, 7]);
  if (wing === "queenside") return new Set([0, 1, 2]);
  return null;
}

function isPassedPawnAfter(chess, square, mover) {
  const f = fileIdx(square);
  const r = rankIdx(square);
  const enemy = mover === "w" ? "b" : "w";
  const dir = mover === "w" ? 1 : -1;
  for (let df = -1; df <= 1; df += 1) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    for (let nr = r + dir; nr >= 0 && nr <= 7; nr += dir) {
      const piece = chess.get(sqFromRankIdx(nf, nr));
      if (!piece) continue;
      if (piece.type === "p" && piece.color === enemy) return false;
      break;
    }
  }
  return true;
}

function defendedBy(chess, square, color) {
  return chess.isAttacked(square, color);
}

/** Build shared context for one decision point (scouted player to move). */
export function buildDecisionContext(fen, { prevOwnMoveUci = null } = {}) {
  const chess = new Chess(fen);
  const mover = chess.turn();
  const material = materialOf(chess);
  const materialDiffMover = material[mover] - material[mover === "w" ? "b" : "w"];
  const { own: ownKingSq, enemy: enemyKingSq, enemyColor } = kingsOf(chess);
  const inCheck = chess.inCheck();
  const tension = pawnTensionPairs(chess);
  const parts = fen.split(" ");
  const castlingRights = parts[2] || "-";
  let prevOwnMoveTo = null;
  if (prevOwnMoveUci && prevOwnMoveUci.length >= 4) {
    prevOwnMoveTo = prevOwnMoveUci.slice(2, 4);
  }
  return {
    chess,
    mover,
    enemyColor,
    materialDiffMover,
    ownKingSq,
    enemyKingSq,
    inCheck,
    tension,
    castlingRights,
    prevOwnMoveFrom: prevOwnMoveUci ? prevOwnMoveUci.slice(0, 2) : null,
    prevOwnMoveTo,
    queenless: queenPresent(chess, "w") || queenPresent(chess, "b") ? 0 : 1,
    phase: phaseOf(chess),
  };
}

/** Decision-level metadata (ply-independent; same for all candidates). */
export function decisionMeta(ctx) {
  return {
    phase: ctx.phase,
    queenless: ctx.queenless,
    materialDiffMover: ctx.materialDiffMover,
  };
}

/** Feature vector for one candidate move (uci). */
export function featureVector(ctx, moveUci) {
  const out = new Float64Array(N_FEATURES);
  const chess = ctx.chess;
  const mover = ctx.mover;
  const moves = chess.moves({ verbose: true });
  const move = moves.find((m) => uciOf(m) === moveUci);
  if (!move) return out;

  const from = move.from;
  const to = move.to;
  const piece = move.piece;
  const captured = move.captured || null;
  const isCapture = Boolean(captured);
  const isPromotion = Boolean(move.promotion);
  const isCastle = move.san === "O-O" || move.san === "O-O-O" || (piece === "k" && Math.abs(fileIdx(to) - fileIdx(from)) === 2);
  const isKingMove = piece === "k";
  const isPawn = piece === "p";
  const isQueen = piece === "q";
  const isMinor = piece === "n" || piece === "b";
  const destDefended = isCapture && defendedBy(chess, to, ctx.enemyColor);
  const destUndefended = isCapture && !defendedBy(chess, to, ctx.enemyColor);

  const set = (id, value) => {
    const idx = FEATURE_IDS.indexOf(id);
    if (idx >= 0) out[idx] = Number.isFinite(value) ? value : 0;
  };

  set("isCapture", isCapture ? 1 : 0);
  set("capturesPawn", isCapture && captured === "p" ? 1 : 0);
  set("capturesUndefendedPawn", isCapture && captured === "p" && destUndefended ? 1 : 0);
  set("capturesDefendedPiece", isCapture && destDefended ? 1 : 0);

  if (isCapture && destDefended) {
    const ownVal = PIECE_VALUE[piece] || 0;
    const capVal = PIECE_VALUE[captured] || 0;
    set("seeLiteLoss", Math.max(0, ownVal - capVal));
  }

  set("capturesQueen", isCapture && captured === "q" ? 1 : 0);
  set("captureWhenAhead", isCapture && ctx.materialDiffMover >= 2 ? 1 : 0);
  set("captureWhenBehind", isCapture && ctx.materialDiffMover <= -2 ? 1 : 0);
  set("isPromotion", isPromotion ? 1 : 0);
  set("isCastle", isCastle ? 1 : 0);
  set("kingMoveNonCastle", isKingMove && !isCastle ? 1 : 0);

  const ownKingRelF = relFile(ctx.ownKingSq, mover);
  const wing = kingWing(ownKingRelF);
  const wingSet = wingFiles(wing);
  if (isPawn && wingSet && !isCapture) {
    const fromRank = relRank(from, mover);
    const toRank = relRank(to, mover);
    if (toRank > fromRank && wingSet.has(relFile(from))) {
      set("pawnPushOwnKingWing", 1);
    }
  }

  if (ctx.inCheck) {
    if (isKingMove) set("checkResponseKingMove", 1);
    else if (isCapture) set("checkResponseCapture", 1);
    else set("checkResponseBlock", 1);
  }

  if (!isPawn && !isKingMove) {
    const before = chebyshev(from, ctx.enemyKingSq);
    const after = chebyshev(to, ctx.enemyKingSq);
    if (after < before) set("movesTowardEnemyKing", 1);
  }

  if (isPawn) {
    const fromRank = relRank(from, mover);
    const toRank = relRank(to, mover);
    if (toRank > fromRank) {
      if (toRank >= 5) set("pawnAdvancePastMidline", 1);
      const rf = relFile(from);
      if (rf === 3 || rf === 4) set("centralPawnPush", 1);
      if (!isCapture) set("quietPawnPush", 1);
    }
    if (isCapture) set("pawnCapture", 1);
    if (isCapture) {
      const hadTension = ctx.tension.has(`${from}|${to}`) || ctx.tension.has(`${to}|${from}`);
      if (hadTension) set("resolvesPawnTension", 1);
    }
  }

  if (!isPawn && !isKingMove) {
    const fromRank = relRank(from, mover);
    const toRank = relRank(to, mover);
    if (toRank < fromRank) set("pieceRetreat", 1);
  }

  if (piece === "b" && fianchettoTargets(mover).includes(to)) set("fianchetto", 1);

  if (piece === "r") {
    const fromRank = relRank(from, mover);
    const toRank = relRank(to, mover);
    if (fromRank <= 2 && toRank >= 3 && toRank <= 4 && fileIdx(from) === fileIdx(to)) {
      set("rookLift", 1);
    }
  }

  if (piece === "n") {
    const rf = relFile(to);
    const rr = relRank(to, mover);
    if (rf === 0 || rf === 7 || rr === 1 || rr === 8) set("knightToRim", 1);
  }

  const boardPiece = chess.get(from);
  if (isMinor && boardPiece && isMinorHomeSquare(boardPiece, from)) {
    set("developsMinorFromHome", 1);
  }

  if (ctx.prevOwnMoveTo && from === ctx.prevOwnMoveTo) {
    set("movesSamePieceAgain", 1);
  }

  if (isMinor && isCentralSquare(to, mover)) set("minorPieceToCenter", 1);
  if (isQueen) set("queenMove", 1);
  if (isCapture && captured !== "p" && destUndefended) set("hangingPieceCapture", 1);
  if (isCentralSquare(to, mover)) set("attacksCenter", 1);

  const hangingBefore = [];
  if (!isCapture) {
    for (let rankIdx0 = 0; rankIdx0 < 8; rankIdx0 += 1) {
      for (let f = 0; f < 8; f += 1) {
        const sqName = sqFromRankIdx(f, rankIdx0);
        const p = chess.get(sqName);
        if (!p || p.color !== mover) continue;
        if (sqName === from) continue;
        if (chess.isAttacked(sqName, ctx.enemyColor) && !defendedBy(chess, sqName, mover)) {
          hangingBefore.push(sqName);
        }
      }
    }
  }

  chess.move(move);
  if (chess.inCheck()) set("givesCheck", 1);
  if (isPawn && isPassedPawnAfter(chess, to, mover)) set("createsPassedPawn", 1);

  for (const sqName of hangingBefore) {
    if (defendedBy(chess, sqName, mover)) {
      set("defendsOwnPiece", 1);
      break;
    }
  }
  chess.undo();

  return out;
}