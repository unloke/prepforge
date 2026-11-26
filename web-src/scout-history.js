// Scout history: the last runs, kept in this browser so a re-scout opens at once
// and only fetches the games played since. One entry per account (owner), source
// set and colour; the newest SCOUT_HISTORY_LIMIT entries are kept. It is a cache
// the user controls from the History list, never the only copy of anything: every
// call fails soft (null / [] / false) and Scout then works as without it.

export const SCOUT_HISTORY_DATABASE = "prepforge-scout-history";
export const SCOUT_HISTORY_LIMIT = 10;
const RUNS = "runs";
const META = "meta";
const VERSION = 1;

/** One entry per source set and colour: the same accounts in any order are one entry. */
export function scoutHistoryKey(usernames, color = "both") {
  const names = [...new Set((usernames || []).map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
  return `${names.sort().join(",")}|${color || "both"}`;
}

// The per-game record keeps only what Scout reads. Dropped and rebuilt on load:
// openingUcis/openingSans (the first openingEndPly moves), totalPly (the move
// count) and sourceAccount (the source). Dropped for good, as nothing reads them:
// opponentRating and nextOwnThinkSeconds. Moves are stored as one string each.
export function compactScoutGame(game) {
  return {
    gameId: game.gameId ?? null,
    color: game.color,
    score: game.score,
    status: game.status ?? null,
    ucis: (game.ucis || []).join(" "),
    sans: (game.sans || []).join(" "),
    rating: game.rating || 0,
    datestamp: game.datestamp || 0,
    speed: game.speed,
    timeControl: game.timeControl ?? null,
    clockAfterPly: game.clockAfterPly || [],
    openingEndPly: game.openingEndPly || 0,
    scoutUsername: game.scoutUsername ?? null,
  };
}

export function restoreScoutGame(record) {
  const ucis = record.ucis ? record.ucis.split(" ") : [];
  const sans = record.sans ? record.sans.split(" ") : [];
  const end = record.openingEndPly || 0;
  return {
    ...record,
    ucis,
    sans,
    totalPly: ucis.length,
    openingUcis: ucis.slice(0, end),
    openingSans: sans.slice(0, end),
    ...(record.scoutUsername ? { sourceAccount: record.scoutUsername } : {}),
  };
}

const ownerOf = (owner) => String(owner || "");
const ownerRange = (owner) => IDBKeyRange.bound([ownerOf(owner)], [ownerOf(owner), []]);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SCOUT_HISTORY_DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Scout history database blocked"));
  });
}

// One transaction over both stores; `action` returns { result } filled by its requests.
async function transaction(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([RUNS, META], mode);
      let out;
      tx.oncomplete = () => resolve(out?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Scout history transaction aborted"));
      try { out = action(tx.objectStore(RUNS), tx.objectStore(META)); } catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

function metaOf(owner, run) {
  const { key, usernames, label, color, savedAt, gameCount } = run;
  return { owner: ownerOf(owner), key, usernames, label, color, savedAt, gameCount };
}

/** Saves (or replaces) one run, then drops the oldest beyond the limit. */
export async function saveScoutRun(owner, run, { limit = SCOUT_HISTORY_LIMIT } = {}) {
  try {
    const record = { ...run, version: VERSION, savedAt: run.savedAt || Date.now() };
    await transaction("readwrite", (runs, meta) => {
      runs.put(record, [ownerOf(owner), record.key]);
      meta.put(metaOf(owner, record), [ownerOf(owner), record.key]);
      const all = meta.getAll(ownerRange(owner));
      all.onsuccess = () => {
        const entries = all.result.filter((entry) => entry.key !== record.key)
          .sort((a, b) => b.savedAt - a.savedAt);
        for (const old of entries.slice(Math.max(0, limit - 1))) {
          runs.delete([ownerOf(owner), old.key]);
          meta.delete([ownerOf(owner), old.key]);
        }
      };
    });
    return true;
  } catch { return false; }
}

/** The owner's saved runs, newest first, without their games. */
export async function listScoutRuns(owner) {
  try {
    const list = await transaction("readonly", (_runs, meta) => meta.getAll(ownerRange(owner)));
    return (list || []).sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export async function loadScoutRun(owner, key) {
  try {
    const run = await transaction("readonly", (runs) => runs.get([ownerOf(owner), key]));
    return run?.version === VERSION ? run : null;
  } catch { return null; }
}

export async function deleteScoutRun(owner, key) {
  try {
    await transaction("readwrite", (runs, meta) => {
      runs.delete([ownerOf(owner), key]);
      meta.delete([ownerOf(owner), key]);
    });
    return true;
  } catch { return false; }
}

export async function clearScoutRuns(owner) {
  try {
    await transaction("readwrite", (runs, meta) => {
      runs.delete(ownerRange(owner));
      meta.delete(ownerRange(owner));
    });
    return true;
  } catch { return false; }
}

/** The history as one object, for the view's deps (tests pass a fake). */
export const scoutHistory = {
  key: scoutHistoryKey, save: saveScoutRun, list: listScoutRuns, load: loadScoutRun,
  remove: deleteScoutRun, clear: clearScoutRuns,
};
