// Phase-aware Maia coach — opening / middlegame / endgame tips from policy + prep.
// Pure: FEN + Maia predictions in, a plain coach object out. No DOM, no worker.
import { Chess } from "chess.js";
import { gamePhase } from "./material.js";

export const PHASE_LABELS = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
};

const TOP_CLOSE = 0.05; // prepared if expected is within 5 percentage points of Maia's top
const HUMAN_ALSO_RANK = 3;

export function phaseOfFen(fen) {
  return gamePhase(fen);
}

function uciKey(uci) {
  return String(uci || "").toLowerCase();
}

function sanOf(fen, uci) {
  if (!fen || !uci) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4) : undefined,
    });
    return move ? move.san : null;
  } catch (_) {
    return null;
  }
}

function asList(predictions) {
  if (!Array.isArray(predictions)) return [];
  return predictions.filter((p) => p && p.move_uci && Number.isFinite(p.probability));
}

function sortedPreds(predictions) {
  return asList(predictions)
    .slice()
    .sort((a, b) => b.probability - a.probability);
}

function findPred(sorted, moveUci) {
  const key = uciKey(moveUci);
  if (!key) return null;
  const idx = sorted.findIndex((p) => uciKey(p.move_uci) === key);
  if (idx < 0) return null;
  return { index: idx, pred: sorted[idx] };
}

export function rankMove(predictions, moveUci) {
  const sorted = sortedPreds(predictions);
  const hit = findPred(sorted, moveUci);
  if (!hit) return null;
  return {
    rank: hit.index + 1,
    probability: hit.pred.probability,
    move_uci: hit.pred.move_uci,
  };
}

function toPct(probability) {
  if (!Number.isFinite(probability)) return null;
  return Math.round(probability * 100);
}

function agreementOf(sorted, expectedUci) {
  if (!expectedUci || !sorted.length) return "unknown";
  const hit = findPred(sorted, expectedUci);
  if (!hit) return "surprise";
  const top = sorted[0];
  if (hit.index === 0 || top.probability - hit.pred.probability <= TOP_CLOSE) {
    return "prepared";
  }
  if (hit.index < HUMAN_ALSO_RANK) return "human-also";
  return "surprise";
}

function crowd(rating) {
  return Number.isFinite(rating) ? "players at your level" : "players";
}

const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

export function isStartFen(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return parts[0] === START_PLACEMENT && parts[1] === "w";
}

// The Train "Your move" banner no longer carries canned phase advice ("Develop toward
// the center...") that had nothing to do with the position. Kept for callers; always "".
export function promptTipFor() {
  return "";
}

function pctText(pct) {
  return pct === null || pct < 1 ? "under 1%" : `${pct}%`;
}

// One short sentence grounded in Maia's move distribution, or "" when there is nothing
// specific to say. Never names the prepared move unless `reveal` (or it is being taught).
function buildTip({ fen, sorted, agreement, expectedSan, expectedUci, expectedPct, playedUci, playedPct, playedRank, humanSan, humanPct, rating, reveal }) {
  if (!sorted.length) return "";
  const who = crowd(rating);
  const playedSan = sanOf(fen, playedUci);
  const missed = !!playedUci && !!expectedUci && uciKey(playedUci) !== uciKey(expectedUci);

  // Train: a wrong answer.
  if (missed) {
    if (reveal && expectedSan) return `${expectedSan} is your prep; ${pctText(expectedPct)} of ${who} play it.`;
    if (!playedSan) return "";
    if (playedPct !== null && playedPct >= 20) return `${playedSan} is popular here, but it isn't your prep.`;
    if (playedPct === null || playedPct < 5) return `Few ${who} play ${playedSan} here.`;
    return "";
  }

  // Train: the prepared move is on screen (teach card or reveal).
  if (expectedUci && expectedSan) {
    if (agreement === "prepared") {
      return uciKey(sorted[0].move_uci) === uciKey(expectedUci)
        ? `Also the most popular move among ${who}.`
        : `One of the main moves among ${who}.`;
    }
    if (agreement === "human-also") return `A common choice among ${who} (${pctText(expectedPct)}).`;
    if (agreement === "surprise") return `Only ${pctText(expectedPct)} of ${who} play it, so expect a surprise.`;
    return "";
  }

  // Analyze: how human the move just played is.
  if (playedSan) {
    if (playedRank === 1) return `${playedSan} is the most common choice among ${who} (${pctText(playedPct)}).`;
    if (humanSan) return `${humanSan} is the usual move among ${who} (${pctText(humanPct)}); ${playedSan} gets ${pctText(playedPct)}.`;
    return "";
  }
  return humanSan ? `${humanSan} is the usual move among ${who} (${pctText(humanPct)}).` : "";
}

// Analyze: the moves players at this level pick here, most popular first: Maia's top
// three, plus the move played and the engine's choice when they sit lower down.
const PICKS_TOP = 3;
function humanPicks(fen, sorted, { playedUci, bestUci }) {
  const played = uciKey(playedUci);
  const best = uciKey(bestUci);
  const shown = sorted.slice(0, PICKS_TOP);
  for (const key of [played, best]) {
    if (!key || shown.some((p) => uciKey(p.move_uci) === key)) continue;
    const hit = findPred(sorted, key);
    shown.push(hit ? hit.pred : { move_uci: key, probability: 0 });
  }
  return shown
    .sort((a, b) => b.probability - a.probability)
    .map((p) => {
      const key = uciKey(p.move_uci);
      const pct = Math.round(p.probability * 1000) / 10;
      return { uci: key, san: sanOf(fen, key) || key, pct, played: key === played, best: !!best && key === best };
    });
}

export function clusterQueueByPhase(queue) {
  const counts = { opening: 0, middlegame: 0, endgame: 0 };
  for (const card of queue || []) {
    const fen = card && card.targets && card.targets[0] && card.targets[0].fen_before;
    if (!fen) continue;
    const phase = phaseOfFen(fen);
    if (counts[phase] != null) counts[phase] += 1;
  }
  const total = counts.opening + counts.middlegame + counts.endgame;
  let majority = "middlegame";
  if (total) {
    if (counts.opening >= counts.middlegame && counts.opening >= counts.endgame) {
      majority = "opening";
    } else if (counts.endgame >= counts.middlegame && counts.endgame >= counts.opening) {
      majority = "endgame";
    }
  }
  return {
    counts,
    total,
    majority,
    majorityLabel: PHASE_LABELS[majority],
  };
}

// A delayed Analyze module import must not restore the previous move's tip.
export function paintAnalysisCoach(input, context, paint) {
  if (input.fen === context?.prevFen && input.playedUci === context?.lastUci) paint(buildPhaseCoach(input));
}

export function buildPhaseCoach({
  fen,
  predictions,
  expectedUci,
  expectedSan,
  playedUci,
  bestUci,
  rating,
  reveal,
} = {}) {
  const phase = phaseOfFen(fen);
  const phaseLabel = PHASE_LABELS[phase] || PHASE_LABELS.middlegame;
  const sorted = sortedPreds(predictions);
  const top = sorted[0] || null;
  const humanUci = top ? top.move_uci : null;
  const humanSan = sanOf(fen, humanUci);
  const humanPct = top ? toPct(top.probability) : null;

  const expectedHit = findPred(sorted, expectedUci);
  const expectedPct = expectedHit ? toPct(expectedHit.pred.probability) : null;
  const playedHit = findPred(sorted, playedUci);
  const playedPct = playedHit ? toPct(playedHit.pred.probability) : null;
  const playedRank = playedHit ? playedHit.index + 1 : null;

  const resolvedExpectedSan = expectedSan || sanOf(fen, expectedUci);
  const agreement = agreementOf(sorted, expectedUci);
  const tip = buildTip({
    fen,
    sorted,
    agreement,
    expectedSan: resolvedExpectedSan,
    expectedUci,
    expectedPct,
    playedUci,
    playedPct,
    playedRank,
    humanSan,
    humanPct,
    rating,
    reveal,
  });

  return {
    phase,
    phaseLabel,
    title: phaseLabel,
    tip,
    // Nothing position-specific to say: callers show nothing rather than filler.
    generic: !tip,
    promptTip: "",
    humanUci,
    humanSan,
    humanPct,
    expectedPct,
    playedPct,
    agreement,
    picks: humanPicks(fen, sorted, { playedUci, bestUci }),
  };
}
