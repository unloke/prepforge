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
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS);
      const metadata = db.objectStoreNames.contains(METADATA)
        ? request.transaction.objectStore(METADATA) : db.createObjectStore(METADATA);
      metadata.createIndex("owner_saved", ["ownerId", "savedAt", "gameId"]);
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
    return await transaction("readonly", (_, metadata) => {
      const result = { result: [] };
      const cursor = metadata.index("owner_saved").openCursor(IDBKeyRange.bound([ownerId || ""], [ownerId || "", []]), "prev");
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const { gameId, savedAt } = cursor.result.value;
        result.result.push({ gameId, savedAt });
        cursor.result.continue();
      };
      return result;
    });
  } catch (_) { return []; }
}

export async function saveCheckpoint(checkpoint) {
  try {
    if (!checkpoint.requestId) return false;
    const payload = { ...checkpoint, ownerId: checkpoint.ownerId || null, savedAt: checkpoint.savedAt || Date.now() };
    const key = checkpointKey(payload.gameId, payload.ownerId);
    await transaction("readwrite", (payloads, metadata) => {
      payloads.put(payload, key);
      metadata.put({ gameId: payload.gameId, ownerId: payload.ownerId || "", savedAt: payload.savedAt,
        version: payload.requestId }, key);
    });
    return true;
  } catch (_) { return false; }
}

export async function loadCheckpoint(gameId, ownerId) {
  try {
    return (await transaction("readonly", (payloads, metadata) => {
      if (gameId) return payloads.get(checkpointKey(gameId, ownerId));
      const result = { result: null };
      const cursor = metadata.index("owner_saved").openCursor(IDBKeyRange.bound([ownerId || ""], [ownerId || "", []]), "prev");
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const payload = payloads.get(cursor.result.primaryKey);
        payload.onsuccess = () => { result.result = payload.result; };
      };
      return result;
    })) || null;
  } catch (_) { return null; }
}

/** Delete only the version the prompt/save owns, preserving a newer computation. */
export async function markCheckpointSaved(gameId, ownerId, requestId) {
  try {
    await transaction("readwrite", (payloads) => {
      const key = checkpointKey(gameId, ownerId);
      const request = payloads.get(key);
      request.onsuccess = () => {
        if (request.result?.requestId === requestId) payloads.put({ ...request.result, serverSaved: true }, key);
      };
    });
    return true;
  } catch (_) { return false; }
}

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
