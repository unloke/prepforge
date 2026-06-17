import { describe, it, expect, afterEach } from "vitest";

import { resolveEngineBase, ortWasmPaths } from "./engine-base.js";

describe("engine-base", () => {
  const saved = globalThis.__ENGINE_ASSET_BASE;

  afterEach(() => {
    if (saved === undefined) delete globalThis.__ENGINE_ASSET_BASE;
    else globalThis.__ENGINE_ASSET_BASE = saved;
  });

  it("falls back to a local prefix string when the global is unset", () => {
    delete globalThis.__ENGINE_ASSET_BASE;
    expect(resolveEngineBase()).toBeNull();
    expect(ortWasmPaths()).toBe("/static/engine/ort/");
  });

  it("keeps the .mjs glue local and points only the .wasm at the CDN", () => {
    globalThis.__ENGINE_ASSET_BASE = "https://cdn.example.com/repo";
    expect(resolveEngineBase()).toBe("https://cdn.example.com/repo/");
    expect(ortWasmPaths()).toEqual({
      mjs: "/static/engine/ort/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "https://cdn.example.com/repo/engine/ort/ort-wasm-simd-threaded.asyncify.wasm",
    });
  });
});
