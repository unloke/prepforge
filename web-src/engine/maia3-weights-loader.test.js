import { describe, it, expect } from "vitest";

import { loadVerifiedWeights, fetchWeightsWithProgress } from "./maia3-weights-loader.js";

// The worker can't be unit-tested in node (it imports onnxruntime-web), so the cache→verify→
// fetch orchestration lives here and is tested with injected fetch / sha256 / cache fakes —
// including the P1 case the review flagged: a CORRUPT cached artifact must evict + re-fetch,
// not wedge init forever.

const ab = (bytes) => Uint8Array.from(bytes).buffer;
const bytesOf = (buf) => [...new Uint8Array(buf)];

// A fake sha256 that just stringifies the bytes, so tests control "matches" vs "mismatch".
const fakeSha = async (buf) => bytesOf(buf).join(",");

// entry whose sha256 matches fakeSha([1,2,3,4]) and size 4.
const goodEntry = { file: "maia3-fp16-good.onnx", bytes: 4, sha256: "1,2,3,4" };

// In-memory cache double matching the { get, put, del } shape loadVerifiedWeights expects.
function makeCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    log: [],
    cache: {
      get: async (k) => {
        return store.has(k) ? store.get(k) : null;
      },
      put: async (k, v) => {
        store.set(k, v);
        return true;
      },
      del: async (k) => {
        store.delete(k);
        return true;
      },
    },
  };
}

// A fetch double returning the given body with optional Content-Length and streaming.
function fakeFetch(body, { ok = true, status = 200, contentLength = null, stream = true, chunks = 1 } = {}) {
  const calls = { count: 0 };
  const impl = async () => {
    calls.count += 1;
    const headers = { get: (h) => (h.toLowerCase() === "content-length" ? contentLength : null) };
    if (!stream) {
      return { ok, status, headers, body: null, arrayBuffer: async () => body };
    }
    const u8 = new Uint8Array(body);
    const size = Math.ceil(u8.length / chunks);
    let i = 0;
    const reader = {
      read: async () => {
        if (i >= u8.length) return { done: true, value: undefined };
        const slice = u8.slice(i, i + size);
        i += size;
        return { done: false, value: slice };
      },
    };
    return { ok, status, headers, body: { getReader: () => reader }, arrayBuffer: async () => body };
  };
  return { impl, calls };
}

describe("loadVerifiedWeights", () => {
  it("returns cached bytes without fetching when the cache hit verifies", async () => {
    const { cache, store } = makeCache({ [goodEntry.file]: ab([1, 2, 3, 4]) });
    const { impl, calls } = fakeFetch(ab([1, 2, 3, 4]));
    const { buf, fromCache } = await loadVerifiedWeights({
      entry: goodEntry,
      url: "http://w/x.onnx",
      cache,
      fetchImpl: impl,
      sha256: fakeSha,
    });
    expect(fromCache).toBe(true);
    expect(bytesOf(buf)).toEqual([1, 2, 3, 4]);
    expect(calls.count).toBe(0); // never hit the network
    expect(store.has(goodEntry.file)).toBe(true);
  });

  it("evicts a CORRUPT cached artifact and falls back to the network (P1)", async () => {
    // Cache holds wrong bytes (sha mismatch). Network serves the correct artifact.
    const { cache, store } = makeCache({ [goodEntry.file]: ab([9, 9, 9, 9]) });
    const { impl, calls } = fakeFetch(ab([1, 2, 3, 4]), { contentLength: "4" });

    const { buf, fromCache } = await loadVerifiedWeights({
      entry: goodEntry,
      url: "http://w/x.onnx",
      cache,
      fetchImpl: impl,
      sha256: fakeSha,
    });

    expect(fromCache).toBe(false); // came from the network, not the bad cache
    expect(bytesOf(buf)).toEqual([1, 2, 3, 4]);
    expect(calls.count).toBe(1); // re-fetched after eviction
    // The corrupt blob was evicted, then the verified network bytes were persisted.
    expect(bytesOf(store.get(goodEntry.file))).toEqual([1, 2, 3, 4]);
  });

  it("cold start: fetches, verifies, and persists the verified bytes", async () => {
    const { cache, store } = makeCache();
    const { impl, calls } = fakeFetch(ab([1, 2, 3, 4]), { contentLength: "4" });
    const { buf, fromCache } = await loadVerifiedWeights({
      entry: goodEntry,
      url: "http://w/x.onnx",
      cache,
      fetchImpl: impl,
      sha256: fakeSha,
    });
    expect(fromCache).toBe(false);
    expect(calls.count).toBe(1);
    expect(bytesOf(buf)).toEqual([1, 2, 3, 4]);
    expect(bytesOf(store.get(goodEntry.file))).toEqual([1, 2, 3, 4]); // cached for next time
  });

  it("throws (and does NOT cache) when the network serves bad bytes", async () => {
    const { cache, store } = makeCache();
    const { impl } = fakeFetch(ab([9, 9, 9, 9]), { contentLength: "4" }); // sha mismatch
    await expect(
      loadVerifiedWeights({
        entry: goodEntry,
        url: "http://w/x.onnx",
        cache,
        fetchImpl: impl,
        sha256: fakeSha,
      }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(store.has(goodEntry.file)).toBe(false); // never cache unverified bytes
  });

  it("a size mismatch from the network throws before the sha check", async () => {
    const { cache } = makeCache();
    const { impl } = fakeFetch(ab([1, 2, 3]), { contentLength: "3" }); // 3 != entry.bytes(4)
    await expect(
      loadVerifiedWeights({ entry: goodEntry, url: "http://w/x.onnx", cache, fetchImpl: impl, sha256: fakeSha }),
    ).rejects.toThrow(/size mismatch/);
  });
});

describe("fetchWeightsWithProgress total (P3)", () => {
  it("reports progress against the manifest size when Content-Length is absent", async () => {
    const { impl } = fakeFetch(ab([1, 2, 3, 4]), { contentLength: null, chunks: 2 });
    const events = [];
    await fetchWeightsWithProgress("http://w/x.onnx", 4, (loaded, total) => events.push({ loaded, total }), {
      fetchImpl: impl,
    });
    // Two chunks of 2 bytes each; total must be the manifest size (4), NOT `loaded` (which
    // would make every chunk read 100%).
    expect(events).toEqual([
      { loaded: 2, total: 4 },
      { loaded: 4, total: 4 },
    ]);
  });

  it("prefers a present Content-Length over the manifest size", async () => {
    const { impl } = fakeFetch(ab([1, 2, 3, 4]), { contentLength: "4", chunks: 2 });
    const events = [];
    await fetchWeightsWithProgress("http://w/x.onnx", 999, (loaded, total) => events.push({ loaded, total }), {
      fetchImpl: impl,
    });
    expect(events).toEqual([
      { loaded: 2, total: 4 },
      { loaded: 4, total: 4 },
    ]);
  });

  it("falls back to a single arrayBuffer read when the body can't stream", async () => {
    const { impl } = fakeFetch(ab([1, 2, 3, 4]), { stream: false, contentLength: null });
    const events = [];
    const buf = await fetchWeightsWithProgress("http://w/x.onnx", 4, (l, t) => events.push({ l, t }), {
      fetchImpl: impl,
    });
    expect(bytesOf(buf)).toEqual([1, 2, 3, 4]);
    expect(events).toEqual([{ l: 4, t: 4 }]);
  });

  it("throws an actionable error on a non-ok response", async () => {
    const { impl } = fakeFetch(ab([]), { ok: false, status: 404 });
    await expect(fetchWeightsWithProgress("http://w/x.onnx", 4, () => {}, { fetchImpl: impl })).rejects.toThrow(
      /weight fetch 404/,
    );
  });
});
