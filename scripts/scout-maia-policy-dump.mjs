// Dump Maia3 opening-policy distributions to a JSON cache the Scout v3 backtest reads
// (scripts/scout-backtest.mjs --maia-cache). This is what turns the harness's placeholder
// uniform prior into the REAL Maia prior, i.e. the actual §8.1 stop/go measurement.
//
// It runs Maia inference DIRECTLY in Node — no browser, no Web Worker, no two-origin rig —
// by loading the local fp32 .onnx with onnxruntime-web's Node build and reusing the exact
// pure token/inference helpers the production worker uses (maia3-tokenizer + maia3-inference,
// both ORT-free). The model queries a BARE FEN (history zero-padded), matching how v3's lazy
// per-node policy read will actually call it in the browser.
//
// Usage:
//   node scripts/scout-maia-policy-dump.mjs <gamesJson> [outPath] [--rating 1800] [--fp16]
//   node scripts/scout-maia-policy-dump.mjs tmp/foe.json tmp/foe-maia.json --rating 1800
//
// For each position where the SCOUTED player is to move (up to ANALYZE_PLIES), keyed by EPD,
// it writes: { "<epd>|<rating>": [{uci, p}, ...] }.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as ort from "onnxruntime-web";
import { Chess } from "chess.js";

import { ANALYZE_PLIES } from "../web-src/scout.js";
import { epdOf } from "../web-src/scout-graph.js";
import { NUM_SQUARES, TOKEN_DIM, tokensFromFen } from "../web-src/engine/maia3-tokenizer.js";
import { buildPredictions } from "../web-src/engine/maia3-inference.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAIA_DIR = join(ROOT, "web-src", "public", "maia3");
const MANIFEST = JSON.parse(readFileSync(join(MAIA_DIR, "maia3.manifest.json"), "utf8"));

// Node build of onnxruntime-web runs WASM on CPU. Single-thread is fine for a batch dump and
// avoids the SharedArrayBuffer / cross-origin-isolation requirement of threaded WASM.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";
// ORT-web resolves its wasm binaries via ESM URL import; on Windows a bare drive path
// ("D:\\...") isn't a valid URL scheme, so hand it a proper file:// dir URL (trailing slash so
// ORT appends the .wasm filename correctly).
ort.env.wasm.wasmPaths =
  pathToFileURL(join(ROOT, "node_modules", "onnxruntime-web", "dist")).href + "/";

function feeds(tokens, elo) {
  return {
    tokens: new ort.Tensor("float32", tokens, [1, NUM_SQUARES, TOKEN_DIM]),
    self_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(elo)]), [1]),
    oppo_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(elo)]), [1]),
  };
}

function parseArgs(argv) {
  const out = { rating: 1800, fp16: false, positional: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--rating") out.rating = Number(argv[++i]) || 1800;
    else if (a === "--fp16") out.fp16 = true;
    else out.positional.push(a);
  }
  return out;
}

// Collect { epd → representative full FEN } for every position where the scouted player is to
// move, across all games, up to maxPlies. Deduped by EPD (transpositions collapse; the model
// reads a bare FEN so the move counters that EPD drops don't change the tokens).
function collectPositions(games, maxPlies) {
  const byEpd = new Map();
  for (const game of games) {
    const color = game.color;
    const ucis = game.openingUcis?.length ? game.openingUcis : game.ucis || [];
    const chess = new Chess();
    const limit = Math.min(ucis.length, maxPlies);
    for (let i = 0; i < limit; i += 1) {
      const mover = i % 2 === 0 ? "white" : "black";
      const fen = chess.fen();
      if (mover === color) {
        const epd = epdOf(fen);
        if (!byEpd.has(epd)) byEpd.set(epd, fen);
      }
      try {
        chess.move({ from: ucis[i].slice(0, 2), to: ucis[i].slice(2, 4), promotion: ucis[i][4] || undefined });
      } catch {
        break;
      }
    }
  }
  return byEpd;
}

async function main() {
  const args = parseArgs(process.argv);
  const gamesPath = args.positional[0];
  const outPath = args.positional[1] || gamesPath.replace(/\.json$/, "") + `-maia-${args.rating}.json`;
  if (!gamesPath) {
    console.error("usage: node scripts/scout-maia-policy-dump.mjs <gamesJson> [outPath] [--rating N] [--fp16]");
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(gamesPath, "utf8"));
  const games = Array.isArray(raw) ? raw : [...(raw.white || []), ...(raw.black || [])];
  console.log(`Loaded ${games.length} games from ${gamesPath}`);

  const artifact = args.fp16 ? MANIFEST.artifacts.fp16 : MANIFEST.artifacts.fp32;
  const modelPath = join(MAIA_DIR, artifact.file);
  console.log(`→ loading ${artifact.file} (${(artifact.bytes / 1e6).toFixed(0)} MB) ...`);
  // Pass the model as bytes (not a path): ORT-web would otherwise try to fetch the path as a
  // URL and hit the same Windows drive-letter scheme error the wasm loader does.
  const modelBytes = new Uint8Array(readFileSync(modelPath));
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  const positions = collectPositions(games, ANALYZE_PLIES);
  console.log(`→ ${positions.size} unique opponent-to-move positions at rating ${args.rating}`);

  const cache = {};
  let done = 0;
  const t0 = Date.now();
  for (const [epd, fen] of positions) {
    let dist = [];
    try {
      const tokens = tokensFromFen(fen);
      const out = await session.run(feeds(tokens, args.rating));
      dist = buildPredictions(out.logits_move.data, fen).map((r) => ({ uci: r.move_uci, p: r.probability }));
    } catch (err) {
      // A malformed/edge FEN just yields no prior for that node (backtest floors to MIN_P).
      dist = [];
    }
    cache[`${epd}|${args.rating}`] = dist;
    done += 1;
    if (done % 200 === 0 || done === positions.size) {
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${done}/${positions.size}  (${rate.toFixed(1)} pos/s)   `);
    }
  }
  process.stdout.write("\n");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(cache));
  console.log(`✓ wrote ${Object.keys(cache).length} policy entries → ${outPath}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}`);
  process.exit(1);
});
