// I'm Feeling Lucky — live titled-game round.
//
// Each click picks a titled/high-rated player from the live Lichess
// leaderboard (static usernames only if the leaderboard is down), fetches
// that player's recent standard games, then replays and scores every PGN
// locally. The Masters walk in train-lucky-db.js is the slow fallback.
// Lichess asks for one request at a time and a full minute after a 429, so a
// click makes a bounded number of sequential requests and never retries.
// No DOM. The fetches are injected so tests run offline on fixtures.

import { Chess } from "chess.js";
import { LUCKY_MAX_ABS_CP } from "./train-lucky-balance.js";
import { cancellationError, isCancellation, throwIfCancelled } from "./cancellation.js";
import {
  nextLuckyPhase,
  pickPhaseCandidate,
  recentGameIdSet,
  rememberLuckyGame,
  rememberLuckyPhase,
  roll,
  sansFromPgn,
  scoreGamePositions,
  storageGet,
  storageSet,
  verifyReplay,
} from "./train-lucky-db.js";

export const TITLED_PLAYERS = [
  "DrNykterstein",
  "nihalsarin",
  "gmnarayanan",
  "RebeccaHarris",
  "DanielNaroditsky",
  "GMHikaru",
  "AnishGiri",
  "penguingim1",
];

const TITLED_GAMES_PER_PLAYER = 5;
const TITLED_MAX_REQUESTS = 3;
const TITLED_MAX_PLAYERS_PER_CLICK = 2;
const TITLED_PLAYER_DISCOVERY_COUNT = 20;
const TITLED_PLAYER_DISCOVERY_PERF = "blitz";
const LUCKY_PLAYER_KEY = "prepforge.lucky_player";
// A stalled upstream is abandoned quickly so the UI can offer another click.
const TITLED_CLICK_DEADLINE_MS = 7000;
const TITLED_FETCH_TIMEOUT_MS = 4000;
const TITLES = new Set(["GM", "IM", "FM", "CM", "WGM", "WIM", "WFM", "WCM", "NM", "LM"]);

export function titledGamesUrl(username, max = TITLED_GAMES_PER_PLAYER) {
  const params = new URLSearchParams({
    max: String(Math.max(1, Math.min(5, Number(max) || TITLED_GAMES_PER_PLAYER))),
    moves: "true",
    clocks: "false",
    // PGN evals let the local gate reject already-decided moments.
    evals: "true",
    opening: "false",
    rated: "true",
    finished: "true",
    // Standard speed pools only: variants cannot replay from the start FEN.
    perfType: "blitz,rapid,classical",
  });
  return `https://lichess.org/api/games/user/${encodeURIComponent(String(username || "").trim())}?${params}`;
}

export function playerTopUrl(count = TITLED_PLAYER_DISCOVERY_COUNT, perfType = TITLED_PLAYER_DISCOVERY_PERF) {
  const safeCount = Math.max(1, Math.min(100, Number(count) || TITLED_PLAYER_DISCOVERY_COUNT));
  return `https://lichess.org/api/player/top/${safeCount}/${encodeURIComponent(String(perfType || TITLED_PLAYER_DISCOVERY_PERF))}`;
}

export function currentGameUrl(username) {
  const params = new URLSearchParams({ moves: "true", clocks: "false", evals: "true", opening: "false" });
  return `https://lichess.org/api/user/${encodeURIComponent(String(username || "").trim())}/current-game?${params}`;
}

async function lichessGet(url, accept, label, signal) {
  const resp = await fetch(url, {
    headers: { Accept: accept },
    signal: signal || AbortSignal.timeout(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw Object.assign(new Error(`${label} responded ${resp.status}`), { status: resp.status });
  return resp;
}

const defaultFetchTopPlayers = async (perfType, count, { signal } = {}) =>
  (await lichessGet(playerTopUrl(count, perfType), "application/json", "Player leaderboard", signal)).json();

const defaultFetchTitledPgn = async (username, max, { signal } = {}) =>
  (await lichessGet(titledGamesUrl(username, max), "application/x-chess-pgn", `Titled games for ${username}`, signal)).text();

const defaultFetchCurrentGamePgn = async (username, { signal } = {}) =>
  (await lichessGet(currentGameUrl(username), "application/x-chess-pgn", `Current game for ${username}`, signal)).text();

/** Split a multi-game PGN response into per-game blocks with headers. */
export function splitPgnBlocks(multiPgn) {
  const blocks = [];
  let current = [];
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of String(multiPgn || "").split("\n")) {
    if (line.startsWith("[Event ") && current.length) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function pgnHeader(block, tag) {
  return String(block || "").match(new RegExp(`^\\[${tag} "([^"]*)"\\]`, "m"))?.[1] ?? null;
}

function shuffled(list, rng) {
  const order = list.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(roll(rng) * (i + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Live titled-games round for Feeling Lucky: {fen, ply, phase, score, reason:
 * "titled-game", gameId, sans, white, black, sourceUrl, source, player} or
 * throws. Normal click: one leaderboard read and one recent-games feed. A
 * healthy but empty feed may spend the remaining budget on another player; a
 * feed transport error switches once to that player's current/last game.
 */
export async function luckyTitledStart({
  phase = null,
  storage = null,
  rng = Math.random,
  exclude = [],
  minPly = 8,
  players = TITLED_PLAYERS,
  gamesPerPlayer = TITLED_GAMES_PER_PLAYER,
  fetchPgn = defaultFetchTitledPgn,
  fetchCurrentGamePgn = defaultFetchCurrentGamePgn,
  fetchTopPlayers = defaultFetchTopPlayers,
  onStatus = null,
  acceptPosition = null,
  maxRequests = TITLED_MAX_REQUESTS,
  maxPlayersPerClick = TITLED_MAX_PLAYERS_PER_CLICK,
  clickDeadlineMs = TITLED_CLICK_DEADLINE_MS,
  allowCurrentGame = true,
  discoverPlayers = true,
  signal = null,
} = {}) {
  const targetPhase = phase || nextLuckyPhase({ storage, rng });
  const bannedGames = recentGameIdSet(storage);
  const budget = Math.max(1, Math.min(3, Number(maxRequests) || TITLED_MAX_REQUESTS));
  const deadlineAt = Date.now() + Math.max(1000, Math.min(15000, Number(clickDeadlineMs) || TITLED_CLICK_DEADLINE_MS));
  let requestCount = 0;
  let transportError = null;
  const request = async (status, fetcher) => {
    throwIfCancelled(signal);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw Object.assign(new Error("Lichess request budget exhausted — try again"), { status: 503 });
    requestCount += 1;
    try { onStatus?.(status); } catch { /* status is best-effort */ }
    const timeout = AbortSignal.timeout(Math.min(TITLED_FETCH_TIMEOUT_MS, remaining));
    const result = await fetcher({ signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    throwIfCancelled(signal);
    return result;
  };
  const failed = (error) => {
    if (error.balanceCheck) throw error;
    if (isCancellation(error) || signal?.aborted) throw cancellationError();
    if (isTransportError(error)) transportError = error;
  };
  const pick = (raw, fallbackId, sourceUrl) => pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
    storage, rng, exclude, minPly, bannedGames, fallbackId, sourceUrl, acceptPosition,
  });

  let names = [];
  if (discoverPlayers) {
    try {
      names = leaderboardPlayerNames(await request("Finding a fresh titled player on Lichess…",
        (options) => fetchTopPlayers(TITLED_PLAYER_DISCOVERY_PERF, TITLED_PLAYER_DISCOVERY_COUNT, options)));
    } catch (error) {
      failed(error);
    }
  }
  if (!names.length) names = (Array.isArray(players) ? players : []).map((n) => String(n || "").trim()).filter(Boolean);
  const order = shuffled(names, rng);
  const lastPlayer = storageGet(storage, LUCKY_PLAYER_KEY);
  if (order.length > 1 && lastPlayer && order[0] === lastPlayer) [order[0], order[1]] = [order[1], order[0]];

  let attemptedPlayer = order[0] || null;
  const playerBudget = Math.max(1, Math.min(budget, Number(maxPlayersPerClick) || TITLED_MAX_PLAYERS_PER_CLICK));
  const feedBudget = Math.max(1, Math.min(Math.max(1, budget - requestCount), playerBudget));
  for (const username of order.slice(0, feedBudget)) {
    if (requestCount >= budget) break;
    attemptedPlayer = username;
    storageSet(storage, LUCKY_PLAYER_KEY, username);
    let raw;
    try {
      raw = await request(`Fetching fresh games from ${username}…`, (options) => fetchPgn(username, gamesPerPlayer, options));
    } catch (error) {
      failed(error);
      // A transport error is not retried against another feed; only the
      // current-game path below may follow it. Empty/404 feeds move on.
      if (transportError) break;
      continue;
    }
    const picked = await pick(raw, username, titledGamesUrl(username, gamesPerPlayer));
    if (picked) return { ...picked, source: "lichess-user-feed", player: username };
  }

  // Degraded path, only after a feed transport error: the player's
  // current/last game is live data too and costs one request.
  if (transportError && allowCurrentGame && requestCount < budget && attemptedPlayer) {
    try {
      const raw = await request(`Trying ${attemptedPlayer}'s current game…`, (options) => fetchCurrentGamePgn(attemptedPlayer, options));
      const picked = await pick(raw, attemptedPlayer, currentGameUrl(attemptedPlayer));
      if (picked) return { ...picked, source: "lichess-current-game", player: attemptedPlayer };
    } catch (error) {
      failed(error);
    }
  }

  throwIfCancelled(signal);
  if (transportError) throw transportError;
  throw new Error("No sharp titled game found — try again");
}

function isTransportError(error) {
  const status = Number(error?.status);
  return status === 429 || status >= 500
    || /network|failed to fetch|timeout|offline|unavailable|rate limit/i.test(String(error?.message ?? error ?? ""));
}

function leaderboardPlayerNames(payload) {
  const seen = new Set();
  const out = [];
  for (const user of Array.isArray(payload?.users) ? payload.users : []) {
    const username = String(user?.username || user?.id || "").trim();
    if (!username || seen.has(username.toLowerCase())) continue;
    const title = String(user?.title || "").trim().toUpperCase();
    const rating = Number(user?.perfs?.blitz?.rating ?? user?.perfs?.rapid?.rating);
    // Titled or clearly high-rated only: an anonymous high-volume account's
    // games are a poor fit for a real-game training prompt.
    if (!TITLES.has(title) && (!Number.isFinite(rating) || rating < 2600)) continue;
    seen.add(username.toLowerCase());
    out.push(username);
  }
  return out;
}

export function pgnEvalCpByFen(block) {
  const game = new Chess(), evals = new Map();
  try { game.loadPgn(block); } catch { return evals; }
  for (const { fen, comment } of game.getComments()) {
    const raw = comment.match(/\[%eval\s+([^\]\s]+)\]/)?.[1];
    if (!raw) continue;
    const cp = raw.startsWith("#") ? Infinity : Number(raw) * 100;
    if (!Number.isNaN(cp)) evals.set(fen, cp);
  }
  return evals;
}

function gameIdFromBlock(block, fallbackId) {
  const explicit = pgnHeader(block, "GameId");
  if (explicit) return explicit;
  const site = pgnHeader(block, "Site");
  return String(site || "").match(/lichess\.org\/(?:[^/]+\/)?([A-Za-z0-9]{8})(?:\/|$)/i)?.[1] || site || fallbackId;
}

async function pickFromBlocks(blocks, targetPhase, { storage, rng, exclude, bannedGames, minPly, fallbackId, sourceUrl, acceptPosition }) {
  const candidates = [];
  const seenGames = new Set();
  for (const block of blocks) {
    // Variant and unfinished games cannot replay from the start FEN.
    const variant = pgnHeader(block, "Variant");
    if (variant && variant.toLowerCase() !== "standard") continue;
    if (pgnHeader(block, "Result") === "*") continue;
    const gameId = String(gameIdFromBlock(block, fallbackId) || "");
    if (!gameId || seenGames.has(gameId) || bannedGames.has(gameId)) continue;
    seenGames.add(gameId);
    const sans = sansFromPgn(block);
    if (sans.length < minPly) continue;
    const positions = verifyReplay(sans);
    if (!positions) continue;
    const evals = pgnEvalCpByFen(block);
    // Missing annotations require the final engine check; known bad evals never bypass the range.
    for (const candidate of scoreGamePositions(positions, sans.length < 24 ? { minPly: 2, maxPlyFromEnd: 1 } : {})) {
      const cp = evals.get(candidate.position.fen);
      if (cp !== undefined && Math.abs(cp) > LUCKY_MAX_ABS_CP) continue;
      candidates.push({ ...candidate, gameId, sans, white: pgnHeader(block, "White"), black: pgnHeader(block, "Black") });
    }
  }
  let candidate = null;
  while (candidates.length) {
    candidate = pickPhaseCandidate(candidates, targetPhase, { rng, exclude });
    if (!candidate) return null;
    if (!acceptPosition || await acceptPosition(candidate.position.fen)) break;
    const rejected = candidate.position.fen;
    for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].position.fen === rejected) candidates.splice(i, 1);
    candidate = null;
  }
  if (!candidate) return null;
  rememberLuckyPhase(candidate.phase, storage);
  bannedGames.add(candidate.gameId);
  rememberLuckyGame(candidate.gameId, storage);
  return {
    fen: candidate.position.fen,
    ply: candidate.position.ply,
    phase: candidate.phase,
    score: candidate.score,
    reason: "titled-game",
    gameId: candidate.gameId,
    sans: candidate.sans,
    white: candidate.white,
    black: candidate.black,
    sourceUrl,
  };
}
