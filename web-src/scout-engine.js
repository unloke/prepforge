// Opt-in Stockfish deep scan for Scout: evaluate the opponent's opening moves,
// cache per game, and aggregate recurring mistake patterns by trie path.

import { Chess } from "chess.js";
import { createEngineProvider } from "./engine/stockfish-provider.js";
import { analyzeGamePositions, isTerminalPosition } from "./engine/game-analyzer.js";
import { classifyMove, cpToWin } from "./explain.js";
import { ANALYZE_PLIES, MAX_PLIES, triePathKey } from "./scout.js";

export { triePathKey };

export const SCOUT_ENGINE_DEPTH = 12;
export const SCOUT_ENGINE_MIN_RECURRENCE = 2;
export const SCOUT_ENGINE_DEFAULT_GAMES = 60;
const CACHE_PREFIX = "prepforge.scout.engine.v1";

class ScanCancelled extends Error {
  constructor(message = "Deep scan stopped") {
    super(message);
    this.cancelled = true;
  }
}

function cacheKey(gameId, depth, plies) {
  return `${CACHE_PREFIX}:${gameId}:d${depth}:p${plies}`;
}

function readGameCache(store, gameId, depth, plies) {
  if (!gameId) return null;
  try {
    const raw = store.getItem(cacheKey(gameId, depth, plies));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeGameCache(store, gameId, depth, plies, payload) {
  if (!gameId) return;
  try {
    store.setItem(cacheKey(gameId, depth, plies), JSON.stringify(payload));
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

function buildMoveResults(positions, evalMap) {
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
    if (!classification || classification.label === "Best move" || classification.label === "Good move") {
      continue;
    }
    moves.push({
      ...pos,
      cpLoss,
      classification: classification.label,
      bestUci: beforeEval.best_move_uci,
    });
  }
  return moves;
}

async function analyzeGameMoves(game, oppColor, { depth, storage, shouldCancel, createProvider }) {
  const cached = readGameCache(storage, game.gameId, depth, ANALYZE_PLIES);
  if (cached?.moves) return cached.moves;

  const positions = collectOpponentPositions(game, oppColor);
  if (!positions.length) return [];

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

  const moves = buildMoveResults(positions, evalMap);
  writeGameCache(storage, game.gameId, depth, ANALYZE_PLIES, { moves, at: Date.now() });
  return moves;
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

  const filtered = games
    .filter((g) => g.color === oppColor)
    .filter((g) => speedFilter === "all" || g.speed === speedFilter)
    .slice(0, maxGames);

  const total = filtered.length;
  const allGameMoves = [];

  for (let i = 0; i < filtered.length; i += 1) {
    if (typeof shouldCancel === "function" && shouldCancel()) throw new ScanCancelled();
    const game = filtered[i];
    const moves = await analyzeGameMoves(game, oppColor, {
      depth,
      storage: store,
      shouldCancel,
      createProvider,
    });
    allGameMoves.push(moves.map((m) => ({ ...m, gameId: game.gameId })));
    if (typeof onProgress === "function") onProgress(i + 1, total);
  }

  return aggregateEngineByTriePath(allGameMoves);
}