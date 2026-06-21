// Opt-in Stockfish deep scan for Scout: evaluate the opponent's opening moves,
// cache per game, and aggregate recurring mistake patterns by trie path.

import { Chess } from "chess.js";
import { createEngineProvider } from "./engine/stockfish-provider.js";
import { analyzeGamePositions, isTerminalPosition } from "./engine/game-analyzer.js";
import { classifyMove, cpToWin } from "./explain.js";
import { confidence } from "./scout-stats.js";
import { ANALYZE_PLIES, MAX_PLIES, triePathKey } from "./scout.js";

export { triePathKey };

export const SCOUT_ENGINE_DEPTH = 12;
export const SCOUT_ENGINE_MIN_RECURRENCE = 2;
export const SCOUT_ENGINE_DEFAULT_GAMES = 60;
export const ENGINE_AGG_MIN_ANALYZED_GAMES = 3;
export const ENGINE_AGG_MIN_COVERAGE_PCT = 60;
export const ENGINE_CACHE_SCHEMA = 3;
const CACHE_PREFIX = "prepforge.scout.engine.v3";
const LEGACY_CACHE_PREFIX = "prepforge.scout.engine.v1";
const STALE_CACHE_PREFIXES = [LEGACY_CACHE_PREFIX, "prepforge.scout.engine.v2"];

class ScanCancelled extends Error {
  constructor(message = "Deep scan stopped") {
    super(message);
    this.cancelled = true;
  }
}

function cacheKey(gameId, depth, plies) {
  return `${CACHE_PREFIX}:${gameId}:d${depth}:p${plies}`;
}

function staleCacheKey(prefix, gameId, depth, plies) {
  return `${prefix}:${gameId}:d${depth}:p${plies}`;
}

function moveHasReplyFields(move) {
  if (!move || typeof move !== "object") return false;
  const hasOpponentAlt =
    Object.prototype.hasOwnProperty.call(move, "opponentBestAlternativeUci") ||
    Object.prototype.hasOwnProperty.call(move, "bestUci");
  return (
    hasOpponentAlt &&
    Object.prototype.hasOwnProperty.call(move, "ourReplyUci") &&
    Object.prototype.hasOwnProperty.call(move, "ourReplyPv")
  );
}

export function isCompleteScanCacheEntry(cached) {
  if (!cached?.record || cached.schemaVersion !== ENGINE_CACHE_SCHEMA) return false;
  const rec = cached.record;
  if (!Number.isFinite(rec.eligibleOpponentPlies) || !Number.isFinite(rec.analyzedOpponentPlies)) {
    return false;
  }
  if (!Array.isArray(rec.moves) || !Array.isArray(rec.mistakes)) return false;
  if (rec.complete !== true) return false;
  if (rec.analyzedOpponentPlies > 0 && rec.moves.length !== rec.analyzedOpponentPlies) {
    return false;
  }
  if (rec.moves.length > 0 && !rec.moves.every(moveHasReplyFields)) {
    return false;
  }
  return true;
}

function purgeStaleCacheKeys(store, gameId, depth, plies) {
  for (const prefix of STALE_CACHE_PREFIXES) {
    const key = staleCacheKey(prefix, gameId, depth, plies);
    if (store.getItem(key)) store.removeItem(key);
  }
}

export function readGameCache(store, gameId, depth, plies) {
  if (!gameId) return null;
  try {
    purgeStaleCacheKeys(store, gameId, depth, plies);
    const key = cacheKey(gameId, depth, plies);
    const raw = store.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isCompleteScanCacheEntry(parsed)) return parsed;
      store.removeItem(key);
    }
  } catch (_) {
    return null;
  }
  return null;
}

function writeGameCache(store, gameId, depth, plies, payload) {
  if (!gameId) return;
  try {
    store.setItem(
      cacheKey(gameId, depth, plies),
      JSON.stringify({ ...payload, schemaVersion: ENGINE_CACHE_SCHEMA }),
    );
  } catch (_) {
    /* best-effort */
  }
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

export function classifyOpponentMove({ fenBefore, playedUci, bestUci, beforeCp, afterCp }) {
  const mover = moverFromFen(fenBefore);
  // classifyMove expects White-POV win % and applies mover flip internally.
  const classification = classifyMove({
    winBefore: cpToWin(beforeCp),
    winAfter: cpToWin(afterCp),
    mover,
    isBest: playedUci && bestUci && playedUci === bestUci,
  });
  const cpLoss = cpLossFromEvals(beforeCp, afterCp, mover);
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
        pathKey: triePathKey(pathUcis),
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
    } catch (_) {
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
  } catch (_) {
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

async function analyzeGameForScan(game, oppColor, { depth, storage, shouldCancel, createProvider }) {
  const cached = readGameCache(storage, game.gameId, depth, ANALYZE_PLIES);
  if (cached?.record) {
    return {
      mistakes: cached.record.mistakes || buildMistakeMoves(cached.record.moves || []),
      record: cached.record,
    };
  }

  const positions = collectOpponentPositions(game, oppColor);
  if (!positions.length) {
    const empty = buildGameScanRecord(game, [], []);
    return { mistakes: [], record: empty };
  }

  const fens = [];
  for (const pos of positions) {
    fens.push(pos.fenBefore);
    const afterFen = afterPlayedFen(pos.fenBefore, pos.playedUci);
    if (afterFen && !isTerminalPosition(afterFen)) fens.push(afterFen);
  }

  const evalMap = await analyzeGamePositions({
    positions: fens,
    depth,
    concurrency: 1,
    shouldCancel,
    createProvider,
    onProgress: () => {},
  });

  const analyzedMoves = buildAnalyzedMoveResults(positions, evalMap);
  const record = buildGameScanRecord(game, positions, analyzedMoves);
  writeGameCache(storage, game.gameId, depth, ANALYZE_PLIES, {
    record,
    moves: record.mistakes,
    at: Date.now(),
  });
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
} = {}) {
  const store =
    storage ||
    (typeof localStorage === "undefined"
      ? { getItem: () => null, setItem: () => {} }
      : localStorage);

  const scope = selectEngineScope(games, { color: oppColor, speedFilter, maxGames });
  const filtered = scope.games;

  const total = filtered.length;
  const allGameMoves = [];
  const scanRecords = [];

  for (let i = 0; i < filtered.length; i += 1) {
    if (typeof shouldCancel === "function" && shouldCancel()) throw new ScanCancelled();
    const game = filtered[i];
    const { mistakes, record } = await analyzeGameForScan(game, oppColor, {
      depth,
      storage: store,
      shouldCancel,
      createProvider,
    });
    allGameMoves.push(mistakes.map((m) => ({ ...m, gameId: game.gameId })));
    scanRecords.push(record);
    if (typeof onProgress === "function") onProgress(i + 1, total);
  }

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