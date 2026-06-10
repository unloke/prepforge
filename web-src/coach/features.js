// Move feature extraction — the factual layer the coach reasons from.
//
// Given the position before/after a move and two short engine reads (the BEFORE
// position with MultiPV, the AFTER position), this distils the long list of facts a
// human coach actually uses: how much win% the move kept or threw away, what the best
// and second-best tries were and where they lead on material, whether a mate or a free
// piece was on the table and missed, whether the move hangs something, the game phase,
// and so on. No DOM, no engine calls here — just chess.js + arithmetic — so it tests
// headlessly and the orchestration (which owns the worker) stays thin.
import { Chess } from "chess.js";
import { cpToWin, moveAccuracy } from "../explain.js";
import {
  PIECE_VALUE,
  walkLine,
  gamePhase,
  materialBalance,
} from "./material.js";

// White-POV win% from a (cp|mate) eval. Mate is decisive.
function winWhite({ cp, mate }) {
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  if (cp === null || cp === undefined) return 50;
  return cpToWin(cp);
}

function toMover(winWhiteVal, mover) {
  return mover === "white" ? winWhiteVal : 100 - winWhiteVal;
}

// Enemy pieces `byColor` can capture that are undefended, or defended by less than
// they are worth (i.e. winnable material). Returns richest-first.
function captureTargets(chess, byColor) {
  const victim = byColor === "w" ? "b" : "w";
  const out = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== victim || piece.type === "k") continue;
      const attackers = chess.attackers(piece.square, byColor);
      if (!attackers.length) continue;
      const defenders = chess.attackers(piece.square, victim);
      const worth = PIECE_VALUE[piece.type] || 0;
      const cheapestAttacker = Math.min(
        ...attackers.map((sq) => PIECE_VALUE[chess.get(sq).type] || 0)
      );
      const hanging = !defenders.length;
      if (hanging || cheapestAttacker < worth) {
        out.push({ square: piece.square, type: piece.type, worth, hanging });
      }
    }
  }
  return out.sort((a, b) => b.worth - a.worth);
}

function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

// input: {
//   ply, moveNumber, mover ('white'|'black'), uci, san, fenBefore, fenAfter,
//   beforeEval: { lines: [{ uci, san, cp, mate, pvUci, pvSan }, ...] },  // MultiPV >= 1
//   afterEval:  { cp, mate, pvUci, pvSan },
// }  (cp/mate are White-POV; null when absent)
export function buildMoveFeatures(input) {
  const { mover, uci, san, fenBefore, fenAfter, beforeEval, afterEval } = input;
  const lines = (beforeEval && beforeEval.lines) || [];
  const best = lines[0] || null;
  const alt = lines[1] || null;

  // --- Evaluations and win% ------------------------------------------------
  const evalBeforeWhite = best ? winWhite(best) : 50;
  const evalAfterWhite = winWhite(afterEval || {});
  const winBeforeMover = toMover(evalBeforeWhite, mover);
  const winAfterMover = toMover(evalAfterWhite, mover);
  const winDelta = winBeforeMover - winAfterMover; // + = win% thrown away
  const accuracy = moveAccuracy(winBeforeMover, winAfterMover);

  const mateBefore = best ? best.mate ?? null : null;
  const mateAfter = afterEval ? afterEval.mate ?? null : null;
  const hadMateBefore = mateBefore !== null && (mateBefore > 0) === (mover === "white");
  const hasMateAfter = mateAfter !== null && (mateAfter > 0) === (mover === "white");
  const inMateNet = mateAfter !== null && (mateAfter > 0) !== (mover === "white");

  // --- Best move / alternative & their lines (walked from the SAME before-FEN) --
  const bestUci = best ? best.uci : null;
  const bestSan = best ? best.san : null;
  const isBest = !!bestUci && bestUci === uci;
  const altUci = alt ? alt.uci : null;
  const altSan = alt ? alt.san : null;
  const altWinMover = alt ? toMover(winWhite(alt), mover) : null;

  const bestLine = best ? walkLine(fenBefore, best.pvUci) : null;
  const altLine = alt ? walkLine(fenBefore, alt.pvUci) : null;
  // The line the move you played actually leads to: your move, then best play.
  const playedLine = walkLine(fenBefore, [uci, ...((afterEval && afterEval.pvUci) || [])]);

  // --- Position facts (chess.js on the two FENs) ---------------------------
  const before = safeChess(fenBefore);
  const after = safeChess(fenAfter);
  const moverLetter = mover === "white" ? "w" : "b";
  const oppLetter = mover === "white" ? "b" : "w";

  const wasInCheck = before ? before.isCheck() : false;
  const isCheck = after ? after.isCheck() : false; // the move gives check
  const legalBefore = before ? before.moves().length : 0;
  const onlyMove =
    legalBefore <= 1 ||
    (isBest && altWinMover !== null && winBeforeMover - altWinMover >= 15);

  // Undefended/winnable enemy targets — before (what was on offer) and after
  // (what the move now threatens). And: did the move hang our own material?
  const looseBefore = before ? captureTargets(before, moverLetter) : [];
  const looseAfter = after ? captureTargets(after, moverLetter) : [];
  const hangingOwn = after ? captureTargets(after, oppLetter) : [];
  const hangingOwnTop = hangingOwn[0] || null;

  // Did the move say "no thanks" to free material or a forced mate?
  const bestTargetBefore = looseBefore[0] || null;
  const tookSomething = !!(playedLine && playedLine.sanSeq[0] && /x/.test(san));
  const missedMate = hadMateBefore && !hasMateAfter && winDelta > 5;
  const missedWin =
    !missedMate &&
    winDelta >= 8 &&
    !!bestTargetBefore &&
    bestTargetBefore.worth >= 3 &&
    !(tookSomething && /x/.test(san));

  const phase = gamePhase(fenBefore);
  const materialBefore = before ? materialBalance(before) : 0;
  const materialAfter = after ? materialBalance(after) : 0;

  // The opponent's best reply (the punishment) after the move — "after Nxh4…".
  const replySan = afterEval && afterEval.pvSan ? afterEval.pvSan[0] || null : null;
  const replyUci = afterEval && afterEval.pvUci ? afterEval.pvUci[0] || null : null;

  // --- Classification (win-drop, with the Great override) ------------------
  // NB: Brilliant is NOT decided here. It needs Maia (a human-move model): a move
  // is brilliant only when the engine loves it but humans wouldn't find/like it.
  // The orchestration runs that check async and upgrades via markBrilliant().
  const classification = classifyMoveRich({ winDelta, winAfterMover, isBest, onlyMove });

  // Worth asking Maia about? Brilliant doesn't require literally the engine's #1 line —
  // a "Best" or "Excellent"-tier move (winDelta <= 5) that keeps the side at least level
  // is the "Sound" layer of the server-side definition; Maia settles the rest.
  const brilliantCandidate = winDelta <= 5 && winAfterMover >= 50;

  return {
    ply: input.ply ?? null,
    moveNumber: input.moveNumber ?? null,
    mover,
    san,
    uci,
    fenBefore,
    fenAfter,

    evalBeforeWhite,
    evalAfterWhite,
    winBeforeMover,
    winAfterMover,
    winDelta,
    accuracy,
    evalBeforeCp: best ? best.cp ?? null : null,
    evalAfterCp: afterEval ? afterEval.cp ?? null : null,
    mateBefore,
    mateAfter,
    hadMateBefore,
    hasMateAfter,
    inMateNet,

    isBest,
    bestUci,
    bestSan,
    altUci,
    altSan,
    altWinMover,
    bestLine,
    altLine,
    playedLine,

    phase,
    materialBefore,
    materialAfter,

    wasInCheck,
    isCheck,
    isForced: wasInCheck && legalBefore <= 1,
    onlyMove,
    looseBefore,
    looseAfter,
    hangingOwn,
    hangingOwnTop,
    missedMate,
    missedWin,
    replySan,
    replyUci,

    brilliantCandidate,
    maia: null, // filled in by markBrilliant() if the orchestration runs the Maia check
    classification,
  };
}

// Decide brilliancy from the Maia (human-move model) read of the SAME move — a
// Maia/Stockfish disagreement, no SEE and no sacrifice test. These thresholds mirror
// the canonical server-side detector (services/brilliant.py) so a move flagged live by
// the coach is the same one a full-game analysis would star:
//   1. Unintuitive — humans almost never find it: maiaHumanProb <= 0.10.
//   2. Reveal      — the engine's truth is far above the human's first-glance read:
//                    engineWin - maiaWin >= 30 points (server min_reveal_score 0.30).
//   3. Sound       — the move stays at least level (engine-best, winAfterMover >= 50);
//                    enforced by the candidate gate before we ever query Maia.
//   maiaHumanProb — Maia's probability a human plays this move (0..1)
//   maiaWinAfter  — Maia's win chance for the mover after the move (0..1)
export const BRILLIANT_MAX_HUMAN_PROB = 0.1; // (1) humans rarely find it
export const BRILLIANT_MIN_WIN_GAP = 30; // (2) engine win% over Maia win%, in points
export function isBrilliantByMaia(features, { maiaHumanProb, maiaWinAfter }) {
  if (!features || !features.brilliantCandidate) return false;
  if (!Number.isFinite(maiaHumanProb) || !Number.isFinite(maiaWinAfter)) return false;
  const engineWin = features.winAfterMover; // %, mover POV (Stockfish)
  const humanWin = maiaWinAfter * 100; // %, mover POV (Maia)
  return maiaHumanProb <= BRILLIANT_MAX_HUMAN_PROB && engineWin - humanWin >= BRILLIANT_MIN_WIN_GAP;
}

// Upgrade a feature vector to Brilliant in place once the Maia check confirms it.
export function markBrilliant(features, maia) {
  features.maia = maia || null;
  features.classification = { code: "brilliant", label: "Brilliant", glyph: "!!", tone: "brilliant" };
  return features;
}

// Grade the move from the win% drop (Lichess/chess.com style). Great is the only
// in-here upgrade; Brilliant is decided separately via the Maia check (isBrilliantByMaia).
export function classifyMoveRich({ winDelta, winAfterMover, isBest, onlyMove }) {
  // Great: the only move that holds the position together — finding it mattered.
  if (isBest && onlyMove && winAfterMover >= 25) {
    return { code: "great", label: "Great move", glyph: "!", tone: "good" };
  }
  if (isBest || winDelta <= 2) {
    return { code: "best", label: "Best move", glyph: "✓", tone: "good" };
  }
  if (winDelta <= 5) return { code: "good", label: "Good move", glyph: "✓", tone: "good" };
  if (winDelta <= 10) return { code: "inaccuracy", label: "Inaccuracy", glyph: "?!", tone: "warn" };
  if (winDelta <= 20) return { code: "mistake", label: "Mistake", glyph: "?", tone: "warn" };
  return { code: "blunder", label: "Blunder", glyph: "??", tone: "danger" };
}
