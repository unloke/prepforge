// Plain-language position coach — the "basic explanatory" layer for Analyze.
//
// Two halves, both deliberately simple so a club player reads them at a glance:
//
//   describePosition(fen, { lastSan, lastUci }) -> { headline, points[], arrows[] }
//       Pure, instant, engine-free heuristics from chess.js: who stands better on
//       material, what the move just played did, whose move it is, and any loose
//       (undefended, attacked) pieces. `arrows` are board hints (e.g. the piece a
//       hanging-piece warning refers to) drawn as coloured arrows/circles.
//
//   explainEngineIdea({ bestSan, bestUci, scoreCp, mateIn, sideToMove }) -> string
//       Turns a Stockfish result into one sentence ("Best is Nf3, keeping a small
//       edge"). The caller draws bestUci as an arrow on the board — that is the
//       "idea shown on the board"; this is the words next to it.
//
// Kept DOM-free and dependency-light (just chess.js) so it unit-tests headlessly.
import { Chess } from "chess.js";

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAME = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

function sideWord(turn) {
  return turn === "w" ? "White" : "Black";
}

// Material balance in pawns, from White's perspective (+ favours White).
function materialBalance(chess) {
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const v = PIECE_VALUE[piece.type] || 0;
      score += piece.color === "w" ? v : -v;
    }
  }
  return score;
}

function describeMaterial(balance) {
  const abs = Math.abs(balance);
  if (abs < 0.5) return "Material is level.";
  const leader = balance > 0 ? "White" : "Black";
  if (abs <= 1) return `${leader} is up a pawn.`;
  if (abs < 3) return `${leader} is up ${abs} pawns.`;
  if (abs < 5) return `${leader} is up a piece (about ${abs}).`;
  if (abs < 9) return `${leader} is up the exchange or more (about ${abs}).`;
  return `${leader} is up heavy material (about ${abs}).`;
}

// Plain description of the move that produced this position, from its SAN plus a
// couple of position facts. SAN already encodes capture/check/castle/promotion,
// so this needs no engine.
function describeMove(san, uci, chess) {
  if (!san) return null;
  const dest = uci ? uci.slice(2, 4) : san.replace(/[+#!?]/g, "").slice(-2);
  const moverPiece = uci ? chess.get(dest) : null;
  const moverName = moverPiece ? PIECE_NAME[moverPiece.type] : "piece";
  const bits = [];
  if (san.startsWith("O-O-O")) bits.push("castles queenside, tucking the king away");
  else if (san.startsWith("O-O")) bits.push("castles kingside, tucking the king away");
  else if (san.includes("=")) bits.push(`promotes a pawn to a new ${PIECE_NAME[san.split("=")[1][0].toLowerCase()] || "piece"}`);
  else if (san.includes("x")) bits.push(`captures with the ${moverName} on ${dest}`);
  else bits.push(`moves the ${moverName} to ${dest}`);
  if (san.includes("#")) bits.push("delivering checkmate");
  else if (san.includes("+")) bits.push("with check");
  return `Last move ${san} — ${bits.join(", ")}.`;
}

// Loose pieces: a piece of the side NOT to move that the side-to-move attacks and
// that is either undefended or defended fewer times than attacked. Cheap, useful
// "you can win material here" hint. Returns [{ square, type, color }].
function loosePieces(chess) {
  const mover = chess.turn();
  const victim = mover === "w" ? "b" : "w";
  const out = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== victim || piece.type === "k") continue;
      const attackers = chess.attackers(piece.square, mover);
      if (!attackers.length) continue;
      const defenders = chess.attackers(piece.square, victim);
      // Hanging (no defender) or attacked by something cheaper than it is worth.
      const cheapestAttacker = Math.min(
        ...attackers.map((sq) => PIECE_VALUE[chess.get(sq).type] || 0)
      );
      const worth = PIECE_VALUE[piece.type] || 0;
      if (!defenders.length || cheapestAttacker < worth) {
        out.push({ square: piece.square, type: piece.type, color: piece.color });
      }
    }
  }
  // Surface at most the two most valuable, so the panel stays terse.
  return out.sort((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type]).slice(0, 2);
}

export function describePosition(fen, opts = {}) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return { headline: "", points: [], arrows: [] };
  }
  const turn = chess.turn();
  const points = [];
  const arrows = [];

  // Terminal states first — nothing else matters.
  if (chess.isCheckmate()) {
    return {
      headline: `Checkmate — ${sideWord(turn === "w" ? "b" : "w")} wins.`,
      points: [],
      arrows: [],
    };
  }
  if (chess.isStalemate()) {
    return { headline: "Stalemate — the game is a draw.", points: [], arrows: [] };
  }
  if (chess.isInsufficientMaterial()) {
    return {
      headline: "Draw — not enough material to checkmate.",
      points: [],
      arrows: [],
    };
  }

  const balance = materialBalance(chess);
  const headline = describeMaterial(balance);

  const moveText = describeMove(opts.lastSan, opts.lastUci, chess);
  if (moveText) points.push(moveText);

  points.push(`${sideWord(turn)} to move.`);

  if (chess.isCheck()) {
    points.push(`${sideWord(turn)}'s king is in check — dealing with it comes first.`);
    const kingSq = findKing(chess, turn);
    if (kingSq) arrows.push({ type: "circle", square: kingSq, color: "danger" });
  }

  const loose = loosePieces(chess);
  for (const lp of loose) {
    points.push(
      `${sideWord(lp.color === "w" ? "w" : "b")}'s ${PIECE_NAME[lp.type]} on ${lp.square} is loose — ${sideWord(turn)} can target it.`
    );
    arrows.push({ type: "circle", square: lp.square, color: "warn" });
  }

  return { headline, points, arrows };
}

function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) return piece.square;
    }
  }
  return null;
}

// One sentence from a Stockfish result. The caller draws `bestUci` as the arrow.
export function explainEngineIdea({ bestSan, scoreCp, mateIn, sideToMove }) {
  if (!bestSan) return "";
  const mover = sideToMove === "black" ? "Black" : "White";
  let assess = "";
  if (mateIn !== null && mateIn !== undefined) {
    assess = mateIn > 0 ? `forcing mate in ${mateIn}` : `but the position is lost (mate in ${Math.abs(mateIn)})`;
  } else if (scoreCp !== null && scoreCp !== undefined) {
    // scoreCp is from the side-to-move's perspective (engine convention here).
    const pawns = scoreCp / 100;
    const abs = Math.abs(pawns);
    if (abs < 0.4) assess = "keeping the balance";
    else if (pawns > 0) assess = abs < 1.2 ? "keeping a small edge" : abs < 3 ? "for a clear advantage" : "and is winning";
    else assess = abs < 1.2 ? "though slightly worse" : abs < 3 ? "but stands clearly worse" : "but is losing";
  }
  return `Engine idea: ${mover} should play ${bestSan}${assess ? ", " + assess : ""}.`;
}
