// One compiled module per immutable URL per page; Cache Storage holds only bytes.
const CACHE_NAME = "prepforge-stockfish";

export class EngineAssetError extends Error {
  constructor(cause) {
    super(`Engine asset failed: ${cause.message}`, { cause });
    this.name = "EngineAssetError";
  }
}

export function createEngineAssetManager({
  builds = globalThis.__STOCKFISH__,
  fetchAsset = (...args) => fetch(...args),
  cacheStorage = () => globalThis.caches,
  wasm = WebAssembly,
} = {}) {
  const entries = new Map();
  const urlFor = net => `/static/engine/${builds[net].dir}/stockfish.wasm`;
  const folders = new Set(Object.values(builds).map(b => b.dir));
  function entryFor(net) {
    const url = urlFor(net);
    if (!entries.has(url)) entries.set(url, {
      state: { net, phase: "idle", loaded: 0, total: builds[net].bytes, error: null },
      listeners: new Set(), promise: null, generation: 0, abort: null,
    });
    return entries.get(url);
  }
  function emit(entry, changes) {
    Object.assign(entry.state, changes);
    for (const fn of [...entry.listeners]) {
      try { fn({ ...entry.state }); } catch { /* consumer error */ }
    }
  }
  async function prune(cache) {
    for (const key of await cache.keys()) {
      const folder = new URL(key.url).pathname.match(/^\/static\/engine\/([0-9a-f]{8})\//)?.[1];
      if (folder && !folders.has(folder)) await cache.delete(key);
    }
  }
  // A net this device no longer runs keeps no bytes: the load in flight is
  // stopped, the entry starts over, and its cached file is gone. A load that was
  // already running cannot write behind the delete (see `live` below).
  async function remove(net) {
    const entry = entryFor(net);
    entry.generation++;
    entry.abort?.();
    entry.abort = null;
    entry.promise = null;
    emit(entry, { phase: "idle", loaded: 0, error: null });
    try {
      const cache = await cacheStorage()?.open(CACHE_NAME);
      await cache?.delete(urlFor(net));
    } catch { /* denied, private mode or already evicted */ }
  }
  async function load(entry, url) {
    const generation = entry.generation;
    const live = () => entry.generation === generation;
    let cache, response;
    try {
      cache = await cacheStorage()?.open(CACHE_NAME);
      response = await cache?.match(url);
    } catch { /* denied, private mode or eviction: use the network */ }
    const cached = !!response;
    emit(entry, { phase: cached ? "compile" : "download" });
    if (!response) response = await fetchAsset(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
    if (!live()) throw new Error(`net ${entry.state.net} removed`);

    // Cache.put consumes its stream concurrently. Await each write so a slower
    // cache consumer cannot accumulate an entire second net in a tee/clone queue.
    let writer, stored;
    if (cache && !cached) {
      const stream = new TransformStream();
      writer = stream.writable.getWriter();
      stored = Promise.resolve().then(() => cache.put(url, new Response(stream.readable, {
        headers: { "Content-Type": "application/wasm" },
      }))).then(() => {
        void prune(cache).catch(() => {});
      }).catch(() => {
        const failed = writer;
        writer = null;
        void failed?.abort().catch(() => {});
      });
    }
    const reader = response.body?.getReader();
    let stopped = false;
    // remove() fails the stream a consumer is reading: the read that is waiting
    // rejects at once, so the load ends here instead of after the whole net.
    let failStream = null;
    const counted = new ReadableStream({
      async pull(controller) {
        failStream = (reason) => { stopped = true; try { controller.error(reason); } catch { /* already closed */ } };
        try {
          const chunk = reader ? await reader.read() : { done: true };
          if (stopped || !live()) return;
          if (chunk.done) {
            // Responses without streaming bodies still use exactly one byte read.
            if (!reader) {
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (writer) await Promise.race([writer.write(bytes), stored]).catch(() => {});
              if (stopped || !live()) return;
              controller.enqueue(bytes);
              emit(entry, { loaded: bytes.byteLength });
            }
            if (writer) void writer.close().catch(() => {});
            emit(entry, { phase: "compile" });
            controller.close();
          } else {
            emit(entry, { loaded: entry.state.loaded + chunk.value.byteLength });
            if (writer) await Promise.race([writer.write(chunk.value), stored]).catch(() => {});
            if (stopped || !live()) return;
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (writer) void writer.abort(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        stopped = true;
        if (writer) void writer.abort(reason).catch(() => {});
        return reader?.cancel(reason);
      },
    });
    entry.abort = () => { stopped = true; failStream?.(new Error(`net ${entry.state.net} removed`)); void counted.cancel().catch(() => {}); };
    const input = new Response(counted, { headers: { "Content-Type": "application/wasm" } });
    // MIME is normalized above, so an actual compile error is never retried as a
    // second download. Older engines without streaming compile consume bytes once.
    try {
      const module = reader && typeof wasm.compileStreaming === "function"
        ? await wasm.compileStreaming(input)
        : await wasm.compile(await input.arrayBuffer());
      emit(entry, { phase: "ready" });
      return module;
    } catch (error) {
      // A streaming compiler can reject before EOF. Stop both consumers then,
      // rather than leaving a fetch or cache write waiting on abandoned pulls.
      stopped = true;
      if (writer) void writer.abort(error).catch(() => {});
      await reader?.cancel(error).catch(() => {});
      throw error;
    }
  }
  return {
    engineAssetState(net) { return { ...entryFor(net).state }; },
    loadEngineModule(net) {
      const entry = entryFor(net);
      const generation = entry.generation;
      entry.promise ||= Promise.resolve().then(() => load(entry, urlFor(net))).catch(cause => {
        const error = new EngineAssetError(cause);
        // A load stopped by remove() is not this net's failure: the entry is
        // already back to idle, and the next yes downloads again.
        if (entry.generation === generation) emit(entry, { phase: "error", error });
        throw error;
      });
      return entry.promise;
    },
    removeEngineAsset: remove,
    subscribeEngineAsset(net, fn) {
      const entry = entryFor(net);
      entry.listeners.add(fn);
      fn({ ...entry.state });
      return () => entry.listeners.delete(fn);
    },
  };
}

export const { loadEngineModule, removeEngineAsset, subscribeEngineAsset, engineAssetState } = createEngineAssetManager();
