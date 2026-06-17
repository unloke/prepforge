// Resolve the engine WASM base at RUNTIME on the main thread (workers can't see
// window.__ENGINE_ASSET_BASE). Mirrors maia3-provider.js resolveModelBase:
// injected global (production knob) → build-time Vite var → null (local fallback).
//
// HARD RULE learned the hard way: the executable glue (.js/.mjs that spawns pthread
// workers) MUST stay same-origin. Emscripten's pthread bootstrap resolves the worker
// script URL from the main worker's `location.href`; if that origin is a blob: or a
// cross-origin host, the resolution mangles and the engine dies. Only the raw `.wasm`
// BINARY — which is fetched as data (CORS) and then transferred to pthread workers as a
// compiled module — is safe to host cross-origin. So `ortWasmPaths()` below keeps the
// `.mjs` local and points only the big `.wasm` at the CDN.

const LOCAL_ORT_DIR = "/static/engine/ort/";
// onnxruntime-web/webgpu (asyncify) runtime filenames — must match the vendored files
// (scripts/sync-ort.mjs) and what ORT 1.26 requests for this build.
const ORT_MJS_FILE = "ort-wasm-simd-threaded.asyncify.mjs";
const ORT_WASM_FILE = "ort-wasm-simd-threaded.asyncify.wasm";

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

// onnxruntime-web `env.wasm.wasmPaths`. With a remote base set, return the OBJECT form
// (ORT 1.26 Env.WasmFilePaths): keep the `.mjs` glue same-origin (pthread/proxy workers
// spawn from it) and fetch only the ~23 MB `.wasm` binary from the CDN. Without a base,
// return the local prefix string so ORT loads both files from /static/engine/ort/.
export function ortWasmPaths() {
  const base = resolveEngineBase();
  if (!base) return LOCAL_ORT_DIR;
  return {
    mjs: LOCAL_ORT_DIR + ORT_MJS_FILE,
    wasm: `${base}engine/ort/${ORT_WASM_FILE}`,
  };
}
