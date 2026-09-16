// I'm Feeling Lucky — database-only entry.
// Every click goes straight to the Lichess database/master-game
// critical-position sampler (train-lucky-db.js). No personal
// workspace lookup happens here on purpose.
// The personal flow (miss / departure / fork from the user's own games and
// trees) stays available as an independent capability in its own module for
// other callers — it is intentionally not referenced from this module.

import { luckyDbStart } from "./train-lucky-db.js";

export async function runFeelingLucky({
  luckyDbStartFn = luckyDbStart,
  ensureExplorer = null,
  storage = null,
  exclude = [],
  rating = 1500,
  onStatus = () => {},
  setBanner = () => {},
  startSession = async () => {},
} = {}) {
  setBanner("runin", "Asking the Lichess database…", "Finding a critical position");
  let picked = null;
  try {
    let fetchStats = null;
    if (typeof ensureExplorer === "function") {
      const client = await ensureExplorer();
      fetchStats = (db, fen, opts) => client.fetchStats(db, fen, opts);
    }
    picked = await luckyDbStartFn({
      storage,
      exclude,
      rating,
      fetchStats,
      engine: null,
      maia: null,
      onStatus: (msg) => setBanner("runin", "Asking the Lichess database…", msg),
    });
  } catch (error) {
    const msg = (error && error.message) || String(error);
    onStatus(msg);
    setBanner(
      "idle",
      "Database unavailable",
      /link your lichess/i.test(msg)
        ? "Connect Lichess (top-right chip) so Lucky can read the masters database."
        : "Try again — the masters database may be rate-limited right now.",
    );
    return null;
  }
  if (!picked) {
    onStatus("No sharp database game found — try again.");
    setBanner(
      "idle",
      "Nothing sharp this time",
      "Try again — Lucky draws a fresh master game each click.",
    );
    return null;
  }
  await startSession({
    fen: picked.fen,
    reason: picked.reason,
    phase: picked.phase,
    nodeId: picked.nodeId,
  });
  return picked;
}
