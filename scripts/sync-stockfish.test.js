import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import { capSharedHeap, injectSharedHeap, discoverStockfishBuild, stockfishBuild, stockfishIdentity, syncStockfish, MAX_HEAP_PAGES } from "./sync-stockfish.mjs";
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "src/prepforge_chess/web/static/engine/stockfish.manifest.json"), "utf8"));
describe("Stockfish package synchronization", () => {
  it.each(["big", "lite"])("discovers and bundles the %s threaded pair with net identity", net => {
    const suffix = net === "lite" ? "-lite" : "";
    expect(discoverStockfishBuild({ net, packageJson: { version: "99.1.0", buildVersion: "99" },
      files: [`stockfish-99${suffix}.js`, `stockfish-99${suffix}.wasm`] })).toEqual({
      sourceJs: `stockfish-99${suffix}.js`, sourceWasm: `stockfish-99${suffix}.wasm`, buildVersion: "99" });
    const build = stockfishBuild(net);
    expect(build.dir).toMatch(/^[a-f0-9]{8}$/);
    expect(build.id).toContain(build.nets.join("+"));
    expect(build.files.script.data).toContain(`maximum:${MAX_HEAP_PAGES[net]},shared:!0`);
    expect(build.files.script.data).toContain('f={wasmMemory:f.wasmMemory,locateFile:');
    expect(build.files.script.data).toContain('if(e.data.wasmMemory){f.wasmMemory=e.data.wasmMemory;i();return}');
    expect(build.files.script.data).not.toContain('i(),onmessage=onmessage||');
    expect(stockfishIdentity()[net]).toMatchObject({
      packageVersion: manifest.engines[net].packageVersion,
      initialHeapPages: manifest.engines[net].initialHeapPages,
      maxHeapPages: MAX_HEAP_PAGES[net],
    });
  });
  it("ships both distinct hashed folders and complete manifest metadata", () => {
    const manifest = syncStockfish();
    expect(manifest.engines.big.dir).not.toBe(manifest.engines.lite.dir);
    for (const net of ["big", "lite"]) {
      const b = manifest.engines[net];
      expect(b.files.script.bundled).toBe(`${b.dir}/stockfish.js`);
      expect(b.files.wasm.bundled).toBe(`${b.dir}/stockfish.wasm`);
      expect(b.id).toBe(`sf${b.engineVersion}@${b.packageVersion}+${b.files.wasm.sha256.slice(0, 8)}/${b.nets.join("+")}`);
      expect(readFileSync(join(root, "web-src/public/engine", b.files.script.bundled), "utf8"))
        .toContain(`maximum:${MAX_HEAP_PAGES[net]},shared:!0`);
    }
  });
  it("fails on changed layout or memory declaration", () => {
    expect(() => discoverStockfishBuild({ net: "big", packageJson: { version: "99", buildVersion: "99" },
      files: ["stockfish-99.js"] })).toThrow(/missing WASM pair/);
    expect(() => capSharedHeap("new WebAssembly.Memory({initial:1})", "big")).toThrow(/changed upstream/);
    expect(() => injectSharedHeap("changed")).toThrow(/changed upstream/);
    const upstream = readFileSync(join(root, "node_modules/stockfish/bin", manifest.engines.big.files.script.source), "utf8");
    expect(() => injectSharedHeap(upstream.replace('i(),onmessage=', 'changed(),onmessage='))).toThrow(/changed upstream/);
    expect(() => injectSharedHeap(upstream + upstream)).toThrow(/changed upstream/);
  });

  it.each(["big", "lite"])("injects %s in the browser worker while preserving the pthread load handler", async net => {
    const script = stockfishBuild(net).files.script.data;
    // Stub only the WASM factory. Execute the real outer glue, including its
    // branch selection and both pthread onmessage assignments, without an engine.
    const start = script.indexOf("function d(){");
    const end = script.indexOf('function n(e){if(f.ccall(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const glue = script.slice(0, start) + 'function d(){return globalThis.fakeFactory}' + script.slice(end);
    const memory = { buffer: {} }, commands = vi.fn();
    function context(hash) {
      const ctx = { onmessage: null, location: { hash, origin: "https://test.invalid", pathname: "/stockfish.js" },
        postMessage: vi.fn(), console, fakeFactory: vi.fn(module => {
          module.ccall = commands; module._isReady = () => true; module._pthread_self = () => 0;
          return Promise.resolve(module);
        }) };
      ctx.self = ctx;
      runInNewContext(glue, ctx);
      return ctx;
    }
    const browser = context("");
    expect(browser.fakeFactory).not.toHaveBeenCalled(); // no allocation before the reservation arrives
    browser.onmessage({ data: { wasmMemory: memory } });
    browser.onmessage({ data: "uci" });
    await Promise.resolve();
    expect(browser.fakeFactory).toHaveBeenCalledTimes(1);
    expect(browser.fakeFactory.mock.calls[0][0].wasmMemory).toBe(memory);
    expect(commands).toHaveBeenCalledWith("command", null, ["string"], ["uci"], { async: false });

    const pthread = context("#stockfish.wasm,worker");
    expect(pthread.fakeFactory).not.toHaveBeenCalled();
    expect(pthread.onmessage).not.toBe(pthread._origOnmessage); // the final pthread wrapper wins
    const wasmModule = {};
    pthread.onmessage({ data: { cmd: "load", wasmMemory: memory, wasmModule } });
    await Promise.resolve();
    expect(pthread.fakeFactory).toHaveBeenCalledTimes(1);
    expect(pthread.fakeFactory.mock.calls[0][0]).toMatchObject({
      wasmMemory: memory, buffer: memory.buffer, wasmModule, ENVIRONMENT_IS_PTHREAD: true,
    });
    expect(pthread.fakeFactory.mock.calls[0][0].locateFile).toBeUndefined(); // browser i() did not run
    pthread._origOnmessage = vi.fn(pthread._origOnmessage);
    pthread.onmessage({ data: { cmd: "processThreadQueue" } });
    expect(pthread._origOnmessage).toHaveBeenCalledTimes(1);
  });
});
