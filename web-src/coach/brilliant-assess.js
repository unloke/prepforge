import { localBoardAfterMove } from "../chess-local.js";
import { moverWinChanceAfter, BRILLIANT_MAX_HUMAN_PROB } from "./features.js";

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
// trusts these numbers, so the client is the single source of truth for strength. We assess
// every played move; the server only consults the eligible (Best/Excellent) ones, so
// over-supplying is harmless (and avoids porting the win-chance/classification math to JS).
//
// The third brilliant layer is trap_gap (services/brilliant.py): sf_truth(played) −
// sf_truth(the move a human would NATURALLY play). The server can't compute it (no engine),
// so we do it here and ship it. It needs an extra Stockfish eval of the natural move, so we
// only compute it for the moves that can possibly clear the gate — the UNINTUITIVE ones
// (humanProbability <= the cap). That cap is browser-sourced and used verbatim server-side,
// so gating on it never skips a move the server would flag, and it keeps the extra engine
// work to the rare handful of candidate moves rather than every ply. `evals` is the analysis
// run's per-FEN eval map (so sf_truth(played) = eval of fen_after, reused, not recomputed).
export async function computeBrilliantAssessments({ moves, evals, depth, rating, onProgress, shouldCancel, provider, analyzeFn }) {
  const assessments = [];
  const candidates = []; // unintuitive moves needing a trap_gap: { item, side, playedAfterFen }
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
    if (m && m.fen_before && m.uci) {
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
        if (a.humanProbability <= BRILLIANT_MAX_HUMAN_PROB) {
          candidates.push({ item, side: m.side, playedAfterFen: m.fen_after });
        }
      }
    }
    if (onProgress) onProgress(i + 1, total);
  }

  // Second pass: attach trap_gap to the unintuitive candidates (in place, on their items).
  if (candidates.length) {
    await attachClientTrapGaps({
      candidates,
      evals: evals || new Map(),
      depth,
      rating,
      provider,
      analyzeFn,
      shouldCancel,
      cancelledError,
    });
  }
  return assessments;
}

// For each unintuitive candidate, ask Maia for the move a human would naturally play, then
// run Stockfish once on the position it leads to; trap_gap = sf_truth(played) − sf_truth(that
// natural move), mover POV (0..1). The natural-move positions are de-duplicated and evaluated
// in ONE Stockfish batch (analyzeFn), so even several candidates cost a small, shared pool
// rather than a provider each. A candidate whose trap can't be evaluated (no policy / illegal
// natural move / missing eval) is left with no trap_gap — the server then can't judge its
// trap layer and won't flag it (fail closed). A natural move equal to the played one is a
// real 0 (no trap), shipped as such.
export async function attachClientTrapGaps({ candidates, evals, depth, rating, provider, analyzeFn, shouldCancel, cancelledError }) {
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
      plan.push({ cand }); // no policy → trap un-evaluable
      continue;
    }
    if (naturalUci.toLowerCase() === String(cand.item.uci).toLowerCase()) {
      plan.push({ cand, sameAsPlayed: true });
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
    plan.push({ cand, humanFen });
  }

  let humanEvals = new Map();
  if (humanFens.length) {
    humanEvals = await analyzeFn({
      positions: humanFens,
      depth,
      multipv: 1,
      shouldCancel,
    });
  }

  for (const p of plan) {
    if (p.sameAsPlayed) {
      p.cand.item.trap_gap = 0;
      continue;
    }
    if (!p.humanFen) continue; // un-evaluable → leave trap_gap absent
    const playedEval = evals.get(p.cand.playedAfterFen);
    const humanEval = humanEvals.get(p.humanFen);
    if (!playedEval || !humanEval) continue;
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
