// Copy the onnxruntime-web runtime (the asyncify build — one threaded-SIMD wasm
// that backs both the WASM CPU EP and the WebGPU EP) out of the npm package into
// web-src/public/engine/ort/<hash>/ so Vite serves them at
// /static/engine/ort/<hash>/*. Runs before every build/dev (see package.json
// `sync-engine`). web-src/public/engine is gitignored (regenerated from the
// pinned npm package); Vite copies public/ into the static dir at build time.
//
// The .mjs glue and its .wasm must be the same release: a mismatched pair fails
// in the browser with "call_indirect to a signature that does not match". So both
// sit together in one folder named by their joint hash, served same-origin and
// cached as immutable, and an ORT bump changes the folder and so the URL.
// vite.config.js defines globalThis.__ORT_DIR__ from ortDir().
import { mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "node_modules", "onnxruntime-web", "dist");
const dstDir = join(repoRoot, "web-src", "public", "engine", "ort");

// The `onnxruntime-web/webgpu` entry loads the `.asyncify` variant by name.
const files = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"];

export function ortDir() {
  const hash = createHash("sha256");
  for (const name of files) {
    const from = join(srcDir, name);
    if (!existsSync(from)) throw new Error(`[sync-ort] missing ${from} - run \`npm install\` first.`);
    hash.update(readFileSync(from));
  }
  return hash.digest("hex").slice(0, 8);
}

export function syncOrt() {
  const dir = ortDir();
  mkdirSync(join(dstDir, dir), { recursive: true });
  for (const name of readdirSync(dstDir)) if (name !== dir) rmSync(join(dstDir, name), { recursive: true });
  for (const name of files) copyFileSync(join(srcDir, name), join(dstDir, dir, name));
  console.log(`[sync-ort] copied the runtime to engine/ort/${dir}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncOrt();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
