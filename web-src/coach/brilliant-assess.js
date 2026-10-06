import { localBoardAfterMove } from "../chess-local.js";
import {
  moverWinChanceAfter,
  sanityExclusion,
  BRILLIANT_MAX_HUMAN_PROB,
  BRILLIANT_MIN_WIN_GAP,
  BRILLIANT_MIN_TRAP_GAP,
  BRILLIANT_MAX_CANDIDATE_WIN_DELTA,
  GREAT_MAX_HUMAN_PROB,
  GREAT_MIN_TRAP_GAP,
  GREAT_MIN_WIN,
  GREAT_MAX_WIN_BEFORE,
} from "./features.js";

// Stockfish concurrency for the trap-line batch. This pass runs WHILE the ~1 GB Maia session is
// still resident (it needs Maia's policy to pick each human-natural move), so an extra 6-worker
// Stockfish pool on top is what pushed peak memory to ~1.2 GB. It only ever evaluates a handful
// of de-duplicated candidate positions, so a small pool barely costs wall-clock while meaningfully
// trimming that peak — capped here (game-analyzer still clamps to the position count).
const TRAP_STOCKFISH_CONCURRENCY = 2;

// Deep confirmation. Every move that could still earn Brilliant or Great gets one MultiPV-3
// search of its position this much deeper than the analysis; its gaps are read from that
// search, and a move that falls out of the top three there, or whose own score moves more
// than CONFIRM_MAX_DRIFT (win chance, 0..1) from the analysis read, loses its trap_gap so
// the server can't grade it (fail closed): a grade must not rest on a depth fluctuation.
const CONFIRM_DEPTH_GAIN = 2;
const CONFIRM_MAX_DRIFT = 0.1;

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
//     equals the server's loss (same evals, same 0.00368208 sigmoid), and the cap mirrors the
//     server's excellent_loss = 0.02 (winDelta is in percentage points, so 2 ⇔ 0.02).
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
//   provider  — getSharedMaia3Provider(): .batch("moveAssessmentMany") / .moveAssessment() / .predictions()
//   analyzeFn — analyzeGamePositions() from engine/game-analyzer.js
//
// The per-move Maia3 assessment (humanProbability, winChanceAfter) is computed IN THE BROWSER
// so the server's BrilliantAnalyzer (via ReplayMaia) can grade with zero server compute.
// Best-effort: if Maia is unavailable (no weights) or any inference fails, the caller drops
// the Maia signals and the analysis still completes — exactly the server's no-Maia path.
//
// `rating` is the player's effective Maia3 strength (Settings-pinned, else AUTO from the
// linked Lichess account, else the model default) — the SAME effectiveMaiaRating() the live
// coach uses, so a brilliancy flagged in full-game analysis matches one the coach stars live,
// and the read is personalized ("因材施教"). The server's ReplayMaia ignores its own rating and
// trusts these numbers, so the client is the single source of truth for strength.
//
// Brilliant has four layers (services/brilliant.py / isBrilliantByMaia), and they get
// steadily more expensive — so we check them CHEAPEST-FIRST and only ever pay for a layer
// once everything cheaper has passed:
//   0. Eligible (free): winDelta <= candidate cap — pure arithmetic over `evals`, no model
//      call at all. A move that isn't Best/Excellent can't be graded, so this gate spares a
//      Maia forward on the (many) clearly-suboptimal plies.
//   1. Unintuitive (one batched Maia forward pair, shared with the assessment).
//   2. Reveal (free, from the numbers already in hand): Stockfish's win% sits far above
//      Maia's first-glance read.
//   3. trap_gap: sf_truth(played) − sf_truth(the move a human would NATURALLY play). The
//      natural move comes off the same policy forward as the assessment; its position needs
//      one Stockfish eval (free when it is the played move, the engine's first choice, or a
//      game position the main pass already searched).
//   4. Decisive: an only move (only_move_gap) or a sacrifice (read off the reply line).
//
// Great (the tier under Brilliant) adds a critical find for moderately unintuitive moves in a
// live position: the natural move fails by GREAT_MIN_TRAP_GAP and at most one other move comes
// close (two_move_gap). It is checked as a two-stage funnel so it costs almost nothing: a
// SHALLOW single-line eval of the natural move first (the screen), and the MultiPV-3 search
// only for the few moves that survive it.
//
// The Maia pass streams: createBrilliantAssessor().push(fen, eval) takes each Stockfish
// result as the main pass produces it, and a move is assessed as soon as both of its
// positions are known — so Maia runs WHILE Stockfish does instead of after it. finish(evals)
// drains the rest and runs the (small) trap / gap batches.
//
// We only ship assessments for eligible moves; the server consults assessments solely for
// the Best/Excellent ones it classifies, so dropping the rest is both safe and faster.
//
// Optional phase instrumentation (onPhase): `{ phase, detail }` per sub-phase, so a slow
// analysis can be attributed to the real phase. Never throws (guarded internally).

// Moves per batched Maia request.
const ASSESS_CHUNK = 16;

// The Great screen: a single-line eval of the natural move this far below the analysis depth.
// It only has to tell a natural move that loses 10+ points from one that doesn't; the few that
// pass are searched again at the analysis depth, then confirmed (see CONFIRM_DEPTH_GAIN).
const SCREEN_DEPTH_DROP = 6;
const SCREEN_MIN_DEPTH = 8;

function cancelledError() {
  const err = new Error("Analysis stopped");
  err.cancelled = true;
  return err;
}

export function createBrilliantAssessor({ moves, depth, rating, onProgress, onTrapProgress, shouldCancel, provider, analyzeFn, onPhase }) {
  const total = moves.length;
  const evalMap = new Map();
  const movesByFen = new Map(); // fen → indices of the moves it belongs to
  moves.forEach((m, i) => {
    for (const fen of [m && m.fen_before, m && m.fen_after]) {
      if (fen) movesByFen.set(fen, [...(movesByFen.get(fen) || []), i]);
    }
  });
  const state = new Array(total).fill(0); // 0 waiting · 1 queued for Maia · 2 done
  const slots = new Array(total).fill(null); // the assessment item per move, in move order
  const naturals = new Map(); // item → the natural (Maia top-policy) move, when the batch said
  const queue = [];
  let failure = null;
  let streamFailed = false; // a chunk failed before finish(): retry it there, stop streaming
  const retry = [];
  let finishing = false;
  let done = 0;
  let assessed = 0;
  let skippedIneligible = 0;
  const batched = typeof provider.batch === "function";
  const cancelled = () => !!(shouldCancel && shouldCancel());
  const phase = (name, detail) => {
    try {
      if (typeof onPhase === "function") onPhase({ phase: name, detail });
    } catch (_) {
      /* instrumentation only */
    }
  };
  const progress = () => {
    if (finishing && onProgress) onProgress(done, total);
  };

  function settle(i) {
    state[i] = 2;
    done += 1;
    progress();
  }

  // The shared sanity gates (forced, a recapture of the previous move): the server never
  // grades such a move, so it never costs a Maia forward either.
  function excluded(i) {
    const m = moves[i];
    const prev = i > 0 ? moves[i - 1] : null;
    const linked = prev && prev.fen_after === m.fen_before;
    return !!sanityExclusion({
      fenBefore: m.fen_before,
      uci: m.uci,
      prevFenBefore: linked ? prev.fen_before : null,
      prevUci: linked ? prev.uci : null,
    });
  }

  // Decide a move once both of its positions are evaluated: ineligible ones are settled for
  // free, eligible ones join the Maia queue.
  function consider(i) {
    if (state[i] !== 0) return;
    const m = moves[i];
    if (!m || !m.fen_before || !m.uci) {
      skippedIneligible += 1;
      settle(i);
      return;
    }
    if (!evalMap.has(m.fen_before) || !evalMap.has(m.fen_after)) {
      if (!finishing) return; // wait for the other position
      skippedIneligible += 1; // never evaluated → can't be graded
      settle(i);
      return;
    }
    if (!brilliantEligible(evalMap, m) || excluded(i)) {
      skippedIneligible += 1;
      settle(i);
      return;
    }
    state[i] = 1;
    queue.push(i);
  }

  function record(i, a) {
    const m = moves[i];
    assessed += 1;
    if (a && Number.isFinite(a.humanProbability) && Number.isFinite(a.winChanceAfter)) {
      const item = { fen: m.fen_before, uci: m.uci, human_probability: a.humanProbability, win_chance_after: a.winChanceAfter };
      if (typeof a.naturalUci === "string") naturals.set(item, a.naturalUci);
      slots[i] = item;
    }
    settle(i);
  }

  async function runChunk(indices) {
    if (cancelled()) throw cancelledError();
    if (batched) {
      const reads = await provider.batch("moveAssessmentMany", {
        items: indices.map((i) => ({ fen: moves[i].fen_before, moveUci: moves[i].uci })),
        rating,
      });
      // The await can span the model download/init/inference: honour a Stop that arrived.
      if (cancelled()) throw cancelledError();
      indices.forEach((i, k) => record(i, reads ? reads[k] : null));
      return;
    }
    for (const i of indices) {
      if (cancelled()) throw cancelledError();
      const a = await provider.moveAssessment({ fen: moves[i].fen_before, moveUci: moves[i].uci, rating });
      if (cancelled()) throw cancelledError();
      record(i, a);
    }
  }

  // While Stockfish runs, Maia takes a full chunk at a time whenever it is free. (Smaller,
  // eager chunks measured no faster: they only take more CPU from the Stockfish workers.)
  // A chunk that fails here (say Maia's init failed) is retried once in finish(), the way the
  // pass used to retry init when it ran after Stockfish; a Stop is kept and surfaced there.
  let busy = null;
  function pump() {
    if (busy || finishing || streamFailed || failure || queue.length < ASSESS_CHUNK) return;
    const indices = queue.splice(0, ASSESS_CHUNK);
    busy = runChunk(indices)
      .catch((err) => {
        if (err && err.cancelled) failure = failure || err;
        else {
          streamFailed = true;
          retry.push(...indices);
        }
      })
      .finally(() => {
        busy = null;
        pump();
      });
  }

  return {
    // One main-pass result. Safe to call any number of times, in any order.
    push(fen, ev) {
      if (finishing || streamFailed || failure || !ev || !movesByFen.has(fen)) return;
      evalMap.set(fen, ev);
      for (const i of movesByFen.get(fen)) consider(i);
      pump();
    },

    // The complete eval map: assess whatever is left, then run the trap / gap batches.
    async finish(evals) {
      finishing = true;
      if (evals && typeof evals.forEach === "function") evals.forEach((ev, fen) => evalMap.set(fen, ev));
      phase("maia-inference-start", { total, streamed: done });
      if (done) progress();
      while (busy) await busy; // let the streamed chunk settle first
      if (failure) throw failure;
      queue.unshift(...retry.splice(0));
      for (let i = 0; i < total; i++) consider(i);
      // Before draining: the first chunk can also drive the model download + session init.
      if (cancelled()) throw cancelledError();
      while (queue.length) await runChunk(queue.splice(0, ASSESS_CHUNK));
      phase("maia-inference-done", { assessed, skippedIneligible, total });

      const assessments = slots.filter(Boolean);
      const candidates = []; // layers 0–2 passed: need a full-depth trap_gap
      const screens = []; // Great critical-find candidates: need the shallow screen
      moves.forEach((m, i) => {
        const item = slots[i];
        if (!item) return;
        const engineWin = moverWinChanceFromEval(evalMap.get(m.fen_after), m.side) * 100;
        const winBefore = moverWinChanceFromEval(evalMap.get(m.fen_before), m.side) * 100;
        const greatLive = item.human_probability <= GREAT_MAX_HUMAN_PROB && engineWin >= GREAT_MIN_WIN && winBefore <= GREAT_MAX_WIN_BEFORE;
        const cand = { item, side: m.side, playedAfterFen: m.fen_after, naturalUci: naturals.get(item), greatLive };
        if (item.human_probability <= BRILLIANT_MAX_HUMAN_PROB && engineWin - item.win_chance_after * 100 >= BRILLIANT_MIN_WIN_GAP) {
          candidates.push(cand);
        } else if (greatLive) {
          screens.push(cand);
        }
      });

      // A failure HERE must not discard the assessments already computed for the whole game:
      // a move left without a trap_gap / gap simply fails closed on the server. A cancel still
      // propagates, so a Stop can't be swallowed into a "finished" analysis.
      if (candidates.length || screens.length) {
        try {
          await attachClientTrapGaps({
            candidates,
            screens,
            evals: evalMap,
            depth,
            rating,
            provider,
            analyzeFn,
            onProgress: onTrapProgress,
            shouldCancel,
            cancelledError,
            onPhase: (evt) => phase(evt?.phase || "maia-traps", evt?.detail),
          });
          await attachAlternativeGaps({
            candidates,
            // Only the moves whose natural alternative failed earn the MultiPV-3 search.
            critical: [...candidates, ...screens].filter((c) => c.greatLive && c.item.trap_gap >= GREAT_MIN_TRAP_GAP),
            evals: evalMap,
            depth,
            analyzeFn,
            shouldCancel,
            cancelledError,
            onPhase: (evt) => phase(evt?.phase || "maia-only-move", evt?.detail),
          });
        } catch (err) {
          if (err && err.cancelled) throw err;
        }
      }
      return assessments;
    },
  };
}

// The whole Maia pass over a finished eval map (no streaming).
export async function computeBrilliantAssessments({ evals, ...options }) {
  return createBrilliantAssessor(options).finish(evals || new Map());
}

// trap_gap = sf_truth(played) − sf_truth(the move a human would naturally play), mover POV
// (0..1), for each Brilliant candidate (searched at the analysis depth) and each Great screen
// (searched SCREEN_DEPTH_DROP shallower — it only has to spot a natural move that loses 10+
// points). The natural move is the one the assessment batch already read off Maia's policy;
// only a candidate without it asks Maia again. Its value costs no search when it is the
// played move (a real 0), the engine's first choice (the pre-move eval), or a position the
// main pass already searched; the rest are de-duplicated into one Stockfish batch per depth.
// A candidate whose trap can't be evaluated (no policy / illegal natural move / missing
// eval) is left with no trap_gap — the server then can't judge its trap layer and won't
// flag it (fail closed).
export async function attachClientTrapGaps({ candidates, screens = [], evals, depth, rating, provider, analyzeFn, onProgress, shouldCancel, cancelledError, onPhase }) {
  const emit = (name, detail) => {
    try {
      if (typeof onPhase === "function") onPhase({ phase: name, detail });
    } catch (_) {
      /* instrumentation only */
    }
  };
  const plan = []; // { cand, known? (an eval in hand), humanFen? }
  const deepFens = new Set();
  const screenFens = new Set();
  let policyCalls = 0;
  emit("maia-traps-policy-start", { candidates: candidates.length, screens: screens.length });
  const work = [...candidates.map((cand) => [cand, true]), ...screens.map((cand) => [cand, false])];
  for (const [cand, deep] of work) {
    if (shouldCancel && shouldCancel()) throw cancelledError();
    let naturalUci = typeof cand.naturalUci === "string" ? cand.naturalUci : null;
    if (cand.naturalUci === undefined) {
      try {
        policyCalls += 1;
        const preds = await provider.predictions({ fen: cand.item.fen, rating });
        naturalUci = preds && preds.length ? preds[0].move_uci : null;
      } catch (_) {
        naturalUci = null;
      }
      if (shouldCancel && shouldCancel()) throw cancelledError();
    }
    if (!naturalUci) continue; // no policy → trap un-evaluable
    if (naturalUci.toLowerCase() === String(cand.item.uci).toLowerCase()) {
      cand.item.trap_gap = 0; // the natural move IS the played one: no trap
      continue;
    }
    const before = evals.get(cand.item.fen);
    if (before && before.best_move_uci === naturalUci) {
      plan.push({ cand, known: before });
      continue;
    }
    let humanFen = null;
    try {
      humanFen = localBoardAfterMove(cand.item.fen, naturalUci).move.fen_after;
    } catch (_) {
      humanFen = null;
    }
    if (!humanFen) continue;
    if (!evals.has(humanFen)) (deep ? deepFens : screenFens).add(humanFen);
    plan.push({ cand, humanFen });
  }
  for (const fen of deepFens) screenFens.delete(fen);

  const searched = new Map();
  emit("maia-traps-policy-done", { policyCalls, deep: deepFens.size, screen: screenFens.size });
  const run = async (fens, searchDepth) => {
    if (!fens.size) return;
    if (shouldCancel && shouldCancel()) throw cancelledError();
    emit("maia-traps-stockfish-start", { positions: fens.size, depth: searchDepth });
    const reads = await analyzeFn({
      positions: [...fens],
      depth: searchDepth,
      multipv: 1,
      // Keep the trap pool small: it runs alongside the resident Maia session, so a big
      // Stockfish fan-out here is the main avoidable contributor to the memory peak.
      concurrency: TRAP_STOCKFISH_CONCURRENCY,
      // Surface the trap-line batch as its own progress (the toast's "traps" phase), so a
      // game with candidates doesn't look frozen while it runs.
      onProgress,
      shouldCancel,
    });
    reads.forEach((ev, fen) => searched.set(fen, ev));
  };
  await run(deepFens, depth);
  await run(screenFens, Math.max(SCREEN_MIN_DEPTH, (Number(depth) || SCREEN_MIN_DEPTH) - SCREEN_DEPTH_DROP));
  const apply = () => {
    for (const p of plan) {
      const playedEval = evals.get(p.cand.playedAfterFen);
      const humanEval = p.known || searched.get(p.humanFen) || evals.get(p.humanFen);
      if (!playedEval || !humanEval) continue; // a missing eval → trap layer un-evaluable
      const playedWc = moverWinChanceAfter({ cp: playedEval.score_cp ?? null, mate: playedEval.mate_in ?? null }, p.cand.side);
      const humanWc = moverWinChanceAfter({ cp: humanEval.score_cp ?? null, mate: humanEval.mate_in ?? null }, p.cand.side);
      p.cand.item.trap_gap = playedWc - humanWc;
    }
  };
  apply();
  // A natural move the shallow screen says fails is read again at the analysis depth, so the
  // trap compares two reads of the same depth.
  const recheck = new Set(
    plan.filter((p) => p.humanFen && screenFens.has(p.humanFen) && p.cand.item.trap_gap >= GREAT_MIN_TRAP_GAP).map((p) => p.humanFen),
  );
  if (recheck.size) {
    await run(recheck, depth);
    apply();
  }
  emit("maia-traps-stockfish-done", { positions: deepFens.size + screenFens.size + recheck.size });
}

// only_move_gap / two_move_gap = sf_truth(played) − sf_truth(the best / second-best OTHER
// move), mover POV (0..1), from one MultiPV-3 read of the position before the move, searched
// CONFIRM_DEPTH_GAIN deeper than the analysis. Every move that can still be graded is read:
// a hard find (a Brilliant candidate whose trap held: at least Great) and a critical find
// (natural move failed the trap). The same read confirms the move (see CONFIRM_MAX_DRIFT):
// one that doesn't hold up loses its trap_gap. Every position is searched once.
export async function attachAlternativeGaps({ candidates, critical = [], evals, depth, analyzeFn, shouldCancel, cancelledError, onPhase }) {
  const wc = (ev, side) => moverWinChanceAfter({ cp: ev.score_cp ?? null, mate: ev.mate_in ?? null }, side);
  const groups = new Map(); // fen → [cand]
  const seen = new Set();
  const queue = (cand) => {
    if (seen.has(cand.item) || !evals.get(cand.playedAfterFen)) return;
    seen.add(cand.item);
    groups.set(cand.item.fen, [...(groups.get(cand.item.fen) || []), cand]);
  };
  for (const cand of candidates) if (cand.item.trap_gap >= BRILLIANT_MIN_TRAP_GAP) queue(cand);
  for (const cand of critical) if (cand.item.trap_gap >= GREAT_MIN_TRAP_GAP) queue(cand);
  if (!groups.size) return;
  if (shouldCancel && shouldCancel()) throw cancelledError();
  if (typeof onPhase === "function") onPhase({ phase: "maia-confirm-start", detail: { positions: groups.size } });
  const reads = await analyzeFn({
    positions: [...groups.keys()],
    depth: (Number(depth) || 0) + CONFIRM_DEPTH_GAIN,
    multipv: 3,
    concurrency: TRAP_STOCKFISH_CONCURRENCY,
    shouldCancel,
  });
  for (const [fen, cands] of groups) {
    const read = reads.get(fen);
    const lines = read && (read.score_cp != null || read.mate_in != null)
      ? [{ move_uci: read.best_move_uci, score_cp: read.score_cp, mate_in: read.mate_in }, read.second, read.third].filter(Boolean)
      : [];
    for (const { item, side, playedAfterFen } of cands) {
      const mine = lines.find((l) => l.move_uci === item.uci);
      const playedWc = mine ? wc(mine, side) : null;
      if (playedWc === null || Math.abs(playedWc - wc(evals.get(playedAfterFen), side)) > CONFIRM_MAX_DRIFT) {
        delete item.trap_gap; // not confirmed at depth: the server can't grade it
        continue;
      }
      const others = lines.filter((l) => l.move_uci !== item.uci);
      if (others[0]) item.only_move_gap = playedWc - wc(others[0], side);
      if (others[1]) item.two_move_gap = playedWc - wc(others[1], side);
    }
  }
}
