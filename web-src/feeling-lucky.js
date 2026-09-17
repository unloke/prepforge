// I'm Feeling Lucky — database-first entry with a titled-games fallback.
//
// Primary: the Lichess masters critical-position sampler
// (train-lucky-db.js). It needs a linked Lichess token and one explorer read
// per walked ply, so it can fail on 429 cooldowns, dry continuations, or
// empty topGames — all surfacing as "No sharp database game".
//
// Fallback: recent titled-player games from the PUBLIC Lichess games API
// (train-lucky-titled.js). No auth of any kind, one round trip per player,
// full PGNs — so the same scorer/phase gate still picks a critical, legal
// Play-ready position. The two paths share scoring, phase rotation, replay
// verification, and dedup; only the upstream differs.
// The personal flow (miss / departure / fork from the user's own games and
// trees) stays available as an independent capability in its own module for
// other callers — it is intentionally not referenced from this module.

import { luckyDbStart } from "./train-lucky-db.js";
import { luckyTitledStart } from "./train-lucky-titled.js";

export async function runFeelingLucky({
  luckyDbStartFn = luckyDbStart,
  luckyTitledStartFn = luckyTitledStart,
  ensureExplorer = null,
  storage = null,
  exclude = [],
  rating = 1500,
  onStatus = () => {},
  setBanner = () => {},
  startSession = async () => {},
} = {}) {
  setBanner("runin", "Asking the Lichess database…", "Finding a critical position");
  let dbError = null;
  let sessionFailed = null;
  const beginSession = async (picked) => {
    // startSession (Play-session paint) failures are product failures, not
    // sampler failures: never relabel them as "Database unavailable" /
    // "Nothing sharp". Surface the real message and stop.
    try {
      await startSession({
        fen: picked.fen,
        reason: picked.reason,
        phase: picked.phase,
        nodeId: picked.nodeId,
      });
    } catch (error) {
      sessionFailed = error;
      const msg = (error && error.message) || String(error);
      onStatus(msg);
      setBanner("idle", "Could not start that position", msg);
      return false;
    }
    return true;
  };
  try {
    let fetchStats = null;
    if (typeof ensureExplorer === "function") {
      const client = await ensureExplorer();
      fetchStats = (db, fen, opts) => client.fetchStats(db, fen, opts);
    }
    const picked = await luckyDbStartFn({
      storage,
      exclude,
      rating,
      fetchStats,
      engine: null,
      maia: null,
      onStatus: (msg) => setBanner("runin", "Asking the Lichess database…", msg),
    });
    if (picked) {
      if (await beginSession(picked)) return picked;
      return null;
    }
  } catch (error) {
    dbError = error;
    const msg = (error && error.message) || String(error);
    // Fall through to the titled path on: empty-result ("No sharp database
    // game"), the unlinked-token shape the proxy returns, AND explorer
    // transport throttling (ExplorerRateLimited: "rate limit hit - cooling
    // down", no .status). The curated /game/export layer is unthrottled, so
    // a transient masters throttle must not dead-end the click. Only
    // non-throttle transport failures (502, network, auth 401/403) abort
    // here — a titled fallback must not mask those behind a quiet success.
    if (!/no sharp database game|link your lichess|rate limit hit|cooling down|too many requests|429/i.test(msg)) {
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
  }
  // Masters walk came up empty (or the visitor has no linked token, which
  // surfaces as the same empty shape): try titled games before telling the
  // user there is nothing sharp. The titled path needs no token, so an
  // unlinked visitor still gets a Play session here.
  setBanner("runin", "Asking titled players' recent games…", "Finding a critical position");
  try {
    const picked = await luckyTitledStartFn({
      storage,
      exclude,
      onStatus: (msg) => setBanner("runin", "Asking titled players' recent games…", msg),
    });
    if (picked) {
      if (await beginSession(picked)) return picked;
      return null;
    }
  } catch (titledError) {
    // Titled-path failures: throttling AND offline/timeout are transport
    // failures, not empty results — surface Database unavailable (retry
    // hint), never Nothing sharp.
    const titledMsg = (titledError && titledError.message) || String(titledError);
    if (
      /rate limit|429|too many requests|responded 50|network|failed to fetch|load failed|timeout|timed out|timeouterror|aborterror|offline|enotfound|econn|dns/i.test(
        titledMsg,
      )
    ) {
      onStatus(titledMsg);
      setBanner(
        "idle",
        "Database unavailable",
        "Try again — Lichess is rate-limiting game downloads right now.",
      );
      return null;
    }
    // fall through to the unified empty-result below
  }
  if (dbError) onStatus(dbError.message || String(dbError));
  else onStatus("No sharp database game found — try again.");
  setBanner(
    "idle",
    "Nothing sharp this time",
    "Try again — Lucky draws a fresh master game each click.",
  );
  return null;
}
