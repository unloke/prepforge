// Maia3 reads for Scout game-plan rows: leaf-FEN WDL from the opponent's perspective.

import { enrichPrepTarget, terminalMoveIsOpponent } from "./scout.js";

export const MAIA_ENRICH_IDLE = "idle";
export const MAIA_ENRICH_LOADING = "loading";
export const MAIA_ENRICH_READY = "ready";
export const MAIA_ENRICH_PARTIAL = "partial";
export const MAIA_ENRICH_FAILED = "failed";

export function clampMaiaRating(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n) || n <= 0) return 1500;
  return Math.max(600, Math.min(2600, Math.round(n)));
}

/** Median of the scouted player's rating in games for one colour. */
export function medianOpponentRating(games, color) {
  const ratings = games
    .filter((g) => g.color === color && g.rating > 0)
    .map((g) => g.rating)
    .sort((a, b) => a - b);
  if (!ratings.length) return 1500;
  const mid = Math.floor(ratings.length / 2);
  return ratings.length % 2 ? ratings[mid] : Math.round((ratings[mid - 1] + ratings[mid]) / 2);
}

/** Invert side-to-move WDL when the leaf position is the user's turn. */
export function wdlToOpponentPerspective(wdl, leafIsUserTurn) {
  if (!wdl) return null;
  if (leafIsUserTurn) {
    return { win: wdl.loss, draw: wdl.draw, loss: wdl.win };
  }
  return { win: wdl.win, draw: wdl.draw, loss: wdl.loss };
}

export function maiaScorePctFromWdl(wdl) {
  if (!wdl) return null;
  const total = (wdl.win || 0) + (wdl.draw || 0) + (wdl.loss || 0);
  if (!total) return 50;
  return Math.round((((wdl.win || 0) + 0.5 * (wdl.draw || 0)) / total) * 100);
}

export function maiaResultKey(fen, rating) {
  return `${clampMaiaRating(rating)}|${fen}`;
}

export function getMaiaResultEntry(maiaResults, fen, rating) {
  if (!maiaResults) return null;
  return maiaResults.get(maiaResultKey(fen, rating)) ?? null;
}

export function isMaiaFailed(maiaResults, fen, rating) {
  return getMaiaResultEntry(maiaResults, fen, rating)?.failed === true;
}

export function isMaiaAttempted(maiaResults, fen, rating) {
  const entry = getMaiaResultEntry(maiaResults, fen, rating);
  if (!entry) return false;
  if (entry.failed) return true;
  return entry.maiaScorePct != null && !!entry.maiaWdl;
}

export function getCachedMaiaResult(maiaResults, fen, rating) {
  const hit = getMaiaResultEntry(maiaResults, fen, rating);
  if (!hit || hit.failed || hit.maiaScorePct == null || !hit.maiaWdl) return null;
  return hit;
}

export function rememberMaiaResult(maiaResults, fen, rating, maia) {
  if (!maiaResults || !maia?.maiaWdl || maia.maiaScorePct == null) return;
  maiaResults.set(maiaResultKey(fen, rating), {
    maiaWdl: maia.maiaWdl,
    maiaScorePct: maia.maiaScorePct,
  });
}

export function rememberMaiaFailure(maiaResults, fen, rating) {
  if (!maiaResults) return;
  maiaResults.set(maiaResultKey(fen, rating), { failed: true });
}

export function countMaiaOutcomes(lines, { maiaResults, rating, fenAfterLine }) {
  let resolved = 0;
  let failed = 0;
  let missing = 0;
  for (const line of lines || []) {
    const fen = fenAfterLine(line.ucis);
    const entry = getMaiaResultEntry(maiaResults, fen, rating);
    if (entry?.failed) failed += 1;
    else if (entry?.maiaWdl && entry.maiaScorePct != null) resolved += 1;
    else missing += 1;
  }
  return { resolved, failed, missing, expected: lines?.length || 0 };
}

export function classifyMaiaEnrichState({ resolved, failed, expected }) {
  const attempted = resolved + failed;
  if (!expected) return MAIA_ENRICH_IDLE;
  if (attempted < expected) return MAIA_ENRICH_LOADING;
  if (resolved === expected) return MAIA_ENRICH_READY;
  if (resolved === 0) return MAIA_ENRICH_FAILED;
  return MAIA_ENRICH_PARTIAL;
}

export function openingLinesNeedMaia(lines, { maiaResults, rating, fenAfterLine }) {
  if (!lines?.length) return false;
  return lines.some(
    (line) => !isMaiaAttempted(maiaResults, fenAfterLine(line.ucis), rating),
  );
}

/** Scope key — failures retry only when speed, game count, or median rating changes. */
export function computeMaiaScopeKey({ activeSpeed, gameCount, ratings }) {
  return `${activeSpeed || "all"}|${gameCount || 0}|${ratings?.white ?? 0}|${ratings?.black ?? 0}`;
}

export function maiaProviderCacheKey(resultKey) {
  const pipeIdx = resultKey.indexOf("|");
  if (pipeIdx < 0) return null;
  const rating = resultKey.slice(0, pipeIdx);
  const fen = resultKey.slice(pipeIdx + 1);
  return `wdlRead|${rating}|${fen}`;
}

/** Drop failed leaf entries and their in-flight provider keys; keep successes. */
export function pruneMaiaFailures(maiaResults, maiaCache) {
  if (!maiaResults?.size) return 0;
  let removed = 0;
  for (const [key, entry] of [...maiaResults.entries()]) {
    if (!entry?.failed) continue;
    maiaResults.delete(key);
    removed += 1;
    const providerKey = maiaProviderCacheKey(key);
    if (providerKey && maiaCache) maiaCache.delete(providerKey);
  }
  return removed;
}

export function resetMaiaScopeCache(state, scopeKey) {
  if (!state || state.maiaScopeKey === scopeKey) return false;
  state.maiaScopeKey = scopeKey;
  if (!state.maiaResults) state.maiaResults = new Map();
  if (!state.maiaCache) state.maiaCache = new Map();
  const pruned = pruneMaiaFailures(state.maiaResults, state.maiaCache);
  if (pruned > 0 && state.maiaEnrichState !== MAIA_ENRICH_LOADING) {
    state.maiaEnrichState = MAIA_ENRICH_IDLE;
  }
  return true;
}

/** Normalize Maia `{win,draw,loss}` or empirical `{w,d,l}` for bar rendering. */
export function scoutLineWdlCounts(line) {
  if (line?.maiaWdl) {
    return {
      w: line.maiaWdl.win ?? 0,
      d: line.maiaWdl.draw ?? 0,
      l: line.maiaWdl.loss ?? 0,
    };
  }
  return { w: line?.w || 0, d: line?.d || 0, l: line?.l || 0 };
}

export function applyMaiaToLine(line, cached, baselineScorePct, enrich = enrichPrepTarget) {
  if (!cached) return line;
  const enriched = enrich(line, baselineScorePct, { maiaScorePct: cached.maiaScorePct });
  return { ...enriched, maiaWdl: cached.maiaWdl, maiaScorePct: cached.maiaScorePct };
}

export function applyMaiaToLines(
  lines,
  { maiaResults, rating, oppColor, baselineScorePct, fenAfterLine, enrichPrepTarget: enrich = enrichPrepTarget },
) {
  if (!maiaResults?.size || !lines?.length) return lines;
  return lines.map((line) => {
    const fen = fenAfterLine(line.ucis);
    const cached = getCachedMaiaResult(maiaResults, fen, rating);
    return applyMaiaToLine(line, cached, baselineScorePct, enrich);
  });
}

export function scoutMaiaRankedNote(prepTargets, state = MAIA_ENRICH_IDLE) {
  if (!prepTargets?.length) return "";
  const withMaia = prepTargets.filter((t) => t.maiaScorePct != null).length;
  const total = prepTargets.length;
  if (withMaia === total) {
    return `<div class="scout-ranked-note muted hint">Ranked by exploitability · score/WDL are Maia estimates</div>`;
  }
  if (state === MAIA_ENRICH_LOADING && withMaia < total) {
    return `<div class="scout-ranked-note muted hint">Ranked by exploitability · Maia estimates loading…</div>`;
  }
  if (state === MAIA_ENRICH_PARTIAL && withMaia > 0) {
    return `<div class="scout-ranked-note muted hint">Ranked by exploitability · partial Maia estimates · empirical score/WDL on remaining lines</div>`;
  }
  if (state === MAIA_ENRICH_PARTIAL) {
    return `<div class="scout-ranked-note muted hint">Ranked by exploitability · empirical score/WDL (Maia unavailable on some lines)</div>`;
  }
  if (state === MAIA_ENRICH_FAILED) {
    return `<div class="scout-ranked-note muted hint">Ranked by exploitability · empirical score/WDL (Maia unavailable)</div>`;
  }
  return `<div class="scout-ranked-note muted hint">Ranked by exploitability · empirical score/WDL</div>`;
}

export function markUnattemptedMaiaFailures(
  lines,
  { maiaResults, rating, fenAfterLine },
) {
  if (!maiaResults || !lines?.length) return;
  for (const line of lines) {
    const fen = fenAfterLine(line.ucis);
    if (!isMaiaAttempted(maiaResults, fen, rating)) {
      rememberMaiaFailure(maiaResults, fen, rating);
    }
  }
}

/**
 * One Maia positionRead for a game-plan line; memoized per (fen, rating).
 * Returns { maiaWdl, maiaScorePct } from the scouted opponent's POV.
 */
export async function readLineMaiaWdl(
  line,
  { provider, rating, oppColor, fenAfterLine, cache = new Map(), maiaResults = null },
) {
  if (!line?.ucis?.length || !oppColor || !fenAfterLine) return null;
  const fen = fenAfterLine(line.ucis);
  const r = clampMaiaRating(rating);
  if (isMaiaFailed(maiaResults, fen, r)) return null;
  const cached = getCachedMaiaResult(maiaResults, fen, r);
  if (cached) return cached;
  if (!provider) {
    rememberMaiaFailure(maiaResults, fen, r);
    return null;
  }
  const cacheKey = `wdlRead|${r}|${fen}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = provider.wdlRead({ fen, rating: r }).catch(() => null);
    cache.set(cacheKey, pending);
  }
  const read = await pending;
  if (!read?.wdl) {
    rememberMaiaFailure(maiaResults, fen, r);
    return null;
  }
  const leafIsUserTurn = terminalMoveIsOpponent(line.ucis, oppColor);
  const maiaWdl = wdlToOpponentPerspective(read.wdl, leafIsUserTurn);
  const maiaScorePct = maiaScorePctFromWdl(maiaWdl);
  const result = { maiaWdl, maiaScorePct };
  rememberMaiaResult(maiaResults, fen, r, result);
  return result;
}

/**
 * Fetch missing Maia reads for opening lines, store in maiaResults, return enriched lines.
 * Caller should re-run rankGamePlan on the returned lines for Maia-based ordering.
 */
export async function enrichOpeningLinesWithMaia(
  lines,
  {
    provider,
    rating,
    oppColor,
    baselineScorePct,
    fenAfterLine,
    enrichPrepTarget: enrich = enrichPrepTarget,
    cache = new Map(),
    maiaResults = null,
    shouldCancel = () => false,
  },
) {
  if (!lines?.length) return lines;
  const out = [...lines];
  for (let i = 0; i < out.length; i += 1) {
    if (shouldCancel()) return out;
    const line = out[i];
    const fen = fenAfterLine(line.ucis);
    if (isMaiaAttempted(maiaResults, fen, rating)) {
      const cached = getCachedMaiaResult(maiaResults, fen, rating);
      if (cached) out[i] = applyMaiaToLine(line, cached, baselineScorePct, enrich);
      continue;
    }
    const maia = await readLineMaiaWdl(line, {
      provider,
      rating,
      oppColor,
      fenAfterLine,
      cache,
      maiaResults,
    });
    if (!maia || shouldCancel()) continue;
    out[i] = applyMaiaToLine(line, maia, baselineScorePct, enrich);
  }
  return out;
}