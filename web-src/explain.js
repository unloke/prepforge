import {
  CP_CLAMP, WC_SIGMOID_SCALE,
  EXCELLENT_MAX_LOSS, GOOD_MAX_LOSS, INACCURACY_MAX_LOSS, MISTAKE_MAX_LOSS,
} from "./generated/shared-constants.js";

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
//   3. Move narration. describeMove() (coach/move-facts.js) says what a move plainly
//      does: develops, castles, takes the centre, attacks a piece it can win.
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
import { seeCapture } from "./coach/material.js";
import { describeMove } from "./coach/move-facts.js";

export { describeMove };

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

function other(turn) {
  return turn === "w" ? "b" : "w";
}

// ---------------------------------------------------------------------------
// Evaluation → human verdict (Lichess win-probability model).
// ---------------------------------------------------------------------------

// Centipawns (White POV) -> White win expectancy 0..100. Lichess's logistic fit.
export function cpToWin(cp) {
  const c = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, Math.trunc(cp ?? 0)));
  return 100 / (1 + Math.exp(-WC_SIGMOID_SCALE * c));
}

// Match services/classification.py, including the signed cp retained for mate(0).
export function evaluationToWin({ cp, mate } = {}) {
  return cpToWin(mate > 0 ? CP_CLAMP : mate < 0 ? -CP_CLAMP : cp);
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
      // The cheapest NON-KING attacker. A king (worth 0) is excluded here: it can never win
      // a DEFENDED piece (the capture would be moving into check, an illegal move), so a king
      // bearing on a guarded piece must not read as "eyes the bishop" via the cheap-attacker
      // fallback — that produced the fake "Kg4 leans on the defended bishop on h4".
      const nonKingAttackers = attackers
        .map((sq) => PIECE_VALUE[chess.get(sq).type] || 0)
        .filter((v) => v > 0);
      const cheapestNonKing = nonKingAttackers.length ? Math.min(...nonKingAttackers) : Infinity;
      // The king is always a "target" (a check); for everything else SEE decides whether
      // grabbing the piece actually wins material, so a solidly-defended piece no longer
      // reads as "eyes the knight" / a fake fork partner. Fall back to the cheap heuristic
      // only when SEE is unevaluable — and then a king attacker only wins an undefended piece.
      if (piece.type === "k") {
        out.push({ square: piece.square, type: piece.type, worth });
        continue;
      }
      const see = seeCapture(chess, piece.square, byColor);
      const winnable = see !== null ? see > 0 : !defenders.length || cheapestNonKing < worth;
      if (winnable) {
        out.push({ square: piece.square, type: piece.type, worth });
      }
    }
  }
  return out.sort((a, b) => b.worth - a.worth);
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

  if (isBest || drop <= EXCELLENT_MAX_LOSS) {
    return { label: "Best move", glyph: "✓", tone: "good" };
  }
  if (drop <= GOOD_MAX_LOSS) return { label: "Good move", glyph: "✓", tone: "good" };
  // Error tiers match Lichess's judgment cutoffs (5 / 10 / 15 win% lost) and the Coach's
  // classifyMoveRich so the three surfaces agree. Blunder was >20 here — laxer than
  // Lichess, so a ~15-pt slip read as a mere mistake.
  if (drop <= INACCURACY_MAX_LOSS) return { label: "Inaccuracy", glyph: "?!", tone: "warn" };
  if (drop <= MISTAKE_MAX_LOSS) return { label: "Mistake", glyph: "?", tone: "warn" };
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
