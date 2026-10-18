import { describe, it, expect } from "vitest";

import {
  loadVerifiedWeights,
  fetchWeightsReliably,
  fetchWeightsWithProgress,
  WEIGHT_STALL_MS,
  WEIGHT_ATTEMPTS,
} from "./maia3-weights-loader.js";

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

// --- C1: stall timeout, retry, and never caching a partial --------------------
// The reported symptom was "stuck at 37% for 120s". The cause: there was no timeout at
// all, only the browser's own socket behavior, so a stream that stopped delivering
// bytes hung forever. The budget is silence-based (no bytes for N seconds), so a
// slow-but-alive link still finishes, and each attempt is torn down rather than left
// hanging on a connection that will not deliver.

// A fetch double whose stream never delivers another byte: the shape that hung.
function hangingFetch() {
  const calls = { count: 0, cancelled: 0, signals: [] };
  const impl = async (_url, { signal } = {}) => {
    calls.count += 1;
    calls.signals.push(signal);
    // A read that never settles is the stall. Real fetch semantics: aborting the
    // request rejects the in-flight read, so the fake has to do the same or the
    // stall timer could never unblock anything.
    const read = new Promise((_resolve, reject) => {
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
    });
    const reader = {
      read: () => read,
      cancel: async () => {
        calls.cancelled += 1;
      },
      releaseLock: () => {},
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(goodEntry.bytes) },
      body: { getReader: () => reader },
      arrayBuffer: async () => ab([1, 2, 3, 4]),
    };
  };
  return { impl, calls };
}

describe("weight download stall and retry (C1)", () => {
  it("a stalled download is aborted, retried, and reported as a stall", async () => {
    const { impl, calls } = hangingFetch();
    const attempts = [];
    await expect(
      fetchWeightsReliably("http://w/x.onnx", goodEntry.bytes, () => {}, {
        fetchImpl: impl,
        stallMs: 20,
        attempts: 3,
        backoffMs: 0,
        onAttempt: (n) => attempts.push(n),
      }),
    ).rejects.toThrow(/weight download stalled: no bytes from http:\/\/w\/x\.onnx for 0s/);
    expect(calls.count).toBe(3); // 1 initial + 2 retries
    expect(attempts).toEqual([2, 3]); // the UI can say it is trying again
    // Each attempt's own signal was aborted: the stream was torn down rather
    // than left hanging on a connection that will not deliver.
    expect(calls.signals.map((s) => s.aborted)).toEqual([true, true, true]);
  });

  it("a stall error keeps fetch's AbortError name so callers can classify it", async () => {
    const { impl } = hangingFetch();
    await loadVerifiedWeights({
      entry: goodEntry,
      url: "http://w/x.onnx",
      fetchImpl: impl,
      sha256: fakeSha,
      stallMs: 20,
      attempts: 1,
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (error) => {
        expect(error.name).toBe("AbortError");
        expect(error.message).toMatch(/stalled/);
      },
    );
  });

  it("a size mismatch is NOT retried: the same wrong bytes would come back", async () => {
    const { cache, store } = makeCache();
    const { impl, calls } = fakeFetch(ab([1, 2, 3, 4, 5]), { contentLength: "5" }); // 5 != 4
    await expect(
      loadVerifiedWeights({
        entry: goodEntry,
        url: "http://w/x.onnx",
        cache,
        fetchImpl: impl,
        sha256: fakeSha,
        stallMs: 20,
        attempts: 3,
        backoffMs: 0,
      }),
    ).rejects.toThrow(/size mismatch/);
    expect(calls.count).toBe(1); // no backoff burned on a mismatch
    expect(store.size).toBe(0); // and nothing was persisted
  });

  it("a stalled download leaves no partial in the cache", async () => {
    const { cache, store } = makeCache();
    const { impl } = hangingFetch();
    await expect(
      loadVerifiedWeights({
        entry: goodEntry,
        url: "http://w/x.onnx",
        cache,
        fetchImpl: impl,
        sha256: fakeSha,
        stallMs: 20,
        attempts: 2,
        backoffMs: 0,
      }),
    ).rejects.toThrow(/stalled/);
    // The only cache write happens after verify() passes, so nothing landed.
    expect(store.size).toBe(0);
  });

  it("an external abort stops the retry loop", async () => {
    const { impl, calls } = hangingFetch();
    const controller = new AbortController();
    const pending = fetchWeightsReliably("http://w/x.onnx", goodEntry.bytes, () => {}, {
      fetchImpl: impl,
      stallMs: 1_000_000,
      attempts: 3,
      backoffMs: 0,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("user navigated away"));
    await expect(pending).rejects.toThrow(/user navigated away/);
    expect(calls.count).toBe(1); // no retry after the caller cancelled
  });

  it("a slow-but-alive download is never aborted by the stall budget", async () => {
    // Chunks arrive 30ms apart under a 10s stall budget: exactly the case a
    // total wall-clock timeout would have killed.
    let i = 0;
    const impl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(goodEntry.bytes) },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= 4) return { done: true, value: undefined };
            await new Promise((r) => setTimeout(r, 30));
            i += 1;
            return { done: false, value: new Uint8Array([1]) };
          },
        }),
      },
      arrayBuffer: async () => ab([1, 2, 3, 4]),
    });
    const buf = await fetchWeightsReliably("http://w/x.onnx", goodEntry.bytes, () => {}, {
      fetchImpl: impl,
      stallMs: 10_000,
      attempts: 1,
    });
    expect(bytesOf(buf)).toEqual([1, 1, 1, 1]);
  });

  it("exports the defaults the UI shows as its retry copy", () => {
    expect(WEIGHT_STALL_MS).toBe(20_000);
    expect(WEIGHT_ATTEMPTS).toBe(3);
  });
});

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

  it("uses the manifest size even when Content-Length disagrees", async () => {
    const { impl } = fakeFetch(ab([1, 2, 3, 4]), { contentLength: "4", chunks: 2 });
    const events = [];
    await fetchWeightsWithProgress("http://w/x.onnx", 4, (loaded, total) => events.push({ loaded, total }), {
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
it("verified bytes are usable before the cache write completes", async () => {
  let finish;
  const write = new Promise(resolve => { finish = resolve; });
  const { impl } = fakeFetch(ab([1, 2, 3, 4]));
  const result = await loadVerifiedWeights({ entry: goodEntry, url: "x", fetchImpl: impl, sha256: fakeSha,
    cache: { get: async () => null, put: () => write } });
  expect(bytesOf(result.buf)).toEqual([1, 2, 3, 4]);
  finish(true);
  expect(await result.cacheWrite).toBe(true);
});
it("oversized streams stop at the manifest bound", async () => {
  let reads = 0, cancelled = false, released = false;
  const fetchImpl = async () => ({ ok: true, headers: { get: () => null }, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(3) }; },
    cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; },
  }) } });
  await expect(fetchWeightsWithProgress("x", 4, () => {}, { fetchImpl })).rejects.toThrow(/exceeds manifest/);
  expect(reads).toBe(2); expect(cancelled).toBe(true); expect(released).toBe(true);
});
it("a failed cache write does not fail verified model initialization", async () => {
  const { impl } = fakeFetch(ab([1, 2, 3, 4]));
  const result = await loadVerifiedWeights({ entry: goodEntry, url: "x", fetchImpl: impl, sha256: fakeSha,
    cache: { get: async () => null, put: async () => { throw Error("quota"); } } });
  expect(await result.cacheWrite).toBe(false);
});
