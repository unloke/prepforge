// Hidden Stockfish pre-filter for Scout: shallow eval on all opening-line candidates,
// rank by objective prep value, and pick the top pool for Maia3 WDL enrichment.
// Engine metrics travel with candidates to the final budgeted selector.

import { preparationValue, selectPreparationRoutes, routeKey, canonicalPosition } from "./scout-preparation-value.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";
import {
  createEngineProvider,
  STOCKFISH_PACKAGE_VERSION,
} from "./engine/stockfish-provider.js";
import {
  SCOUT_BRANCH_SCORE_CAP,
  SCOUT_MAIA_LIMIT,
  SCOUT_MIN_ROUTE_REACH,
  SCOUT_SCORING_VERSION,
  SCOUT_STOCKFISH_DEPTH,
  fenBeforeLastMove,
  hashGameIdsForScope,
  normalizeToOpponentTerminal,
  terminalMoveIsOpponent,
} from "./scout.js";

export const SCOUT_PREFILTER_DEPTH = SCOUT_STOCKFISH_DEPTH;
export const SCOUT_PREFILTER_LIMIT = SCOUT_BRANCH_SCORE_CAP;
/** Bounded Maia backup pool; engine reads are capped upstream at 300 per colour. */
export const SCOUT_PREFILTER_POOL_SIZE = 64;
export const SCOUT_MAIA_PREFILTER_LIMIT = SCOUT_MAIA_LIMIT;
export const SCOUT_PREFILTER_CONCURRENCY = 3;
/** Run the bounded leaf queue to completion unless cancelled. */
export const SCOUT_PREFILTER_TIME_BUDGET_MS = Infinity;
export const SCOUT_PREFILTER_ENGINE_VERSION = `stockfish-${STOCKFISH_PACKAGE_VERSION}-lite`;
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

/** Only distinct leaf FENs need depth-8 Stockfish reads. */
export function collectPrefilterFens(lines, { fenAfterLine, oppColor }) {
  const fens = [];
  const seen = new Set();
  for (const line of lines || []) {
    const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
    if (!normalized) continue;
    const ucis = normalized.ucis;
    if (!terminalMoveIsOpponent(ucis, oppColor)) continue;
    const leaf = fenAfterLine(ucis);
    if (!leaf || seen.has(canonicalPosition(leaf))) continue;
    seen.add(canonicalPosition(leaf));
    fens.push(leaf);
  }
  return fens;
}

/**
 * Read objective position opportunity; personal relevance is scored separately.
 */
export function scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq, funnel }) {
  const drop = (key) => {
    if (funnel?.scoreDrops) {
      funnel.scoreDrops[key] = (funnel.scoreDrops[key] || 0) + 1;
    }
  };

  const normalized = normalizeToOpponentTerminal(line.ucis, line.sans, oppColor);
  if (!normalized) {
    drop("notOppTerminal");
    return null;
  }
  const ucis = normalized.ucis;
  if (!terminalMoveIsOpponent(ucis, oppColor)) {
    drop("notOppTerminal");
    return null;
  }

  // fenBefore is still derived (chess.js, not an engine read) for the mover check and the
  // ancestor-frequency lookup; only its Stockfish eval is gone.
  const fenBefore = fenBeforeLastMove(ucis);
  const fenLeaf = fenAfterLine(ucis);
  const leafEval = fenLeaf ? evalMap.get(fenLeaf) ?? evalMap.get(canonicalEvalIndex(evalMap).get(canonicalPosition(fenLeaf))) : null;
  if (!leafEval || (!Number.isFinite(leafEval.score_cp) && !Number.isFinite(leafEval.mate_in))) {
    drop("noEval");
    return null;
  }

  const mover = moverFromFen(fenBefore);
  if (mover !== oppColor) {
    drop("moverMismatch");
    return null;
  }

  const afterCp = leafEval.score_cp ?? 0;
  const userLeafAdvantage = oppColor === 'white' ? -afterCp : afterCp;
  // Mate counts only when it favours the USER (the side preparing). `mate_in` is White-POV,
  // so flip its sign for a black-user (oppColor white). Opponent-mate leaves get mateIn 0.
  const rawMate = leafEval.mate_in ?? 0;
  const userMate = oppColor === 'white' ? -rawMate : rawMate;
  const mateIn = userMate > 0 ? userMate : 0;
  const hasUserReply = !!leafEval.best_move_uci || mateIn > 0;

  if (!hasUserReply) {
    drop("noUserReply");
    return null;
  }

  const ancestorInfo = ancestorFreq?.get(fenBefore) || { frequency: 0.001 };

  if (funnel) funnel.scored = (funnel.scored || 0) + 1;

  return {
    userLeafAdvantage,
    userMate,
    terminalFen: fenLeaf,
    oppColor,
    mateIn,
    hasUserReply,
    prefilterScore: userLeafAdvantage,
    routeReach: line.routeReach ?? null,
    routePlausibility: line.routePlausibility ?? null,
    ancestorFrequency: line.routeReach ?? ancestorInfo.frequency,
    ancestorScorePct: line.ancestorScorePct ?? ancestorInfo.scorePct,
    ancestorGames: line.ancestorGames ?? ancestorInfo.games,
    scorePct: line.scorePct,
    games: line.games,
    routeSupportGames: line.routeSupportGames ?? null,
    evidenceGames: line.evidenceGames,
    routeScorePct: line.routeScorePct,
  };
}

/** Keep every assessed candidate until final selection; no early nested collapse. */
export function rankPrefilterCandidates(
  lines,
  evalMap,
  { fenAfterLine, oppColor, ancestorFreq, baselineScorePct = 50, funnelOut },
) {
  const funnel = {
    totalLines: (lines || []).length,
    scoreDrops: {
      notOppTerminal: 0,
      noEval: 0,
      incompleteEval: 0,
      moverMismatch: 0,
      noUserReply: 0,
    },
    scored: 0,
    gateDrops: { unreachable: 0, noOpportunity: 0 },
    survived: 0,
  };

  const scored = [];
  for (const line of lines || []) {
    const metrics = scorePrefilterLine(line, evalMap, {
      fenAfterLine,
      oppColor,
      ancestorFreq,
      funnel,
    });
    if (!metrics) continue;
    scored.push({
      line,
      ...metrics,
    });
  }
  const gated = scored.filter((entry) => {
    if (entry.routeReach != null && entry.routeReach < SCOUT_MIN_ROUTE_REACH) {
      funnel.gateDrops.unreachable++;
      return false;
    }
    if (!preparationValue({ ...entry.line, ...entry }, baselineScorePct).engineOk) {
      funnel.gateDrops.noOpportunity++;
      return false;
    }
    return true;
  }).map((entry) => ({ ...entry, line: { ...entry.line, ...Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "line")), baselineScorePct } }));
  const rank = new Map(selectPreparationRoutes(gated.map(e => e.line), { limit: gated.length, baseline: baselineScorePct })
    .map((line, i) => [routeKey(line), i]));
  // Materialize pure sort inputs once per call; nothing survives receipt updates.
  const ordered = gated.map(entry => {
    const key = routeKey(entry.line);
    return { entry, key, rank: rank.get(key) ?? Infinity,
      soft: preparationValue(entry.line, baselineScorePct).softValue };
  });
  ordered.sort((a,b) => a.rank - b.rank || b.soft - a.soft || a.key.localeCompare(b.key));
  for (let n = 0; n < ordered.length; n++) gated[n] = ordered[n].entry;
  funnel.survived = gated.length;
  if (funnelOut) Object.assign(funnelOut, funnel);
  return gated;
}

export function prefilterPoolLines(ranked, poolSize = SCOUT_PREFILTER_POOL_SIZE) {
  return (ranked || []).slice(0, poolSize).map((entry) => entry.line);
}

export function prefilterMaiaLines(ranked, limit = SCOUT_MAIA_PREFILTER_LIMIT) {
  const lines = (ranked || []).map(entry => ({ ...entry.line,
    prefilterScore: entry.prefilterScore ?? entry.line.prefilterScore,
    mateIn: entry.mateIn ?? entry.line.mateIn }));
  return selectPreparationRoutes(lines, { limit, baseline: lines[0]?.baselineScorePct ?? 50, oppColor: lines[0]?.oppColor ?? "white" });
}

/** Ranked-opening fallback when Stockfish prefilter cannot run. */
export function buildFallbackPrefilterData(
  lines,
  { poolSize = SCOUT_PREFILTER_POOL_SIZE, limit = SCOUT_MAIA_PREFILTER_LIMIT } = {},
) {
  const pool = (lines || []).slice(0, poolSize);
  const ranked = (lines || []).map((line) => ({
    line,
    prefilterScore: undefined,
    hasUserReply: true,
    mateIn: 0,
  }));
  const maiaLines = prefilterMaiaLines(ranked, limit);
  return { ranked, pool, maiaLines };
}

/** Merge prospective per-colour recommendations, then optional Maia backups. */
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
  // Assess prospective recommendations first, then bounded backups. An ONNX
  // failure changes availability of supplemental WDL, not candidate membership.
  const front = new Set();
  for (const color of ["white", "black"]) {
    const lines = entries.filter(e => e.oppColor === color).map(e => e.line);
    for (const line of selectPreparationRoutes(lines, { baseline: baselineByColor[color] ?? 50, oppColor: color })) front.add(`${color}|${routeKey(line)}`);
  }
  const ordered = entries.map(entry => {
    const key = routeKey(entry.line);
    return { entry, key, front: Number(front.has(`${entry.oppColor}|${key}`)),
      value: preparationValue(entry.line, baselineByColor[entry.oppColor] ?? 50).value };
  });
  ordered.sort((a,b) => b.front - a.front || b.value - a.value ||
    a.entry.oppColor.localeCompare(b.entry.oppColor) || a.key.localeCompare(b.key));
  for (let n = 0; n < ordered.length; n++) entries[n] = ordered[n].entry;
  return entries.slice(0, poolSize);
}

// Counter-only transpositions reuse successful reads without changing their cache keys.
function cachedPositionEval(cache, fen, depth) {
  const hit = cache?.get(prefilterCacheKey(fen, depth));
  if (hit?.complete === true) return hit;
  const scope = `${SCOUT_PREFILTER_ENGINE_VERSION}|d${depth}|`;
  const position = canonicalPosition(fen);
  for (const [key, value] of cache || []) if (value?.complete === true && key.startsWith(scope) &&
    canonicalPosition(key.slice(scope.length)) === position) return value;
  return hit;
}

// Counter-only transpositions: canonical position -> stored FEN, per eval map.
const canonicalEvalIndexes = new WeakMap();
function canonicalEvalIndex(evalMap) {
  let index = canonicalEvalIndexes.get(evalMap);
  if (!index || index.size0 !== evalMap.size) {
    index = new Map();
    for (const fen of evalMap.keys()) if (!index.has(canonicalPosition(fen))) index.set(canonicalPosition(fen), fen);
    index.size0 = evalMap.size;
    canonicalEvalIndexes.set(evalMap, index);
  }
  return index;
}

/** Read cached evals from an in-memory Map keyed by prefilterCacheKey. */
export function evalMapFromCache(fens, cache, depth = SCOUT_PREFILTER_DEPTH) {
  const map = new Map();
  for (const fen of fens || []) {
    const hit = cachedPositionEval(cache, fen, depth);
    if (hit) map.set(fen, hit);
  }
  return map;
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
    analyzeGamePositions: injectedAnalyze = analyzeGamePositions,
  } = {},
) {
  if (!lines?.length || !fenAfterLine || !oppColor) {
    return {
      ranked: [],
      pool: [],
      maiaLines: [],
      incompleteLines: [],
      funnel: { totalLines: 0 },
    };
  }

  const allFens = collectPrefilterFens(lines, { fenAfterLine, oppColor });
  const missing = allFens.filter((fen) => {
    const hit = cachedPositionEval(cache, fen, depth);
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
    try {
      freshEvals = await injectedAnalyze({
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
    } catch (err) {
      // Budget expiry throws AnalysisCancelled with partialResults; user cancellation should re-throw.
      const isBudgetStop = err.cancelled && budgetExpired() && !shouldCancel();
      if (!isBudgetStop) throw err;
      // Use partial evaluations from workers. Mark them as incomplete so the UI knows
      // some FENs didn't finish, but still rank what we have.
      if (err.partialResults) {
        freshEvals = err.partialResults;
        for (const [fen, evalResult] of freshEvals) {
          cache.set(prefilterCacheKey(fen, depth), wrapEvalComplete(evalResult, false));
        }
      }
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

  const funnel = {};
  const ranked = rankPrefilterCandidates(lines, evalMap, {
    fenAfterLine,
    oppColor,
    ancestorFreq,
    baselineScorePct,
    funnelOut: funnel,
  });
  const pool = prefilterPoolLines(ranked, poolSize);
  const maiaLines = prefilterMaiaLines(ranked, SCOUT_MAIA_PREFILTER_LIMIT);
  const incompleteLines = pool.filter((line) => {
    const metrics = scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor, ancestorFreq });
    return !metrics;
  });

  funnel.poolSize = pool.length;
  funnel.maiaCandidates = maiaLines.length;

  return {
    ranked,
    pool,
    maiaLines,
    incompleteLines,
    funnel,
    cancelled: superseded || hitTimeBudget,
    budgetExpired: hitTimeBudget,
    superseded,
  };
}
