// I'm Feeling Lucky — live Lichess game entry.
//
// Production asks Lichess for a fresh titled/high-rated player, fetches a
// small recent-game PGN feed on demand, and performs replay, phase selection,
// critical scoring and dedup locally. The slower Masters walk is a lazy
// quality fallback when live feeds are empty, and is never prefetched. Every
// pick must pass a Stockfish balance check before practice starts.

import { luckyDbStart } from "./train-lucky-db.js";
import { luckyTitledStart } from "./train-lucky-titled.js";
import { balancedPracticeEval, createLuckyBalanceCheck } from "./train-lucky-balance.js";
import { cancellationError, isCancellation, throwIfCancelled } from "./cancellation.js";

const FINDING = "Finding a position…";
const TRANSPORT = /rate limit|429|too many requests|responded 4\d\d|responded 5\d\d|network|failed to fetch|load failed|timeout|timed out|timeouterror|aborterror|offline|enotfound|econn|dns|unavailable|link your lichess/i;
const NO_QUALITY = /no sharp (?:database|titled) game|try again/i;
const messageOf = (error) => error?.message || String(error);

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
      throw Object.assign(new Error(messageOf(cause)), { balanceCheck: true });
    }
    throwIfCancelled(signal);
    const accepted = balancedPracticeEval(pv);
    confirmedFen = accepted ? fen : null;
    return accepted;
  };
  try {
    throwIfCancelled(signal);
    return await runFeelingLuckySelection({ ...options, acceptPosition, isConfirmed: (fen) => confirmedFen === fen });
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) return null;
    options.onStatus?.(messageOf(error));
    options.setBanner?.("idle", "Could not verify position", "Retry — Stockfish must confirm an evaluation between −1.5 and +1.5.");
    return null;
  } finally {
    balance.close();
  }
}

async function runFeelingLuckySelection({
  luckyDbStartFn = luckyDbStart,
  luckyTitledStartFn = luckyTitledStart,
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
  setBanner("runin", FINDING, "Discovering a fresh titled player on Lichess");
  const progress = (msg) => setBanner("runin", FINDING, msg);
  const unavailable = (error, sub) => {
    onStatus(messageOf(error));
    setBanner("idle", "Database unavailable", sub);
    return null;
  };
  // A sampler error: balance-check failures and cancellation propagate.
  const rethrow = (error) => {
    if (error.balanceCheck) throw error;
    if (isCancellation(error) || signal?.aborted) throw cancellationError();
  };
  const beginSession = async (picked) => {
    throwIfCancelled(signal);
    if (!isConfirmed(picked.fen) && !await acceptPosition(picked.fen)) {
      throwIfCancelled(signal);
      setBanner("idle", "No balanced position found", "Try again · evaluation must be between −1.5 and +1.5.");
      return null;
    }
    throwIfCancelled(signal);
    // Play-session start failures are product failures, not sampler failures:
    // surface the real message rather than "Database unavailable".
    try {
      const { fen, reason, phase, gameId, white, black, sourceUrl } = picked;
      const started = await startSession({ fen, reason, phase, gameId, white, black, sourceUrl });
      throwIfCancelled(signal);
      if (started === false) throw new Error("Could not start that position");
    } catch (error) {
      if (isCancellation(error) || signal?.aborted) throw cancellationError();
      onStatus(messageOf(error));
      setBanner("idle", "Could not start that position", messageOf(error));
      return null;
    }
    return picked;
  };

  // Fast path: live leaderboard discovery followed by one recent-games feed.
  let dbError = null;
  setBanner("runin", FINDING, "Fetching fresh titled games from Lichess");
  try {
    throwIfCancelled(signal);
    const picked = await luckyTitledStartFn({ storage, exclude, acceptPosition, signal, onStatus: progress });
    throwIfCancelled(signal);
    if (picked) return beginSession(picked);
  } catch (error) {
    rethrow(error);
    const msg = messageOf(error);
    if (!NO_QUALITY.test(msg) || TRANSPORT.test(msg)) {
      return unavailable(error, "Try again — Lichess game export is unavailable or rate-limited.");
    }
    dbError = error;
  }

  // Masters fallback when live feeds are empty. The Explorer client opens
  // lazily, so a successful feed click never pays for it.
  if (typeof ensureExplorer === "function") {
    let explorer = null;
    const fetchStats = async (db, fen, opts) => {
      throwIfCancelled(signal);
      explorer ||= Promise.resolve().then(() => ensureExplorer());
      const client = await explorer;
      throwIfCancelled(signal);
      if (typeof client?.fetchStats !== "function") throw new Error("Lichess explorer is unavailable");
      const stats = await client.fetchStats(db, fen, opts);
      throwIfCancelled(signal);
      return stats;
    };
    try {
      throwIfCancelled(signal);
      const picked = await luckyDbStartFn({ storage, exclude, rating, fetchStats, onStatus: progress, acceptPosition });
      throwIfCancelled(signal);
      if (picked) return beginSession(picked);
    } catch (error) {
      rethrow(error);
      dbError = error;
      if (TRANSPORT.test(messageOf(error))) {
        return unavailable(error, "Try again — Lichess game export or Explorer is unavailable.");
      }
    }
  }

  throwIfCancelled(signal);
  onStatus(dbError ? messageOf(dbError) : "No sharp database game found — try again.");
  setBanner("idle", "No balanced position found", "Try again · −1.5 to +1.5 from fresh Lichess games.");
  return null;
}
