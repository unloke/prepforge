// I'm Feeling Lucky, database round: walk a masters line and start from one of
// its critical positions. Pure game-shape helpers live here next to the small
// async sampler; the score itself is train-lucky-crit.js. No DOM. Deps
// (fetchStats, storage) are injected so it is unit-testable without a network.

import { Chess } from "chess.js";

import {
  boardSnapshot,
  CRITICAL_THRESHOLD,
  divideGame,
  extractLocalFeatures,
  phaseAt,
  pickKeyIndex,
  scorePosition,
} from "./train-lucky-crit.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const LUCKY_PHASE_KEY = "prepforge.lucky_phase";
export const LUCKY_GAME_KEY = "prepforge.lucky_game_ids";
const PHASES = ["opening", "middlegame", "endgame"];
const MAX_RECENT_GAMES = 12;
// Six broad doors into the masters DB so consecutive clicks do not keep
// drawing the same e4-e5 family. The FENs are the positions AFTER the move.
export const LUCKY_SEED_FENS = [
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
];

/** rng() clamped to [0, 1). */
export function roll(rng) {
  const value = typeof rng === "function" ? rng() : Math.random();
  return Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0;
}

export function storageGet(storage, key) {
  try { return storage?.getItem?.(key) ?? null; } catch { return null; }
}

export function storageSet(storage, key, value) {
  try { storage?.setItem?.(key, value); } catch { /* best-effort */ }
}

export function nextLuckyPhase({ storage = null, rng = Math.random } = {}) {
  const last = storageGet(storage, LUCKY_PHASE_KEY);
  // Strict rotation keeps the three buckets balanced; the surprise comes from
  // which game and which critical moment is drawn inside the bucket.
  if (PHASES.includes(last)) return PHASES[(PHASES.indexOf(last) + 1) % PHASES.length];
  return PHASES[Math.floor(roll(rng) * PHASES.length)];
}

export function rememberLuckyPhase(phase, storage = null) {
  if (PHASES.includes(phase)) storageSet(storage, LUCKY_PHASE_KEY, phase);
}

function recentGameIds(storage) {
  try {
    const parsed = JSON.parse(storageGet(storage, LUCKY_GAME_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function recentGameIdSet(storage) {
  return new Set(recentGameIds(storage));
}

export function rememberLuckyGame(gameId, storage = null) {
  if (!gameId || !storage) return;
  const ids = [String(gameId), ...recentGameIds(storage).filter((id) => id !== String(gameId))];
  storageSet(storage, LUCKY_GAME_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_GAMES)));
}

/** Replay the SAN line from the start and confirm every ply reproduces. */
export function verifyReplay(sans, startFen = START_FEN) {
  const list = Array.isArray(sans) ? sans : [];
  const walked = walkSans(list, startFen);
  return walked.length === list.length + 1 ? walked : null;
}

/** Walk SAN history into per-ply {fen, ply, san, uci}; illegal tails stop short. */
export function walkSans(sans, startFen = START_FEN) {
  const chess = new Chess(startFen);
  const positions = [{ fen: chess.fen(), ply: 0, san: null, uci: null }];
  for (const san of sans || []) {
    let move;
    try { move = chess.move(String(san || "").trim()); } catch { break; }
    positions.push({ fen: chess.fen(), ply: positions.length, san: move.san, uci: move.lan });
  }
  return positions;
}

function placementSide(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return `${parts[0] || ""} ${parts[1] || ""}`;
}

/**
 * Cheap local pass over a fully-replayed game: lichess division first (per
 * game, not per position — see train-lucky-crit.js), then the position scorer
 * per candidate ply. Phase comes from phaseAt(ply, division); the score itself
 * never sees the phase.
 */
export function scoreGamePositions(positions, { minPly = 6, maxPlyFromEnd = 6 } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const end = Math.max(0, list.length - maxPlyFromEnd);
  const division = divideGame(list.map((pos) => boardSnapshot(pos?.fen)));
  const out = [];
  list.forEach((pos, i) => {
    if (!pos?.fen || pos.ply < minPly || i >= end || placementSide(pos.fen) === placementSide(START_FEN)) return;
    let features;
    try { features = extractLocalFeatures(pos.fen, pos.ply); } catch { return; }
    out.push({ index: out.length, position: pos, features, phase: phaseAt(pos.ply, division), score: scorePosition(features) });
  });
  return out;
}

export function pickPhaseCandidate(candidates, phase, { rng = Math.random, exclude = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const banned = new Set((exclude || []).map(placementSide).filter((id) => id && id !== " "));
  const fresh = list.filter((c) => !banned.has(placementSide(c.position.fen)));
  const freshInPhase = fresh.filter((c) => c.phase === phase);
  const critical = (pool) => pool.filter((c) => c.score >= CRITICAL_THRESHOLD);
  const ranked = (pool) => pool.slice().sort((a, b) => b.score - a.score).slice(0, 6);
  // Fresh critical moments in the phase, then fresh critical anywhere (keeps
  // the critical gate), then fresh best-effort in the phase, then anything
  // fresh; only when every candidate is banned do we recycle.
  const pool = [critical(freshInPhase), critical(fresh), freshInPhase, fresh, list].find((p) => p.length);
  if (!pool) return null;
  const shortlist = ranked(pool);
  const idx = pickKeyIndex(shortlist.map((c, i) => ({ index: i, score: c.score })), { rng });
  return shortlist[idx] || shortlist[0];
}

function playUci(chess, uci) {
  const text = String(uci || "");
  try {
    return chess.move({ from: text.slice(0, 2), to: text.slice(2, 4), promotion: text.slice(4) || undefined });
  } catch {
    return null;
  }
}

/**
 * Walk the masters explorer into a database-backed continuation LINE.
 *
 * A masters `topGames[]` entry is one next-move `uci` plus an OTB game key —
 * never movetext — and the public API cannot export that game. So the line
 * starts with the entry's ply and continues with the explorer's own weighted
 * continuation from each position masters reached: every ply is legal and
 * database-backed, but plies may come from different games. Call it a "master
 * database-derived line", never "the game".
 */
export async function buildMasterLine({
  startFen = START_FEN,
  firstUci = null,
  fetchStats = null,
  rating,
  rng = Math.random,
  maxPly = 64,
  say = null,
} = {}) {
  const sans = [];
  const chess = new Chess(startFen);
  const step = (uci) => {
    const applied = playUci(chess, uci);
    if (applied) sans.push(applied.san);
    return !!applied;
  };
  if (firstUci && !step(firstUci)) return null;
  while (!chess.isGameOver() && sans.length < maxPly) {
    let stats;
    try {
      say?.("Following the master line…");
      stats = await fetchStats("masters", chess.fen(), { rating });
    } catch {
      break;
    }
    const continuations = stats?.moves || [];
    if (!continuations.length) break;
    // Weighted by master popularity: the most-played reply usually continues,
    // but the dice occasionally take a side road.
    const total = continuations.reduce((sum, m) => sum + (Number(m.total) || 0), 0);
    let pick = continuations[0];
    if (total > 0 && typeof rng === "function") {
      let draw = roll(rng) * total;
      pick = continuations.find((move) => (draw -= Number(move.total) || 0) < 0) || continuations[0];
    }
    if (!pick?.uci || !step(pick.uci)) break;
  }
  if (!sans.length) return null;
  return { sans, over: chess.isGameOver(), startFen };
}

/**
 * Database round for Feeling Lucky.
 *
 * 1. Pick a seed door (rng) and ask the masters explorer for its topGames.
 * 2. Walk each entry's `uci` into a master database-derived line.
 * 3. Verify the line fully replays from the seed; drop illegal/truncated ones.
 * 4. Divide the game, score every ply locally, keep the target phase's
 *    critical shortlist.
 * 5. Enrich the shortlist (<=6 explorer reads, best-effort), re-score, pick.
 */
export async function luckyDbStart({
  phase = null,
  storage = null,
  rng = Math.random,
  exclude = [],
  rating = 1500,
  fetchStats = null,
  onStatus = null,
  acceptPosition = null,
  maxWalkPly = 96,
} = {}) {
  const say = (msg) => {
    try { onStatus?.(msg); } catch { /* status is best-effort */ }
  };
  const targetPhase = phase || nextLuckyPhase({ storage, rng });
  if (typeof fetchStats !== "function") throw new Error("Lichess explorer is unavailable");
  const context = { targetPhase, rng, exclude, bannedGames: recentGameIdSet(storage), rating, fetchStats, maxWalkPly, say, acceptPosition };
  const seedIndex = Math.floor(roll(rng) * LUCKY_SEED_FENS.length);
  const seedOrder = [LUCKY_SEED_FENS[seedIndex], ...LUCKY_SEED_FENS.filter((_, i) => i !== seedIndex)];
  let lastError = null;
  for (const seedFen of seedOrder) {
    let seed;
    try {
      seed = await fetchStats("masters", seedFen, { rating, topGames: 4 });
    } catch (error) {
      lastError = error;
      if ([400, 401, 403].includes(error?.status)) break;
      continue;
    }
    const picked = await luckyDbStartFromSeed(seed, seedFen, context);
    if (picked) {
      rememberLuckyPhase(picked.phase, storage);
      rememberLuckyGame(picked.gameId, storage);
      return picked;
    }
  }
  if (lastError) throw lastError;
  throw new Error("No sharp database game found — try again");
}

async function luckyDbStartFromSeed(seed, seedFen, { targetPhase, rng, exclude, bannedGames, rating, fetchStats, maxWalkPly, say, acceptPosition }) {
  say("Asking the Lichess database for master positions…");
  const seen = (entry) => (bannedGames.has(String(entry.id)) ? 1 : 0);
  const freshFirst = (seed?.topGames || []).slice().sort((a, b) => seen(a) - seen(b) || roll(rng) - 0.5);
  for (const entry of freshFirst) {
    if (!entry?.uci) continue;
    say("Following a master line…");
    let walk;
    try {
      walk = await buildMasterLine({ startFen: seedFen, firstUci: entry.uci, fetchStats, rating, rng, maxPly: maxWalkPly, say });
    } catch {
      continue;
    }
    const sans = walk?.sans || [];
    if (sans.length < 4) continue;
    const positions = verifyReplay(sans, seedFen);
    if (!positions) continue;
    const scored = scoreGamePositions(positions, sans.length < 24 ? { minPly: 2, maxPlyFromEnd: 1 } : {});
    const candidate = pickPhaseCandidate(scored, targetPhase, { rng, exclude });
    if (!candidate) continue;
    const best = await enrichCandidate(candidate, scored, { fetchStats, rating, say });
    if (acceptPosition && !await acceptPosition(best.position.fen)) continue;
    return {
      fen: best.position.fen,
      ply: best.position.ply,
      phase: best.phase,
      score: best.score,
      reason: "db-critical",
      gameId: entry.id != null ? String(entry.id) : null,
      sans,
      seedFen,
    };
  }
  return null;
}

async function enrichCandidate(candidate, scored, { fetchStats, rating, say }) {
  const peers = scored
    .filter((c) => c.phase === candidate.phase)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const shortlist = peers.length ? peers : [candidate];
  say("Checking which moments masters actually debated…");
  for (const row of shortlist) {
    try {
      const stats = await fetchStats("masters", row.position.fen, { rating });
      row.score = scorePosition(row.features, { explorer: { totalGames: stats.totalGames, moves: stats.moves } });
    } catch {
      // explorer 400/429/offline → the cheap local score stands
    }
  }
  shortlist.sort((a, b) => b.score - a.score);
  return shortlist[0];
}

export function sansFromPgn(pgn) {
  const body = String(pgn || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("["))
    .join(" ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\d+\.{1,3}/g, " ")
    .replace(/\b(1-0|0-1|1\/2-1\/2)\b/g, " ")
    .replace(/\*/g, " ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ");
  const chess = new Chess(START_FEN);
  const sans = [];
  let depth = 0;
  for (const token of body.split(/\s+/).filter(Boolean)) {
    if (token === "(") depth += 1;
    else if (token === ")") depth = Math.max(0, depth - 1);
    if (depth > 0 || token === ")") continue;
    const clean = token.replace(/[!?+#]+$/, "");
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(clean) && !/^[KQRBNPa-hO0-]/i.test(clean)) continue;
    let move;
    try {
      move = chess.move(/^[a-h][1-8][a-h][1-8]/i.test(clean) ? clean.toLowerCase() : clean);
    } catch {
      break;
    }
    sans.push(move.san);
  }
  return sans;
}
