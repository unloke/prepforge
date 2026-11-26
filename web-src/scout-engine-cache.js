// Per-game localStorage cache for the Scout deep scan.
//
// One entry per (game, depth, plies). A small index entry records each entry's write
// time and size, so a write evicts from the index instead of reading and parsing
// every other entry (which made a scan of N games cost O(N²) parses). Mistakes are
// not stored: they are the moves flagged `isInaccuracy` and are rebuilt on read.

export const ENGINE_CACHE_SCHEMA = 6;
export const ENGINE_CACHE_MAX_ENTRIES = 120;
export const ENGINE_CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const ENGINE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ENGINE_CACHE_PREFIX = "prepforge.scout.engine.v6";
// Older scan caches use the same stem with a lower version; they are dropped when
// the index is rebuilt, since no reader can use them any more.
const LEGACY_PREFIX_STEM = "prepforge.scout.engine.v";
export const ENGINE_CACHE_INDEX_KEY = `${ENGINE_CACHE_PREFIX}:index`;

export function engineCacheKey(gameId, depth, plies) {
  return `${ENGINE_CACHE_PREFIX}:${gameId}:d${depth}:p${plies}`;
}

function moveHasReplyFields(move) {
  if (!move || typeof move !== "object") return false;
  const has = (field) => Object.prototype.hasOwnProperty.call(move, field);
  return has("opponentBestAlternativeUci") && has("ourReplyUci") && has("ourReplyPv");
}

export function isCompleteScanCacheEntry(cached) {
  if (!cached?.record || cached.schemaVersion !== ENGINE_CACHE_SCHEMA) return false;
  const rec = cached.record;
  if (!Number.isFinite(rec.eligibleOpponentPlies) || !Number.isFinite(rec.analyzedOpponentPlies)) {
    return false;
  }
  if (!Array.isArray(rec.moves) || !Array.isArray(rec.mistakes)) return false;
  if (rec.complete !== true || rec.analyzedOpponentPlies !== rec.eligibleOpponentPlies) return false;
  if (rec.analyzedOpponentPlies > 0 && rec.moves.length !== rec.analyzedOpponentPlies) {
    return false;
  }
  if (rec.moves.length > 0 && !rec.moves.every(moveHasReplyFields)) {
    return false;
  }
  return true;
}

// The stored form drops the derived `mistakes` (and any legacy top-level copy).
function storedPayload(payload) {
  const { moves: _legacyMoves, ...rest } = payload;
  const { mistakes: _mistakes, ...record } = payload.record || {};
  return { ...rest, record, schemaVersion: ENGINE_CACHE_SCHEMA };
}

function rehydrate(parsed) {
  if (!parsed?.record || !Array.isArray(parsed.record.moves)) return parsed;
  return {
    ...parsed,
    record: { ...parsed.record, mistakes: parsed.record.moves.filter((m) => m?.isInaccuracy) },
  };
}

function readIndex(store) {
  try {
    const parsed = JSON.parse(store.getItem(ENGINE_CACHE_INDEX_KEY) || "null");
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
      return parsed.entries;
    }
  } catch {
    /* rebuilt below */
  }
  return null;
}

function writeIndex(store, entries) {
  try {
    store.setItem(ENGINE_CACHE_INDEX_KEY, JSON.stringify({ entries }));
  } catch {
    /* best-effort */
  }
}

// One full pass, only when the index is missing or unreadable: index the current
// entries and drop older-version ones.
function rebuildIndex(store) {
  const entries = {};
  if (typeof store.length !== "number" || typeof store.key !== "function") return entries;
  const legacy = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key?.startsWith(LEGACY_PREFIX_STEM) || key === ENGINE_CACHE_INDEX_KEY) continue;
    if (!key.startsWith(`${ENGINE_CACHE_PREFIX}:`)) {
      legacy.push(key);
      continue;
    }
    const raw = store.getItem(key);
    let at = 0;
    try { at = JSON.parse(raw).at || 0; } catch { /* malformed cache is evicted first */ }
    entries[key] = [at, (raw?.length || 0) * 2];
  }
  for (const key of legacy) store.removeItem(key);
  return entries;
}

function dropFromIndex(store, key) {
  const entries = readIndex(store);
  if (!entries || !(key in entries)) return;
  delete entries[key];
  writeIndex(store, entries);
}

export function readGameCache(store, gameId, depth, plies, provenance) {
  if (!gameId) return null;
  try {
    const key = engineCacheKey(gameId, depth, plies);
    const raw = store.getItem(key);
    if (raw) {
      const parsed = rehydrate(JSON.parse(raw));
      const age = Date.now() - parsed.at;
      if (provenance && parsed.provenance === provenance && Number.isFinite(age) &&
          age >= 0 && age <= ENGINE_CACHE_TTL_MS && isCompleteScanCacheEntry(parsed)) return parsed;
      store.removeItem(key);
      dropFromIndex(store, key);
    }
  } catch {
    return null;
  }
  return null;
}

export function writeGameCache(store, gameId, depth, plies, payload) {
  if (!gameId) return;
  try {
    if (!payload.provenance || !isCompleteScanCacheEntry({
      ...payload, record: { ...payload.record, mistakes: [] }, schemaVersion: ENGINE_CACHE_SCHEMA,
    })) return;
    const value = JSON.stringify(storedPayload(payload));
    // Count UTF-16 storage bytes conservatively. Evict only this derived cache;
    // user data and sync receipts are never part of this retention policy.
    const size = value.length * 2;
    if (size > ENGINE_CACHE_MAX_BYTES) return;
    const target = engineCacheKey(gameId, depth, plies);
    const index = readIndex(store) || rebuildIndex(store);
    delete index[target];
    const entries = Object.entries(index).map(([key, [at, bytes]]) => ({ key, at, bytes }));
    let bytes = size + entries.reduce((sum, e) => sum + e.bytes, 0);
    entries.sort((a, b) => a.at - b.at);
    while (entries.length && (entries.length >= ENGINE_CACHE_MAX_ENTRIES || bytes > ENGINE_CACHE_MAX_BYTES ||
        Date.now() - entries[0].at > ENGINE_CACHE_TTL_MS)) {
      const oldest = entries.shift();
      store.removeItem(oldest.key);
      delete index[oldest.key];
      bytes -= oldest.bytes;
    }
    store.setItem(target, value);
    index[target] = [payload.at || Date.now(), size];
    writeIndex(store, index);
  } catch {
    /* best-effort */
  }
}
