import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Keeps two kinds of large, redundant binaries out of the committed static/ deploy
// image. Both would otherwise bloat the image with bytes the runtime never serves.
//
//  1. ONNX weights: web-src/public/maia3/ holds the git-ignored binaries (fp16
//     ~46 MB, fp32 ~91 MB) next to the tracked manifest. Vite's publicDir copy is
//     all-or-nothing, so a plain build drags ~137 MB into static/ — but the design
//     is "ONNX is CDN/object-store hosted, never in the image" (only the small
//     manifest ships in-image). We strip the copied weights from the output,
//     keeping the manifest. The transient copy is local-only.
//
//  2. ort runtime wasm: importing onnxruntime-web makes Rollup emit a ~23 MB
//     `assets/ort-wasm-*.wasm` from the bundle's built-in `new URL(...)` default.
//     But the runtime fetches the wasm from `ort.env.wasm.wasmPaths`
//     (/static/engine/ort/, the copy scripts/sync-ort.mjs vendors), so the emitted
//     asset is a never-fetched duplicate. We drop it from the bundle.
function trimDeployAssets() {
  return {
    name: "trim-deploy-assets",
    apply: "build",
    // generateBundle runs before write, so deleting a key prevents the file ever
    // landing in static/. The emitted ort wasm is unused (wasmPaths overrides it).
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/ort-wasm-.*\.wasm$/.test(fileName)) {
          delete bundle[fileName];
          console.log(`[trim-deploy-assets] dropped emitted ${fileName} (vendored at engine/ort/)`);
        }
      }
    },
    // publicDir files are copied at write time, not part of the bundle object, so
    // the ONNX weights are removed here after the copy.
    closeBundle() {
      const dir = fileURLToPath(
        new URL("./src/prepforge_chess/web/static/maia3", import.meta.url),
      );
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        return; // no maia3/ in output (e.g. weights weren't present locally)
      }
      for (const name of names) {
        if (name.endsWith(".onnx") || name.endsWith(".onnx.data")) {
          rmSync(join(dir, name), { force: true });
          console.log(`[trim-deploy-assets] dropped ${name} from build output`);
        }
      }
    },
  };
}

// Dev/CI-only diagnostic entries, included ONLY when MAIA3_HARNESS=1. Kept out of the
// default (deploy) build so the production server never exposes a page that downloads the
// 46 MB model. The provider harness is the one that drives the real worker bundle path
// (importing maia3-provider pulls in `new Worker(new URL("./maia3-worker.js", ...))`, so
// the build emits the maia3-worker chunk with onnxruntime-web bundled inside the worker).
function harnessInputs() {
  // Exact "1" only — so MAIA3_HARNESS=0/false/"" do NOT accidentally ship diagnostics.
  if (process.env.MAIA3_HARNESS !== "1") return {};
  return {
    "maia3-smoke": fileURLToPath(new URL("./web-src/maia3-smoke.html", import.meta.url)),
    "maia3-provider-harness": fileURLToPath(
      new URL("./web-src/maia3-provider-harness.html", import.meta.url),
    ),
  };
}

// The Python server (web/server.py) serves the built app: index.html at "/"
// and every other asset under "/static/*". So Vite builds into the package's
// static dir and prefixes built asset URLs with /static/.
//
// Build artifacts are committed (the deploy image runs `pip install .` with no
// Node), so a build must be run and committed when web-src/ changes.
export default defineConfig({
  root: "web-src",
  base: "/static/",
  plugins: [trimDeployAssets()],
  build: {
    outDir: fileURLToPath(
      new URL("./src/prepforge_chess/web/static", import.meta.url),
    ),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./web-src/index.html", import.meta.url)),
        // Diagnostic pages are DEV/CI-only and MUST NOT ship in the deploy image: each
        // boots onnxruntime-web and pulls a 46 MB model, so a public copy is a free DoS
        // surface on the production server. Opt in with MAIA3_HARNESS=1 (used by the
        // headless gate: `MAIA3_HARNESS=1 npm run build` →
        // scripts/run-provider-harness-headless.mjs). A plain `npm run build` omits them.
        ...harnessInputs(),
      },
    },
  },
  // onnxruntime-web ships a prebuilt ESM bundle that dynamically imports its
  // wasm loader by URL; pre-bundling it makes Vite's dev import-analysis rewrite
  // that dynamic import (…asyncify.mjs?import) and fail. Excluding it leaves the
  // bundle untouched so the loader resolves from ort.env.wasm.wasmPaths.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  server: {
    // `npm run dev` (HMR). API/oauth are proxied to the Python server so the
    // dev server can stay a pure static/asset host. App is at /static/ in dev.
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/oauth": "http://127.0.0.1:8765",
    },
  },
});
