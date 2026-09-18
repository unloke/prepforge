// I'm Feeling Lucky — live Lichess game entry.
//
// Production asks Lichess for a fresh titled/high-rated player, fetches a
// small recent-game PGN feed on demand, and performs replay, phase selection,
// critical scoring and dedup locally. No position pool or maintained game-ID
// dataset is bundled. The slower Masters walk remains an explicit quality
// fallback when live game feeds are empty, and is never prefetched.
// The personal flow (miss / departure / fork from the user's own games and
// trees) stays available as an independent capability in its own module for
// other callers — it is intentionally not referenced from this module.

import { luckyDbStart } from "./train-lucky-db.js";
import { luckyTitledStart } from "./train-lucky-titled.js";

export async function runFeelingLucky({
  luckyDbStartFn = luckyDbStart,
  luckyTitledStartFn = luckyTitledStart,
  // Dynamic Lichess game feeds are the production path. Setting this false
  // keeps the old Masters-first seam available for focused sampler tests;
  // `allowReferences` is an explicit emergency/test-only opt-in.
  preferDynamic = true,
  allowReferences = false,
  ensureExplorer = null,
  storage = null,
  exclude = [],
  rating = 1500,
  onStatus = () => {},
  setBanner = () => {},
  startSession = async () => {},
} = {}) {
  setBanner(
    "runin",
    "Finding a position…",
    preferDynamic
      ? "Discovering a fresh titled player on Lichess"
      : "Following the Lichess masters database",
  );
  let dbError = null;
  let sessionFailed = null;
  const beginSession = async (picked) => {
    // startSession (Play-session paint) failures are product failures, not
    // sampler failures: never relabel them as "Database unavailable" /
    // "Nothing sharp". Surface the real message and stop.
    try {
      const started = await startSession({
        fen: picked.fen,
        reason: picked.reason,
        phase: picked.phase,
        nodeId: picked.nodeId,
        gameId: picked.gameId,
        white: picked.white,
        black: picked.black,
        source: picked.source,
        sourceUrl: picked.sourceUrl,
      });
      if (started === false) throw new Error("Could not start that position");
    } catch (error) {
      sessionFailed = error;
      const msg = (error && error.message) || String(error);
      onStatus(msg);
      setBanner("idle", "Could not start that position", msg);
      return false;
    }
    return true;
  };
  const isNoQuality = (message) => /no sharp (?:database|titled) game|try again/i.test(String(message || ""));
  const isTransport = (message) =>
    /rate limit|429|too many requests|responded 4\d\d|responded 5\d\d|network|failed to fetch|load failed|timeout|timed out|timeouterror|aborterror|offline|enotfound|econn|dns|unavailable|link your lichess/i.test(
      String(message || ""),
    );

  // Explorer is deliberately lazy. A successful live feed never opens the
  // Explorer client, so the normal click stays at discovery + one feed read.
  let explorerPromise = null;
  const lazyFetchStats = async (db, fen, opts) => {
    if (!explorerPromise) {
      explorerPromise = (typeof ensureExplorer === "function"
        ? Promise.resolve().then(() => ensureExplorer())
        : Promise.reject(new Error("Lichess explorer is unavailable")));
    }
    const client = await explorerPromise;
    if (!client || typeof client.fetchStats !== "function") {
      throw new Error("Lichess explorer is unavailable");
    }
    return client.fetchStats(db, fen, opts);
  };

  const runDb = async (fetchStats) =>
    luckyDbStartFn({
      storage,
      exclude,
      rating,
      fetchStats,
      engine: null,
      maia: null,
      onStatus: (msg) => setBanner("runin", "Finding a position…", msg),
    });

  if (preferDynamic) {
    // Fast production path: live leaderboard discovery followed by one
    // recent-games feed. A healthy click therefore uses two small requests;
    // no fixed game ID is consulted. `allowReferences` is retained only as
    // an explicit test/emergency opt-in for the reference seam.
    setBanner("runin", "Finding a position…", "Fetching fresh titled games from Lichess");
    try {
      const picked = await luckyTitledStartFn({
        storage,
        exclude,
        allowReferences: Boolean(allowReferences),
        onStatus: (msg) => setBanner("runin", "Finding a position…", msg),
      });
      if (picked) {
        if (await beginSession(picked)) return picked;
        return null;
      }
    } catch (error) {
      const msg = (error && error.message) || String(error);
      if (!isNoQuality(msg) || isTransport(msg)) {
        onStatus(msg);
        setBanner("idle", "Database unavailable", "Try again — Lichess game export is unavailable or rate-limited.");
        return null;
      }
      dbError = error;
    }

    // If live feeds are empty, retain the Masters sampler as an explicit
    // quality fallback when an Explorer provider is available. It is lazy and
    // therefore never adds serial Explorer latency to a successful feed click.
    if (typeof ensureExplorer === "function") {
      try {
        const picked = await runDb(lazyFetchStats);
        if (picked) {
          if (await beginSession(picked)) return picked;
          return null;
        }
      } catch (error) {
        dbError = error;
        const msg = (error && error.message) || String(error);
        if (isTransport(msg)) {
          onStatus(msg);
          setBanner("idle", "Database unavailable", "Try again — Lichess game export or Explorer is unavailable.");
          return null;
        }
      }
    }
  } else {
    // Back-compat/investigation seam: callers that explicitly opt out of the
    // live path keep the previous Masters-first ordering.
    let fetchStats = null;
    try {
      if (typeof ensureExplorer === "function") {
        const client = await ensureExplorer();
        fetchStats = (db, fen, opts) => client.fetchStats(db, fen, opts);
      }
      const picked = await runDb(fetchStats);
      if (picked) {
        if (await beginSession(picked)) return picked;
        return null;
      }
    } catch (error) {
      dbError = error;
      const msg = (error && error.message) || String(error);
      if (!isNoQuality(msg) && !/link your lichess|cooling down/i.test(msg)) {
        onStatus(msg);
        setBanner("idle", "Database unavailable", "Try again — the masters database may be rate-limited right now.");
        return null;
      }
    }
    try {
      const picked = await luckyTitledStartFn({
        storage,
        exclude,
        onStatus: (msg) => setBanner("runin", "Finding a position…", msg),
      });
      if (picked) {
        if (await beginSession(picked)) return picked;
        return null;
      }
    } catch (error) {
      const msg = (error && error.message) || String(error);
      if (isTransport(msg)) {
        onStatus(msg);
        setBanner("idle", "Database unavailable", "Try again — Lichess game export is unavailable or rate-limited.");
        return null;
      }
    }
  }
  if (dbError) onStatus(dbError.message || String(dbError));
  else onStatus("No sharp database game found — try again.");
  setBanner(
    "idle",
    "Nothing sharp this time",
    preferDynamic
      ? "Try again — Lucky queries fresh Lichess games on each click."
      : "Try again — Lucky draws a fresh master game each click.",
  );
  return null;
}
