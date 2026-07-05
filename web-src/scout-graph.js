// Transposition-aware position graph for Scout v3 — EPD-keyed aggregation replacing the
// path-keyed trie. Pure: no engine, no DOM; fold games incrementally and project move stats.

import { Chess } from "chess.js";

import {
  ANALYZE_PLIES,
  SCOUT_RECENCY_HALF_LIFE_DAYS,
  isEarlyResignCollapse,
  uciToSan,
} from "./scout.js";

const MS_PER_DAY = 86_400_000;

/** EPD = first 4 space-separated fields of a FEN (piece placement, side, castling, en passant).
 *  Dropping the halfmove/fullmove counters is what merges transpositions. */
export function epdOf(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

/** Fresh empty graph. `root` is the EPD of the initial position. */
export function createGraph() {
  return { nodes: new Map(), root: START_EPD };
}

function getGameOpeningMoves(game) {
  const ucis = game.openingUcis?.length ? game.openingUcis : game.ucis || [];
  const sans = game.openingSans?.length ? game.openingSans : game.sans || [];
  return { ucis, sans };
}

function createNode(epd, ply) {
  // reachK / freshN are per-game-guarded distinct-game counts (see the seen-guard in insertGame):
  // reachK = distinct games that reached this position; freshN = distinct games that reached it
  // inside the fresh window W (§2.0). node.totalN/totalWN stay per-ply (legacy consumers).
  return { epd, ply, moves: new Map(), totalN: 0, totalWN: 0, reachK: 0, freshN: 0 };
}

function createEdge(uci) {
  return {
    uci,
    n: 0,
    wN: 0,
    w: 0,
    d: 0,
    l: 0,
    lastDatestamp: 0,
    recentN: 0,
    olderN: 0,
    // v6 provenance (§2.0). All maintained incrementally under the per-game seen-guard so a single
    // game that revisits the same edge (repetition) contributes once.
    gameRefs: [], // bounded FIFO, cap SCOUT_GAMEREFS_CAP: {gameId, datestamp, result, plyAtVisit}
    distinctDateN: 0, // distinct calendar days he actually played this move (≥2 gate, §2.1)
    freshK: 0, // times he played this move inside the fresh window W
    dateKeys: new Set(), // internal: day-bucket set backing distinctDateN
  };
}

/** Per-edge game-provenance ring buffer cap (§2.0): 500 games × 24 plies × ~40B, edges shared by
 *  transposition, capped here → well under 1MB. distinctDateN/freshK are NOT derived from this
 *  capped list (they'd undercount after eviction); they are maintained on their own. */
export const SCOUT_GAMEREFS_CAP = 32;

function incrementResult(edge, score) {
  if (score === 1) edge.w += 1;
  else if (score === 0.5) edge.d += 1;
  else edge.l += 1;
}

function recencyWeight(game, anchorTs, recency) {
  if (!recency) return 1;
  if (!game.datestamp || game.datestamp <= 0) return 0.3;
  const ageDays = Math.max(0, (anchorTs - game.datestamp) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / SCOUT_RECENCY_HALF_LIFE_DAYS);
}

function ensureNode(graph, epd, ply) {
  if (!graph.nodes.has(epd)) {
    graph.nodes.set(epd, createNode(epd, ply));
  } else {
    graph.nodes.get(epd).ply = Math.min(graph.nodes.get(epd).ply, ply);
  }
  return graph.nodes.get(epd);
}

function ensureEdge(node, uci) {
  if (!node.moves.has(uci)) node.moves.set(uci, createEdge(uci));
  return node.moves.get(uci);
}

function applyUci(chess, uci) {
  return chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] || undefined,
  });
}

/** Newest datestamp among games (recency anchor). Returns Date.now() if none. */
export function graphAnchorTs(games) {
  let newest = 0;
  for (const g of games || []) {
    if (g.datestamp && g.datestamp > newest) newest = g.datestamp;
  }
  return newest || Date.now();
}

/** Fold ONE game into a persistent per-colour graph (incremental, O(plies)).
 *  Skips wrong-colour games and (when excludeCollapse) early-resign collapses, so it is safe to
 *  call blindly on every streamed game. Returns `graph` for chaining. */
export function insertGame(
  graph,
  game,
  color,
  {
    maxPlies = ANALYZE_PLIES,
    anchorTs = null,
    recency = true,
    excludeCollapse = true,
    recencyBoundaryTs = null,
    // Fresh window W boundary timestamp (§2.1). Visits/plays with datestamp ≥ this are "fresh".
    // null → treat everything as fresh (freshN/freshK count all; STALE can't fire without a window).
    freshBoundaryTs = null,
  } = {},
) {
  if (!game || game.color !== color) return graph;
  if (excludeCollapse && isEarlyResignCollapse(game)) return graph;

  const anchor = anchorTs ?? (game.datestamp > 0 ? game.datestamp : Date.now());
  const boundary = recencyBoundaryTs ?? anchor - 60 * MS_PER_DAY;
  const freshCutoff = freshBoundaryTs == null ? -Infinity : freshBoundaryTs;
  const isFresh = (game.datestamp || 0) >= freshCutoff;
  const dayKey = game.datestamp > 0 ? Math.floor(game.datestamp / MS_PER_DAY) : null;
  const wNGame = recencyWeight(game, anchor, recency);
  const { ucis } = getGameOpeningMoves(game);
  const chess = new Chess();
  const limit = Math.min(ucis.length, maxPlies);

  // Per-game seen-guard (§2.0): a game that transposes back to the same node/edge within its own
  // opening must not double-count distinct-game provenance (reachK/freshN/gameRefs/distinctDateN).
  const seenNodes = new Set();
  const seenEdges = new Set();

  for (let i = 0; i < limit; i += 1) {
    const epd = epdOf(chess.fen());
    const node = ensureNode(graph, epd, i);
    const edge = ensureEdge(node, ucis[i]);

    edge.n += 1;
    edge.wN += wNGame;
    incrementResult(edge, game.score);
    edge.lastDatestamp = Math.max(edge.lastDatestamp, game.datestamp || 0);
    if (game.datestamp >= boundary) edge.recentN += 1;
    else edge.olderN += 1;
    node.totalN += 1;
    node.totalWN += wNGame;

    // --- guarded distinct-game provenance ---
    if (!seenNodes.has(epd)) {
      seenNodes.add(epd);
      node.reachK += 1;
      if (isFresh) node.freshN += 1;
    }
    const edgeKey = `${epd}|${ucis[i]}`;
    if (!seenEdges.has(edgeKey)) {
      seenEdges.add(edgeKey);
      if (isFresh) edge.freshK += 1;
      if (dayKey != null && !edge.dateKeys.has(dayKey)) {
        edge.dateKeys.add(dayKey);
        edge.distinctDateN = edge.dateKeys.size;
      }
      edge.gameRefs.push({
        gameId: game.gameId || null,
        datestamp: game.datestamp || 0,
        result: game.score,
        plyAtVisit: i,
      });
      if (edge.gameRefs.length > SCOUT_GAMEREFS_CAP) edge.gameRefs.shift();
    }

    try {
      applyUci(chess, ucis[i]);
    } catch (_) {
      break;
    }
  }

  return graph;
}

/** Fresh-window boundary timestamp for one colour (§2.1): a game is fresh iff its datestamp is
 *  within the LAST `freshGames` games OR the last `freshDays` days — the union (larger set), so a
 *  low-frequency player doesn't go fully stale just from playing rarely. Returns a timestamp; games
 *  with datestamp ≥ it are fresh. Compute once per graph build and pass to insertGame. */
export function freshWindowBoundary(
  games,
  color,
  { anchorTs = null, freshGames = 20, freshDays = 120 } = {},
) {
  const dated = (games || [])
    .filter((g) => g && g.color === color && g.datestamp > 0)
    .map((g) => g.datestamp)
    .sort((a, b) => b - a);
  const anchor = anchorTs ?? (dated.length ? dated[0] : Date.now());
  const cutoffDays = anchor - freshDays * MS_PER_DAY;
  const cutoffGames = dated.length >= freshGames ? dated[freshGames - 1] : -Infinity;
  return Math.min(cutoffGames, cutoffDays);
}

/** Look up the node at the position reached by replaying `ucis` from the start.
 *  Returns the node object or null if that position was never reached / illegal replay. */
export function nodeAt(graph, ucis) {
  if (!graph) return null;
  const chess = new Chess();
  if (!ucis?.length) return graph.nodes.get(graph.root) || null;

  for (const uci of ucis) {
    try {
      applyUci(chess, uci);
    } catch (_) {
      return null;
    }
  }
  return graph.nodes.get(epdOf(chess.fen())) || null;
}

/** First-move distribution for `color`, from the root node's move edges.
 *  → [{ uci, san, n, wN, share }] sorted by wN desc. `share` = wN / node.totalWN.
 *  `san` derived by replaying the single uci from the start position. */
export function projectFirstMoveDist(graph) {
  const node = graph.nodes.get(graph.root);
  if (!node || node.totalWN <= 0) return [];

  const startFen = new Chess().fen();
  const out = [];
  for (const edge of node.moves.values()) {
    out.push({
      uci: edge.uci,
      san: uciToSan(startFen, edge.uci),
      n: edge.n,
      wN: edge.wN,
      share: edge.wN / node.totalWN,
    });
  }
  out.sort((a, b) => b.wN - a.wN || a.uci.localeCompare(b.uci));
  return out;
}