// Copy the chosen Stockfish WASM build out of the npm package into
// web-src/public/engine/ so Vite serves it at /static/engine/*. Runs before
// every build/dev (see package.json scripts). web-src/public/engine is
// gitignored (regenerated from the pinned npm package); the built copy under
// src/prepforge_chess/web/static/engine IS committed so the Docker image
// (pip install ., no Node) still ships the engine.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "node_modules", "stockfish", "bin");
const dstDir = join(repoRoot, "web-src", "public", "engine");

// Lite multi-threaded build: ~7 MB, embeds a small NNUE, needs cross-origin
// isolation (COOP/COEP) for threads — which the server sends.
const files = ["stockfish-18-lite.js", "stockfish-18-lite.wasm"];

mkdirSync(dstDir, { recursive: true });
for (const name of files) {
  const from = join(srcDir, name);
  if (!existsSync(from)) {
    console.error(`[sync-stockfish] missing ${from} - run \`npm install\` first.`);
    process.exit(1);
  }
  copyFileSync(from, join(dstDir, name));
  console.log(`[sync-stockfish] copied ${name}`);
}
