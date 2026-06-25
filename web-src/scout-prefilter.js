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
/** OR-gate thresholds — a line survives on objective edge, a slip, empirical struggle, or a rare off-book reply. */
export const SCOUT_PREFILTER_CP_LOSS_GATE = 12;
export const SCOUT_PREFILTER_STRUGGLE_GATE = 0.15;
export const SCOUT_PREFILTER_OFFMODAL_GATE = 2;
export const SCOUT_PREFILTER_OFFMODAL_MIN_ADV = 8;

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
    // Prefix-resolved exploitability signals, annotated upstream by rankedOpeningBranches.
    struggle: line.exploitabilityStruggle ?? 0,
    offModal: line.offModal ?? 0,
    prefixGames: line.prefixGames ?? 0,
  };
}

/**
 * Final exploitability rank for a scored candidate: objective edge, amplified by empirical
 * struggle, with family reproducibility (log of prefix games) as a compressing weight — NOT a
 * frequency-dominant score. Frequent main lines and rare-but-recurring weaknesses can both win.
 */
export function exploitabilityRank(entry) {
  const adv = Math.max(0, entry?.prefilterScore ?? 0);
  const struggle = Math.max(0, entry?.struggle ?? 0);
  // Reproducibility weight prefers the family sample (prefixGames); 0 means "no n≥3 family
  // found", so fall back to the leaf branch's own game count rather than treating it as none.
  const prefixGames = entry?.prefixGames || 0;
  const leafGames = entry?.games ?? entry?.line?.games ?? 0;
  const games = prefixGames > 0 ? prefixGames : leafGames;
  return adv * (1 + struggle) * (0.5 + Math.log1p(Math.max(0, games)));
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
  // OR-gate: a line is worth prepping if the opponent is NOT in a comfort zone there, and
  // ANY of — Stockfish finds a clear edge, they slipped (cp-loss), the line family empirically
  // underperforms, or it's a rare off-book reply with a non-trivial edge. This replaces the old
  // AND-style "+20cp AND frequent" wall that zeroed every main line.
  const gated = scored.filter((entry) => {
    if (isOpponentComfortZone(entry, baselineScorePct)) return false;
    const adv = entry.prefilterScore ?? 0;
    const cpLoss = entry.cpLoss ?? 0;
    const struggle = entry.struggle ?? 0;
    const offModal = entry.offModal ?? 0;
    if (adv >= SCOUT_MIN_STOCKFISH_ADVANTAGE) return true;
    if (cpLoss >= SCOUT_PREFILTER_CP_LOSS_GATE) return true;
    if (struggle >= SCOUT_PREFILTER_STRUGGLE_GATE && adv > 0) return true;
    if (offModal >= SCOUT_PREFILTER_OFFMODAL_GATE && adv >= SCOUT_PREFILTER_OFFMODAL_MIN_ADV) {
      return true;
    }
    return false;
  });
  gated.sort(
    (a, b) =>
      exploitabilityRank(b) - exploitabilityRank(a) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      (b.ancestorFrequency ?? 0) - (a.ancestorFrequency ?? 0) ||
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
      exploitabilityRank(b) - exploitabilityRank(a) ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      (b.ancestorFrequency ?? 0) - (a.ancestorFrequency ?? 0) ||
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
    onProgress = null,
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

  // Positions already cached from a prior pass still count toward the bar so it doesn't
  // jump backwards when transpositions or a re-run shrink the missing set.
  const cachedCount = allFens.length - missing.length;
  if (typeof onProgress === "function") {
    onProgress({ done: cachedCount, total: allFens.length, phase: "stockfish" });
  }

  let freshEvals = new Map();
  if (missing.length && !cancelled()) {
    freshEvals = await analyzeGamePositions({
      positions: missing,
      depth,
      concurrency,
      shouldCancel: cancelled,
      onProgress: (done) => {
        if (typeof onProgress === "function") {
          onProgress({ done: cachedCount + done, total: allFens.length, phase: "stockfish" });
        }
      },
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