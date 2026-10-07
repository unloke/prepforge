import { html } from "./html.js";
// Maia3 reads for Scout game-plan rows: leaf-FEN WDL from the opponent's perspective.

import { branchPathKey, enrichPrepTarget, terminalMoveIsOpponent, hashGameIdsForScope, SCOUT_SCORING_VERSION } from "./scout.js";

export const MAIA_ENRICH_IDLE = "idle";
export const MAIA_ENRICH_LOADING = "loading";
export const MAIA_ENRICH_READY = "ready";
export const MAIA_ENRICH_PARTIAL = "partial";
export const MAIA_ENRICH_FAILED = "failed";
// Analysis-layer Maia is OFF: enrichment never ran, and the report must say
// the feature needs Maia instead of looking like a failure or a partial read.
export const MAIA_ENRICH_OFF = "maia-off";

import { SCOUT_PREFILTER_POOL_SIZE } from "./scout-prefilter.js";

export const SCOUT_MAIA_TARGET_COUNT = 12;
/**
 * Target successful Maia3 WDL reads per opponent colour. The report recommends up
 * to SCOUT_MAIA_TARGET_COUNT routes for EACH colour, so a run that scouts both
 * colours needs up to 2 × this many reads.
 */
export const SCOUT_MAIA_SUCCESS_TARGET = SCOUT_MAIA_TARGET_COUNT;
/**
 * Max new wdlRead attempts while chasing successTarget — failures pull backups
 * without reducing the success goal.
 */
export const SCOUT_MAIA_MAX_ATTEMPTS = SCOUT_PREFILTER_POOL_SIZE;

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
  const entry = getMaiaResultEntry(maiaResults, fen, rating);
  return entry?.failed === true;
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
  maiaResults.set(maiaResultKey(fen, rating), { failed: true, method: "wdlRead" });
}

export function classifyMaiaEnrichState({ resolved, failed, expected }) {
  const attempted = resolved + failed;
  if (!expected) return MAIA_ENRICH_IDLE;
  if (attempted < expected) return MAIA_ENRICH_LOADING;
  if (resolved === expected) return MAIA_ENRICH_READY;
  if (resolved === 0) return MAIA_ENRICH_FAILED;
  return MAIA_ENRICH_PARTIAL;
}

/** Scope key — failures retry only when speed, game count, or median rating changes. */
export function computeMaiaScopeKey({ activeSpeed, gameCount, games, ratings }) {
  return `${activeSpeed || "all"}|${gameCount || 0}|${ratings?.white ?? 0}|${ratings?.black ?? 0}|${games?.length ? hashGameIdsForScope(games) : gameCount || 0}|${SCOUT_SCORING_VERSION}`;
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
  return line?.routeWdl ?? { w: line?.w || 0, d: line?.d || 0, l: line?.l || 0 };
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

export function scoutMaiaRankedNote(
  prepTargets,
  state = MAIA_ENRICH_IDLE,
  { prefilterState = "idle" } = {},
) {
  if (!prepTargets?.length) return "";
  const withMaia = prepTargets.filter((t) => t.maiaScorePct != null).length;
  const total = prepTargets.length;
  // One shared inline progress state already names this work; never repeat
  // transient loading sentences in both colour cards.
  if (prefilterState === "loading" || state === MAIA_ENRICH_LOADING) return "";
  // Settled states carry no standing note: how the list is ranked is not repeated
  // on every report. Keep errors and the action that fixes a blocked state.
  if (withMaia < total && (state === MAIA_ENRICH_FAILED || state === MAIA_ENRICH_PARTIAL)) {
    return html`<div class="scout-ranked-note muted hint">Maia unavailable on ${total - withMaia}/${total} lines. Retry in Settings → Maia3.</div>`;
  }

  return "";
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

/** Per-colour success targets: min(successTarget, pool entries of that colour). */
function maiaTargetsByColor(rankedEntries, successTarget) {
  const counts = { white: 0, black: 0 };
  for (const entry of rankedEntries || []) {
    if (entry?.oppColor in counts) counts[entry.oppColor] += 1;
  }
  return {
    white: Math.min(successTarget, counts.white),
    black: Math.min(successTarget, counts.black),
  };
}

/**
 * Globally ranked Stockfish pool → Maia WDL. Success target and attempt budget are
 * separate so backup reads can still reach 12 successes after failures.
 */
export async function enrichGlobalMaiaPool(
  rankedEntries,
  {
    successTarget = SCOUT_MAIA_SUCCESS_TARGET,
    maxAttempts = SCOUT_MAIA_MAX_ATTEMPTS,
    attemptsUsed = 0,
    provider,
    fenAfterLine,
    getRating,
    getBaselineScorePct,
    enrichPrepTarget: enrich = enrichPrepTarget,
    cache = new Map(),
    maiaResults = null,
    shouldCancel = () => false,
    onProgress = null,
  } = {},
) {
  const successes = [];
  const successesByColor = { white: [], black: [] };
  let attempts = attemptsUsed;
  const seenKeys = new Set();
  const targets = maiaTargetsByColor(rankedEntries, successTarget);
  const target = targets.white + targets.black;
  const colorDone = (color) => successesByColor[color].length >= targets[color];
  const reportProgress = () => {
    if (typeof onProgress === "function") {
      onProgress({ done: successes.length, total: target, phase: "maia" });
    }
  };
  reportProgress();

  for (const entry of rankedEntries || []) {
    if (shouldCancel()) break;
    if (colorDone("white") && colorDone("black")) break;
    if (attempts >= maxAttempts) break;

    const line = entry?.line;
    const oppColor = entry?.oppColor;
    if (!line?.ucis?.length || !(oppColor in successesByColor)) continue;
    if (colorDone(oppColor)) continue;

    const key = `${oppColor}|${branchPathKey(line.ucis)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const rating = getRating(oppColor);
    const baselineScorePct = getBaselineScorePct(oppColor);
    const fen = fenAfterLine(line.ucis);
    let maia = null;
    if (isMaiaAttempted(maiaResults, fen, rating)) {
      maia = getCachedMaiaResult(maiaResults, fen, rating);
    } else {
      attempts += 1;
      maia = await readLineMaiaWdl(line, {
        provider,
        rating,
        oppColor,
        fenAfterLine,
        cache,
        maiaResults,
      });
    }
    if (!maia || shouldCancel()) continue;
    const enriched = applyMaiaToLine(line, maia, baselineScorePct, enrich);
    successes.push({ oppColor, line: enriched });
    successesByColor[oppColor].push(enriched);
    reportProgress();
  }

  return { successes, successesByColor, attempts };
}

/** Successful reads per colour, capped at that colour's target. */
export function countGlobalMaiaSuccesses(
  rankedEntries,
  { successTarget = SCOUT_MAIA_SUCCESS_TARGET, maiaResults, getRating, fenAfterLine },
) {
  const resolved = { white: 0, black: 0 };
  for (const entry of rankedEntries || []) {
    if (!(entry.oppColor in resolved)) continue;
    const rating = getRating(entry.oppColor);
    const fen = fenAfterLine(entry.line.ucis);
    if (getCachedMaiaResult(maiaResults, fen, rating)) resolved[entry.oppColor] += 1;
  }
  return {
    white: Math.min(resolved.white, successTarget),
    black: Math.min(resolved.black, successTarget),
  };
}

export function countGlobalMaiaOutcomes(
  rankedEntries,
  { successTarget = SCOUT_MAIA_SUCCESS_TARGET, maiaResults, getRating, fenAfterLine },
) {
  const pool = rankedEntries || [];
  const targets = maiaTargetsByColor(pool, successTarget);
  const expected = targets.white + targets.black;
  const resolvedByColor = { white: 0, black: 0 };
  let failed = 0;

  for (const entry of pool) {
    if (!(entry.oppColor in resolvedByColor)) continue;
    const rating = getRating(entry.oppColor);
    const fen = fenAfterLine(entry.line.ucis);
    const result = getMaiaResultEntry(maiaResults, fen, rating);
    if (result?.failed) failed += 1;
    else if (result?.maiaWdl && result.maiaScorePct != null) resolvedByColor[entry.oppColor] += 1;
  }

  const targetResolved =
    Math.min(resolvedByColor.white, targets.white) + Math.min(resolvedByColor.black, targets.black);
  return {
    resolved: targetResolved,
    failed,
    missing: Math.max(0, expected - targetResolved),
    expected,
  };
}

/**
 * Preserve every assessed candidate and its metrics for final set selection.
 * Maia availability never decides which rows may compete for a recommendation.
 */
export function buildGamePlanDisplayLines({ rankedEntries = [], stockfishDisplayLines = [] } = {}) {
  const byKey = new Map();
  for (const entry of rankedEntries) {
    const line = entry.line ?? entry;
    if (line.ucis?.length) byKey.set(branchPathKey(line.ucis), { ...line,
      prefilterScore: entry.prefilterScore ?? line.prefilterScore,
      mateIn: entry.mateIn ?? line.mateIn });
  }
  for (const line of stockfishDisplayLines) {
    const key = branchPathKey(line.ucis || []);
    if (!byKey.has(key)) byKey.set(key, line);
  }
  return [...byKey.values()];
}

export function globalMaiaPoolNeedsWork(
  rankedEntries,
  {
    successTarget = SCOUT_MAIA_SUCCESS_TARGET,
    maxAttempts = SCOUT_MAIA_MAX_ATTEMPTS,
    attemptsUsed = 0,
    maiaResults,
    getRating,
    fenAfterLine,
  },
) {
  const pool = rankedEntries || [];
  if (!pool.length) return false;
  if (attemptsUsed >= maxAttempts) return false;
  const targets = maiaTargetsByColor(pool, successTarget);
  const resolved = countGlobalMaiaSuccesses(pool, {
    successTarget, maiaResults, getRating, fenAfterLine,
  });
  return pool.some((entry) => {
    if (!(entry.oppColor in targets) || resolved[entry.oppColor] >= targets[entry.oppColor]) {
      return false;
    }
    const rating = getRating(entry.oppColor);
    const fen = fenAfterLine(entry.line.ucis);
    return !isMaiaAttempted(maiaResults, fen, rating);
  });
}
