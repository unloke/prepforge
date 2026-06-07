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

// Stream the weight download so the caller can show real progress. Each chunk reports
// cumulative bytes against `expectedBytes` (the manifest size) — NOT the raw
// Content-Length, which a server may omit (then `total` would be 0 and every chunk would
// look like 100%). Content-Length wins when present and sane; otherwise we fall back to the
// manifest size so the percentage is meaningful. Falls back to a single arrayBuffer() read
// when the runtime can't stream a body.
export async function fetchWeightsWithProgress(url, expectedBytes, onProgress, { fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    throw new Error(
      `weight fetch ${resp.status} for ${url}. The ONNX weights are not under that base. ` +
        `Point the runtime at a host that serves them (asset base is resolved on the main ` +
        `thread and passed into this worker).`,
    );
  }
  const headerTotal = Number(resp.headers.get("content-length")) || 0;
  const total = headerTotal || expectedBytes || 0;
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    onProgress(buf.byteLength, total || buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total || loaded);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
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
  const fetched = await fetchWeightsWithProgress(
    url,
    entry.bytes,
    (loaded, total) => report("download", loaded, total),
    { fetchImpl },
  );
  report("verify", 0, entry.bytes);
  const bad = await verify(fetched);
  if (bad) throw new Error(bad); // a bad network response is a real error, not a fallback
  await cache.put(file, fetched); // persist verified bytes (best-effort)
  return { buf: fetched, fromCache: false };
}
