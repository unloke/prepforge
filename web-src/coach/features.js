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
  perPieceDiff,
  squareExchange,
  squareExchangeBoard,
  seeCapture,
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

// Mover-POV win CHANCE (0..1) from a White-POV {cp, mate} eval — the same fraction the
// server's win_chance_for_side produces, so a browser-computed trap_gap lands on the
// server's scale (compared against min_trap_gap = 0.05). (A mate maps to 1/0 here; the
// server maps it to ~0.975/0.025 — a negligible gap that only shows when the human's
// natural move walks into a forced mate, which a "trap" alternative essentially never is.)
export function moverWinChanceAfter(evalWhite, mover) {
  return toMover(winWhite(evalWhite || {}), mover) / 100;
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
      // SEE is authoritative: only call a piece winnable if actually GRABBING it nets
      // material once the recaptures resolve. The old "cheapest attacker is cheaper than
      // the victim" test flagged adequately-defended pieces as free (a bishop "eyeing" a
      // knight that's solidly guarded). Fall back to that heuristic only when SEE can't be
      // evaluated (illegal turn flip etc.), so a real threat is never silently dropped.
      const see = seeCapture(chess, piece.square, byColor);
      const winnable = see !== null ? see > 0 : hanging || cheapestAttacker < worth;
      if (winnable) {
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
  // Forced = there was literally one legal move. The player made no decision, so this is
  // NOT something they "found" — it's the only thing the rules allowed. Kept distinct from
  // onlyMove below so the prose says "this is forced", not "great find".
  const forced = legalBefore === 1;
  // "Only move" = a real choice existed (more than one legal move) but just one keeps the
  // position, the engine's best a clear cut above its own second choice (>=15 win% points)
  // — finding it actually mattered. 15 is deliberately above the "good"/"best" noise band
  // (winDelta <= 5) so a routine best move with a close second isn't over-praised.
  const onlyMove =
    !forced &&
    isBest &&
    altWinMover !== null &&
    winBeforeMover - altWinMover >= 15;

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
  // Honest material once THIS move's own trade resolves. Reading the raw board right
  // after a capture counts you up the piece you just took before the recapture lands —
  // the "phantom pawn". Settle the contested square (only when the move was a capture;
  // a quiet move starts no exchange) so an even trade reads as level, not "a pawn up".
  const moveDest = uci ? uci.slice(2, 4) : null;
  const moveWasCapture = /x/.test(san || "");
  let materialAfterSettled = materialAfter;
  // The settled piece composition (White-POV count delta), so the commentary can tell
  // "the exchange" from "two pawns". For a capture we read it off the square once the
  // trade resolves; for a quiet move the board already is the settled position.
  let materialDiffAfter = after ? perPieceDiff(after) : null;
  if (after && moveWasCapture && moveDest) {
    const probe = safeChess(fenAfter);
    if (probe) materialAfterSettled = squareExchange(probe, moveDest);
    const probe2 = safeChess(fenAfter);
    if (probe2) materialDiffAfter = perPieceDiff(squareExchangeBoard(probe2, moveDest));
  }

  // The opponent's best reply (the punishment) after the move — "after Nxh4…".
  const replySan = afterEval && afterEval.pvSan ? afterEval.pvSan[0] || null : null;
  const replyUci = afterEval && afterEval.pvUci ? afterEval.pvUci[0] || null : null;

  // --- Classification (win-drop, with the Great override) ------------------
  // NB: Brilliant is NOT decided here. It needs Maia (a human-move model): a move
  // is brilliant only when the engine loves it but humans wouldn't find/like it.
  // The orchestration runs that check async and upgrades via markBrilliant().
  const classification = classifyMoveRich({ winDelta, winAfterMover, isBest, onlyMove, forced });

  // Worth asking Maia about? Mirror the server's brilliant eligibility exactly: only a
  // Best or Excellent-tier move qualifies (services/brilliant.py, gated on the
  // classifier's BEST/EXCELLENT). The server lands there two ways (services/classification.py):
  // it returns BEST the instant the played move is its first choice (isBest) REGARDLESS of
  // any eval delta, else Excellent when the win-chance loss is at most 0.03 — i.e.
  // `isBest || winDelta <= 3` here, since winDelta IS that loss in percentage points. The
  // isBest leg matters because winBefore (best line of fenBefore) and winAfter (the fenAfter
  // read) are separate searches that can disagree by > 3 pts on a sharp line, which would
  // otherwise drop a literal best move — a prime brilliancy candidate. A "Good"-tier move
  // (not best, winDelta in (3, 5]) is NOT brilliant-eligible: the old <= 5 gate over-flagged
  // moves the full-game analysis would never star. (There is no extra win-floor: the server's
  // old "stays at least level" sound layer was replaced by the trap_gap check — see
  // isBrilliantByMaia. Dropping the floor is deliberate, not implied by the other
  // layers: a reveal of 0.30 only forces the engine's truth to >= 0.30 for the mover
  // (the human read can't dip below 0), NOT that the mover is winning — so a brilliant
  // resource in a worse-but-defensible position still qualifies. The trap_gap, not a
  // win floor, is what keeps the false positives out.)
  const brilliantCandidate = isBest || winDelta <= BRILLIANT_MAX_CANDIDATE_WIN_DELTA;

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
    materialAfterSettled,
    materialDiffAfter,

    wasInCheck,
    isCheck,
    forced,
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
// Maia/Stockfish disagreement, no SEE and no sacrifice test. These three layers mirror
// the canonical server-side detector (services/brilliant.py) so a move flagged live by
// the coach is the same one a full-game analysis would star:
//   1. Unintuitive — humans almost never find it: maiaHumanProb <= 0.10.
//   2. Reveal      — the engine's truth is far above the human's first-glance read:
//                    engineWin - maiaWin >= 30 points (server min_reveal_score 0.30).
//                    The reveal gap carries much of the load against false positives:
//                    real sacrifices reveal >= 36 points, while a chaotic pawn-race dud —
//                    where policy mass is merely spread thin across several roughly-
//                    equal rook moves — reveals only ~20. (An earlier "looks already
//                    won" glance cap was removed: its window was razor-thin and it
//                    wrongly rejected the Immortal queen sac 11.Qxh7+, glance ~61.)
//   3. Trap        — the move a human would NATURALLY play instead throws the advantage
//                    away: trapGap = sf_truth(played) - sf_truth(Maia's top-policy move),
//                    mover POV, >= 0.05 (server min_trap_gap). This replaced the old
//                    "stays at least level (winAfterMover >= 50)" sound layer, which kept
//                    far more false positives on the labeled set. trapGap is computed by
//                    the orchestration (it needs an extra Stockfish read of the natural
//                    move) and passed in; un-evaluable (null/NaN) → not brilliant.
//   maiaHumanProb — Maia's probability a human plays this move (0..1)
//   maiaWinAfter  — Maia's win chance for the mover after the move (0..1)
//   trapGap       — win chance the natural human move throws away vs the played one (0..1)
export const BRILLIANT_MAX_HUMAN_PROB = 0.1; // (1) humans rarely find it
export const BRILLIANT_MIN_WIN_GAP = 30; // (2) engine win% over Maia win%, in points
export const BRILLIANT_MIN_TRAP_GAP = 0.05; // (3) win chance the natural move throws away
// Brilliant is only considered for a Best/Excellent-tier move: a win-chance loss of at
// most this many points (winDelta <= 3 ⇔ the server's <= 0.03 EXCELLENT cutoff). This is
// the cheapest layer of all — it's pure arithmetic over evals already in hand — so the
// full-game path checks it BEFORE spending a Maia forward on the move (see brilliant-assess).
export const BRILLIANT_MAX_CANDIDATE_WIN_DELTA = 3;
export function isBrilliantByMaia(features, { maiaHumanProb, maiaWinAfter, trapGap }) {
  if (!features || !features.brilliantCandidate) return false;
  if (!Number.isFinite(maiaHumanProb) || !Number.isFinite(maiaWinAfter)) return false;
  // No trap value (Maia had no policy, or the natural move couldn't be evaluated) → we
  // can't judge the trap layer, so we don't flag it. Fail closed, matching the server.
  if (!Number.isFinite(trapGap)) return false;
  const engineWin = features.winAfterMover; // %, mover POV (Stockfish)
  const humanWin = maiaWinAfter * 100; // %, mover POV (Maia)
  return (
    maiaHumanProb <= BRILLIANT_MAX_HUMAN_PROB &&
    engineWin - humanWin >= BRILLIANT_MIN_WIN_GAP &&
    trapGap >= BRILLIANT_MIN_TRAP_GAP
  );
}

// Upgrade a feature vector to Brilliant in place once the Maia check confirms it.
export function markBrilliant(features, maia) {
  features.maia = maia || null;
  features.classification = { code: "brilliant", label: "Brilliant", glyph: "!!", tone: "brilliant" };
  return features;
}

// Grade the move from the win% drop (Lichess/chess.com style). Great is the only
// in-here upgrade; Brilliant is decided separately via the Maia check (isBrilliantByMaia).
export function classifyMoveRich({ winDelta, winAfterMover, isBest, onlyMove, forced }) {
  // Forced: only one legal move existed. The player had no decision to make, so we neither
  // praise it as a find nor blame it as an error — we just note that it was forced. This
  // must come first: a forced move is "best" by default (it's the only line the engine has)
  // and would otherwise be mislabelled "Great move / the only move you found".
  if (forced) {
    return { code: "forced", label: "Forced", glyph: "□", tone: "info" };
  }
  // Great: the only move that holds the position together — finding it mattered.
  // The winAfterMover >= 25 floor keeps "Great" for moves that actually rescue the
  // position (or better); below that the mover is still losing even after finding the
  // only try, which reads as "Best" (still correct, just not a save worth celebrating).
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
