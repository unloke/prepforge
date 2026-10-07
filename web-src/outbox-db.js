import { mergeOutboxState } from "./sync-queue.js";

export const OUTBOX_DATABASE = "prepforge-sync-outbox";
const STORE = "owners";
const ownerKey = (owner) => String(owner || "anon");

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Outbox database blocked; close other tabs"));
    request.onsuccess = () => resolve(request.result);
  });
}

// One read/merge/write transaction per call, so concurrent tabs never lose
// each other's ops. Tombstones are kept: there is no enforced server replay
// horizon, and a suspended tab may still hold settled work.
async function update(owner, incoming, settled) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let value;
      let failure;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error("Outbox transaction aborted"));
      const read = store.get(ownerKey(owner));
      read.onsuccess = () => {
        try {
          value = mergeOutboxState(read.result?.state, incoming, settled);
          store.put({ version: 1, state: value }, ownerKey(owner));
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

export function loadDurableOutbox(owner) { return update(owner, null, null); }

export function saveDurableOutbox(owner, state, settled = null) {
  // Snapshot before the async open: callers may clear their live queues next.
  return update(owner, structuredClone(state), structuredClone(settled));
}

/** Confirmed history is retained; clearing never deletes another tab's work. */
export function clearDurableOutbox(owner) { return loadDurableOutbox(owner); }
