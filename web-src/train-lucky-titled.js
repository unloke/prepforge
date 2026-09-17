// I'm Feeling Lucky — titled-games round.
//
// Fallback (and offline-proof companion) to the masters-explorer walk in
// train-lucky-db.js. The masters walk needs a linked Lichess token and one
// explorer read per ply; when it fails — unlinked token, 429 cooldown, dry
// continuation, empty topGames — this path serves the same product promise
// from a different upstream: the PUBLIC Lichess games API
// (GET /api/games/user/{titled}, Accept: application/x-chess-pgn).
//
// Why this upstream is reliable:
// - No auth of any kind (verified: anonymous 200, `access-control-allow-origin: *`).
// - One HTTP round trip returns full PGNs (no per-ply reads, no rate-limit
//   cooldown coupling to the explorer).
// - Titled blitz/rapid/classical games are real, high-quality, decisive
//   positions — the same scoring gate (train-lucky-crit.js) and phase
//   rotation apply, so training value is identical in kind.
// - Per-player failure is tolerated: one 404/dead account just moves to the
//   next name; only total failure throws.
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

// Verified reachable (anonymous PGN export, standard/blitz/rapid games).
// Order is reshuffled per click; dead names are skipped, never fatal.
// NOTE: bulk /api/games/user/* is per-IP throttled ("only run 1
// request(s) at a time"). CURATED_GAMES below is the primary source —
// single-game /game/export/{id} has no such throttle (verified: 4 rapid
// sequential exports all 200) — and the bulk names only refill the pool.
export const TITLED_PLAYERS = [
  "nihalsarin",
  "DrNykterstein",
  "gmnarayanan",
  "RebeccaHarris",
];

// Curated single-game ids (verified 200 via /game/export, standard games).
// Coverage: opening (Alekhine Exchange), middlegame tactics, endgame grind.
// These are the offline-proof core: one round trip each, no bulk throttle.
export const CURATED_GAMES = [
  { id: "kAdOQKeh", white: "respects_55", black: "DrNykterstein" },
  { id: "rrdtEiYG", white: "kim01", black: "NihalSarin" },
  { id: "xKWdG1d1", white: "DrNykterstein", black: "opponent" },
  { id: "SnXhGC57", white: "opponent", black: "DrNykterstein" },
];

export const TITLED_GAMES_PER_PLAYER = 2;
const TITLED_FETCH_TIMEOUT_MS = 12000;

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
    max: String(Math.max(1, Math.min(5, Number(max) || 2))),
    moves: "true",
    clocks: "false",
    evals: "false",
    opening: "false",
    rated: "true",
    // Standard chess only: variants (Atomic/Crazyhouse/960/from-position)
    // cannot replay from START_FEN, so they only burn hit-rate. Perf types
    // already scope to blitz/rapid/classical pools.
    variant: "standard",
    perfType: "blitz,rapid,classical",
  });
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

export async function defaultFetchTitledPgn(username, max = TITLED_GAMES_PER_PLAYER) {
  const resp = await fetch(titledGamesUrl(username, max), {
    headers: { Accept: "application/x-chess-pgn" },
    signal: timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
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

export async function defaultFetchSinglePgn(gameId) {
  const resp = await fetch(singleGameUrl(gameId), {
    headers: { Accept: "application/x-chess-pgn" },
    signal: timeoutSignal(TITLED_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const error = new Error(`Single game export responded ${resp.status} for ${gameId}`);
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
 * Titled-games round for Feeling Lucky.
 *
 * Mirrors luckyDbStart's contract: {fen, ply, phase, score, reason, gameId,
 * sans} or throws. `reason` is "titled-game" so the UI labels the source
 * honestly (never "Master game" for these).
 *
 * Transport note: lichess.org rate-limits /api/games/user/* per IP when
 * several requests run concurrently ("only run 1 request at a time", seen
 * live as 404-on-first-burst then 429). Retries are therefore SEQUENTIAL
 * with a short backoff between players — never parallel — and a 429 is
 * treated as "try the next player", exactly like a 404.
 */
export async function luckyTitledStart({
  phase = null,
  storage = null,
  rng = Math.random,
  exclude = [],
  minPly = 8,
  players = TITLED_PLAYERS,
  curatedGames = CURATED_GAMES,
  gamesPerPlayer = TITLED_GAMES_PER_PLAYER,
  fetchPgn = defaultFetchTitledPgn,
  fetchSinglePgn = defaultFetchSinglePgn,
  onStatus = null,
  retryDelayMs = 1200,
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
  // Shared dedup with the masters walk: both paths read/write the same
  // LUCKY_GAME_KEY list, so the fallback never re-serves a just-played game.
  const bannedGames = recentGameIdSet(storage);
  // Layer 1 — curated single games (unthrottled /game/export, verified 200).
  // Reshuffled per click; a dead id just moves to the next one.
  const curated = (Array.isArray(curatedGames) ? curatedGames : [])
    .map((g) => (g && g.id != null ? String(g.id) : ""))
    .filter(Boolean);
  const curatedOrder = curated.slice();
  for (let i = curatedOrder.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(roll(rng) * (i + 1)));
    [curatedOrder[i], curatedOrder[j]] = [curatedOrder[j], curatedOrder[i]];
  }
  say("Asking titled players' recent games…");
  for (const gameId of curatedOrder) {
    let raw = null;
    try {
      raw = await fetchSinglePgn(gameId);
    } catch (_) {
      continue;
    }
    const pick = pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
      storage,
      rng,
      exclude,
      minPly,
      bannedGames,
      fallbackId: gameId,
    });
    if (pick) return pick;
  }
  // Layer 2 — bulk per-player feeds (throttle-prone; best-effort refill).
  const names = (Array.isArray(players) ? players : [])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  if (!names.length && !curatedOrder.length) {
    throw new Error("No sharp titled game found — try again");
  }
  // Reshuffle per click so consecutive clicks don't trace the same player.
  // Fisher–Yates with the injected rng: deterministic under test seeds.
  const order = names.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(roll(rng) * (i + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  say("Asking titled players' recent games…");
  let rateLimited = false;
  for (const username of order) {
    let raw = null;
    try {
      raw = await fetchPgn(username, gamesPerPlayer);
    } catch (error) {
      // 429 (or the burst-shaped 404 seen live): back off, then continue to
      // the next player. Anything else (DNS, offline) skips immediately.
      if (error && (error.status === 429 || error.status === 404)) {
        rateLimited = true;
        if (retryDelayMs > 0) {
          say("Lichess asks for a short pause — trying the next player…");
          await sleep(retryDelayMs);
        }
      }
      continue;
    }
    const pick = pickFromBlocks(splitPgnBlocks(raw), targetPhase, {
      storage,
      rng,
      exclude,
      minPly,
      bannedGames,
      fallbackId: username,
    });
    if (pick) return pick;
  }
  // Distinguish "upstream throttled us" from "nothing sharp": the entry
  // routes throttling to Database unavailable (retry hint), not Nothing
  // sharp — conflating them is exactly the old masking bug.
  if (rateLimited) {
    const error = new Error("Lichess games rate limit - try again shortly");
    error.status = 429;
    throw error;
  }
  throw new Error("No sharp titled game found — try again");
}

function pickFromBlocks(blocks, targetPhase, { storage, rng, exclude, bannedGames = null, minPly: floor = 8, fallbackId = "" } = {}) {
  for (const block of blocks || []) {
    // Skip non-standard games up front: variant PGNs (Atomic, Crazyhouse,
    // Chess960, from-position) cannot replay from START_FEN.
    const variant = pgnHeader(block, "Variant");
    if (variant && variant.toLowerCase() !== "standard") continue;
    // Shared dedup: never re-serve a game either path just played. The
    // masters walk enforces this via freshFirst; mirror it here.
    const blockId = pgnHeader(block, "GameId") || pgnHeader(block, "Site") || fallbackId;
    if (bannedGames instanceof Set && blockId && bannedGames.has(String(blockId))) continue;
    const sans = sansFromPgn(block);
    if (sans.length < floor) continue;
    const positions = verifyReplay(sans);
    if (!positions) continue;
    const short = sans.length < 24;
    const scored = scoreGamePositions(positions, short ? { minPly: 2, maxPlyFromEnd: 1 } : {});
    if (!scored.length) continue;
    const candidate = pickPhaseCandidate(scored, targetPhase, { rng, exclude });
    if (!candidate) continue;
    const pos = candidate.position;
    rememberLuckyPhase(candidate.phase, storage);
    if (bannedGames instanceof Set) bannedGames.add(String(blockId));
    rememberLuckyGame(blockId, storage);
    return {
      fen: pos.fen,
      ply: pos.ply,
      phase: candidate.phase,
      score: candidate.score,
      reason: "titled-game",
      gameId: String(blockId),
      sans,
      white: pgnHeader(block, "White"),
      black: pgnHeader(block, "Black"),
    };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
