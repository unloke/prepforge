// Scout v12 — decision-matrix dump: every scouted-player decision with Maia top-k +
// interpretable feature vectors. Offline Node harness (no browser).
//
// Usage:
//   node scripts/scout-bias-dump.mjs <gamesJson> [outPath] [--rating 1800] [--fp16]
//     [--max-plies 60] [--top-k 12]
//   node scripts/scout-bias-dump.mjs tmp/foe.json tmp/foe-bias.ndjson --max-plies 20

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as ort from "onnxruntime-web";
import { Chess } from "chess.js";

import { epdOf } from "../web-src/scout-graph.js";
import {
  FEATURE_IDS,
  buildDecisionContext,
  decisionMeta,
  featureVector,
} from "../web-src/scout-bias-features.js";
import { NUM_SQUARES, TOKEN_DIM, tokensFromFen } from "../web-src/engine/maia3-tokenizer.js";
import { buildPredictions } from "../web-src/engine/maia3-inference.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAIA_DIR = join(ROOT, "web-src", "public", "maia3");
const MANIFEST = JSON.parse(readFileSync(join(MAIA_DIR, "maia3.manifest.json"), "utf8"));

ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";
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
  const out = { rating: 1800, fp16: false, maxPlies: 60, topK: 12, positional: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--rating") out.rating = Number(argv[++i]) || 1800;
    else if (a === "--fp16") out.fp16 = true;
    else if (a === "--max-plies") out.maxPlies = Number(argv[++i]) || 60;
    else if (a === "--top-k") out.topK = Number(argv[++i]) || 12;
    else out.positional.push(a);
  }
  return out;
}

function shannonEntropy(dist) {
  let h = 0;
  for (const { p } of dist) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

// Arena berserk halves ONE player's clock, so game.clockInitialSeconds (600 in a
// berserked 600s game) is wrong for that player ~25% of the time in this data. The
// player's own first clock reading is the reliable budget estimate: first moves are
// near-instant, so cs[parity] ≈ their true starting time regardless of berserk.
function ownInitialCs(game) {
  const cs = game.clockCsAfterPly;
  if (!Array.isArray(cs)) return null;
  const parity = game.color === "white" ? 0 : 1;
  const first = cs[parity];
  return Number.isFinite(first) && first > 0 ? first : null;
}

function thinkCsAtPly(game, ply) {
  const cs = game.clockCsAfterPly;
  const inc = game.clockIncrementSeconds ?? 0;
  if (!Array.isArray(cs)) return null;
  const parity = game.color === "white" ? 0 : 1;
  if (ply % 2 !== parity) return null;
  // First own move: the pre-move clock is unknowable when berserk is in play — stay null.
  if (ply <= parity) return null;
  const beforeCs = cs[ply - 2];
  const afterCs = cs[ply];
  if (!Number.isFinite(beforeCs) || !Number.isFinite(afterCs)) return null;
  return Math.max(0, beforeCs + inc * 100 - afterCs);
}

function clockFracAfterPly(game, ply) {
  const cs = game.clockCsAfterPly;
  const initialCs = ownInitialCs(game);
  if (!Array.isArray(cs) || !initialCs) return null;
  const after = cs[ply];
  if (!Number.isFinite(after)) return null;
  return Math.min(1, after / initialCs);
}

function legalUciSet(chess) {
  return new Set(
    chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || "")),
  );
}

function buildCandidates(dist, played, legal, topK) {
  const probByUci = new Map(dist.map((r) => [r.uci, r.p]));
  const cands = [];
  const seen = new Set();
  if (legal.has(played)) {
    cands.push({ uci: played, p: probByUci.get(played) ?? 0 });
    seen.add(played);
  }
  for (const { uci, p } of dist.slice(0, topK)) {
    if (seen.has(uci)) continue;
    if (!legal.has(uci)) continue;
    cands.push({ uci, p });
    seen.add(uci);
  }
  return cands;
}

async function maiaDistFor(session, fen, rating) {
  const tokens = tokensFromFen(fen);
  const out = await session.run(feeds(tokens, rating));
  return buildPredictions(out.logits_move.data, fen).map((r) => ({
    uci: r.move_uci,
    p: r.probability,
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  const gamesPath = args.positional[0];
  const outPath =
    args.positional[1] || gamesPath.replace(/\.json$/, "") + `-bias-${args.rating}.ndjson`;
  if (!gamesPath) {
    console.error(
      "usage: node scripts/scout-bias-dump.mjs <gamesJson> [outPath] [--rating N] [--fp16] [--max-plies N] [--top-k N]",
    );
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(gamesPath, "utf8"));
  const games = Array.isArray(raw) ? raw : [...(raw.white || []), ...(raw.black || [])];
  console.log(`Loaded ${games.length} games from ${gamesPath}`);

  const artifact = args.fp16 ? MANIFEST.artifacts.fp16 : MANIFEST.artifacts.fp32;
  const modelPath = join(MAIA_DIR, artifact.file);
  console.log(`→ loading ${artifact.file} (${(artifact.bytes / 1e6).toFixed(0)} MB) ...`);
  const modelBytes = new Uint8Array(readFileSync(modelPath));
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  const policyCache = new Map();
  const lines = [];
  lines.push(
    JSON.stringify({
      featureIds: FEATURE_IDS,
      rating: args.rating,
      topK: args.topK,
      maxPlies: args.maxPlies,
      games: games.length,
    }),
  );

  let decisions = 0;
  let inferCount = 0;
  const t0 = Date.now();

  for (let gi = 0; gi < games.length; gi += 1) {
    const game = games[gi];
    const gameId = game.id || game.gameId || String(gi);
    const ucis = game.ucis || [];
    const chess = new Chess();
    let prevOwnMoveUci = null;
    const limit = Math.min(ucis.length, args.maxPlies);

    for (let ply = 0; ply < limit; ply += 1) {
      const mover = ply % 2 === 0 ? "white" : "black";
      if (mover === game.color) {
        const fen = chess.fen();
        const epd = epdOf(fen);
        const played = ucis[ply];
        const cacheKey = `${epd}|${args.rating}`;

        let dist = policyCache.get(cacheKey);
        if (!dist) {
          try {
            dist = await maiaDistFor(session, fen, args.rating);
          } catch {
            dist = [];
          }
          policyCache.set(cacheKey, dist);
          inferCount += 1;
        }

        const legal = legalUciSet(chess);
        const candsRaw = buildCandidates(dist, played, legal, args.topK);
        const ctx = buildDecisionContext(fen, { prevOwnMoveUci });
        const metaBase = decisionMeta(ctx);

        const cands = candsRaw.map(({ uci, p }) => ({
          uci,
          p,
          f: [...featureVector(ctx, uci)],
        }));

        lines.push(
          JSON.stringify({
            g: gameId,
            ply,
            color: game.color,
            epd,
            played,
            cands,
            meta: {
              phase: metaBase.phase,
              queenless: metaBase.queenless,
              matDiff: metaBase.materialDiffMover,
              thinkCs: thinkCsAtPly(game, ply),
              clockFracAfter: clockFracAfterPly(game, ply),
              entropy: shannonEntropy(dist),
              datestamp: game.datestamp ?? null,
            },
          }),
        );
        decisions += 1;
      }

      try {
        chess.move({
          from: ucis[ply].slice(0, 2),
          to: ucis[ply].slice(2, 4),
          promotion: ucis[ply][4] || undefined,
        });
      } catch {
        break;
      }
      if (mover === game.color) prevOwnMoveUci = ucis[ply];
    }

    if ((gi + 1) % 5 === 0 || gi + 1 === games.length) {
      const rate = decisions / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r  games ${gi + 1}/${games.length}  decisions ${decisions}  infer ${inferCount}  (${rate.toFixed(1)} dec/s)   `,
      );
    }
  }
  process.stdout.write("\n");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(
    `✓ wrote ${decisions} decision rows (${inferCount} unique Maia inferences) → ${outPath}`,
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}`);
  process.exit(1);
});