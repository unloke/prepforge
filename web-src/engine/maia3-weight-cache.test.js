import { describe, it, expect } from "vitest";

import {
  getCachedWeights,
  putCachedWeights,
  deleteCachedWeights,
  clearWeightCache,
} from "./maia3-weight-cache.js";

// The cache module is written against the raw IndexedDB API and is dependency-injectable
// (`{ idb }`), so we drive it here with a compact in-memory fake — no browser, no
// fake-indexeddb dep. The fake fires request.onsuccess for each op and THEN tx.oncomplete,
// matching the ordering the module relies on (reqValue reads result in onsuccess; runTx
// resolves on oncomplete).
function makeFakeIndexedDB() {
  const dbs = new Map(); // name -> { version, stores: Map<storeName, Map<key,value>> }

  function makeDb(rec) {
    return {
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(n) {
        rec.stores.set(n, new Map());
        return {};
      },
      transaction(storeName) {
        const map = rec.stores.get(storeName);
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        const ops = [];
        const store = {
          get(key) {
            const r = { result: undefined, onsuccess: null };
            ops.push(() => {
              r.result = map.get(key);
              if (r.onsuccess) r.onsuccess();
            });
            return r;
          },
          put(value, key) {
            const r = { onsuccess: null };
            ops.push(() => {
              map.set(key, value);
              if (r.onsuccess) r.onsuccess();
            });
            return r;
          },
          clear() {
            const r = { onsuccess: null };
            ops.push(() => {
              map.clear();
              if (r.onsuccess) r.onsuccess();
            });
            return r;
          },
          delete(key) {
            const r = { onsuccess: null };
            ops.push(() => {
              map.delete(key);
              if (r.onsuccess) r.onsuccess();
            });
            return r;
          },
        };
        // Run queued ops then complete, after the caller has wired tx.oncomplete.
        queueMicrotask(() => {
          for (const run of ops) run();
          if (tx.oncomplete) tx.oncomplete();
        });
        return {
          objectStore: () => store,
          get oncomplete() {
            return tx.oncomplete;
          },
          set oncomplete(f) {
            tx.oncomplete = f;
          },
          get onerror() {
            return tx.onerror;
          },
          set onerror(f) {
            tx.onerror = f;
          },
          get onabort() {
            return tx.onabort;
          },
          set onabort(f) {
            tx.onabort = f;
          },
          get error() {
            return tx.error;
          },
        };
      },
      close() {},
    };
  }

  return {
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
      queueMicrotask(() => {
        let rec = dbs.get(name);
        const needsUpgrade = !rec || rec.version < version;
        if (!rec) {
          rec = { version, stores: new Map() };
          dbs.set(name, rec);
        }
        req.result = makeDb(rec);
        if (needsUpgrade) {
          rec.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    _dbs: dbs,
  };
}

const buf = (bytes) => Uint8Array.from(bytes).buffer;

describe("maia3 weight cache", () => {
  it("round-trips an ArrayBuffer under a content-addressed key", async () => {
    const idb = makeFakeIndexedDB();
    const key = "maia3-fp16-deadbeef0000.onnx";
    expect(await getCachedWeights(key, { idb })).toBe(null); // cold miss

    const ok = await putCachedWeights(key, buf([1, 2, 3, 4]), { idb });
    expect(ok).toBe(true);

    const got = await getCachedWeights(key, { idb });
    expect(got).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(got)]).toEqual([1, 2, 3, 4]);
  });

  it("is single-model: putting a new key evicts the previous artifact", async () => {
    const idb = makeFakeIndexedDB();
    await putCachedWeights("maia3-fp16-aaaa.onnx", buf([1]), { idb });
    await putCachedWeights("maia3-fp16-bbbb.onnx", buf([2]), { idb });

    // The old (stale-version) key was cleared so the cache can't grow unbounded.
    expect(await getCachedWeights("maia3-fp16-aaaa.onnx", { idb })).toBe(null);
    const current = await getCachedWeights("maia3-fp16-bbbb.onnx", { idb });
    expect([...new Uint8Array(current)]).toEqual([2]);
  });

  it("evicts a single key with deleteCachedWeights (used to drop a corrupt blob)", async () => {
    const idb = makeFakeIndexedDB();
    await putCachedWeights("maia3-fp16-cccc.onnx", buf([9]), { idb });
    expect(await getCachedWeights("maia3-fp16-cccc.onnx", { idb })).not.toBe(null);

    expect(await deleteCachedWeights("maia3-fp16-cccc.onnx", { idb })).toBe(true);
    expect(await getCachedWeights("maia3-fp16-cccc.onnx", { idb })).toBe(null);
  });

  it("clearWeightCache drops every entry (Settings 'Reset cache' recovery)", async () => {
    const idb = makeFakeIndexedDB();
    await putCachedWeights("maia3-fp16-dddd.onnx", buf([7]), { idb });
    expect(await getCachedWeights("maia3-fp16-dddd.onnx", { idb })).not.toBe(null);

    expect(await clearWeightCache({ idb })).toBe(true);
    expect(await getCachedWeights("maia3-fp16-dddd.onnx", { idb })).toBe(null);
  });

  it("clearWeightCache is a no-op without IndexedDB / on errors", async () => {
    expect(await clearWeightCache({ idb: null })).toBe(false);
    expect(
      await clearWeightCache({
        idb: {
          open() {
            throw new Error("boom");
          },
        },
      }),
    ).toBe(false);
  });

  it("deleteCachedWeights is a no-op without IndexedDB / on errors", async () => {
    expect(await deleteCachedWeights("k", { idb: null })).toBe(false);
    expect(
      await deleteCachedWeights("k", {
        idb: {
          open() {
            throw new Error("boom");
          },
        },
      }),
    ).toBe(false);
  });

  it("is a best-effort no-op when IndexedDB is unavailable", async () => {
    expect(await getCachedWeights("k", { idb: null })).toBe(null);
    expect(await putCachedWeights("k", buf([1]), { idb: null })).toBe(false);
  });

  it("swallows IndexedDB errors as a miss / failed put (never throws)", async () => {
    const throwingIdb = {
      open() {
        throw new Error("SecurityError: IndexedDB disabled");
      },
    };
    expect(await getCachedWeights("k", { idb: throwingIdb })).toBe(null);
    expect(await putCachedWeights("k", buf([1]), { idb: throwingIdb })).toBe(false);
  });

  it("ignores empty keys / buffers", async () => {
    const idb = makeFakeIndexedDB();
    expect(await getCachedWeights("", { idb })).toBe(null);
    expect(await putCachedWeights("", buf([1]), { idb })).toBe(false);
    expect(await putCachedWeights("k", null, { idb })).toBe(false);
  });
});
