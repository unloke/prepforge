// Copy the onnxruntime-web runtime (the asyncify build — one threaded-SIMD wasm
// that backs both the WASM CPU EP and the WebGPU EP) out of the npm package into
// web-src/public/engine/ort/ so Vite serves them at /static/engine/ort/*. Runs
// before every build/dev (see package.json `sync-engine`). web-src/public/engine
// is gitignored (regenerated from the pinned npm package); Vite copies public/
// into the committed static dir at build time so the Docker image (pip install .,
// no Node) still ships the runtime.
//
// The `onnxruntime-web/webgpu` entry (ort.webgpu.bundle.min.mjs) loads the
// `.asyncify` variant by name, and maia3-smoke/worker set
// ort.env.wasm.wasmPaths = "/static/engine/ort/" so the runtime fetches it there.
// (Keep this list in sync with whatever filename the chosen ort entry references.)
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "node_modules", "onnxruntime-web", "dist");
const dstDir = join(repoRoot, "web-src", "public", "engine", "ort");

// The asyncify threaded-SIMD wasm serves the WASM CPU EP and hosts the WebGPU
// EP. The .mjs is the loader glue the bundle fetches at runtime alongside .wasm.
const files = [
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
];

mkdirSync(dstDir, { recursive: true });
for (const name of files) {
  const from = join(srcDir, name);
  if (!existsSync(from)) {
    console.error(`[sync-ort] missing ${from} - run \`npm install\` first.`);
    process.exit(1);
  }
  copyFileSync(from, join(dstDir, name));
  console.log(`[sync-ort] copied ${name}`);
}
