// Maia3 weight loading: resolve VERIFIED model bytes from cache or network, with a real
// download-progress stream (docs/browser-engine-migration.md Phase 3c, Stage 4b).
//
// Split out of maia3-worker.js so it carries NO onnxruntime-web import and is fully
// dependency-injectable (fetch / sha256 / cache) — the worker can't be unit-tested in node
// (it imports ORT), but this orchestration (the part with the cache-corruption fallback and
// the progress math) can, and IS (maia3-weights-loader.test.js). The worker just calls
// loadVerifiedWeights() and hands the bytes to InferenceSession.create.

import {
  getCachedWeights,
  putCachedWeights,
  deleteCachedWeights,
} from "./maia3-weight-cache.js";

export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// A 46 MB download that stops receiving bytes is indistinguishable from a slow
// network until it isn't: the reported "stuck at 37% for 120s" is a stall, not a
// slow link. So the budget is silence-based (no bytes for N seconds), never a
// total wall-clock budget that a slow-but-alive connection would burn through.
export const WEIGHT_STALL_MS = 20_000;
// Two extra attempts with backoff: enough to ride out a dead CDN edge or a
// dropped connection; the caller's own Retry covers anything else.
export const WEIGHT_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Backoff between attempts (see the retry wrapper below).
const RETRY_BACKOFF_MS = 1_000;

// The stall error is ours, so it carries a stable shape: the name a fetch uses when
// its signal fires, plus text that names the url and the silence budget. A
// spec-compliant fetch rejects with abort()'s reason, so this readable text survives
// the trip through the real fetch instead of being replaced by a generic message.
function stallError(url, stallMs) {
  const error = new Error(
    `weight download stalled: no bytes from ${url} for ${Math.round(stallMs / 1000)}s`,
  );
  error.name = "AbortError";
  return error;
}

// One fetch attempt, aborted if no bytes arrive for `stallMs`. The
// AbortController is owned here, so a stalled stream is torn down rather than
// left hanging on a connection that will not deliver.
async function fetchWeightsOnce(url, expectedBytes, onProgress, { fetchImpl, stallMs, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  // Reset every time bytes actually arrive, so the clock measures silence.
  let stalled = setTimeout(() => controller.abort(stallError(url, stallMs)), stallMs);
  const keepAlive = () => {
    clearTimeout(stalled);
    stalled = setTimeout(() => controller.abort(stallError(url, stallMs)), stallMs);
  };
  try {
    return await fetchWeightsWithProgress(url, expectedBytes, onProgress, {
      fetchImpl,
      signal: controller.signal,
      keepAlive,
    });
  } finally {
    clearTimeout(stalled);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// The download with the stall timeout and retries. A partial is never cached
// (only a fully verified buffer is written), so a retry always starts clean.
// `onAttempt` lets the UI say it is trying again.
export async function fetchWeightsReliably(
  url,
  expectedBytes,
  onProgress,
  {
    fetchImpl = fetch,
    stallMs = WEIGHT_STALL_MS,
    attempts = WEIGHT_ATTEMPTS,
    backoffMs = RETRY_BACKOFF_MS,
    signal,
    onAttempt,
  } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw signal.reason || new Error("weight download aborted");
    if (attempt > 1) {
      await sleep(backoffMs);
      // Fires when the retry really starts, so the byte count restarts then rather
      // than while the backoff is still running.
      onAttempt?.(attempt);
    }
    try {
      return await fetchWeightsOnce(url, expectedBytes, onProgress, { fetchImpl, stallMs, signal });
    } catch (error) {
      lastError = error;
      // A caller-initiated abort is a cancellation, not a failure to retry.
      if (signal?.aborted) throw signal.reason || error;
      if (attempt === attempts) break;
      if (!isRetryableTransportError(lastError)) break;
    }
  }
  throw lastError;
}

// A wrong-size or wrong-hash body is a real mismatch, not a flaky connection:
// retrying it would burn three backoffs to get the same wrong bytes. Only
// transport failures (stall, reset, 5xx) are worth another attempt.
const RETRYABLE_FETCH = /fetch failed|networkerror|network error|load failed|connection|reset|aborted|timed? ?out|stall|5\d\d|weight fetch 5\d\d/i;

function isRetryableTransportError(error) {
  const message = String(error?.message || "");
  if (/weight size mismatch/.test(message)) return false;
  return RETRYABLE_FETCH.test(message);
}

// Stream the weight download so the caller can show real progress. Each chunk reports
// cumulative bytes against `expectedBytes` (the manifest size) — NOT the raw
// Content-Length, which a server may omit (then `total` would be 0 and every chunk would
// look like 100%). Content-Length wins when present and sane; otherwise we fall back to the
// manifest size so the percentage is meaningful. Falls back to a single arrayBuffer() read
// when the runtime can't stream a body.
export async function fetchWeightsWithProgress(url, expectedBytes, onProgress, { fetchImpl = fetch, signal = null, keepAlive = null } = {}) {
  const resp = await fetchImpl(url, { signal });
  if (!resp.ok) {
    throw new Error(`weight fetch ${resp.status} for ${url}`);
  }
  const headerTotal = Number(resp.headers.get("content-length")) || 0;
  const total = expectedBytes || headerTotal || 0;
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    if (expectedBytes && buf.byteLength !== expectedBytes) throw new Error("weight size mismatch");
    onProgress(buf.byteLength, total || buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const out = expectedBytes ? new Uint8Array(expectedBytes) : null;
  const chunks = out ? null : [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (out && loaded + value.byteLength > out.byteLength) {
        await reader.cancel?.();
        throw new Error("weight size mismatch: download exceeds manifest");
      }
      if (out) out.set(value, loaded);
      else chunks.push(value);
      loaded += value.byteLength;
      // Bytes arrived: the silence clock restarts. A no-op without the retry wrapper.
      keepAlive?.();
      onProgress(loaded, total || loaded);
    }
  } finally { reader.releaseLock?.(); }
  if (out) {
    if (loaded !== expectedBytes) throw new Error("weight size mismatch: download truncated");
    return out.buffer;
  }
  const assembled = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return assembled.buffer;
}

// Resolve verified weight bytes for `entry.file`:
//   1. cache hit → verify (size + sha256). If it FAILS, evict the bad key and fall through
//      to the network — a corrupt cache must never permanently wedge init.
//   2. network fetch (cold start or evicted-corrupt cache) → verify. A bad network response
//      is a genuine failure (throws). On success, persist the verified bytes for next time.
// The integrity gate is the SAME for cache and network bytes: the manifest is the source of
// truth, the cache is only a speed optimization. Returns { buf, fromCache }.
export async function loadVerifiedWeights({
  entry,
  url,
  report = () => {},
  cache = { get: getCachedWeights, put: putCachedWeights, del: deleteCachedWeights },
  fetchImpl = fetch,
  sha256 = sha256Hex,
  signal = null,
  stallMs = WEIGHT_STALL_MS,
  attempts = WEIGHT_ATTEMPTS,
  backoffMs = RETRY_BACKOFF_MS,
} = {}) {
  const file = entry.file;

  const verify = async (bytes) => {
    if (bytes.byteLength !== entry.bytes) {
      return `size mismatch for ${file}: got ${bytes.byteLength} B != manifest ${entry.bytes} B`;
    }
    const sha = await sha256(bytes);
    if (sha !== entry.sha256) {
      return `sha256 mismatch for ${file}: got ${sha} != manifest ${entry.sha256}`;
    }
    return null;
  };

  // 1) Cache first.
  const cached = await cache.get(file);
  if (cached) {
    report("cache", entry.bytes, entry.bytes);
    report("verify", 0, entry.bytes);
    const bad = await verify(cached);
    if (!bad) return { buf: cached, fromCache: true };
    // Corrupt/stale cached blob: evict and re-fetch rather than failing forever.
    await cache.del(file);
  }

  // 2) Network.
  report("download", 0, entry.bytes);
  const fetched = await fetchWeightsReliably(
    url,
    entry.bytes,
    (loaded, total) => report("download", loaded, total),
    {
      fetchImpl,
      signal,
      stallMs,
      attempts,
      backoffMs,
      // A retry starts the byte count over, which is what actually happened.
      onAttempt: () => report("download", 0, entry.bytes),
    },
  );
  report("verify", 0, entry.bytes);
  const bad = await verify(fetched);
  if (bad) throw new Error(bad); // a bad network response is a real error, not a fallback
  // Cache writes may outlive init; terminating the worker only loses this cache.
  const cacheWrite = Promise.resolve().then(() => cache.put(file, fetched)).catch(() => false);
  return { buf: fetched, fromCache: false, cacheWrite };
}
