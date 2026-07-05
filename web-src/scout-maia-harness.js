// Shared Maia3 ONNX harness for offline scout scripts (bias-dump, bias-routes, route-audit).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ort from "onnxruntime-web";

import { NUM_SQUARES, TOKEN_DIM, tokensFromFen } from "./engine/maia3-tokenizer.js";
import { buildPredictions } from "./engine/maia3-inference.js";

export function configureOrtWasm(wasmDirUrl) {
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
  ort.env.wasm.wasmPaths = wasmDirUrl;
}

export function maiaFeeds(tokens, elo) {
  return {
    tokens: new ort.Tensor("float32", tokens, [1, NUM_SQUARES, TOKEN_DIM]),
    self_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(elo)]), [1]),
    oppo_elos: new ort.Tensor("int64", BigInt64Array.from([BigInt(elo)]), [1]),
  };
}

export function legalUciSet(chess) {
  return new Set(
    chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || "")),
  );
}

export function buildCandidates(dist, legal, topK) {
  const cands = [];
  const seen = new Set();
  for (const { uci, p } of dist.slice(0, topK)) {
    if (seen.has(uci) || !legal.has(uci)) continue;
    cands.push({ uci, p });
    seen.add(uci);
  }
  return cands;
}

export async function createMaiaSession(maiaDir, manifest, { fp16 = false } = {}) {
  const artifact = fp16 ? manifest.artifacts.fp16 : manifest.artifacts.fp32;
  const modelPath = join(maiaDir, artifact.file);
  const modelBytes = new Uint8Array(readFileSync(modelPath));
  return ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
}

export async function maiaDistFor(session, fen, rating) {
  const tokens = tokensFromFen(fen);
  const out = await session.run(maiaFeeds(tokens, rating));
  return buildPredictions(out.logits_move.data, fen).map((r) => ({
    uci: r.move_uci,
    p: r.probability,
  }));
}