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
const SURPRISE_MAX = 0.08; // Maia barely plays it
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

function ratingCrowd(rating) {
  return Number.isFinite(rating) ? "players at your rating" : "players at this level";
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

export function isStartFen(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return parts[0] === START_PLACEMENT && parts[1] === "w";
}

// Spoiler-safe line for the Train "Your move" banner. Never names a SAN —
// naming the prepared move (or Maia's e4 at the start) is the answer.
export function promptTipFor(fen, phase) {
  if (isStartFen(fen)) return "Play the first move of your repertoire.";
  return phaseFollowup(phase || phaseOfFen(fen));
}

function genericTip(phase) {
  if (phase === "opening") {
    return "Develop your pieces, occupy the center, and get the king safe.";
  }
  if (phase === "endgame") {
    return "Activate the king, push your pawns, and don't rush tactics.";
  }
  return "Look for typical plans: improve your pieces, create a target, and keep the king safe.";
}

function phaseFollowup(phase) {
  if (phase === "opening") return "Develop toward the center and keep the king safe.";
  if (phase === "endgame") return "Activate the king, push pawns, and don't rush tactics.";
  return "Improve your pieces, create a target, and keep the king safe.";
}

function missTip({ phase, expectedSan, rating, playedRare, reveal }) {
  const crowd = capitalize(ratingCrowd(rating));
  // First miss is a retry: never name the prepared SAN. The second miss
  // already titles the banner "It's Nf3".
  if (!reveal) {
    const lead = playedRare
      ? `${crowd} almost never play that.`
      : "That's not the prepared move.";
    return `${lead} ${phaseFollowup(phase)}`;
  }
  const lead = playedRare
    ? `${crowd} almost never play that; they choose ${expectedSan}.`
    : `That's not the prepared move. ${crowd} choose ${expectedSan}.`;
  return `${lead} ${phaseFollowup(phase)}`;
}

function buildTip({
  phase,
  sorted,
  agreement,
  expectedSan,
  playedUci,
  expectedUci,
  playedProb,
  rating,
  humanSan,
  fen,
  reveal,
}) {
  const playedDiffers =
    !!playedUci && !!expectedUci && uciKey(playedUci) !== uciKey(expectedUci);
  const humanSan2 = sorted.length > 1 ? sanOf(fen, sorted[1].move_uci) : null;
  const crowd = ratingCrowd(rating);

  if (playedDiffers && expectedSan && sorted.length) {
    const playedRare = !Number.isFinite(playedProb) || playedProb < SURPRISE_MAX;
    return missTip({ phase, expectedSan, rating, playedRare, reveal });
  }

  // Waiting at the start FEN (no move played yet): never say "everyone plays
  // e4". That is both a spoiler and not a real opening lesson.
  if (isStartFen(fen) && !playedUci) {
    if (expectedSan && agreement === "surprise") {
      return `This is the first move of your repertoire. Humans almost never play ${expectedSan} here, so treat it as a sideline and still develop, occupy the center, and castle.`;
    }
    if (expectedSan) {
      return `This is the first move of your repertoire. ${expectedSan} occupies the center; develop and castle next.`;
    }
    return genericTip(phase);
  }

  if (!sorted.length) return genericTip(phase);

  if (phase === "opening") {
    if (agreement === "prepared" && expectedSan) {
      return `This is what ${crowd} actually play. ${expectedSan} develops toward the center; castle before the fight opens.`;
    }
    if (agreement === "human-also" && expectedSan) {
      return `${expectedSan} is also what humans play here. Develop, occupy the center, and get the king safe.`;
    }
    if (agreement === "surprise" && expectedSan) {
      return `Your prep is a trap humans miss. They almost never play ${expectedSan} here, so treat it as a sideline and still develop, occupy the center, and castle.`;
    }
    if (humanSan) {
      return `Humans go ${humanSan} here. Develop, occupy the center, and get the king safe.`;
    }
    return genericTip(phase);
  }

  if (phase === "endgame") {
    const conversion = expectedSan || humanSan;
    if (agreement === "prepared" && conversion) {
      return `${conversion} is the human conversion move. Activate the king, push pawns, and don't rush tactics.`;
    }
    if (agreement === "human-also" && expectedSan) {
      return `Humans look at ${humanSan || expectedSan} to convert; ${expectedSan} is in that mix. Activate the king, push pawns, and don't rush tactics.`;
    }
    if (agreement === "surprise" && expectedSan) {
      return `Your prep with ${expectedSan} is a sideline humans miss. Activate the king, push pawns, and don't rush tactics.`;
    }
    if (humanSan) {
      return `Humans look at ${humanSan} to convert. Activate the king, push pawns, and don't rush tactics.`;
    }
    return genericTip(phase);
  }

  // middlegame
  if (agreement === "prepared" && expectedSan) {
    const second =
      humanSan2 && humanSan2 !== expectedSan ? ` Humans also look at ${humanSan2}.` : "";
    return `The prepared move ${expectedSan} is the human choice.${second} Improve your pieces and create a target.`;
  }
  if (agreement === "human-also" && expectedSan) {
    if (humanSan && humanSan2) {
      return `Humans look at ${humanSan} and ${humanSan2}; ${expectedSan} is in that mix. Improve your pieces and create a target.`;
    }
    return `${expectedSan} is a human choice here. Improve your pieces, create a target, and keep the king safe.`;
  }
  if (agreement === "surprise" && expectedSan) {
    return `Your prep is a sideline humans miss. They rarely play ${expectedSan}; typical plans still apply: improve pieces and create a target.`;
  }
  if (humanSan && humanSan2) {
    return `Humans look at ${humanSan} and ${humanSan2}. Improve your pieces, create a target, and keep the king safe.`;
  }
  if (humanSan) {
    return `Humans look at ${humanSan}. Improve your pieces, create a target, and keep the king safe.`;
  }
  return genericTip(phase);
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

export function buildPhaseCoach({
  fen,
  predictions,
  expectedUci,
  expectedSan,
  playedUci,
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
  const playedProb = playedHit ? playedHit.pred.probability : null;

  const resolvedExpectedSan = expectedSan || sanOf(fen, expectedUci);
  const agreement = agreementOf(sorted, expectedUci);

  return {
    phase,
    phaseLabel,
    title: `${phaseLabel} coach`,
    tip: buildTip({
      phase,
      sorted,
      agreement,
      expectedSan: resolvedExpectedSan,
      playedUci,
      expectedUci,
      playedProb,
      rating,
      humanSan,
      fen,
      reveal,
    }),
    promptTip: promptTipFor(fen, phase),
    humanUci,
    humanSan,
    humanPct,
    expectedPct,
    playedPct,
    agreement,
  };
}
