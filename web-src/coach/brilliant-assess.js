import { localBoardAfterMove } from "../chess-local.js";
import {
  moverWinChanceAfter,
  BRILLIANT_MAX_HUMAN_PROB,
  BRILLIANT_MIN_WIN_GAP,
  BRILLIANT_MAX_CANDIDATE_WIN_DELTA,
} from "./features.js";

// Mover-POV win chance (0..1) from an analysis eval-map entry ({score_cp, mate_in},
// White-POV), or null when that position wasn't evaluated.
function moverWinChanceFromEval(ev, side) {
  if (!ev) return null;
  return moverWinChanceAfter({ cp: ev.score_cp ?? null, mate: ev.mate_in ?? null }, side);
}

// Layer 0 — is this move even Brilliant-eligible (Best/Excellent tier)? Mirrors the server's
// classifier (classification.py), which lands Best/Excellent two distinct ways:
//   • BEST — the played move IS the engine's first choice (played === best_move_uci). The
//     server returns BEST here BEFORE it computes any loss, and best_move_uci is the same
//     browser-supplied value we hold, so we must short-circuit the same way: the analysis
//     runs two independent fixed-depth searches (fen_before and fen_after) that can disagree
//     by more than the cap on a sharp line, and without this bypass a literal best move — a
//     prime brilliancy candidate — could be dropped before Maia ever sees it.
//   • EXCELLENT — otherwise the win-chance loss is within the cap: winDelta = win%(before,
//     best play) − win%(after the played move) <= BRILLIANT_MAX_CANDIDATE_WIN_DELTA. winDelta
//     equals the server's loss (same evals, same 0.00368208 sigmoid).
// Pure arithmetic over evals already in hand — no model call — so it is the first thing
// checked. A position the analysis somehow didn't evaluate is treated as ineligible (it
// can't be flagged without its eval anyway).
function brilliantEligible(evalMap, move) {
  const evBefore = evalMap.get(move.fen_before);
  const evAfter = evalMap.get(move.fen_after);
  if (!evBefore || !evAfter) return false;
  if (evBefore.best_move_uci && evBefore.best_move_uci === move.uci) return true; // BEST
  const before = moverWinChanceFromEval(evBefore, move.side);
  const after = moverWinChanceFromEval(evAfter, move.side);
  return (before - after) * 100 <= BRILLIANT_MAX_CANDIDATE_WIN_DELTA; // EXCELLENT-tier
}

// Browser-side computation of the per-move Maia3 assessment + trap_gap that the server's
// BrilliantAnalyzer (via ReplayMaia) consumes. Extracted from app.js so the fragile wiring
// that actually populates `trap_gap` — the provider/eval object shapes, the eval-map
// lookups, the cancellation seams — is unit-testable with fake engines (the server can't
// recompute any of it, so a typo here silently ships no trap_gap). The heavy collaborators
// (the Maia provider and the Stockfish batch analyzer) are injected so a test never spins up
// a real engine:
//   provider  — getSharedMaia3Provider(): .moveAssessment() / .predictions()
//   analyzeFn — analyzeGamePositions() from engine/game-analyzer.js

// Phase 3d: compute each played move's Maia3 assessment (humanProbability,
// winChanceAfter) IN THE BROWSER so the server's BrilliantAnalyzer (via ReplayMaia) can
// flag brilliancies with zero server compute. Best-effort: if Maia is unavailable (no
// weights) or any inference fails, we return what we have (possibly []), and the analysis
// still completes without brilliancies — exactly the server's no-Maia degradation.
//
// `rating` is the player's effective Maia3 strength (Settings-pinned, else AUTO from the
// linked Lichess account, else the model default) — the SAME effectiveMaiaRating() the live
// coach uses, so a brilliancy flagged in full-game analysis matches one the coach stars live,
// and the read is personalized ("因材施教"). The server's ReplayMaia ignores its own rating and
// trusts these numbers, so the client is the single source of truth for strength.
//
// Brilliant has three layers (services/brilliant.py / isBrilliantByMaia), and they get
// steadily more expensive — so we check them CHEAPEST-FIRST and only ever pay for a layer
// once everything cheaper has passed:
//   0. Eligible (free): winDelta <= candidate cap — pure arithmetic over `evals`, no model
//      call at all. A move that isn't Best/Excellent can't be brilliant, so this gate spares
//      a Maia forward on the (many) clearly-suboptimal plies.
//   1. Unintuitive (one Maia value forward, shared with the assessment): humanProbability
//      <= the cap.
//   2. Reveal (free, from the numbers already in hand): Stockfish's win% sits far above
//      Maia's first-glance read.
//   3. trap_gap (the costly one): sf_truth(played) − sf_truth(the move a human would
//      NATURALLY play). The server can't compute it (no engine), so we do it here and ship
//      it. It alone needs an extra Maia POLICY read AND an extra Stockfish eval, so it runs
//      only for the handful of candidates that already cleared layers 0–2 — never on a move
//      a free check already ruled out. (This ordering is the fix for the trap_gap layer
//      slowing whole-game analysis: it used to fire on every UNINTUITIVE ply, blunders
//      included.) `evals` is the analysis run's per-FEN eval map (so sf_truth(played) =
//      eval of fen_after, reused, not recomputed).
//
// We only ship assessments for eligible moves; the server consults assessments solely for
// the Best/Excellent ones it classifies, so dropping the rest is both safe and faster.
export async function computeBrilliantAssessments({ moves, evals, depth, rating, onProgress, onTrapProgress, shouldCancel, provider, analyzeFn }) {
  const assessments = [];
  const candidates = []; // moves through layers 0–2 needing a trap_gap: { item, side, playedAfterFen }
  const evalMap = evals && typeof evals.get === "function" ? evals : new Map();
  const total = moves.length;
  const cancelledError = () => {
    const err = new Error("Analysis stopped");
    err.cancelled = true;
    return err;
  };
  for (let i = 0; i < total; i++) {
    // Before kicking off each assessment. The FIRST iteration's moveAssessment also drives
    // the model download + session init, so this is the pre-init checkpoint too.
    if (shouldCancel && shouldCancel()) throw cancelledError();
    const m = moves[i];
    if (m && m.fen_before && m.uci && brilliantEligible(evalMap, m)) {
      const a = await provider.moveAssessment({ fen: m.fen_before, moveUci: m.uci, rating });
      // The await above can span a long download/init/inference; honour a Stop that arrived
      // during it so we neither record this result nor proceed to the next move. (Aborting the
      // in-flight fetch itself is the future AbortSignal work; this stops at the next seam.)
      if (shouldCancel && shouldCancel()) throw cancelledError();
      if (a && Number.isFinite(a.humanProbability) && Number.isFinite(a.winChanceAfter)) {
        const item = {
          fen: m.fen_before,
          uci: m.uci,
          human_probability: a.humanProbability,
          win_chance_after: a.winChanceAfter,
        };
        assessments.push(item);
        // Layers 1 & 2, both free now that we hold the assessment: unintuitive AND reveal.
        // Only a move clearing both earns the costly trap_gap layer below.
        const unintuitive = a.humanProbability <= BRILLIANT_MAX_HUMAN_PROB;
        const engineWin = moverWinChanceFromEval(evalMap.get(m.fen_after), m.side) * 100;
        const revealClears = engineWin - a.winChanceAfter * 100 >= BRILLIANT_MIN_WIN_GAP;
        if (unintuitive && revealClears) {
          candidates.push({ item, side: m.side, playedAfterFen: m.fen_after });
        }
      }
    }
    if (onProgress) onProgress(i + 1, total);
  }

  // Second pass: attach trap_gap to the unintuitive candidates (in place, on their items).
  // A failure HERE must not discard the first-pass assessments we already computed for the
  // whole game: a candidate that ends up with no trap_gap simply fails closed on the server
  // (its trap layer is un-judgeable, so it won't be flagged), which is the correct local
  // degradation — losing every move's assessment over one batched-Stockfish hiccup is not. A
  // cancel still propagates, so a Stop can't be swallowed into a "finished" analysis.
  if (candidates.length) {
    try {
      await attachClientTrapGaps({
        candidates,
        evals: evals || new Map(),
        depth,
        rating,
        provider,
        analyzeFn,
        onProgress: onTrapProgress,
        shouldCancel,
        cancelledError,
      });
    } catch (err) {
      if (err && err.cancelled) throw err;
      // Non-cancel trap failure: keep the assessments already in hand; affected candidates
      // just ship without a trap_gap.
    }
  }
  return assessments;
}

// For each candidate (a move that already cleared the eligible + unintuitive + reveal layers
// in computeBrilliantAssessments), ask Maia for the move a human would naturally play, then
// run Stockfish once on the position it leads to; trap_gap = sf_truth(played) − sf_truth(that
// natural move), mover POV (0..1). The natural-move positions are de-duplicated and evaluated
// in ONE Stockfish batch (analyzeFn), so even several candidates cost a small, shared pool
// rather than a provider each. A candidate whose trap can't be evaluated (no policy / illegal
// natural move / missing eval) is left with no trap_gap — the server then can't judge its
// trap layer and won't flag it (fail closed). A natural move equal to the played one is a
// real 0 (no trap), shipped as such.
export async function attachClientTrapGaps({ candidates, evals, depth, rating, provider, analyzeFn, onProgress, shouldCancel, cancelledError }) {
  const plan = []; // { cand, humanFen?, sameAsPlayed? }
  const humanFens = [];
  const seen = new Set();
  for (const cand of candidates) {
    if (shouldCancel && shouldCancel()) throw cancelledError();
    let naturalUci = null;
    try {
      const preds = await provider.predictions({ fen: cand.item.fen, rating });
      naturalUci = preds && preds.length ? preds[0].move_uci : null;
    } catch (_) {
      naturalUci = null;
    }
    if (shouldCancel && shouldCancel()) throw cancelledError();
    if (!naturalUci) {
      plan.push({ cand, naturalUci: null }); // no policy → trap un-evaluable
      continue;
    }
    if (naturalUci.toLowerCase() === String(cand.item.uci).toLowerCase()) {
      plan.push({ cand, sameAsPlayed: true, naturalUci });
      continue;
    }
    let humanFen = null;
    try {
      humanFen = localBoardAfterMove(cand.item.fen, naturalUci).move.fen_after;
    } catch (_) {
      humanFen = null;
    }
    if (humanFen && !seen.has(humanFen)) {
      seen.add(humanFen);
      humanFens.push(humanFen);
    }
    plan.push({ cand, humanFen, naturalUci });
  }

  let humanEvals = new Map();
  if (humanFens.length) {
    humanEvals = await analyzeFn({
      positions: humanFens,
      depth,
      multipv: 1,
      // Surface the trap-line Stockfish batch as its own progress (the toast's "traps" phase),
      // so a game with brilliancy candidates doesn't look frozen while this batch runs.
      onProgress,
      shouldCancel,
    });
  }

  for (const p of plan) {
    if (p.sameAsPlayed) {
      p.cand.item.trap_gap = 0;
      continue;
    }
    if (!p.humanFen) {
      continue; // un-evaluable → leave trap_gap absent
    }
    const playedEval = evals.get(p.cand.playedAfterFen);
    const humanEval = humanEvals.get(p.humanFen);
    if (!playedEval || !humanEval) {
      continue; // a missing eval → trap layer un-evaluable, leave trap_gap absent
    }
    const playedWc = moverWinChanceAfter(
      { cp: playedEval.score_cp ?? null, mate: playedEval.mate_in ?? null },
      p.cand.side,
    );
    const humanWc = moverWinChanceAfter(
      { cp: humanEval.score_cp ?? null, mate: humanEval.mate_in ?? null },
      p.cand.side,
    );
    p.cand.item.trap_gap = playedWc - humanWc;
  }
}
