// Hidden Stockfish pre-filter for Scout: shallow eval on all opening-line candidates,
// rank by objective prep value, and pick the top pool for Maia3 WDL enrichment.
// Results never surface in the Scout UI — only the Maia-ranked game plan is shown.

import { analyzeGamePositions } from "./engine/game-analyzer.js";
import { createEngineProvider } from "./engine/stockfish-provider.js";
import { cpLossFromEvals } from "./scout-engine.js";
import {
  SCOUT_BRANCH_SCORE_CAP,
  SCOUT_MAIA_LIMIT,
  SCOUT_SCORING_VERSION,
  SCOUT_STOCKFISH_DEPTH,
  fenBeforeLastMove,
  hashGameIdsForScope,
  isNestedLine,
  isOpponentComfortZone,
  normalizeToOpponentTerminal,
  openingReproducibilityScore,
  terminalMoveIsOpponent,
  triePathKey,
} from "./scout.js";

export const SCOUT_PREFILTER_DEPTH = SCOUT_STOCKFISH_DEPTH;
export const SCOUT_PREFILTER_LIMIT = SCOUT_BRANCH_SCORE_CAP;
/** All branch candidates run through Stockfish; Maia takes the top unique lines only. */
export const SCOUT_PREFILTER_POOL_SIZE = SCOUT_BRANCH_SCORE_CAP;
export const SCOUT_MAIA_PREFILTER_LIMIT = SCOUT_MAIA_LIMIT;
export const SCOUT_PREFILTER_CONCURRENCY = 3;
export const SCOUT_PREFILTER_TIME_BUDGET_MS = 45_000;
export const SCOUT_PREFILTER_ENGINE_VERSION = "stockfish-18-lite";
/** Legacy minimum cp-loss threshold; no longer used in scorePrefilterLine (kept for backward compat). */
export const SCOUT_PREFILTER_MIN_CP_LOSS = 6;
export const SCOUT_MIN_ANCESTOR_FREQUENCY = 0.01;
export const SCOUT_MIN_STOCKFISH_ADVANTAGE = 20;

export const PREFILTER_IDLE = "idle";
export const PREFILTER_LOADING = "loading";
export const PREFILTER_READY = "ready";
export const PREFILTER_FAILED = "failed";

/** Scope key — username, speed, game-id set, and scoring version (not raw count). */
export function computePrefilterScopeKey({
  username,
  activeSpeed,
  games,
  gameCount,
} = {}) {
  const idsHash = games?.length ? hashGameIdsForScope(games) : String(gameCount || 0);
  return `${String(username || "").toLowerCase()}|${activeSpeed || "all"}|${idsHash}|${SCOUT_SCORING_VERSION}`;
}

function moverFromFen(fen) {
  const parts = String(fen || "").split(" ");
  return parts[1] === "b" ? "black" : "white";
}

export function prefilterCacheKey(fen, depth = SCOUT_PREFILTER_DEPTH) {
  return `${SCOUT_PREFILTER_ENGINE_VERSION}|d${depth}|${fen}`;
}

/** Collect distinct FENs needed to score opening-line candidates. */
export function collectPrefilterFens(lines, { fenAfterLine, oppColor }) {
  const fens = [];
  const seen = new Set();
  for (const line of lines || []) {
    const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
    if (!normalized) continue;
    const ucis = normalized.ucis;
    if (!terminalMoveIsOpponent(ucis, oppColor)) continue;
    const before = fenBeforeLastMove(ucis);
    const leaf = fenAfterLine(ucis);
    for (const fen of [before, leaf]) {
      if (!fen || seen.has(fen)) continue;
      seen.add(fen);
      fens.push(fen);
    }
  }
  return fens;
}

/**
 * Score one line from shallow Stockfish reads. Higher prefilterScore = more objectively
 * worth preparing. Returns null when the line should be excluded.
 */
export function scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq }) {
  const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
  if (!normalized) return null;
  const ucis = normalized.ucis;
  if (!terminalMoveIsOpponent(ucis, oppColor)) return null;

  const fenBefore = fenBeforeLastMove(ucis);
  const fenLeaf = fenAfterLine(ucis);
  const playedUci = ucis[ucis.length - 1];
  const beforeEval = fenBefore ? evalMap.get(fenBefore) : null;
  const leafEval = fenLeaf ? evalMap.get(fenLeaf) : null;
  if (!beforeEval || !leafEval) return null;
  if (beforeEval.complete === false || leafEval.complete === false) return null;

  const mover = moverFromFen(fenBefore);
  if (mover !== oppColor) return null;

  const beforeCp = beforeEval.score_cp ?? 0;
  const afterCp = leafEval.score_cp ?? 0;
  const bestUci = beforeEval.best_move_uci;
  const cpLoss = cpLossFromEvals(beforeCp, afterCp, mover);
  const userLeafAdvantage = oppColor === 'white' ? -afterCp : afterCp;
  const playedIsBest = !!(playedUci && bestUci && playedUci === bestUci);
  const hasUserReply = !!leafEval.best_move_uci;

  if (!hasUserReply) return null;

  const ancestorInfo = ancestorFreq?.get(fenBefore) || { frequency: 0.001 };

  return {
    cpLoss,
    userLeafAdvantage,
    playedIsBest,
    hasUserReply,
    prefilterScore: userLeafAdvantage,
    ancestorFrequency: ancestorInfo.frequency,
    ancestorScorePct: ancestorInfo.scorePct,
    ancestorGames: ancestorInfo.games,
    scorePct: line.scorePct,
    games: line.games,
  };
}

function tiebreakRecencyShare(a, b) {
  const aStamp = a.lastSeen?.lastDatestamp ?? a.lastDatestamp ?? 0;
  const bStamp = b.lastSeen?.lastDatestamp ?? b.lastDatestamp ?? 0;
  return bStamp - aStamp || (b.share || 0) - (a.share || 0) || (b.count || 0) - (a.count || 0);
}

/** Collapse nested prefix lines — keep the deeper representative only when score is not worse. */
export function collapseNestedPrefilterLines(sorted) {
  const chosen = [];
  for (const entry of sorted) {
    const nestedIdx = chosen.findIndex((c) => isNestedLine(c.line, entry.line));
    if (nestedIdx >= 0) {
      const existing = chosen[nestedIdx];
      const cPath = existing.line.line || triePathKey(existing.line.ucis || []);
      const gPath = entry.line.line || triePathKey(entry.line.ucis || []);
      if (gPath.startsWith(`${cPath}>`)) {
        if (entry.prefilterScore >= existing.prefilterScore) {
          chosen[nestedIdx] = entry;
        }
      } else if (entry.prefilterScore > existing.prefilterScore) {
        chosen[nestedIdx] = entry;
      }
      continue;
    }
    chosen.push(entry);
  }
  return chosen;
}

/**
 * Rank all opening-line candidates by objective Stockfish signals. Returns scored
 * entries sorted best-first; count/recency are tiebreakers only.
 */
export function rankPrefilterCandidates(
  lines,
  evalMap,
  { fenAfterLine, oppColor, ancestorFreq, baselineScorePct = 50 },
) {
  const scored = [];
  for (const line of lines || []) {
    const metrics = scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq });
    if (!metrics) continue;
    scored.push({
      line,
      ...metrics,
    });
  }
  const gated = scored.filter((entry) => {
    if ((entry.ancestorFrequency ?? 0) < SCOUT_MIN_ANCESTOR_FREQUENCY) return false;
    if ((entry.prefilterScore ?? 0) < SCOUT_MIN_STOCKFISH_ADVANTAGE) return false;
    if (isOpponentComfortZone(entry, baselineScorePct)) return false;
    return openingReproducibilityScore(entry, baselineScorePct) > 0;
  });
  gated.sort(
    (a, b) =>
      openingReproducibilityScore(b, baselineScorePct) -
        openingReproducibilityScore(a, baselineScorePct) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      tiebreakRecencyShare(a.line, b.line),
  );
  return collapseNestedPrefilterLines(gated);
}

export function prefilterPoolLines(ranked, poolSize = SCOUT_PREFILTER_POOL_SIZE) {
  return (ranked || []).slice(0, poolSize).map((entry) => entry.line);
}

export function prefilterMaiaLines(ranked, limit = SCOUT_MAIA_PREFILTER_LIMIT) {
  const seen = new Set();
  const out = [];
  for (const entry of ranked || []) {
    const key = entry.line?.line || triePathKey(entry.line?.ucis || []);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.line);
    if (out.length >= limit) break;
  }
  return out;
}

/** Ranked-opening fallback when Stockfish prefilter cannot run. */
export function buildFallbackPrefilterData(
  lines,
  { poolSize = SCOUT_PREFILTER_POOL_SIZE, limit = SCOUT_PREFILTER_LIMIT } = {},
) {
  const pool = (lines || []).slice(0, poolSize);
  const ranked = pool.map((line) => ({
    line,
    prefilterScore: 0,
    hasUserReply: true,
    cpLoss: 0,
    playedIsBest: false,
  }));
  const maiaLines = prefilterMaiaLines(ranked, limit);
  return { ranked, pool, maiaLines };
}

/**
 * Merge per-colour Stockfish-ranked entries into one global pool for Maia3.
 * Each colour list is already nested-collapsed in rankPrefilterCandidates — do
 * not collapse again here, because isNestedLine compares UCI paths only and
 * would incorrectly drop unrelated lines from the other opponent-colour section.
 */
export function mergeGlobalPrefilterRanked(
  rankedByColor,
  { poolSize = SCOUT_PREFILTER_POOL_SIZE, baselineByColor = {} } = {},
) {
  const entries = [];
  for (const oppColor of ["white", "black"]) {
    for (const entry of rankedByColor?.[oppColor] || []) {
      entries.push({ ...entry, oppColor });
    }
  }
  entries.sort(
    (a, b) =>
      openingReproducibilityScore(b, baselineByColor[b.oppColor] ?? 50) -
        openingReproducibilityScore(a, baselineByColor[a.oppColor] ?? 50) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      tiebreakRecencyShare(a.line, b.line) ||
      a.oppColor.localeCompare(b.oppColor),
  );
  return entries.slice(0, poolSize);
}

/** Read cached evals from an in-memory Map keyed by prefilterCacheKey. */
export function evalMapFromCache(fens, cache, depth = SCOUT_PREFILTER_DEPTH) {
  const map = new Map();
  for (const fen of fens || []) {
    const hit = cache?.get(prefilterCacheKey(fen, depth));
    if (hit) map.set(fen, hit);
  }
  return map;
}

/** Store eval results into the session cache. */
export function rememberPrefilterEvals(cache, evalMap, depth = SCOUT_PREFILTER_DEPTH) {
  if (!cache || !evalMap) return;
  for (const [fen, evalResult] of evalMap) {
    cache.set(prefilterCacheKey(fen, depth), evalResult);
  }
}

/**
 * Shallow Stockfish pass over all candidate lines. Returns ranked entries and the
 * top pool for Maia (limit + backup headroom). Never writes UI-facing data.
 */
function wrapEvalComplete(evalResult, complete = true) {
  if (!evalResult) return { complete: false };
  return { ...evalResult, complete };
}

export async function runStockfishPrefilter(
  lines,
  {
    fenAfterLine,
    oppColor,
    ancestorFreq = null,
    baselineScorePct = 50,
    depth = SCOUT_PREFILTER_DEPTH,
    poolSize = SCOUT_PREFILTER_POOL_SIZE,
    concurrency = SCOUT_PREFILTER_CONCURRENCY,
    timeBudgetMs = SCOUT_PREFILTER_TIME_BUDGET_MS,
    cache = new Map(),
    shouldCancel = () => false,
    createProvider = createEngineProvider,
    now = () => Date.now(),
  } = {},
) {
  if (!lines?.length || !fenAfterLine || !oppColor) {
    return { ranked: [], pool: [], maiaLines: [], incompleteLines: [] };
  }

  const allFens = collectPrefilterFens(lines, { fenAfterLine, oppColor });
  const missing = allFens.filter((fen) => {
    const hit = cache.get(prefilterCacheKey(fen, depth));
    return !hit || hit.complete !== true;
  });

  const startedAt = now();
  const budgetExpired = () => now() - startedAt >= timeBudgetMs;
  const cancelled = () => shouldCancel() || budgetExpired();

  let freshEvals = new Map();
  if (missing.length && !cancelled()) {
    freshEvals = await analyzeGamePositions({
      positions: missing,
      depth,
      concurrency,
      shouldCancel: cancelled,
      createProvider: (opts) => createProvider({ ...opts, maxDepth: depth }),
    });
    for (const [fen, evalResult] of freshEvals) {
      cache.set(prefilterCacheKey(fen, depth), wrapEvalComplete(evalResult, !cancelled()));
    }
  }

  const superseded = shouldCancel();
  const hitTimeBudget = budgetExpired() && !superseded;
  for (const fen of missing) {
    const key = prefilterCacheKey(fen, depth);
    if (!cache.has(key)) {
      cache.set(key, wrapEvalComplete(null, false));
    }
  }

  const evalMap = evalMapFromCache(allFens, cache, depth);
  for (const [fen, evalResult] of freshEvals) {
    if (!evalMap.has(fen)) evalMap.set(fen, evalResult);
  }

  const ranked = rankPrefilterCandidates(lines, evalMap, {
    fenAfterLine,
    oppColor,
    ancestorFreq,
    baselineScorePct,
  });
  const pool = prefilterPoolLines(ranked, poolSize);
  const maiaLines = prefilterMaiaLines(ranked, SCOUT_MAIA_PREFILTER_LIMIT);
  const incompleteLines = pool.filter((line) => {
    const metrics = scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq });
    return !metrics;
  });

  return {
    ranked,
    pool,
    maiaLines,
    incompleteLines,
    cancelled: superseded || hitTimeBudget,
    budgetExpired: hitTimeBudget,
    superseded,
  };
}