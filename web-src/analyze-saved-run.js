// Running Analyze again on a game the library already reviewed.
//
// `prepare` names the game's latest saved review (engine, depth, whether Maia ran).
// When that review was searched at least as deep as this run asks, its per-position
// Stockfish reads go into the store's game channel before the whole-game pass, so
// the pass reuses every one instead of searching the game again. Grading, Maia and
// the save still run, so the new review uses today's classifier on the same reads.
//
// A review from either Stockfish net this app ships counts (savedEvalUsable). The
// extra GET of the saved review happens only on this path.

import { savedEvalUsable } from "./engine/stockfish-provider.js";

export function savedRunCovers(prep) {
  const saved = prep?.saved_analysis;
  return !!(saved && prep.game_id && savedEvalUsable(saved.engine) && Number(saved.depth) >= Number(prep.depth));
}

// Publish the saved review's reads for this run's positions. Returns how many were
// seeded; a review that cannot be read leaves the pass to search as before.
export async function seedSavedRun(store, prep, fetchJson) {
  if (!savedRunCovers(prep)) return 0;
  let saved;
  try {
    saved = await fetchJson(`/api/analyses/${encodeURIComponent(prep.game_id)}`);
  } catch {
    return 0;
  }
  const evals = saved?.position_evals || {};
  let seeded = 0;
  for (const fen of prep.positions || []) {
    const ev = evals[fen];
    if (!ev || !savedEvalUsable(ev.engine) || (ev.score_cp == null && ev.mate_in == null)) continue;
    store.publishGame(fen, { ...ev, pv: ev.pv || [] }, prep.saved_analysis.depth);
    seeded += 1;
  }
  return seeded;
}
