// Running Analyze again on a game the library already reviewed.
//
// `prepare` names the game's latest saved review (engine, depth, whether Maia ran).
// When that review may cover this run, its per-position Stockfish reads are fetched
// and handed to the whole-game pass, which takes each one instead of searching it.
// Grading, Maia and the save still run, so the new review uses today's classifier on
// the same reads.
//
// Each read is judged on its own: only one searched at least as deep as this run asks
// is taken (a review can hold shallower reads, and the latest review can change between
// `prepare` and this read). The reads go to the pass as a map of their own, not into
// the store's bounded cache, so a game longer than that cache keeps all of them. Each
// keeps its `engine`, so the save records the net that actually searched it.
//
// A review from either Stockfish net this app ships counts (savedEvalUsable). The
// extra GET of the saved review happens only on this path.

import { savedEvalUsable } from "./engine/stockfish-provider.js";

export function savedRunCovers(prep) {
  const saved = prep?.saved_analysis;
  return !!(saved && prep.game_id && savedEvalUsable(saved.engine) && Number(saved.depth) >= Number(prep.depth));
}

// The saved review's usable reads of this run's positions (fen -> eval), or null when
// there is no review to use or it cannot be read: the pass then searches as before.
export async function savedRunReads(prep, fetchJson) {
  if (!savedRunCovers(prep)) return null;
  let saved;
  try {
    saved = await fetchJson(`/api/analyses/${encodeURIComponent(prep.game_id)}`);
  } catch {
    return null;
  }
  const evals = saved?.position_evals || {};
  const reads = new Map();
  for (const fen of prep.positions || []) {
    const ev = evals[fen];
    if (!ev || !savedEvalUsable(ev.engine) || (ev.score_cp == null && ev.mate_in == null)) continue;
    if (!(Number(ev.depth) >= Number(prep.depth))) continue;
    reads.set(fen, { ...ev, pv: ev.pv || [] });
  }
  return reads.size ? reads : null;
}
