// Lichess opening-explorer client: tiny, cached, rate-limit-respectful.
//
// explorer.lichess.ovh dropped anonymous access in early 2026, so the requests go
// through PrepForge's thin authenticated proxy (/api/lichess/explorer/{db}), which
// attaches the user's linked-account token server-side and memoises responses
// across users. Keeping THIS side polite still matters — every avoided request is
// upstream traffic the proxy never has to make:
//
//  - cache first: responses are kept in storage for days (the masters DB barely
//    moves), so revisiting a node costs zero requests;
//  - one request in flight per client, later calls for the same key share it;
//  - a 429 (passed through from Lichess) opens a cooldown window during which every
//    fetch fails fast with ExplorerRateLimited instead of hammering the API.
//
// Deps are injected (fetch, storage, clock) so all of it is unit-testable without
// a network or a DOM, matching the csrf.js / engine modules' style.

export const EXPLORER_BASE = "/api/lichess/explorer";

const CACHE_KEY = "prepforge.explorer.cache.v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week: opening stats are slow-moving
const CACHE_CAP = 150; // ~a long Build session of distinct positions
const COOLDOWN_MS = 60 * 1000;

// The player-pool endpoint wants rating buckets, not a number. Map a rating to its
// bucket and one neighbour so the pool is "people about as strong as you".
const RATING_BUCKETS = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

export function ratingBucketsFor(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return [1600, 1800];
  let nearest = RATING_BUCKETS[0];
  for (const bucket of RATING_BUCKETS) {
    if (Math.abs(bucket - r) < Math.abs(nearest - r)) nearest = bucket;
  }
  const idx = RATING_BUCKETS.indexOf(nearest);
  const neighbour =
    r >= nearest
      ? RATING_BUCKETS[Math.min(idx + 1, RATING_BUCKETS.length - 1)]
      : RATING_BUCKETS[Math.max(idx - 1, 0)];
  return neighbour === nearest ? [nearest] : [nearest, neighbour].sort((a, b) => a - b);
}

export class ExplorerRateLimited extends Error {
  constructor(retryInMs) {
    super("Lichess explorer rate limit hit - cooling down");
    this.name = "ExplorerRateLimited";
    this.retryInMs = retryInMs;
  }
}

// Only fen + ratings travel; the proxy pins every other upstream parameter.
export function explorerUrl(db, fen, { rating } = {}) {
  const params = new URLSearchParams();
  params.set("fen", fen);
  if (db === "lichess") {
    params.set("ratings", ratingBucketsFor(rating).join(","));
  }
  return `${EXPLORER_BASE}/${db === "lichess" ? "lichess" : "masters"}?${params}`;
}

// Normalize a raw explorer payload into what the panel renders. Percentages are
// of decided+drawn games for THAT move row.
export function normalizeExplorer(raw) {
  const totalAll =
    (Number(raw.white) || 0) + (Number(raw.draws) || 0) + (Number(raw.black) || 0);
  const moves = (raw.moves || []).map((m) => {
    const white = Number(m.white) || 0;
    const draws = Number(m.draws) || 0;
    const black = Number(m.black) || 0;
    const total = white + draws + black;
    const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return {
      uci: m.uci,
      san: m.san,
      total,
      share: totalAll > 0 ? total / totalAll : 0,
      whitePct: pct(white),
      drawPct: pct(draws),
      blackPct: pct(black),
    };
  });
  return {
    totalGames: totalAll,
    opening: raw.opening ? `${raw.opening.eco} ${raw.opening.name}` : null,
    moves,
  };
}

export function formatGames(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function createExplorerClient({ fetchImpl, storage, now } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const clock = now || (() => Date.now());
  const store =
    storage ||
    (typeof localStorage === "undefined"
      ? { getItem: () => null, setItem: () => {} }
      : localStorage);

  let cooldownUntil = 0;
  const inflight = new Map();

  function readCache() {
    try {
      const parsed = JSON.parse(store.getItem(CACHE_KEY) || "null");
      return parsed && typeof parsed === "object" && parsed.entries ? parsed : { entries: {} };
    } catch (_) {
      return { entries: {} };
    }
  }

  function writeCache(cache) {
    const keys = Object.keys(cache.entries);
    if (keys.length > CACHE_CAP) {
      keys
        .sort((a, b) => cache.entries[a].at - cache.entries[b].at)
        .slice(0, keys.length - CACHE_CAP)
        .forEach((k) => delete cache.entries[k]);
    }
    try {
      store.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (_) {
      /* storage full — caching is best-effort */
    }
  }

  // fetchStats(db, fen, {rating}) → normalized stats (see normalizeExplorer).
  async function fetchStats(db, fen, { rating } = {}) {
    const url = explorerUrl(db, fen, { rating });
    const cache = readCache();
    const hit = cache.entries[url];
    if (hit && clock() - hit.at < CACHE_TTL_MS) return hit.data;

    const wait = cooldownUntil - clock();
    if (wait > 0) throw new ExplorerRateLimited(wait);

    if (inflight.has(url)) return inflight.get(url);
    const request = (async () => {
      const resp = await doFetch(url, { credentials: "same-origin" });
      if (resp.status === 429) {
        cooldownUntil = clock() + COOLDOWN_MS;
        throw new ExplorerRateLimited(COOLDOWN_MS);
      }
      if (resp.status === 400) {
        throw new Error("link your Lichess account to use the opening explorer");
      }
      if (!resp.ok) throw new Error(`Explorer responded ${resp.status}`);
      const data = normalizeExplorer(await resp.json());
      const fresh = readCache();
      fresh.entries[url] = { at: clock(), data };
      writeCache(fresh);
      return data;
    })().finally(() => inflight.delete(url));
    inflight.set(url, request);
    return request;
  }

  return { fetchStats };
}
