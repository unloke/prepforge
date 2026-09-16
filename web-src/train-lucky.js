// I'm Feeling Lucky — pick a non-start "key" FEN from games or trees the app
// already has. Lichess explorer has no mistake-ply endpoint; this synthesizes
// from analyzed games (engine miss / book departure) and repertoire forks.

import { Chess } from "chess.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const MISS_CLASSES = new Set([
  "mistake",
  "blunder",
  "inaccuracy",
  "missed_win",
  "missed_tactic",
]);

export function isStartFen(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return parts[0] === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR" && parts[1] === "w";
}

function placementSide(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return `${parts[0] || ""} ${parts[1] || ""}`;
}

function roll(rng) {
  const value = typeof rng === "function" ? rng() : Math.random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

export function fensFromSanHistory(sans, startFen = START_FEN) {
  const chess = new Chess(startFen);
  const positions = [{ fen: chess.fen(), ply: 0 }];
  for (const san of sans || []) {
    const move = chess.move(san);
    if (!move) break;
    positions.push({ fen: chess.fen(), ply: positions.length });
  }
  return positions;
}

export function keyPositionsFromGame(game) {
  const keys = [];
  if (!game || typeof game !== "object") return keys;

  const moves = game.moves || [];
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const fen = move.fen_before || move.fen;
    if (!fen || isStartFen(fen)) continue;
    const classification = String(move.classification || "").toLowerCase();
    if (MISS_CLASSES.has(classification)) {
      keys.push({ fen, reason: "miss", ply: i + 1 });
    }
  }

  const departPly = Number(game.departure_ply);
  const leftPrep = game.departure_reason === "user_left_preparation";
  if (leftPrep && departPly > 0) {
    let fen = game.departure_fen || null;
    if (!fen && (game.move_san_history || []).length) {
      const path = fensFromSanHistory(game.move_san_history);
      // FEN before the departing ply (ply is 1-indexed).
      const before = path[Math.max(0, departPly - 1)];
      fen = before ? before.fen : null;
    }
    if (!fen && moves[departPly - 1]) {
      fen = moves[departPly - 1].fen_before;
    }
    if (fen && !isStartFen(fen)) {
      keys.push({ fen, reason: "departure", ply: departPly });
    }
  }
  return keys;
}

export function keyPositionsFromTree(nodes) {
  const list = Array.isArray(nodes) ? nodes : (nodes && nodes.nodes) || [];
  const byParent = new Map();
  for (const node of list) {
    if (!node || node.is_enabled === false) continue;
    const parentId = node.parent_id || node.parentId || null;
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(node);
  }
  const byId = new Map(list.map((node) => [node.id, node]));
  const keys = [];
  for (const [parentId, children] of byParent) {
    if (children.length < 2) continue;
    const parent = byId.get(parentId);
    const fen = (parent && (parent.fen || parent.fen_after)) || children[0].fen_before;
    if (!fen || isStartFen(fen)) continue;
    keys.push({
      fen,
      reason: "fork",
      replies: children.length,
      nodeId: parentId,
    });
  }
  return keys;
}

export function collectLuckyKeys({ games = [], trees = [] } = {}) {
  const seen = new Set();
  const keys = [];
  const pushAll = (items) => {
    for (const item of items) {
      const id = placementSide(item.fen);
      if (!id || seen.has(id) || isStartFen(item.fen)) continue;
      seen.add(id);
      keys.push(item);
    }
  };
  for (const game of games) pushAll(keyPositionsFromGame(game));
  for (const tree of trees) pushAll(keyPositionsFromTree(tree));
  return keys;
}

export function pickLuckyStart({ games = [], trees = [], rng = Math.random, exclude = [] } = {}) {
  const keys = collectLuckyKeys({ games, trees });
  if (!keys.length) return null;
  const banned = new Set(
    (exclude || []).map((fen) => placementSide(fen)).filter(Boolean),
  );
  const fresh = banned.size ? keys.filter((key) => !banned.has(placementSide(key.fen))) : keys;
  const pool = fresh.length ? fresh : keys;
  const index = Math.min(pool.length - 1, Math.floor(roll(rng) * pool.length));
  return pool[index];
}

/**
 * Lucky entry used by Train: if the book is a repertoire, load it first so
 * forks in that tree are candidates even when Build was never opened.
 * `loadRepertoire(id)` must return a payload with `.nodes` (same shape as
 * GET /api/build/load).
 */
export async function luckyStartFromWorkspace({
  book = "explorer",
  repertoireId = null,
  currentBuild = null,
  loadRepertoire = null,
  analysisMoves = null,
  replayGames = null,
  rng = Math.random,
  exclude = [],
} = {}) {
  const games = [];
  if (analysisMoves && analysisMoves.length) games.push({ moves: analysisMoves });
  if (Array.isArray(replayGames)) games.push(...replayGames);

  let buildNodes = null;
  if (book === "repertoire" && repertoireId) {
    const already =
      currentBuild &&
      currentBuild.repertoire_id === repertoireId &&
      Array.isArray(currentBuild.nodes);
    if (already) {
      buildNodes = currentBuild.nodes;
    } else if (typeof loadRepertoire === "function") {
      const payload = await loadRepertoire(repertoireId);
      if (payload && Array.isArray(payload.nodes)) buildNodes = payload.nodes;
    }
  } else if (currentBuild && Array.isArray(currentBuild.nodes)) {
    buildNodes = currentBuild.nodes;
  }

  const trees = buildNodes ? [buildNodes] : [];
  return pickLuckyStart({ games, trees, rng, exclude });
}
