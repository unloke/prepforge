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
import { balancedPracticeEval, createLuckyBalanceCheck } from "./train-lucky-balance.js";
import { cancellationError, isCancellation, throwIfCancelled } from "./cancellation.js";

export async function runFeelingLucky(options = {}) {
  const signal = options.signal || null;
  const balance = createLuckyBalanceCheck({ signal });
  let confirmedFen = null;
  const acceptPosition = async (fen) => {
    throwIfCancelled(signal);
    options.setBanner?.("runin", "Checking position…", "Stockfish · −1.5 to +1.5");
    let pv;
    try { pv = await (options.evaluatePosition || balance.evaluate)(fen); }
    catch (cause) {
      if (isCancellation(cause) || signal?.aborted) throw cancellationError();
      const error = new Error(cause?.message || String(cause)); error.balanceCheck = true; throw error;
    }
    throwIfCancelled(signal);
    const accepted = balancedPracticeEval(pv);
    confirmedFen = accepted ? fen : null;
    return accepted;
  };
  try {
    throwIfCancelled(signal);
    return await runFeelingLuckySelection({ ...options, acceptPosition,
      isConfirmed: (fen) => confirmedFen === fen });
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) return null;
    const message = error?.message || String(error);
    options.onStatus?.(message);
    options.setBanner?.("idle", "Could not verify position", "Retry — Stockfish must confirm an evaluation between −1.5 and +1.5.");
    return null;
  } finally {
    balance.close();
  }
}

async function runFeelingLuckySelection({
  luckyDbStartFn = luckyDbStart,
  luckyTitledStartFn = luckyTitledStart,
  // Reference feeds are an explicit emergency/test-only opt-in.
  allowReferences = false,
  ensureExplorer = null,
  storage = null,
  exclude = [],
  rating = 1500,
  onStatus = () => {},
  setBanner = () => {},
  startSession = async () => {},
  acceptPosition,
  isConfirmed,
  signal = null,
} = {}) {
  throwIfCancelled(signal);
  setBanner(
    "runin",
    "Finding a position…",
    "Discovering a fresh titled player on Lichess",
  );
  let dbError = null;
  let sessionFailed = null;
  const beginSession = async (picked) => {
    throwIfCancelled(signal);
    if (!isConfirmed(picked.fen) && !await acceptPosition(picked.fen)) {
      throwIfCancelled(signal);
      setBanner("idle", "No balanced position found", "Try again · evaluation must be between −1.5 and +1.5.");
      return false;
    }
    throwIfCancelled(signal);
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
      throwIfCancelled(signal);
      if (started === false) throw new Error("Could not start that position");
    } catch (error) {
      if (isCancellation(error) || signal?.aborted) throw cancellationError();
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
    throwIfCancelled(signal);
    if (!explorerPromise) {
      explorerPromise = (typeof ensureExplorer === "function"
        ? Promise.resolve().then(() => ensureExplorer())
        : Promise.reject(new Error("Lichess explorer is unavailable")));
    }
    const client = await explorerPromise;
    throwIfCancelled(signal);
    if (!client || typeof client.fetchStats !== "function") {
      throw new Error("Lichess explorer is unavailable");
    }
    const stats = await client.fetchStats(db, fen, opts);
    throwIfCancelled(signal);
    return stats;
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
      acceptPosition,
      signal,
    });


    // Fast production path: live leaderboard discovery followed by one
    // recent-games feed. A healthy click therefore uses two small requests;
    // no fixed game ID is consulted. `allowReferences` is retained only as
    // an explicit test/emergency opt-in for the reference seam.
    setBanner("runin", "Finding a position…", "Fetching fresh titled games from Lichess");
    try {
      throwIfCancelled(signal);
      const picked = await luckyTitledStartFn({
        storage,
        exclude,
        allowReferences: Boolean(allowReferences),
        acceptPosition,
        signal,
        onStatus: (msg) => setBanner("runin", "Finding a position…", msg),
      });
      throwIfCancelled(signal);
      if (picked) {
        if (await beginSession(picked)) return picked;
        return null;
      }
    } catch (error) {
      if (error.balanceCheck) throw error;
      if (isCancellation(error) || signal?.aborted) throw cancellationError();
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
        throwIfCancelled(signal);
        const picked = await runDb(lazyFetchStats);
        throwIfCancelled(signal);
        if (picked) {
          if (await beginSession(picked)) return picked;
          return null;
        }
      } catch (error) {
        if (error.balanceCheck) throw error;
        if (isCancellation(error) || signal?.aborted) throw cancellationError();
        dbError = error;
        const msg = (error && error.message) || String(error);
        if (isTransport(msg)) {
          onStatus(msg);
          setBanner("idle", "Database unavailable", "Try again — Lichess game export or Explorer is unavailable.");
          return null;
        }
      }
    }

  throwIfCancelled(signal);
  if (dbError) onStatus(dbError.message || String(dbError));
  else onStatus("No sharp database game found — try again.");
  setBanner(
    "idle",
    "No balanced position found",
    "Try again · −1.5 to +1.5 from fresh Lichess games.",
  );
  return null;
}
