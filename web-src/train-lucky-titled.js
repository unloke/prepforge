// I'm Feeling Lucky — live titled-game round.
//
// Production's fast path chooses a titled/high-rated player at click time,
// fetches that player's recent standard games from the public user-game
// export, then replays and scores every returned PGN locally. The Masters /
// Explorer walk in train-lucky-db.js remains an optional slow fallback; it
// needs a linked token and one Explorer read per walked ply.
//
// Why this upstream is reliable:
// - No auth of any kind (verified: anonymous 200, `access-control-allow-origin: *`).
// - One HTTP round trip returns several complete PGNs, so candidate discovery
//   is local rather than a position-by-position Explorer traversal.
// - Recent game IDs are deduplicated in storage, while the player list only
//   chooses a live feed; no position pool or maintained game-ID dataset is
//   used by production.
// - A transport failure can make one bounded current-game request; no retry
//   loop waits through the API's one-request-at-a-time rate limit.
//
// No DOM. The PGN fetch is injected so tests run offline on fixtures.

import {
  nextLuckyPhase,
  pickPhaseCandidate,
  recentGameIdSet,
  rememberLuckyGame,
  rememberLuckyPhase,
  sansFromPgn,
  scoreGamePositions,
  verifyReplay,
} from "./train-lucky-db.js";

// The leaderboard is the dynamic player directory; every click selects from
// its current titled/high-rating users before reading a recent-game feed.
// The static usernames below are only a fallback if that directory is down.
// Lichess asks clients to make one request at a time (and wait after 429), so
// the sampler never fans out or retries these feed requests concurrently.
export const TITLED_PLAYERS = [
  // A small username directory is not a candidate pool: each click asks
  // Lichess for the player's current recent games, and only returned game IDs
  // enter the local scorer. Keep several players for player/game diversity.
  "DrNykterstein",
  "nihalsarin",
  "gmnarayanan",
  "RebeccaHarris",
  "DanielNaroditsky",
  "GMHikaru",
  "AnishGiri",
  "penguingim1",
];

// Small emergency/test references only. Production never enables this layer:
// it is retained so offline fixtures and a manually requested verification can
// still exercise the single-game export without creating a maintained pool.
export const CURATED_GAMES = [
  { id: "kAdOQKeh", white: "respects_55", black: "DrNykterstein" },
  { id: "xKWdG1d1", white: "DrNykterstein", black: "opponent" },
  { id: "SnXhGC57", white: "opponent", black: "DrNykterstein" },
];

export const TITLED_GAMES_PER_PLAYER = 5;
export const TITLED_MAX_REQUESTS = 3;
export const TITLED_MAX_PLAYERS_PER_CLICK = 2;
export const TITLED_PLAYER_DISCOVERY_COUNT = 20;
export const TITLED_PLAYER_DISCOVERY_PERF = "blitz";
export const LUCKY_PLAYER_KEY = "prepforge.lucky_player";
// Keep a degraded click bounded as well as request-count bounded. Normal
// leaderboard + feed clicks complete well below this; a stalled upstream is
// abandoned quickly enough that the UI can offer another click instead of
// waiting through a long retry chain.
export const TITLED_CLICK_DEADLINE_MS = 7000;
const TITLED_FETCH_TIMEOUT_MS = 4000;

function storageGet(storage, key) {
  try {
    return storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
  } catch (_) {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (storage && typeof storage.setItem === "function") storage.setItem(key, String(value));
  } catch (_) {
    // best-effort
  }
}

function timeoutSignal(ms) {
  // AbortSignal.timeout is missing on older browsers — fall back to a
  // manual AbortController so those browsers degrade to "no timeout"
  // instead of failing every fetch synchronously.
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
  } catch (_) {
    // fall through to the controller below
  }
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    setTimeout(() => {
      try {
        controller.abort(new Error("timeout"));
      } catch (_) {
        try {
          controller.abort();
        } catch (_) {
          // ignore
        }
      }
    }, ms);
    return controller.signal;
  }
  return undefined;
}

function roll(rng) {
  const value = typeof rng === "function" ? rng() : Math.random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

export function titledGamesUrl(username, max = TITLED_GAMES_PER_PLAYER) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    max: String(Math.max(1, Math.min(5, Number(max) || TITLED_GAMES_PER_PLAYER))),
    moves: "true",
    clocks: "false",
    // PGN eval annotations let the local gate reject already-decided moments
    // while keeping the response to a small bounded set of full games.
    evals: "true",
    opening: "false",
    rated: "true",
    finished: "true",
    // These perf types are the standard chess speed pools. Variant perf types
    // (Atomic/Crazyhouse/960/from-position) are intentionally not requested;
    // they cannot replay from START_FEN and only burn the response budget.
    perfType: "blitz,rapid,classical",
  });
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

export function playerTopUrl(
  count = TITLED_PLAYER_DISCOVERY_COUNT,
  perfType = TITLED_PLAYER_DISCOVERY_PERF,
) {
  const safeCount = Math.max(1, Math.min(100, Number(count) || TITLED_PLAYER_DISCOVERY_COUNT));
  const safePerf = String(perfType || TITLED_PLAYER_DISCOVERY_PERF);
  return `https://lichess.org/api/player/top/${safeCount}/${encodeURIComponent(safePerf)}`;
}

export async function defaultFetchTopPlayers(
  perfType = TITLED_PLAYER_DISCOVERY_PERF,
  count = TITLED_PLAYER_DISCOVERY_COUNT,
  { signal } = {},
) {
  const resp = await fetch(playerTopUrl(count, perfType), {
    headers: { Accept: "application/json" },
    signal: signal || timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Player leaderboard responded ${resp.status}`);
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

export async function defaultFetchTitledPgn(username, max = TITLED_GAMES_PER_PLAYER, { signal } = {}) {
  const resp = await fetch(titledGamesUrl(username, max), {
    headers: { Accept: "application/x-chess-pgn" },
    signal: signal || timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Titled games responded ${resp.status} for ${username}`);
    error.status = resp.status;
    throw error;
  }
  return resp.text();
}

export function singleGameUrl(gameId) {
  return `https://lichess.org/game/export/${encodeURIComponent(String(gameId || ""))}`;
}

export function currentGameUrl(username) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    moves: "true",
    clocks: "false",
    evals: "true",
    opening: "false",
  });
  return `https://lichess.org/api/user/${safe}/current-game?${params}`;
}

export async function defaultFetchSinglePgn(gameId, { signal } = {}) {
  const resp = await fetch(`${singleGameUrl(gameId)}?evals=1&clocks=0`, {
    headers: { Accept: "application/x-chess-pgn" },
    signal: signal || timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Single game export responded ${resp.status} for ${gameId}`);
    error.status = resp.status;
    throw error;
  }
  return resp.text();
}

export async function defaultFetchCurrentGamePgn(username, { signal } = {}) {
  const resp = await fetch(currentGameUrl(username), {
    headers: { Accept: "application/x-chess-pgn" },
    signal: signal || timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Current game export responded ${resp.status} for ${username}`);
    error.status = resp.status;
    throw error;
  }
  return resp.text();
}

/** Split a multi-game PGN response into per-game blocks with headers. */
export function splitPgnBlocks(multiPgn) {
  const text = String(multiPgn || "");
  if (!text.trim()) return [];
  const blocks = [];
  let current = [];
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("[Event ") && current.length) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

export function pgnHeader(block, tag) {
  const m = String(block || "").match(new RegExp(`^\\[${tag} "([^"]*)"\\]`, "m"));
  return m ? m[1] : null;
}

/**
 * Live titled-games round for Feeling Lucky.
 *
 * Mirrors luckyDbStart's contract: {fen, ply, phase, score, reason, gameId,
 * sans} or throws. `reason` is "titled-game" so the UI can label the source
 * honestly; `source` distinguishes a live user feed from an emergency
 * reference export.
 *
 * Normal click budget: one recent-games feed request, with at most one more
 * request. A feed transport error switches immediately to the player's
 * current/last-game endpoint; a successful but low-quality feed may instead
 * try one different player's feed. There are no sequential sleeps or retry
 * storms: Lichess documents one request at a time and asks clients to wait a
 * full minute after a 429.
 */
export async function luckyTitledStart({
  phase = null,
  storage = null,
  rng = Math.random,
  exclude = [],
  minPly = 8,
  players = TITLED_PLAYERS,
  curatedGames = [],
  gamesPerPlayer = TITLED_GAMES_PER_PLAYER,
  fetchPgn = defaultFetchTitledPgn,
  fetchSinglePgn = defaultFetchSinglePgn,
  fetchCurrentGamePgn = defaultFetchCurrentGamePgn,
  fetchTopPlayers = defaultFetchTopPlayers,
  onStatus = null,
  maxRequests = TITLED_MAX_REQUESTS,
  maxPlayersPerClick = TITLED_MAX_PLAYERS_PER_CLICK,
  clickDeadlineMs = TITLED_CLICK_DEADLINE_MS,
  allowCurrentGame = true,
  discoverPlayers = true,
  discoveryCount = TITLED_PLAYER_DISCOVERY_COUNT,
  discoveryPerfType = TITLED_PLAYER_DISCOVERY_PERF,
  // Explicit test/emergency seam. Production leaves this false, so the
  // immutable references below can never become the source of normal clicks.
  allowReferences = false,
} = {}) {
  const say = (msg) => {
    if (typeof onStatus === "function") {
      try {
        onStatus(msg);
      } catch (_) {
        // ignore
      }
    }
  };
  const targetPhase = phase || nextLuckyPhase({ storage, rng });
  const bannedGames = recentGameIdSet(storage);
  const budget = Math.max(1, Math.min(3, Number(maxRequests) || TITLED_MAX_REQUESTS));
  const deadlineAt = Date.now() + Math.max(1000, Math.min(15000, Number(clickDeadlineMs) || TITLED_CLICK_DEADLINE_MS));
  const requestOptions = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return null;
    return { signal: timeoutSignal(Math.min(TITLED_FETCH_TIMEOUT_MS, remaining)) };
  };
  const exhausted = () => {
    const error = new Error("Lichess request budget exhausted — try again");
    error.status = 503;
    return error;
  };
  const fallbackPlayerBudget = Math.max(
    1,
    Math.min(budget, Number(maxPlayersPerClick) || TITLED_MAX_PLAYERS_PER_CLICK),
  );
  // Dynamic player selection is intentionally separate from game selection:
  // ask Lichess for a current leaderboard, then fetch that player's current
  // recent games. The static usernames are only a bounded fallback when the
  // leaderboard endpoint itself is unavailable.
  const fallbackNames = (Array.isArray(players) ? players : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  let requestCount = 0;
  let transportError = null;
  let discoveredNames = [];
  if (discoverPlayers && requestCount < budget) {
    try {
      const options = requestOptions();
      if (!options) throw exhausted();
      requestCount += 1;
      say("Finding a fresh titled player on Lichess…");
      const payload = await fetchTopPlayers(discoveryPerfType, discoveryCount, options);
      discoveredNames = leaderboardPlayerNames(payload);
    } catch (error) {
      if (isTransportError(error)) transportError = error;
    }
  }
  const names = discoveredNames.length ? discoveredNames : fallbackNames;
  const order = names.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(roll(rng) * (i + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lastPlayer = storageGet(storage, LUCKY_PLAYER_KEY);
  if (order.length > 1 && lastPlayer && order[0] === lastPlayer) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  let attemptedPlayer = order[0] || null;
  // A successful discovery leaves one normal game-feed request. If that feed
  // is healthy but empty/low quality, the remaining bounded request may try a
  // different live player; the normal successful path still stays at one feed.
  const feedBudget = Math.max(
    1,
    Math.min(
      Math.max(1, budget - requestCount),
      fallbackPlayerBudget,
    ),
  );
  for (const username of order.slice(0, feedBudget)) {
    if (requestCount >= budget) break;
    attemptedPlayer = username;
    storageSet(storage, LUCKY_PLAYER_KEY, username);
    let raw = null;
    try {
      const options = requestOptions();
      if (!options) throw exhausted();
      requestCount += 1;
      say(`Fetching fresh games from ${username}…`);
      raw = await fetchPgn(username, gamesPerPlayer, options);
    } catch (error) {
      if (isTransportError(error)) transportError = error;
      // A 429/5xx/network error is not retried against another user feed in
      // the same click. The bounded current-game path below is the only
      // immediate alternative; ordinary 404/empty feeds may move on.
      if (transportError) break;
      continue;
    }
    const pick = pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
      storage,
      rng,
      exclude,
      minPly,
      bannedGames,
      fallbackId: username,
      sourceUrl: titledGamesUrl(username, gamesPerPlayer),
      finishedOnly: true,
    });
    if (pick) return { ...pick, source: "lichess-user-feed", player: username };
  }

  // Fast degraded-path: current/last game is also live Lichess data and costs
  // one request. It is deliberately only used after a feed transport error;
  // a healthy feed gets the richer multi-game local selection instead.
  if (transportError && allowCurrentGame && requestCount < budget && attemptedPlayer) {
    try {
      const options = requestOptions();
      if (!options) throw exhausted();
      requestCount += 1;
      say(`Trying ${attemptedPlayer}'s current game…`);
      const raw = await fetchCurrentGamePgn(attemptedPlayer, options);
      const pick = pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
        storage,
        rng,
        exclude,
        minPly,
        bannedGames,
        fallbackId: attemptedPlayer,
        sourceUrl: currentGameUrl(attemptedPlayer),
        finishedOnly: true,
      });
      if (pick) return { ...pick, source: "lichess-current-game", player: attemptedPlayer };
    } catch (error) {
      if (isTransportError(error)) transportError = error;
    }
  }

  // Small reference layer, only for explicit tests/emergency verification.
  // It is intentionally after all dynamic paths and outside the production
  // default; no normal click can fall back into a maintained ID list.
  if (allowReferences) {
    const curated = (Array.isArray(curatedGames) ? curatedGames : [])
      .map((g) => (g && g.id != null ? String(g.id) : ""))
      .filter(Boolean);
    const curatedOrder = curated.slice();
    for (let i = curatedOrder.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(roll(rng) * (i + 1)));
      [curatedOrder[i], curatedOrder[j]] = [curatedOrder[j], curatedOrder[i]];
    }
    for (const gameId of curatedOrder.slice(0, 3)) {
      let raw = null;
      try {
        const options = requestOptions();
        if (!options) throw exhausted();
        raw = await fetchSinglePgn(gameId, options);
      } catch (error) {
        if (isTransportError(error)) transportError = error;
        continue;
      }
      const pick = pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
        storage,
        rng,
        exclude,
        minPly,
        bannedGames,
        fallbackId: gameId,
        sourceUrl: singleGameUrl(gameId),
        finishedOnly: true,
      });
      if (pick) return { ...pick, source: "lichess-reference", player: null };
    }
  }

  if (transportError) throw transportError;
  throw new Error("No sharp titled game found — try again");
}

function isTransportError(error) {
  const status = Number(error && error.status);
  return Boolean(
    status === 429 || status >= 500 || /network|failed to fetch|timeout|offline|unavailable|rate limit/i.test(
      String(error && error.message ? error.message : error || ""),
    ),
  );
}

function leaderboardPlayerNames(payload) {
  const users = Array.isArray(payload?.users) ? payload.users : [];
  const seen = new Set();
  const out = [];
  const titled = new Set(["GM", "IM", "FM", "CM", "WGM", "WIM", "WFM", "WCM", "NM", "LM"]);
  for (const user of users) {
    const username = String(user?.username || user?.id || "").trim();
    if (!username || seen.has(username.toLowerCase())) continue;
    const title = String(user?.title || "").trim().toUpperCase();
    const rating = Number(user?.perfs?.blitz?.rating ?? user?.perfs?.rapid?.rating);
    // The leaderboard is already strong, but filtering to titled or clearly
    // high-rated accounts avoids selecting an anonymous high-volume account
    // whose recent games are a poor fit for a real-game training prompt.
    if (!titled.has(title) && (!Number.isFinite(rating) || rating < 2600)) continue;
    seen.add(username.toLowerCase());
    out.push(username);
  }
  return out;
}

function pgnEvalCpByPly(block) {
  let body = String(block || "")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("["))
    .join(" ");
  let previous;
  do {
    previous = body;
    body = body.replace(/\([^()]*\)/g, " ");
  } while (body !== previous);
  return [...body.matchAll(/\[%eval\s+([^\]\s]+)\]/g)].map((match) => {
    const raw = String(match[1] || "");
    if (/^#-/.test(raw)) return -100000;
    if (/^#/.test(raw)) return 100000;
    const pawns = Number(raw);
    return Number.isFinite(pawns) ? Math.round(pawns * 100) : null;
  });
}

function gameIdFromBlock(block, fallbackId = "") {
  const explicit = pgnHeader(block, "GameId");
  if (explicit) return explicit;
  const site = pgnHeader(block, "Site");
  const match = String(site || "").match(/lichess\.org\/(?:[^/]+\/)?([A-Za-z0-9]{8})(?:\/|$)/i);
  return match ? match[1] : site || fallbackId;
}

function pickFromBlocks(
  blocks,
  targetPhase,
  {
    storage,
    rng,
    exclude,
    bannedGames = null,
    minPly: floor = 8,
    fallbackId = "",
    sourceUrl = null,
    finishedOnly = false,
  } = {},
) {
  const candidates = [];
  const seenGames = new Set();
  for (const block of blocks || []) {
    // Skip non-standard games up front: variant PGNs (Atomic, Crazyhouse,
    // Chess960, from-position) cannot replay from START_FEN.
    const variant = pgnHeader(block, "Variant");
    if (variant && variant.toLowerCase() !== "standard") continue;
    if (finishedOnly && pgnHeader(block, "Result") === "*") continue;
    // Shared dedup: never re-serve a game either path just played. The
    // masters walk enforces this via freshFirst; mirror it here.
    const blockId = gameIdFromBlock(block, fallbackId);
    if (!blockId || seenGames.has(String(blockId))) continue;
    seenGames.add(String(blockId));
    if (bannedGames instanceof Set && bannedGames.has(String(blockId))) continue;
    const sans = sansFromPgn(block);
    if (sans.length < floor) continue;
    const positions = verifyReplay(sans);
    if (!positions) continue;
    const short = sans.length < 24;
    const rawScored = scoreGamePositions(positions, short ? { minPly: 2, maxPlyFromEnd: 1 } : {});
    const evals = pgnEvalCpByPly(block);
    // Lichess annotated PGNs let us reject already-decided positions. Fixture
    // and bulk feeds without eval tags remain usable; the local critical score
    // is still the gate in that case.
    const evalScored = evals.length
      ? rawScored.filter((candidate) => {
          const cp = evals[candidate.position.ply - 1];
          return Number.isFinite(cp) && Math.abs(cp) <= 350;
        })
      : rawScored;
    // A partially annotated PGN should not become unusable merely because a
    // few candidate plies lack an eval comment. Use the eval gate when it
    // covers a meaningful slice; otherwise retain the local critical score.
    const scored = evalScored.length >= Math.max(3, Math.ceil(rawScored.length * 0.2))
      ? evalScored
      : rawScored;
    for (const candidate of scored) {
      candidates.push({
        ...candidate,
        gameId: String(blockId),
        sans,
        white: pgnHeader(block, "White"),
        black: pgnHeader(block, "Black"),
        sourceUrl: sourceUrl || singleGameUrl(blockId),
      });
    }
  }
  const candidate = pickPhaseCandidate(candidates, targetPhase, { rng, exclude });
  if (!candidate) return null;
  const pos = candidate.position;
  rememberLuckyPhase(candidate.phase, storage);
  if (bannedGames instanceof Set) bannedGames.add(String(candidate.gameId));
  rememberLuckyGame(candidate.gameId, storage);
  return {
    fen: pos.fen,
    ply: pos.ply,
    phase: candidate.phase,
    score: candidate.score,
    reason: "titled-game",
    gameId: candidate.gameId,
    sans: candidate.sans,
    white: candidate.white,
    black: candidate.black,
    sourceUrl: candidate.sourceUrl,
  };
}
