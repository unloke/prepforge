// Position "texture" and "sharpness" from Maia — the second axis the coach reasons from,
// alongside Stockfish's win%/material facts.
//
// Two distinct Maia signals, read off ONE forward (coach/../maia3 positionRead):
//
//  1. POLICY (how obvious is the position to a human?). One move with most of the
//     probability -> an "obvious" position (a recapture, the only natural move); a person
//     barely has to think. Crossed with the move's quality this is what lets the coach
//     call an error in an obvious spot a *slip* and credit a strong, non-obvious move.
//
//  2. WDL SHARPNESS (how easy is the position to mess up?). The LC0 draw-based formula
//     sharpness = (2 / (ln(1/W-1) + ln(1/L-1)))^2 over the position's win/loss prob.
//     BUT: Maia3's value head barely predicts draws in live positions, so the raw score
//     saturates and spans ~17x across phases (opening medians ~340 vs endgame ~20 — see
//     scripts/maia3_sharpness_probe.py). A single global cutoff is therefore meaningless;
//     we read the score RELATIVE TO ITS PHASE, using empirical per-phase percentiles. An
//     opening is never "calm"; an endgame usually is — the band corrects for that.
//
// PURE: distribution + WDL + phase in, facts out. No engine/worker/DOM — unit-tests
// headlessly; the orchestration owns the Maia worker.
import { Chess } from "chess.js";

// --- policy (obviousness) ----------------------------------------------------
export const OBVIOUS_TOP_PROB = 0.55; // one move holds this much -> "obvious" position
export const PLAUSIBLE_FLOOR = 0.1; // a move needs this prob to count as "a candidate"
export const SURPRISE_MAX_PROB = 0.1; // humans pick the played move at most this often

// --- WDL sharpness, phase-relative -------------------------------------------
// Per-phase cutoffs on the raw LC0-WDL sharpness score, from the calibration probe
// (8 Maia self-play games, lila phase labels): { calm: ~p25, lively: ~p75, sharp: ~p90 }.
// Read RELATIVE to the phase: "sharp" = top-decile for positions of this kind.
export const SHARPNESS_BANDS = {
  opening: { calm: 260, lively: 430, sharp: 680 },
  middlegame: { calm: 145, lively: 370, sharp: 460 },
  endgame: { calm: 8, lively: 50, sharp: 85 },
};

function sanOf(fen, uci) {
  if (!fen || !uci) return null;
  try {
    const c = new Chess(fen);
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
    return mv ? mv.san : null;
  } catch (_) {
    return null;
  }
}

// LC0 WDL sharpness: (2 / (ln(1/W - 1) + ln(1/L - 1)))^2. `win`/`loss` are permille
// (0..1000) or fractions — both work, we normalise. Clamps W,L off 0/1 so the logs stay
// finite and clamps the denominator off 0 (a perfectly balanced decisive position).
export function wdlSharpness(win, loss) {
  const scale = win > 1 || loss > 1 ? 1000 : 1; // permille vs fraction
  const eps = 1e-3;
  const w = Math.min(Math.max(win / scale, eps), 1 - eps);
  const l = Math.min(Math.max(loss / scale, eps), 1 - eps);
  let denom = Math.log(1 / w - 1) + Math.log(1 / l - 1);
  if (Math.abs(denom) < 1e-6) denom = denom >= 0 ? 1e-6 : -1e-6;
  return (2 / denom) ** 2;
}

// Map a raw sharpness score to a phase-relative band: "calm" | "normal" | "lively" | "sharp".
export function sharpnessBand(score, phase) {
  const b = SHARPNESS_BANDS[phase] || SHARPNESS_BANDS.middlegame;
  if (!Number.isFinite(score)) return "normal";
  if (score >= b.sharp) return "sharp";
  if (score >= b.lively) return "lively";
  if (score <= b.calm) return "calm";
  return "normal";
}

// computeIntuition({ predictions, fenBefore, playedUci, bestUci, wdl, phase }) -> facts | null
//   predictions — Maia policy over the BEFORE position: [{ move_uci, probability }, ...]
//   wdl         — Maia WDL of the BEFORE position (side-to-move POV): { win, draw, loss }
//   phase       — "opening" | "middlegame" | "endgame" (from material.gamePhase)
// Returns null only when there's nothing usable at all.
export function computeIntuition({ predictions, fenBefore, playedUci, bestUci, wdl, phase } = {}) {
  const preds = Array.isArray(predictions)
    ? predictions.filter((p) => p && Number.isFinite(p.probability))
    : [];

  // Sharpness from WDL (phase-relative). Independent of the policy read.
  let sharpness = null;
  if (wdl && Number.isFinite(wdl.win) && Number.isFinite(wdl.loss)) {
    const score = wdlSharpness(wdl.win, wdl.loss);
    sharpness = {
      score,
      band: sharpnessBand(score, phase),
      phase: phase || null,
      draw: Number.isFinite(wdl.draw) ? wdl.draw : null,
    };
  }

  if (!preds.length) return sharpness ? { texture: "normal", sharpness } : null;

  const sorted = preds.slice().sort((a, b) => b.probability - a.probability);
  const topProb = sorted[0].probability;
  const plausibleCount = sorted.filter((p) => p.probability >= PLAUSIBLE_FLOOR).length;
  const obviousUci = sorted[0].move_uci;
  const playedRow = preds.find((p) => p.move_uci === playedUci) || null;
  const playedProb = playedRow ? playedRow.probability : 0;

  return {
    // texture is purely about move-obviousness now; "how rich/sharp" lives in `sharpness`
    // (WDL-based), since policy spread conflates "many calm options" with "a knife-fight".
    texture: topProb >= OBVIOUS_TOP_PROB ? "obvious" : "normal",
    topProb,
    plausibleCount,
    obviousUci,
    obviousSan: sanOf(fenBefore, obviousUci),
    obviousIsBest: !!bestUci && obviousUci === bestUci,
    playedWasObvious: !!playedUci && playedUci === obviousUci,
    playedProb,
    surprise: playedProb <= SURPRISE_MAX_PROB,
    sharpness, // { score, band, phase, draw } | null
  };
}

// Attach the intuition read to a feature vector in place (mirrors markBrilliant's shape):
// the orchestration fetches the Maia read async and folds it in, then re-renders. `read`
// may be the worker's { predictions, wdl } object, or (legacy) a bare predictions array.
export function attachIntuition(features, read) {
  if (!features) return features;
  const predictions = Array.isArray(read) ? read : (read && read.predictions) || [];
  const wdl = Array.isArray(read) ? null : (read && read.wdl) || null;
  features.intuition = computeIntuition({
    predictions,
    fenBefore: features.fenBefore,
    playedUci: features.uci,
    bestUci: features.bestUci,
    wdl,
    phase: features.phase,
  });
  return features;
}
