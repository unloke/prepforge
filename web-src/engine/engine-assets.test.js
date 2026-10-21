import { describe, expect, it, vi } from "vitest";
import { createEngineAssetManager, EngineAssetError } from "./engine-assets.js";

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const builds = { big: { dir: "1234abcd", bytes: bytes.length }, lite: { dir: "5678abcd", bytes: bytes.length } };
const url = net => `/static/engine/${builds[net].dir}/stockfish.wasm`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(options = {}) {
  const saved = new Map();
  const cache = {
    match: vi.fn(async key => saved.has(key) ? new Response(saved.get(key)) : undefined),
    put: vi.fn(async (key, response) => { saved.set(key, await response.arrayBuffer()); }),
    keys: vi.fn(async () => [...saved.keys()].map(key => ({ url: new URL(key, "https://test.invalid").href }))),
    delete: vi.fn(async key => saved.delete(typeof key === "string" ? key : new URL(key.url).pathname)),
  };
  const module = {};
  const wasm = {
    compileStreaming: vi.fn(async response => { expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes); return module; }),
    compile: vi.fn(async buffer => { expect(new Uint8Array(buffer)).toEqual(bytes); return module; }),
  };
  const fetchAsset = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 4));
      controller.enqueue(bytes.slice(4));
      controller.close();
    },
  }), { headers: { "Content-Type": "application/octet-stream", "Content-Length": "2" } }));
  const cacheStorage = vi.fn(() => ({ open: vi.fn(async () => cache) }));
  const manager = createEngineAssetManager({ builds, fetchAsset, cacheStorage, wasm, ...options });
  return { ...manager, saved, cache, fetchAsset, cacheStorage, wasm, module };
}

describe("shared engine assets", () => {
  it("fetches and compiles each URL once, replays state and uses exact manifest bytes", async () => {
    const f = fixture(), states = [], late = [];
    const unsubscribe = f.subscribeEngineAsset("big", state => states.push(state));
    expect(states).toEqual([{ net: "big", phase: "idle", loaded: 0, total: 8, error: null }]);
    const first = f.loadEngineModule("big");
    expect(f.loadEngineModule("big")).toBe(first);
    expect(await first).toBe(f.module);
    expect(f.engineAssetState("big")).toMatchObject({ phase: "ready", loaded: 8, total: 8 });
    const snapshot = f.engineAssetState("big"); snapshot.phase = "idle";
    expect(f.engineAssetState("big").phase).toBe("ready");
    expect(f.fetchAsset).toHaveBeenCalledExactlyOnceWith(url("big"));
    expect(f.wasm.compileStreaming).toHaveBeenCalledTimes(1);
    expect(states.map(s => s.phase)).toEqual(["idle", "download", "download", "download", "compile", "ready"]);
    expect(states.map(s => s.loaded)).toEqual([0, 0, 4, 8, 8, 8]);
    f.subscribeEngineAsset("big", state => late.push(state));
    expect(late).toEqual([{ net: "big", phase: "ready", loaded: 8, total: 8, error: null }]);
    unsubscribe();
    await f.loadEngineModule("lite");
    expect(states).toHaveLength(6);
    expect(f.fetchAsset).toHaveBeenCalledTimes(2);
  });

  it("recompiles stored bytes on another visit without network and keeps both current folders", async () => {
    const f = fixture();
    f.saved.set("/static/engine/deadbeef/stockfish.wasm", bytes);
    f.saved.set(url("lite"), bytes);
    f.saved.set("/static/engine/ort/ort.wasm", bytes);
    await f.loadEngineModule("big");
    await tick(); // persistence/pruning is independent of readiness
    expect(f.saved.has("/static/engine/deadbeef/stockfish.wasm")).toBe(false);
    expect(f.saved.has(url("lite"))).toBe(true);
    expect(f.saved.has("/static/engine/ort/ort.wasm")).toBe(true);
    const reload = createEngineAssetManager({ builds, cacheStorage: f.cacheStorage,
      fetchAsset: f.fetchAsset, wasm: f.wasm });
    const phases = [];
    reload.subscribeEngineAsset("big", s => phases.push(s.phase));
    await reload.loadEngineModule("big");
    expect(phases).not.toContain("download");
    expect(f.fetchAsset).toHaveBeenCalledTimes(1);
    expect(f.wasm.compileStreaming).toHaveBeenCalledTimes(2);
  });

  it("keeps one promise when a progress listener requests the module with cache access denied", async () => {
    const f = fixture({ cacheStorage: () => { throw new Error("denied"); } });
    let joined;
    f.subscribeEngineAsset("big", state => {
      if (state.phase === "download") joined = f.loadEngineModule("big");
    });
    const first = f.loadEngineModule("big");
    await first;
    expect(joined).toBe(first);
    expect(f.fetchAsset).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "open", "match", "put", "put-after-read", "keys", "delete"])(
    "cache %s failure leaves network compilation usable", async boundary => {
      const f = fixture();
      f.saved.set("/static/engine/deadbeef/stockfish.wasm", bytes);
      const denied = () => { throw new Error("denied/quota/private mode"); };
      if (boundary === "unavailable") f.cacheStorage.mockImplementation(denied);
      else if (boundary === "open") f.cacheStorage.mockReturnValue({ open: denied });
      else if (boundary === "put-after-read") f.cache.put.mockImplementation(async (_url, response) => {
        await response.body.getReader().read();
        throw new Error("quota");
      });
      else f.cache[boundary].mockImplementation(denied);
      expect(await f.loadEngineModule("big")).toBe(f.module);
      await tick();
      expect(f.fetchAsset).toHaveBeenCalledTimes(1);
      if (boundary.startsWith("put")) expect(f.cache.delete).not.toHaveBeenCalled();
    });

  it("backpressures a stalled cache reader instead of buffering an unattended clone", async () => {
    let reader, pulls = 0;
    const f = fixture({ fetchAsset: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 2) controller.enqueue(bytes.slice((pulls - 1) * 4, pulls * 4));
        else controller.close();
      },
    }, { highWaterMark: 0 })) });
    f.cache.put.mockImplementation(async (_key, response) => {
      reader = response.body.getReader();
      // Simulate Cache Storage not reading yet.
      await new Promise(resolve => { f.resumeCache = resolve; });
      while (!(await reader.read()).done) { /* drain */ }
    });
    const pending = f.loadEngineModule("big");
    await tick();
    expect(pulls).toBe(1);
    f.resumeCache();
    expect(await pending).toBe(f.module);
  });

  it("uses one byte compile when compileStreaming is absent or the response has no body", async () => {
    const f = fixture();
    f.wasm.compileStreaming = undefined;
    await f.loadEngineModule("big");
    expect(f.wasm.compile).toHaveBeenCalledTimes(1);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const noBody = fixture({ fetchAsset: async () => ({ ok: true, body: null, arrayBuffer }) });
    await noBody.loadEngineModule("big");
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(noBody.wasm.compile).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "http", "stream", "compile"])("replays %s errors without refetch or recompilation", async boundary => {
    const f = fixture(), states = [];
    if (boundary === "network") f.fetchAsset.mockRejectedValue(new Error("offline"));
    if (boundary === "http") f.fetchAsset.mockResolvedValue(new Response(null, { status: 503 }));
    if (boundary === "stream") f.fetchAsset.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("download interrupted")); },
    })));
    if (boundary === "compile") f.wasm.compileStreaming.mockImplementation(async response => {
      await response.arrayBuffer();
      throw new WebAssembly.CompileError("invalid wasm");
    });
    const pending = f.loadEngineModule("big");
    await expect(pending).rejects.toBeInstanceOf(EngineAssetError);
    f.subscribeEngineAsset("big", state => states.push(state));
    expect(states[0]).toMatchObject({ net: "big", phase: "error", total: 8, error: expect.any(EngineAssetError) });
    expect(f.loadEngineModule("big")).toBe(pending);
    await expect(f.loadEngineModule("big")).rejects.toBeInstanceOf(EngineAssetError);
    expect(f.fetchAsset).toHaveBeenCalledTimes(1);
    expect(f.wasm.compile).not.toHaveBeenCalled();
  });

  it("cancels an early compile rejection without leaving a cache write or progress running", async () => {
    const cancel = vi.fn();
    const f = fixture({ fetchAsset: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(bytes); }, cancel,
    }, { highWaterMark: 0 })) });
    f.wasm.compileStreaming.mockRejectedValue(new WebAssembly.CompileError("invalid header"));
    const states = [];
    f.subscribeEngineAsset("big", state => states.push(state));
    await expect(f.loadEngineModule("big")).rejects.toBeInstanceOf(EngineAssetError);
    await tick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(states.at(-1).phase).toBe("error");
    expect(f.cache.delete).not.toHaveBeenCalled();
  });

  // A device that steps down from the full net keeps none of its 94 MB: the
  // cached file goes and the entry starts over, so a later yes downloads again.
  it("deletes a net's cached bytes and forgets its module", async () => {
    const f = fixture();
    await f.loadEngineModule("big");
    await tick();
    expect(f.saved.has(url("big"))).toBe(true);
    await f.removeEngineAsset("big");
    expect(f.cache.delete).toHaveBeenCalledWith(url("big"));
    expect(f.saved.has(url("big"))).toBe(false);
    expect(f.engineAssetState("big")).toMatchObject({ phase: "idle", loaded: 0 });
    const again = f.loadEngineModule("big");
    expect(await again).toBe(f.module);
    expect(f.fetchAsset).toHaveBeenCalledTimes(2);
    expect(f.wasm.compileStreaming).toHaveBeenCalledTimes(2);
  });

  it("stops an in-flight download before deleting, so nothing is written behind it", async () => {
    const gates = [];
    const f = fixture({ fetchAsset: async () => new Response(new ReadableStream({
      start(controller) { gates.push(() => { controller.enqueue(bytes); controller.close(); }); },
    }, { highWaterMark: 0 })) });
    const pending = f.loadEngineModule("big").catch(error => error);
    await tick();
    expect(f.saved.has(url("big"))).toBe(false);
    await f.removeEngineAsset("big");
    expect(await pending).toBeInstanceOf(EngineAssetError);
    expect(f.saved.has(url("big"))).toBe(false);
    expect(f.cache.delete).toHaveBeenCalledWith(url("big"));
    expect(f.engineAssetState("big")).toMatchObject({ phase: "idle", loaded: 0 });
    // The next load is a real download, not the stopped one.
    const next = f.loadEngineModule("big");
    await tick();
    gates[1]();
    expect(await next).toBe(f.module);
    expect(f.wasm.compileStreaming).toHaveBeenCalledTimes(2);
  });
});
