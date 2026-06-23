// Hidden Stockfish pre-filter for Scout: shallow eval on all opening-line candidates,
// rank by objective prep value, and pick the top pool for Maia3 WDL enrichment.
// Results never surface in the Scout UI — only the Maia-ranked game plan is shown.

import { Chess } from "chess.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";
import { createEngineProvider } from "./engine/stockfish-provider.js";
import { cpLossFromEvals } from "./scout-engine.js";
import {
  SCOUT_GAME_PLAN_LIMIT,
  normalizeToOpponentTerminal,
  terminalMoveIsOpponent,
  triePathKey,
} from "./scout.js";

export const SCOUT_PREFILTER_DEPTH = 8;
export const SCOUT_PREFILTER_LIMIT = SCOUT_GAME_PLAN_LIMIT;
/** Ranked backup pool — Maia pulls replacements from here on per-line failure. */
export const SCOUT_PREFILTER_POOL_SIZE = 24;
export const SCOUT_PREFILTER_CONCURRENCY = 3;
export const SCOUT_PREFILTER_ENGINE_VERSION = "stockfish-18-lite";
/** Minimum objective leak (cp) to treat a line as worth studying when the opponent missed best. */
export const SCOUT_PREFILTER_MIN_CP_LOSS = 6;

export const PREFILTER_IDLE = "idle";
export const PREFILTER_LOADING = "loading";
export const PREFILTER_READY = "ready";
export const PREFILTER_FAILED = "failed";

/** Scope key — re-run prefilter when speed or ingested game count changes. */
export function computePrefilterScopeKey({ activeSpeed, gameCount }) {
  return `${activeSpeed || "all"}|${gameCount || 0}`;
}

function moverFromFen(fen) {
  const parts = String(fen || "").split(" ");
  return parts[1] === "b" ? "black" : "white";
}

function fenBeforeLastMove(ucis) {
  if (!ucis?.length) return null;
  const chess = new Chess();
  for (let i = 0; i < ucis.length - 1; i += 1) {
    const uci = ucis[i];
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch (_) {
      return null;
    }
  }
  return chess.fen();
}

function isNestedLine(a, b) {
  const x = a.line || triePathKey(a.ucis || []);
  const y = b.line || triePathKey(b.ucis || []);
  return x === y || x.startsWith(`${y}>`) || y.startsWith(`${x}>`);
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
export function scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor }) {
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

  const mover = moverFromFen(fenBefore);
  if (mover !== oppColor) return null;

  const beforeCp = beforeEval.score_cp ?? 0;
  const afterCp = leafEval.score_cp ?? 0;
  const bestUci = beforeEval.best_move_uci;
  const cpLoss = cpLossFromEvals(beforeCp, afterCp, mover);
  const playedIsBest = !!(playedUci && bestUci && playedUci === bestUci);
  const hasUserReply = !!leafEval.best_move_uci;

  if (!hasUserReply) return null;
  if (cpLoss < SCOUT_PREFILTER_MIN_CP_LOSS) return null;

  return {
    cpLoss,
    playedIsBest,
    hasUserReply,
    prefilterScore: cpLoss,
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
export function rankPrefilterCandidates(lines, evalMap, { fenAfterLine, oppColor }) {
  const scored = [];
  for (const line of lines || []) {
    const metrics = scorePrefilterLine(line, evalMap, { fenAfterLine, oppColor });
    if (!metrics) continue;
    scored.push({
      line,
      ...metrics,
    });
  }
  scored.sort(
    (a, b) =>
      b.prefilterScore - a.prefilterScore ||
      Number(b.hasUserReply) - Number(a.hasUserReply) ||
      tiebreakRecencyShare(a.line, b.line),
  );
  return collapseNestedPrefilterLines(scored);
}

export function prefilterPoolLines(ranked, poolSize = SCOUT_PREFILTER_POOL_SIZE) {
  return (ranked || []).slice(0, poolSize).map((entry) => entry.line);
}

export function prefilterMaiaLines(ranked, limit = SCOUT_PREFILTER_LIMIT) {
  return prefilterPoolLines(ranked, limit);
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
  const maiaLines = pool.slice(0, limit);
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
  { poolSize = SCOUT_PREFILTER_POOL_SIZE } = {},
) {
  const entries = [];
  for (const oppColor of ["white", "black"]) {
    for (const entry of rankedByColor?.[oppColor] || []) {
      entries.push({ ...entry, oppColor });
    }
  }
  entries.sort(
    (a, b) =>
      b.prefilterScore - a.prefilterScore ||
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
export async function runStockfishPrefilter(
  lines,
  {
    fenAfterLine,
    oppColor,
    depth = SCOUT_PREFILTER_DEPTH,
    poolSize = SCOUT_PREFILTER_POOL_SIZE,
    concurrency = SCOUT_PREFILTER_CONCURRENCY,
    cache = new Map(),
    shouldCancel = () => false,
    createProvider = createEngineProvider,
  } = {},
) {
  if (!lines?.length || !fenAfterLine || !oppColor) {
    return { ranked: [], pool: [], maiaLines: [] };
  }

  const allFens = collectPrefilterFens(lines, { fenAfterLine, oppColor });
  const missing = allFens.filter((fen) => !cache.has(prefilterCacheKey(fen, depth)));

  let freshEvals = new Map();
  if (missing.length && !shouldCancel()) {
    freshEvals = await analyzeGamePositions({
      positions: missing,
      depth,
      concurrency,
      shouldCancel,
      createProvider: (opts) => createProvider({ ...opts, maxDepth: depth }),
    });
    rememberPrefilterEvals(cache, freshEvals, depth);
  }

  if (shouldCancel()) {
    return { ranked: [], pool: [], maiaLines: [], cancelled: true };
  }

  const evalMap = evalMapFromCache(allFens, cache, depth);
  for (const [fen, evalResult] of freshEvals) {
    if (!evalMap.has(fen)) evalMap.set(fen, evalResult);
  }

  const ranked = rankPrefilterCandidates(lines, evalMap, { fenAfterLine, oppColor });
  const pool = prefilterPoolLines(ranked, poolSize);
  const maiaLines = pool.slice(0, SCOUT_PREFILTER_LIMIT);

  return { ranked, pool, maiaLines, cancelled: false };
}