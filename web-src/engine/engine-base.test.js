import { describe, it, expect, afterEach } from "vitest";

import { resolveEngineBase, localEngineBase, ortWasmPaths } from "./engine-base.js";

describe("engine-base", () => {
  const saved = globalThis.__ENGINE_ASSET_BASE;

  afterEach(() => {
    if (saved === undefined) delete globalThis.__ENGINE_ASSET_BASE;
    else globalThis.__ENGINE_ASSET_BASE = saved;
  });

  it("falls back to local paths when the global is unset", () => {
    delete globalThis.__ENGINE_ASSET_BASE;
    expect(resolveEngineBase()).toBeNull();
    expect(localEngineBase()).toBe("/static/engine/");
    expect(ortWasmPaths()).toBe("/static/engine/ort/");
  });

  it("normalizes the injected global and builds the ORT wasm path", () => {
    globalThis.__ENGINE_ASSET_BASE = "https://cdn.example.com/repo";
    expect(resolveEngineBase()).toBe("https://cdn.example.com/repo/");
    expect(ortWasmPaths()).toBe("https://cdn.example.com/repo/engine/ort/");
  });
});