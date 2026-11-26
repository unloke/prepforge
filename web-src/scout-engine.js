// Opt-in Stockfish deep scan for Scout: evaluate the opponent's opening moves,
// cache per game, and aggregate recurring mistake patterns by trie path.

import { Chess } from "chess.js";
import { createEngineProvider, ANALYSIS_MAX_NODES, ENGINE_ID } from "./engine/stockfish-provider.js";
import { analyzeGamePositions, isTerminalPosition } from "./engine/game-analyzer.js";
import { classifyMove, evaluationToWin } from "./explain.js";
import { confidence } from "./scout-stats.js";
import { ANALYZE_PLIES, branchPathKey, triePathKey } from "./scout.js";
import { readGameCache, writeGameCache } from "./scout-engine-cache.js";

export { triePathKey };
export {
  ENGINE_CACHE_SCHEMA, ENGINE_CACHE_MAX_ENTRIES, ENGINE_CACHE_MAX_BYTES, ENGINE_CACHE_TTL_MS,
  isCompleteScanCacheEntry, readGameCache, writeGameCache,
} from "./scout-engine-cache.js";

export const SCOUT_ENGINE_DEPTH = 12;
export const SCOUT_ENGINE_MIN_RECURRENCE = 2;
export const SCOUT_ENGINE_DEFAULT_GAMES = 60;
export const ENGINE_AGG_MIN_ANALYZED_GAMES = 3;
export const ENGINE_AGG_MIN_COVERAGE_PCT = 60;
// Evals kept across the games and colours of one session's scans (a few KB each).
export const SCAN_EVAL_CACHE_MAX = 4000;

export function scoutCacheProvenance(game, oppColor) {
  return JSON.stringify({
    engine: ENGINE_ID,
    classifier: "shared-win-mate-v1",
    maxNodes: ANALYSIS_MAX_NODES,
    opponent: oppColor,
    ucis: game.ucis,
    sans: game.sans,
  });
}

function moverFromFen(fen) {
  const parts = String(fen || "").split(" ");
  return parts[1] === "b" ? "black" : "white";
}

export function cpLossFromEvals(beforeCp, afterCp, mover) {
  const beforeMover = mover === "white" ? beforeCp : -beforeCp;
  const afterMover = mover === "white" ? afterCp : -afterCp;
  return Math.max(0, beforeMover - afterMover);
}

export function classifyOpponentMove({ fenBefore, playedUci, bestUci, beforeCp, afterCp, beforeMate = null, afterMate = null }) {
  const mover = moverFromFen(fenBefore);
  // classifyMove expects White-POV win % and applies mover flip internally.
  const classification = classifyMove({
    winBefore: evaluationToWin({ cp: beforeCp, mate: beforeMate }),
    winAfter: evaluationToWin({ cp: afterCp, mate: afterMate }),
    mover,
    isBest: playedUci && bestUci && playedUci === bestUci,
  });
  const effectiveCp = (cp, mate) => mate > 0 ? 1000 : mate < 0 ? -1000 : cp ?? 0;
  const cpLoss = cpLossFromEvals(effectiveCp(beforeCp, beforeMate), effectiveCp(afterCp, afterMate), mover);
  return { cpLoss, classification, mover };
}

function collectOpponentPositions(game, oppColor, maxPlies = ANALYZE_PLIES) {
  const chess = new Chess();
  const positions = [];
  for (let i = 0; i < Math.min(game.ucis.length, maxPlies); i += 1) {
    const mover = chess.turn() === "b" ? "black" : "white";
    const fenBefore = chess.fen();
    if (mover === oppColor) {
      const pathUcis = game.ucis.slice(0, i);
      positions.push({
        ply: i,
        fenBefore,
        playedUci: game.ucis[i],
        playedSan: game.sans[i],
        // Uncapped: a scan reaches ANALYZE_PLIES (24), past the trie's 16-ply display key.
        pathKey: branchPathKey(pathUcis),
        pathSans: game.sans.slice(0, i),
        pathUcis,
      });
    }
    try {
      chess.move({
        from: game.ucis[i].slice(0, 2),
        to: game.ucis[i].slice(2, 4),
        promotion: game.ucis[i][4],
      });
    } catch {
      break;
    }
  }
  return positions;
}

function afterPlayedFen(fenBefore, playedUci) {
  try {
    const chess = new Chess(fenBefore);
    chess.move({
      from: playedUci.slice(0, 2),
      to: playedUci.slice(2, 4),
      promotion: playedUci[4],
    });
    return chess.fen();
  } catch {
    return null;
  }
}

function buildAnalyzedMoveResults(positions, evalMap) {
  const moves = [];
  for (const pos of positions) {
    const beforeEval = evalMap.get(pos.fenBefore);
    const afterFen = afterPlayedFen(pos.fenBefore, pos.playedUci);
    if (!beforeEval || !afterFen) continue;
    const afterEval = evalMap.get(afterFen);
    if (!afterEval) continue;
    const beforeCp = beforeEval.score_cp ?? 0;
    const afterCp = afterEval.score_cp ?? 0;
    const { cpLoss, classification } = classifyOpponentMove({
      fenBefore: pos.fenBefore,
      playedUci: pos.playedUci,
      bestUci: beforeEval.best_move_uci,
      beforeCp,
      afterCp,
      beforeMate: beforeEval.mate_in,
      afterMate: afterEval.mate_in,
    });
    const label = classification?.label || null;
    const isInaccuracy =
      label && label !== "Best move" && label !== "Good move";
    moves.push({
      ...pos,
      cpLoss,
      classification: label,
      isInaccuracy,
      bestUci: beforeEval.best_move_uci,
      opponentBestAlternativeUci: beforeEval.best_move_uci,
      ourReplyUci: afterEval.best_move_uci,
      ourReplyPv: afterEval.pv?.length ? afterEval.pv.slice() : null,
    });
  }
  return moves;
}

function buildMistakeMoves(analyzedMoves) {
  return analyzedMoves.filter((m) => m.isInaccuracy);
}

function buildGameScanRecord(game, positions, analyzedMoves) {
  const mistakes = buildMistakeMoves(analyzedMoves);
  const firstInaccuracyPly = mistakes.length
    ? Math.min(...mistakes.map((m) => m.ply))
    : null;
  return {
    gameId: game.gameId,
    firstUci: game.ucis[0] || null,
    firstSan: game.sans[0] || null,
    eligibleOpponentPlies: positions.length,
    analyzedOpponentPlies: analyzedMoves.length,
    firstInaccuracyPly,
    moves: analyzedMoves,
    mistakes,
    complete: true,
  };
}

class ScanCancelled extends Error {
  constructor(message = "Deep scan stopped") {
    super(message);
    this.cancelled = true;
  }
}

/**
 * Evals shared by every game, and both colours, of a session's deep scans: most games
 * open the same way, so each position is searched once. Keyed by engine and depth.
 */
export function createScanEvalCache(max = SCAN_EVAL_CACHE_MAX) {
  const map = new Map();
  const keyOf = (depth, fen) => `${ENGINE_ID}|d${depth}|${fen}`;
  return {
    get: (depth, fen) => map.get(keyOf(depth, fen)) ?? null,
    set(depth, fen, evalResult) {
      const key = keyOf(depth, fen);
      map.delete(key);
      map.set(key, evalResult);
      if (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

// The positions one game needs: before each opponent move, and after it unless the
// game is over there (a finished position has no reply to read).
function planGameScan(game, oppColor) {
  const positions = collectOpponentPositions(game, oppColor);
  const fens = new Set();
  for (const pos of positions) {
    fens.add(pos.fenBefore);
    const afterFen = afterPlayedFen(pos.fenBefore, pos.playedUci);
    if (afterFen && !isTerminalPosition(afterFen)) fens.add(afterFen);
  }
  return { game, positions, fens: [...fens], missing: 0 };
}

function finishGameScan(plan, evalMap, { depth, storage, provenance }) {
  const analyzedMoves = buildAnalyzedMoveResults(plan.positions, evalMap);
  const record = buildGameScanRecord(plan.game, plan.positions, analyzedMoves);
  writeGameCache(storage, plan.game.gameId, depth, ANALYZE_PLIES, { record, at: Date.now(), provenance });
  return { mistakes: record.mistakes, record };
}

export function engineScanPatterns(scanResult) {
  if (!scanResult) return null;
  if (scanResult instanceof Map) return scanResult;
  return scanResult.patterns || null;
}

export function selectEngineScope(
  games,
  { color, speedFilter = "all", maxGames = SCOUT_ENGINE_DEFAULT_GAMES } = {},
) {
  const filtered = (games || [])
    .filter((g) => g.color === color)
    .filter((g) => speedFilter === "all" || g.speed === speedFilter);
  const scoped = filtered.slice(0, maxGames);
  const gameIds = scoped.map((g) => g.gameId).filter(Boolean);
  return {
    games: scoped,
    gameIds,
    totalGames: filtered.length,
    maxGames,
    scopeLimited: filtered.length > maxGames,
  };
}

function scopeGameIdsMatch(currentIds, scannedIds) {
  if (currentIds.length !== scannedIds.length) return false;
  const scanSet = new Set(scannedIds);
  return currentIds.every((id) => scanSet.has(id));
}

export function aggregateEngineByFamily(
  scanRecords,
  {
    eligibleGameIds = null,
    eligibleGames = null,
    scanGameIds = null,
    scopeLimited = false,
    maxGames = SCOUT_ENGINE_DEFAULT_GAMES,
  } = {},
) {
  if (!scanRecords?.length) {
    return {
      families: [],
      analyzedGames: 0,
      eligibleGames: eligibleGames ?? 0,
      coveragePct: 0,
      sufficient: false,
      status: "none",
      stale: false,
      minAnalyzedGames: ENGINE_AGG_MIN_ANALYZED_GAMES,
      minCoveragePct: ENGINE_AGG_MIN_COVERAGE_PCT,
    };
  }

  const currentIds = eligibleGameIds || [];
  const scannedIds = scanGameIds || scanRecords.map((r) => r.gameId).filter(Boolean);
  const stale =
    currentIds.length > 0 &&
    scannedIds.length > 0 &&
    !scopeGameIdsMatch(currentIds, scannedIds);

  const idSet = currentIds.length ? new Set(currentIds) : null;
  const records = idSet
    ? scanRecords.filter((r) => r.gameId && idSet.has(r.gameId))
    : scanRecords;

  const byFamily = new Map();
  const totalEligible = eligibleGames != null ? eligibleGames : records.length;
  let totalAnalyzed = 0;

  for (const record of records) {
    const analyzed = (record.analyzedOpponentPlies ?? 0) > 0;
    if (analyzed) totalAnalyzed += 1;

    const key = record.firstUci || "?";
    if (!byFamily.has(key)) {
      byFamily.set(key, {
        uci: record.firstUci,
        san: record.firstSan || "?",
        eligibleGames: 0,
        analyzedGames: 0,
        totalCpLoss: 0,
        totalOpponentPlies: 0,
        firstInaccuracyPlies: [],
      });
    }
    const fam = byFamily.get(key);
    fam.eligibleGames += 1;
    if (analyzed) fam.analyzedGames += 1;
    for (const move of record.moves || []) {
      fam.totalCpLoss += move.cpLoss || 0;
      fam.totalOpponentPlies += 1;
    }
    if (record.firstInaccuracyPly != null) {
      fam.firstInaccuracyPlies.push(record.firstInaccuracyPly);
    }
  }

  const families = [...byFamily.values()].map((fam) => {
    const acpl =
      fam.totalOpponentPlies > 0 ? Math.round(fam.totalCpLoss / fam.totalOpponentPlies) : 0;
    const firstInaccuracyPly = fam.firstInaccuracyPlies.length
      ? Math.round(
          fam.firstInaccuracyPlies.reduce((sum, ply) => sum + ply, 0) /
            fam.firstInaccuracyPlies.length,
        )
      : null;
    const coveragePct =
      fam.eligibleGames > 0 ? Math.round((fam.analyzedGames / fam.eligibleGames) * 100) : 0;
    return {
      uci: fam.uci,
      san: fam.san,
      acpl,
      firstInaccuracyPly,
      analyzedGames: fam.analyzedGames,
      eligibleGames: fam.eligibleGames,
      coveragePct,
      confidence: confidence(fam.analyzedGames),
    };
  });

  families.sort((a, b) => b.acpl - a.acpl || b.analyzedGames - a.analyzedGames);

  const coveragePct =
    totalEligible > 0 ? Math.round((totalAnalyzed / totalEligible) * 100) : 0;
  const sufficient =
    !stale &&
    totalAnalyzed >= ENGINE_AGG_MIN_ANALYZED_GAMES &&
    coveragePct >= ENGINE_AGG_MIN_COVERAGE_PCT;

  return {
    families: stale ? [] : families,
    analyzedGames: totalAnalyzed,
    eligibleGames: totalEligible,
    coveragePct,
    sufficient,
    stale,
    status: stale ? "stale" : sufficient ? "ok" : "insufficient",
    scopeLimited,
    maxGames,
    minAnalyzedGames: ENGINE_AGG_MIN_ANALYZED_GAMES,
    minCoveragePct: ENGINE_AGG_MIN_COVERAGE_PCT,
  };
}

export function aggregateEngineByTriePath(allGameMoves) {
  const byPath = new Map();

  for (const gameMoves of allGameMoves) {
    for (const move of gameMoves) {
      if (!byPath.has(move.pathKey)) {
        byPath.set(move.pathKey, {
          pathKey: move.pathKey,
          pathSans: move.pathSans,
          mistakes: [],
          totalCpLoss: 0,
          mistakeCount: 0,
          blunderCount: 0,
          gamesSeen: new Set(),
        });
      }
      const bucket = byPath.get(move.pathKey);
      bucket.mistakes.push(move);
      bucket.totalCpLoss += move.cpLoss;
      bucket.mistakeCount += 1;
      if (move.classification === "Blunder") bucket.blunderCount += 1;
      if (move.gameId) bucket.gamesSeen.add(move.gameId);
    }
  }

  const patterns = new Map();
  for (const [pathKey, bucket] of byPath) {
    const moveCounts = new Map();
    for (const m of bucket.mistakes) {
      const key = `${m.playedUci}|${m.playedSan}`;
      moveCounts.set(key, (moveCounts.get(key) || 0) + 1);
    }
    let top = null;
    for (const [key, count] of moveCounts) {
      if (count < SCOUT_ENGINE_MIN_RECURRENCE) continue;
      if (!top || count > top.count) top = { key, count };
    }
    if (!top) continue;
    const [playedUci, playedSan] = top.key.split("|");
    const avgCpLoss = bucket.mistakeCount
      ? bucket.totalCpLoss / bucket.mistakeCount
      : 0;
    patterns.set(pathKey, {
      pathKey,
      pathSans: bucket.pathSans,
      playedUci,
      playedSan,
      occurrences: top.count,
      mistakeGames: bucket.mistakeCount,
      avgCpLoss,
      blunderRate: bucket.mistakeCount ? bucket.blunderCount / bucket.mistakeCount : 0,
    });
  }
  return patterns;
}

export async function runScoutDeepScan({
  games,
  oppColor,
  maxGames = SCOUT_ENGINE_DEFAULT_GAMES,
  depth = SCOUT_ENGINE_DEPTH,
  speedFilter = "all",
  onProgress,
  shouldCancel,
  storage,
  createProvider = createEngineProvider,
  evalCache = createScanEvalCache(),
} = {}) {
  const store =
    storage ||
    (typeof localStorage === "undefined"
      ? { getItem: () => null, setItem: () => {} }
      : localStorage);

  const scope = selectEngineScope(games, { color: oppColor, speedFilter, maxGames });
  const filtered = scope.games;

  const total = filtered.length;
  const results = new Array(total);
  let done = 0;
  const evals = { get: (fen) => evalCache.get(depth, fen) };
  const finish = (plan) => {
    results[plan.index] = finishGameScan(plan, evals, { depth, storage: store, provenance: plan.provenance });
    done += 1;
    if (typeof onProgress === "function") onProgress(done, total);
  };
  const settle = (index, result) => {
    results[index] = result;
    done += 1;
    if (typeof onProgress === "function") onProgress(done, total);
  };

  if (typeof shouldCancel === "function" && shouldCancel()) throw new ScanCancelled();
  // One engine pass over every uncached game: one provider for the whole scan, each
  // distinct position searched once, and each game recorded (and cached) the moment
  // its last position is known, so a stopped scan keeps the games it finished.
  const waiting = new Map(); // fen -> plans still waiting on it
  const queue = [];
  const plans = [];
  filtered.forEach((game, index) => {
    const provenance = scoutCacheProvenance(game, oppColor);
    const cached = readGameCache(store, game.gameId, depth, ANALYZE_PLIES, provenance);
    if (cached?.record) {
      settle(index, { mistakes: cached.record.mistakes, record: cached.record });
      return;
    }
    const plan = { ...planGameScan(game, oppColor), index, provenance };
    if (!plan.positions.length) {
      settle(index, { mistakes: [], record: buildGameScanRecord(game, [], []) });
      return;
    }
    for (const fen of plan.fens) {
      if (evalCache.get(depth, fen)) continue;
      plan.missing += 1;
      if (!waiting.has(fen)) {
        waiting.set(fen, []);
        queue.push(fen);
      }
      waiting.get(fen).push(plan);
    }
    plans.push(plan);
    if (!plan.missing) finish(plan);
  });

  if (queue.length) {
    await analyzeGamePositions({
      positions: queue,
      depth,
      concurrency: 1,
      shouldCancel,
      createProvider,
      reuse: (fen) => evalCache.get(depth, fen),
      onResult: (fen, evalResult) => {
        evalCache.set(depth, fen, evalResult);
        const blocked = waiting.get(fen);
        if (!blocked) return;
        waiting.delete(fen);
        for (const plan of blocked) {
          plan.missing -= 1;
          if (plan.missing === 0) finish(plan);
        }
      },
    });
  }
  // A game whose record failed to build in the callback is built from what is known.
  for (const plan of plans) if (!results[plan.index]) finish(plan);

  const allGameMoves = results.map((result, i) =>
    result.mistakes.map((m) => ({ ...m, gameId: filtered[i].gameId })));
  const scanRecords = results.map((result) => result.record);

  return {
    patterns: aggregateEngineByTriePath(allGameMoves),
    scanRecords,
    gameIds: scope.gameIds,
    speedFilter,
    oppColor,
    eligibleGames: total,
    maxGames: scope.maxGames,
    totalGames: scope.totalGames,
    scopeLimited: scope.scopeLimited,
    depth,
  };
}
