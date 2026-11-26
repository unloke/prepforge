import { PREFILTER_IDLE } from "../scout-prefilter.js";
import { compactScoutGame, restoreScoutGame, scoutHistoryKey } from "../scout-history.js";
import { scoutLabel } from "./scout-sources.js";

// The report state and the fetch session one Start creates, and how a saved run
// (scout-history.js) goes into them and comes back out.

export function createScoutState({ usernames, color, lookups, carry }) {
  return {
    usernames: usernames.slice(),
    username: scoutLabel(usernames),
    color,
    games: [],
    profile: { total: 0, speedCounts: {}, recentlyChanged: { white: false, black: false } },
    lookups,
    activeSpeed: carry.activeSpeed,
    engineByColor: carry.engineByColor,
    engineAggByColor: {},
    explorerByColor: carry.explorerByColor,
    sections: {},
    ecoCache: carry.ecoCache,
    maiaResults: carry.maiaResults,
    maiaCache: carry.maiaCache,
    maiaEnrichState: carry.maiaEnrichState,
    prefilterEnrichState: PREFILTER_IDLE,
    prefilterScopeKey: null,
    prefilterPools: { white: [], black: [] },
    prefilterRanked: { white: [], black: [] },
    prefilteredLines: { white: [], black: [] },
    stockfishDisplayLines: { white: [], black: [] },
    prefilterCache: carry.prefilterCache,
    maiaAttemptsUsed: 0,
    // Persistent per-colour opening tries, grown one game at a time as the stream
    // arrives (see insertIntoLiveTries) instead of rebuilt from every game each batch.
    // Anchored to session start (later than any past game) so incremental insertion
    // matches a one-shot build on every displayed stat — see insertGameIntoTrie.
    liveTries: null,
    liveTrieAnchor: Date.now(),
    liveTrieSpeed: null,
    liveTrieCount: 0,
  };
}

export function createScoutSession({ usernames, color }) {
  return {
    usernames: usernames.slice(),
    username: scoutLabel(usernames),
    color,
    controller: null,
    state: "idle",
    seenIds: new Set(),
    // R-05: per-source cursor, progress and outcome (see scout-sources.js), so
    // a partial fetch is visible and each source pages and retries on its own.
    oldestDatestampByUser: {},
    sourceProgress: {},
    acceptedByUser: {},
    sourceStatus: {},
    // A restored run: its sources still to fetch the games played since it was
    // saved (newestDatestampByUser), and the games that came from the save.
    refreshPending: new Set(),
    newestDatestampByUser: {},
    restoredIds: new Set(),
    gamesSinceRender: 0,
    userStopped: false,
    acceptedThisBatch: 0,
  };
}

/** What the history keeps of a finished or paused run. */
export function scoutRunSnapshot(state, session) {
  const sources = {};
  for (const user of session.usernames) {
    let newest = null;
    for (const game of state.games) {
      if (game.scoutUsername === user && game.datestamp > 0 && (newest == null || game.datestamp > newest)) newest = game.datestamp;
    }
    const progress = session.sourceProgress?.[user] || {};
    sources[user] = {
      oldest: session.oldestDatestampByUser[user] ?? null,
      // A refresh that has not finished leaves the saved newest in place.
      newest: session.refreshPending.has(user) ? session.newestDatestampByUser[user] ?? newest : newest,
      exhausted: Boolean(progress.exhausted),
      full: Boolean(progress.full),
    };
  }
  return {
    key: scoutHistoryKey(session.usernames, session.color),
    usernames: session.usernames.slice(),
    label: state.username,
    color: session.color,
    savedAt: Date.now(),
    gameCount: state.games.length,
    games: state.games.map(compactScoutGame),
    sources,
  };
}

/**
 * Puts a saved run into a fresh state and session: its games, counts and
 * per-source cursors. Every source with games is then refreshed: the next stream
 * asks it only for the games after its newest saved one.
 */
export function restoreScoutRun(state, session, run) {
  if (!run?.games?.length) return false;
  // The same accounts typed in another case are the same entry (scoutHistoryKey):
  // the saved games and cursors go to the names this session streams under.
  const current = new Map(session.usernames.map((user) => [user.toLowerCase(), user]));
  const savedSources = new Map(Object.entries(run.sources || {}).map(([user, saved]) => [user.toLowerCase(), saved]));
  for (const record of run.games) {
    const game = restoreScoutGame(record);
    const user = current.get(String(game.scoutUsername || "").toLowerCase());
    if (user) Object.assign(game, { scoutUsername: user, sourceAccount: user });
    if (game.gameId) {
      if (session.seenIds.has(game.gameId)) continue;
      session.seenIds.add(game.gameId);
      session.restoredIds.add(game.gameId);
    }
    state.games.push(game);
    if (game.scoutUsername) session.acceptedByUser[game.scoutUsername] = (session.acceptedByUser[game.scoutUsername] || 0) + 1;
  }
  for (const user of session.usernames) {
    const saved = savedSources.get(user.toLowerCase());
    const accepted = session.acceptedByUser[user] || 0;
    // No saved games from this source: it starts as in a fresh run, from its newest
    // game, so games played since the save are not missed.
    if (saved?.newest == null && !accepted) continue;
    if (saved?.oldest != null) session.oldestDatestampByUser[user] = saved.oldest;
    session.sourceProgress[user] = saved?.exhausted
      ? { full: false, stopped: false, exhausted: true }
      // Not read to its end when saved: older games are left (or unknown).
      : { full: Boolean(saved?.full), stopped: !saved?.full, exhausted: false };
    session.sourceStatus[user] = { status: accepted ? "ok" : "empty", accepted };
    if (saved?.newest != null) {
      session.newestDatestampByUser[user] = saved.newest;
      session.refreshPending.add(user);
    }
  }
  return true;
}

/**
 * A game the stream sent again. During a refresh, the saved newest game (or an
 * older saved one) means the refresh reached the saved games: the new games join
 * them with no gap between. A saved game newer than that came from a refresh that
 * was stopped, and the games between it and the saved newest may still be unread:
 * it now counts as one of this refresh's games, so a gap does not drop it.
 */
export function noteRepeatedGame(session, game) {
  const user = game.scoutUsername;
  if (!game.gameId || !user || !session.refreshPending?.has(user) || !session.restoredIds?.has(game.gameId)) return;
  const boundary = session.newestDatestampByUser?.[user];
  if (boundary != null && game.datestamp <= boundary) (session.refreshReached ||= new Set()).add(user);
  else session.restoredIds.delete(game.gameId);
}

/**
 * After a stream: a source whose refresh came back full has more new games than
 * one batch, so its saved games sit behind a gap. They leave the report, and that
 * source pages on from the new games like a fresh run. Newer games go first, as
 * in a fresh stream (the profile's "recent games" read the front of the list).
 * Returns true when the game list changed.
 */
export function settleRefresh(state, session) {
  const gapped = session.refreshGapped || [];
  session.refreshGapped = [];
  if (!session.refreshedThisStream) return false;
  session.refreshedThisStream = false;
  if (!gapped.length && !session.acceptedThisBatch) return false;
  let games = state.games;
  if (gapped.length) {
    const drop = new Set(gapped);
    games = games.filter((game) => {
      if (!drop.has(game.scoutUsername) || !session.restoredIds.has(game.gameId)) return true;
      session.seenIds.delete(game.gameId);
      session.restoredIds.delete(game.gameId);
      session.acceptedByUser[game.scoutUsername] -= 1;
      return false;
    });
    for (const user of gapped) {
      const accepted = session.acceptedByUser[user] || 0;
      session.sourceStatus[user] = { status: accepted ? "ok" : "empty", accepted };
    }
    state.liveTries = null;
  }
  // A new array, so nothing keyed on the old one (the section memo) reads it as unchanged.
  state.games = games.slice().sort((a, b) => (b.datestamp || 0) - (a.datestamp || 0));
  return true;
}
