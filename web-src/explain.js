// Plain-language position coach — the "explanatory" layer for Analyze.
//
// The goal is to sound like a patient human coach, not a robot reading a number.
// Three open-source ideas drive it:
//
//   1. Win-probability model (Lichess). Centipawns mean nothing to a club player;
//      a win % does. cpToWin() is Lichess's own logistic curve, so "+0.8" becomes
//      "White is a touch better (56%)".
//
//   2. Move classification (Lichess / chess.com "Game Review"). Given the win % of
//      the position before and after the move actually played, classifyMove() grades
//      it Best / Good / Inaccuracy / Mistake / Blunder by how much win % was thrown
//      away — the same idea both sites use to put glyphs on your moves.
//
//   3. Motif narration. describeMove() replays the move on a board and reports what
//      it *does* in chess terms — develops, castles, grabs the centre, forks, hangs
//      a piece — instead of "moves the knight to f3".
//
// Two entry points:
//
//   describePosition(fen, { lastSan, lastUci }) -> { headline, points[], arrows[] }
//       Pure, instant, engine-free. The read you get the moment a move lands.
//
//   explainEngineIdea({ fen, bestUci, bestSan, scoreCp, mateIn, sideToMove })
//       -> { text, tone }
//       Turns a Stockfish result into one human sentence about the best try, with
//       its meaning and the resulting verdict. The caller draws bestUci as the arrow.
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
const CENTER = new Set(["d4", "e4", "d5", "e5"]);
const BIG_CENTER = new Set(["c3", "c4", "c5", "c6", "d3", "d4", "d5", "d6", "e3", "e4", "e5", "e6", "f3", "f4", "f5", "f6"]);
const FIANCHETTO = new Set(["b2", "g2", "b7", "g7"]);

function sideWord(turn) {
  return turn === "w" ? "White" : "Black";
}

function other(turn) {
  return turn === "w" ? "b" : "w";
}

// ---------------------------------------------------------------------------
// Evaluation → human verdict (Lichess win-probability model).
// ---------------------------------------------------------------------------

// Centipawns (White POV) -> White win expectancy 0..100. Lichess's logistic fit.
export function cpToWin(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

// Lichess's single-move accuracy: how faithful a move was to the best, from the
// drop in win % it caused (both already from the mover's POV). 100 = perfect.
export function moveAccuracy(winBeforeMover, winAfterMover) {
  const loss = Math.max(0, winBeforeMover - winAfterMover);
  const acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

// One short clause describing where the eval stands, from the mover's point of view.
// Accepts White-POV cp / mate; `mover` is "white" | "black".
function verdictClause({ cp, mate, mover }) {
  if (mate !== null && mate !== undefined) {
    const moverMatesNext = (mate > 0) === (mover === "white");
    const n = Math.abs(mate);
    return moverMatesNext
      ? `forced mate in ${n}`
      : `but it's mate in ${n} the other way`;
  }
  if (cp === null || cp === undefined) return "";
  const win = cpToWin(cp); // White POV
  const moverWin = mover === "white" ? win : 100 - win;
  const pct = Math.round(moverWin);
  const lead = mover === "white" ? "White" : "Black";
  const trail = mover === "white" ? "Black" : "White";
  if (moverWin >= 50) {
    if (moverWin < 56) return `the position stays balanced (${pct}%)`;
    if (moverWin < 65) return `${lead} is a touch better (${pct}%)`;
    if (moverWin < 80) return `${lead} is clearly better (${pct}%)`;
    if (moverWin < 92) return `${lead} is winning (${pct}%)`;
    return `${lead} is completely winning (${pct}%)`;
  }
  if (moverWin > 44) return `the position stays balanced (${pct}%)`;
  if (moverWin > 35) return `${trail} is a touch better`;
  if (moverWin > 20) return `${trail} is clearly better`;
  if (moverWin > 8) return `${trail} is winning`;
  return `${trail} is completely winning`;
}

// ---------------------------------------------------------------------------
// Material.
// ---------------------------------------------------------------------------

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
  if (abs < 0.5) return "Material is level";
  const leader = balance > 0 ? "White" : "Black";
  if (abs <= 1) return `${leader} is a pawn up`;
  if (abs < 3) return `${leader} is ${abs} pawns up`;
  if (abs < 5) return `${leader} is up a piece`;
  if (abs < 9) return `${leader} is up the exchange or more`;
  return `${leader} is up heavy material`;
}

// ---------------------------------------------------------------------------
// Move narration — what a move *does*, in chess terms.
// ---------------------------------------------------------------------------

function backRank(color) {
  return color === "w" ? "1" : "8";
}

// Pieces of `victimColor` that `byColor` attacks more often than they are defended
// (or that hang outright). Used both for tactic hints and to say a move "forks".
function attackedTargets(chess, byColor, victimColor) {
  const out = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== victimColor) continue;
      const attackers = chess.attackers(piece.square, byColor);
      if (!attackers.length) continue;
      const defenders = piece.type === "k" ? [] : chess.attackers(piece.square, victimColor);
      const worth = PIECE_VALUE[piece.type] || 0;
      const cheapestAttacker = Math.min(
        ...attackers.map((sq) => PIECE_VALUE[chess.get(sq).type] || 0)
      );
      if (piece.type === "k" || !defenders.length || cheapestAttacker < worth) {
        out.push({ square: piece.square, type: piece.type, worth });
      }
    }
  }
  return out.sort((a, b) => b.worth - a.worth);
}

// Describe the move `uci`/`san` played from `fenBefore` as a human phrase, e.g.
// "develops the knight and eyes the centre" or "grabs the bishop on c4 for free".
// Returns "" when the move can't be replayed (bad input).
export function describeMove(fenBefore, uci, san) {
  if (!san) return "";
  let chess;
  try {
    chess = new Chess(fenBefore);
  } catch (_) {
    return "";
  }
  const from = uci ? uci.slice(0, 2) : null;
  const to = uci ? uci.slice(2, 4) : san.replace(/[+#!?]/g, "").slice(-2);
  const moverColor = chess.turn();
  const moverBefore = from ? chess.get(from) : null;

  let move;
  try {
    move = chess.move(san);
  } catch (_) {
    if (!from) return "";
    try {
      move = chess.move({ from, to, promotion: uci && uci.length > 4 ? uci[4] : undefined });
    } catch (_) {
      return "";
    }
  }
  if (!move) return "";

  const pieceType = move.piece;
  const name = PIECE_NAME[pieceType] || "piece";
  const clauses = [];

  // Special moves the SAN already names.
  if (san.startsWith("O-O-O")) {
    clauses.push("castles queenside, getting the king to safety");
  } else if (san.startsWith("O-O")) {
    clauses.push("castles, getting the king safe and the rook into the game");
  } else if (move.promotion) {
    clauses.push(`promotes to a ${PIECE_NAME[move.promotion]}`);
  } else if (move.captured) {
    const took = PIECE_NAME[move.captured] || "piece";
    clauses.push(`takes the ${took} on ${to}`);
  } else if (pieceType === "p") {
    if (CENTER.has(to)) clauses.push(`pushes a pawn to ${to}, claiming the centre`);
    else clauses.push(`pushes the ${to.replace(/[0-9]/, "")}-pawn, gaining space`);
  } else if (
    (pieceType === "n" || pieceType === "b") &&
    from &&
    from.endsWith(backRank(moverColor)) &&
    !to.endsWith(backRank(moverColor))
  ) {
    if (FIANCHETTO.has(to)) clauses.push(`fianchettoes the bishop on ${to}`);
    else clauses.push(`develops the ${name} to ${to}`);
  } else {
    clauses.push(`brings the ${name} to ${to}`);
  }

  // Secondary ideas, drawn from the resulting position (mover already moved, so it
  // is now the opponent's turn — look at what the just-moved side threatens).
  const targets = attackedTargets(chess, moverColor, other(moverColor)).filter(
    (t) => t.square !== to // not "attacks the piece it just captured onto"
  );
  const heavy = targets.filter((t) => t.type !== "p");
  if (san.includes("#")) {
    clauses.push("and it's checkmate");
  } else if (heavy.length >= 2) {
    clauses.push(`forking the ${PIECE_NAME[heavy[0].type]} and ${PIECE_NAME[heavy[1].type]}`);
  } else if (san.includes("+") && heavy.length) {
    clauses.push(`with check, also hitting the ${PIECE_NAME[heavy[0].type]} on ${heavy[0].square}`);
  } else if (san.includes("+")) {
    clauses.push("with check");
  } else if (heavy.length) {
    const t = heavy[0];
    clauses.push(`and now eyes the ${PIECE_NAME[t.type]} on ${t.square}`);
  } else if (
    !move.captured &&
    (pieceType === "n" || pieceType === "b") &&
    !san.startsWith("O") &&
    BIG_CENTER.has(to)
  ) {
    clauses.push("with an eye on the centre");
  }

  return clauses.join(", ");
}

// ---------------------------------------------------------------------------
// Loose pieces (instant tactic hint).
// ---------------------------------------------------------------------------

function loosePieces(chess) {
  const mover = chess.turn();
  return attackedTargets(chess, mover, other(mover))
    .filter((t) => t.type !== "k")
    .slice(0, 2)
    .map((t) => ({ square: t.square, type: t.type, color: other(mover) }));
}

function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) return piece.square;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instant, engine-free position read.
// ---------------------------------------------------------------------------

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
      headline: `Checkmate — ${sideWord(other(turn))} wins.`,
      points: [],
      arrows: [],
    };
  }
  if (chess.isStalemate()) {
    return { headline: "Stalemate — it's a draw.", points: [], arrows: [] };
  }
  if (chess.isInsufficientMaterial()) {
    return { headline: "Dead draw — not enough material to mate.", points: [], arrows: [] };
  }
  if (chess.isThreefoldRepetition && chess.isThreefoldRepetition()) {
    return { headline: "Draw by repetition.", points: [], arrows: [] };
  }

  // Headline: lead with what just happened when we can replay the move (needs the
  // before-position), otherwise the material picture. Keep it one breath long.
  const moveText = opts.prevFen ? describeMove(opts.prevFen, opts.lastUci, opts.lastSan) : "";
  const material = describeMaterial(materialBalance(chess));
  let headline;
  if (moveText) {
    headline = `${sideWord(other(turn))} ${moveText}.`;
    points.push(`${material}.`);
  } else {
    headline = `${material}. ${sideWord(turn)} to move.`;
  }

  points.push(`${sideWord(turn)} to move.`);

  if (chess.isCheck()) {
    points.push(`${sideWord(turn)}'s king is in check — deal with that first.`);
    const kingSq = findKing(chess, turn);
    if (kingSq) arrows.push({ type: "circle", square: kingSq, color: "danger" });
  }

  const loose = loosePieces(chess);
  for (const lp of loose) {
    points.push(
      `${sideWord(lp.color)}'s ${PIECE_NAME[lp.type]} on ${lp.square} is loose — ${sideWord(turn)} can pounce on it.`
    );
    arrows.push({ type: "circle", square: lp.square, color: "warn" });
  }

  return { headline, points, arrows };
}

// ---------------------------------------------------------------------------
// Move classification (Lichess / chess.com "Game Review" style).
// Grade the move actually played by how much win % it gave away.
// ---------------------------------------------------------------------------

// winBefore / winAfter are White-POV win %; `mover` is "white" | "black".
// `isBest` short-circuits to Best when the move equals the engine's top choice.
export function classifyMove({ winBefore, winAfter, mover, isBest }) {
  if (winBefore === null || winBefore === undefined) return null;
  if (winAfter === null || winAfter === undefined) return null;
  const beforeMover = mover === "white" ? winBefore : 100 - winBefore;
  const afterMover = mover === "white" ? winAfter : 100 - winAfter;
  const drop = beforeMover - afterMover; // positive = position got worse

  if (isBest || drop <= 2) {
    return { label: "Best move", glyph: "✓", tone: "good" };
  }
  if (drop <= 5) return { label: "Good move", glyph: "✓", tone: "good" };
  if (drop <= 10) return { label: "Inaccuracy", glyph: "?!", tone: "warn" };
  if (drop <= 20) return { label: "Mistake", glyph: "?", tone: "warn" };
  return { label: "Blunder", glyph: "??", tone: "danger" };
}

// ---------------------------------------------------------------------------
// Engine idea — the suggested move, what it does, and the resulting verdict.
// ---------------------------------------------------------------------------

export function explainEngineIdea({ fen, bestUci, bestSan, scoreCp, mateIn, sideToMove }) {
  if (!bestSan) return { text: "", tone: "info" };
  const mover = sideToMove === "black" ? "black" : "white";
  const who = mover === "black" ? "Black" : "White";
  const meaning = fen && bestUci ? describeMove(fen, bestUci, bestSan) : "";
  const verdict = verdictClause({ cp: scoreCp ?? null, mate: mateIn ?? null, mover });

  // Tone only goes green/red for a clear edge — a "touch better" stays neutral so
  // the box doesn't cry wolf. Matches the "clearly better" wording in verdictClause.
  let tone = "info";
  if (mateIn !== null && mateIn !== undefined) {
    tone = (mateIn > 0) === (mover === "white") ? "good" : "danger";
  } else if (scoreCp !== null && scoreCp !== undefined) {
    const win = mover === "white" ? cpToWin(scoreCp) : 100 - cpToWin(scoreCp);
    tone = win >= 65 ? "good" : win <= 35 ? "danger" : "info";
  }

  let text = `Best is ${bestSan}`;
  if (meaning) text += ` — it ${meaning}`;
  text += ".";
  if (verdict) {
    const cap = verdict.charAt(0).toUpperCase() + verdict.slice(1);
    text += ` ${cap}.`;
  } else if (!meaning) {
    text = `${who} should play ${bestSan}.`;
  }
  return { text, tone };
}
