// Finished analysis is user work, not an evictable cache. Payload and metadata
// commit in one IndexedDB transaction; quota failure keeps the caller's memory copy.
const DATABASE = "prepforge-analysis-checkpoints";
const PAYLOADS = "payloads";
const METADATA = "metadata";

export function checkpointKey(gameId, ownerId) {
  return [ownerId || "", gameId];
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(PAYLOADS);
      db.createObjectStore(METADATA).createIndex("owner", "ownerId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Checkpoint database blocked"));
  });
}

async function transaction(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([PAYLOADS, METADATA], mode);
      let result;
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Checkpoint transaction aborted"));
      try { result = action(tx.objectStore(PAYLOADS), tx.objectStore(METADATA)); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

/** Metadata only: never parse other games' analysis payloads during a save. */
export async function listCheckpointGames(ownerId) {
  try {
    const entries = await transaction("readonly", (_, metadata) => metadata.index("owner").getAll(ownerId || ""));
    return entries.sort((a, b) => b.savedAt - a.savedAt).map(({ gameId, savedAt }) => ({ gameId, savedAt }));
  } catch (_) { return []; }
}

export async function saveCheckpoint(checkpoint) {
  try {
    const payload = { ...checkpoint, ownerId: checkpoint.ownerId || null, savedAt: checkpoint.savedAt || Date.now() };
    const key = checkpointKey(payload.gameId, payload.ownerId);
    await transaction("readwrite", (payloads, metadata) => {
      payloads.put(payload, key);
      metadata.put({ gameId: payload.gameId, ownerId: payload.ownerId || "", savedAt: payload.savedAt,
        version: payload.requestId || payload.savedAt }, key);
    });
    return true;
  } catch (_) { return false; }
}

export async function loadCheckpoint(gameId, ownerId) {
  try {
    if (!gameId) gameId = (await listCheckpointGames(ownerId))[0]?.gameId;
    if (!gameId) return null;
    return (await transaction("readonly", (payloads) => payloads.get(checkpointKey(gameId, ownerId)))) || null;
  } catch (_) { return null; }
}

/** Delete only the version the prompt/save owns, preserving a newer computation. */
export async function clearCheckpoint(gameId, ownerId, version = null) {
  try {
    await transaction("readwrite", (payloads, metadata) => {
      const key = checkpointKey(gameId, ownerId);
      const request = metadata.get(key);
      request.onsuccess = () => {
        if (version !== null && request.result?.version !== version) return;
        payloads.delete(key);
        metadata.delete(key);
      };
    });
    return true;
  } catch (_) { return false; }
}

export function evalMapFrom(checkpoint) {
  const map = new Map();
  for (const entry of checkpoint?.evals || []) {
    if (Array.isArray(entry) && entry.length === 2) map.set(entry[0], entry[1]);
  }
  return map;
}
