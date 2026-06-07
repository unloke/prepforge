// IndexedDB cache for the Maia3 ONNX weights (docs/browser-engine-migration.md
// Phase 3c, Stage 4b). The fp16 artifact is ~46 MB; without a cache every Build
// Generate re-fetches it over the network. The artifact filename is content-addressed
// (`maia3-<label>-<sha12>.onnx`), so the filename IS the cache key: a new model version
// is a new key (natural miss → re-download) and a stale key can be evicted.
//
// This module is deliberately ORT-free and dependency-injectable (the `idb` option) so it
// unit-tests in node against a fake IndexedDB. It is BEST-EFFORT: any IndexedDB failure
// (private-mode quota, corruption, missing API) is swallowed and treated as a cache miss /
// no-op so the worker always falls back to a network fetch and never breaks inference.
//
// Integrity note: the caller (maia3-worker) ALWAYS re-runs the manifest size+sha256 gate
// on the bytes this returns, so a corrupted/truncated cached blob is rejected the same way
// a bad CDN response would be — the cache is a speed optimization, never a trust boundary.

const DB_NAME = "prepforge-maia3";
const STORE = "weights";
const DB_VERSION = 1;

function defaultIdb() {
  return typeof indexedDB !== "undefined" ? indexedDB : null;
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

function runTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(STORE);
    let result;
    let settled = false;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result && result.value !== undefined ? result.value : undefined);
      }
    };
    tx.onerror = () => reject(tx.error || new Error("indexedDB tx failed"));
    tx.onabort = () => reject(tx.error || new Error("indexedDB tx aborted"));
  });
}

function reqValue(store, op, ...args) {
  // Wrap a single IDBRequest so its result is readable after the tx completes.
  const holder = { value: undefined };
  const r = store[op](...args);
  r.onsuccess = () => {
    holder.value = r.result;
  };
  return holder;
}

// Return the cached ArrayBuffer for `key`, or null on a miss / any IndexedDB problem.
export async function getCachedWeights(key, { idb = defaultIdb() } = {}) {
  if (!idb || !key) return null;
  let db = null;
  try {
    db = await openDb(idb);
    const value = await runTx(db, "readonly", (store) => reqValue(store, "get", key));
    if (!value) return null;
    // Stored as ArrayBuffer; tolerate a typed-array shape too.
    if (value instanceof ArrayBuffer) return value;
    if (value && value.buffer instanceof ArrayBuffer) return value.buffer;
    return null;
  } catch {
    return null; // best-effort: any failure is a cache miss
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Delete the entry under `key` (best-effort). Used to evict a cached artifact that fails
// the integrity gate so the worker can re-fetch instead of wedging on corrupt bytes.
// Returns true on success, false on any IndexedDB problem (never throws).
export async function deleteCachedWeights(key, { idb = defaultIdb() } = {}) {
  if (!idb || !key) return false;
  let db = null;
  try {
    db = await openDb(idb);
    await runTx(db, "readwrite", (store) => {
      store.delete(key);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Drop EVERY cached weight (not just one key). Used by the Settings "Reset Maia cache"
// action to recover from a stale/corrupt IndexedDB store: after this the next load
// re-downloads from the network. Returns true on success, false on any problem (never throws).
export async function clearWeightCache({ idb = defaultIdb() } = {}) {
  if (!idb) return false;
  let db = null;
  try {
    db = await openDb(idb);
    await runTx(db, "readwrite", (store) => {
      store.clear();
    });
    return true;
  } catch {
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Store `buffer` under `key`, evicting every other entry first (we only ever keep the one
// currently-referenced model, so the cache can't grow unbounded across model versions).
// Returns true on success, false on any IndexedDB problem (never throws).
export async function putCachedWeights(key, buffer, { idb = defaultIdb() } = {}) {
  if (!idb || !key || !buffer) return false;
  let db = null;
  try {
    db = await openDb(idb);
    await runTx(db, "readwrite", (store) => {
      store.clear(); // single-model cache: drop any prior (stale) artifact
      store.put(buffer, key);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}
