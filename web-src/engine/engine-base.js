// Resolve the Stockfish/ORT WASM base at RUNTIME on the main thread (workers can't
// see window.__ENGINE_ASSET_BASE). Mirrors maia3-provider.js resolveModelBase:
// injected global (production knob) → build-time Vite var → null (local fallback).

const LOCAL_ENGINE_BASE = "/static/engine/";
const LOCAL_ORT_WASM_PATHS = "/static/engine/ort/";

/** @returns {string | null} CDN/HF base with trailing slash, or null for local. */
export function resolveEngineBase() {
  const fromGlobal =
    typeof globalThis !== "undefined" ? globalThis.__ENGINE_ASSET_BASE : undefined;
  if (fromGlobal) {
    return String(fromGlobal).replace(/\/?$/, "/");
  }
  const fromVite =
    typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_ENGINE_ASSET_BASE;
  if (fromVite) {
    return String(fromVite).replace(/\/?$/, "/");
  }
  return null;
}

/** Local Stockfish shim + wasm directory (always same-origin). */
export function localEngineBase() {
  return LOCAL_ENGINE_BASE;
}

/** onnxruntime-web wasmPaths: remote ``<base>engine/ort/`` or local fallback. */
export function ortWasmPaths() {
  const base = resolveEngineBase();
  return base ? `${base}engine/ort/` : LOCAL_ORT_WASM_PATHS;
}