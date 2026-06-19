import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Dev-only save endpoint for the coach-review harness: it POSTs its ratings here and we
// write them straight to coach-review-ratings.json at the repo root, so the rate→tweak
// loop doesn't go through a browser download. The path is deliberately NOT under /api (so
// the proxy to the Python server never claims it) and the whole thing is serve-only, so it
// never exists in a built/deployed image.
function coachReviewSavePlugin() {
  const out = fileURLToPath(new URL("./coach-review-ratings.json", import.meta.url));
  return {
    name: "coach-review-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/__save-coach-review") {
          return next();
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "[]");
            writeFileSync(out, JSON.stringify(parsed, null, 2), "utf-8");
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, count: Array.isArray(parsed) ? parsed.length : 0 }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

// ORT's threaded WASM runtime does import('/engine/ort/ort-wasm-simd-threaded.asyncify.mjs')
// at runtime. In Vite dev mode, Vite's module resolver intercepts this *before* any
// middleware runs and throws "file is in /public … should not be imported from source
// code." The fix: claim the path in resolveId (preventing the public-dir guard) and
// return the file content in load. The middleware serves it as a plain HTTP asset for
// the non-import fetch path (e.g. <script src>). Build is unaffected — Vite copies
// public/ as-is; ORT fetches the .mjs via wasmPaths, never through Rollup.
function publicMjsPlugin() {
  const publicDir = fileURLToPath(new URL("./web-src/public", import.meta.url));
  return {
    name: "public-mjs-serve",
    apply: "serve",
    resolveId(id) {
      if (id.endsWith(".mjs") && id.startsWith("/engine/")) return "\0public-mjs:" + id;
    },
    load(id) {
      if (!id.startsWith("\0public-mjs:")) return;
      const path = id.slice("\0public-mjs:".length);
      const abs = resolve(publicDir, "." + path);
      if (!abs.startsWith(publicDir)) return; // path traversal guard
      try {
        return readFileSync(abs, "utf-8");
      } catch (_) {}
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.endsWith(".mjs") || !url.startsWith("/engine/")) return next();
        const abs = resolve(publicDir, "." + url);
        if (!abs.startsWith(publicDir)) return next();
        let content;
        try { content = readFileSync(abs, "utf-8"); } catch (_) { return next(); }
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.end(content);
      });
    },
  };
}

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
  plugins: [publicMjsPlugin(), coachReviewSavePlugin(), trimDeployAssets()],
  build: {
    outDir: fileURLToPath(
      new URL("./src/prepforge_chess/web/static", import.meta.url),
    ),
    emptyOutDir: true,
    // Source maps are OFF for the committed deploy build: they added ~1.6 MB of
    // .map files to the wheel (index ~1 MB, maia3-worker ~0.5 MB), were served as
    // public static assets, and effectively published the original source. Opt in
    // for a local debugging build with `VITE_SOURCEMAP=1 npm run build`. The dev
    // server (`npm run dev`) always has source maps regardless of this flag.
    sourcemap: process.env.VITE_SOURCEMAP === "1",
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
    // Cross-origin isolation in dev, mirroring the production static server EXACTLY
    // (api/static.py already serves COOP: same-origin + COEP: require-corp). The browser
    // engines (Stockfish / onnxruntime threaded WASM) need crossOriginIsolated, which
    // requires these on the document — without them `npm run dev` runs engines OFF and
    // the Analyze coach / coach-review harness can't evaluate. Safe by construction: any
    // resource the app loads already works under require-corp in prod, so matching it in
    // dev cannot break anything prod doesn't.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
