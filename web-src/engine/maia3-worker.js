// Maia3 Web Worker — owns the onnxruntime-web session and runs all inference off the
// main thread (docs/browser-engine-migration.md Phase 3b). The provider
// (maia3-provider.js) resolves the asset base on the MAIN thread and hands it in the
// init message; this worker treats it as opaque (its own globalThis can't see
// window.__MAIA3_ASSET_BASE). Every message carries a request id which is echoed back
// so the provider can correlate concurrent requests; a single request throwing rejects
// only that request, while init failure / an uncaught error crashes the worker and the
// provider re-inits on the next call.
import * as ort from "onnxruntime-web/webgpu";
import { Chess } from "chess.js";

import {
  NUM_SQUARES,
  TOKEN_DIM,
  tokensFromFen,
  tokensAfterMove,
  assertManifestContract,
} from "./maia3-tokenizer.js";
import {
  TOKENS_PER_POSITION,
  buildPredictions,
  makeHumanProbabilityLookup,
  winChanceAfter,
  wdlCurrent,
} from "./maia3-inference.js";
import { loadVerifiedWeights } from "./maia3-weights-loader.js";

ort.env.wasm.wasmPaths = "/static/engine/ort/"; // vendored runtime (scripts/sync-ort.mjs)
// Thread count is resolved per-init from the message the provider sends (Stage 4c). Pin a
// safe single-threaded default at module load; init() overrides it before the first session
// create. Threaded WASM needs SharedArrayBuffer (cross-origin isolation), so we also clamp
// to 1 in init when this worker isn't crossOriginIsolated, regardless of the request.
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

// Apply the requested ORT WASM thread count, clamped to 1 when the worker lacks cross-origin
// isolation (no SharedArrayBuffer → a threaded session would fail to construct). Returns the
// count actually applied so the provider/harness can confirm threading really engaged.
function applyWasmThreads(requested) {
  const coi = typeof self !== "undefined" ? !!self.crossOriginIsolated : false;
  let n = Number.isInteger(requested) && requested >= 1 ? requested : 1;
  if (!coi) n = 1;
  ort.env.wasm.numThreads = n;
  return n;
}

let session = null;
let defaultRating = 1500;

function isValidFen(fen) {
  try {
    // chess.js throws on a malformed FEN.
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

// Build the 3-input feed for `count` stacked positions. tokens is a flat Float32Array
// of length count*TOKENS_PER_POSITION; the model's batch axis is dynamic (exported
// with dynamic_axes), so count may be > 1 for the batched value forward.
function feeds(tokens, count, selfElos, oppoElos) {
  return {
    tokens: new ort.Tensor("float32", tokens, [count, NUM_SQUARES, TOKEN_DIM]),
    self_elos: new ort.Tensor("int64", BigInt64Array.from(selfElos, (e) => BigInt(e)), [count]),
    oppo_elos: new ort.Tensor("int64", BigInt64Array.from(oppoElos, (e) => BigInt(e)), [count]),
  };
}

async function init({ id, assetBase, manifest, backend = "wasm", numThreads, defaultRating: rating }) {
  // Contract gate before trusting any token shape / legal mask (history, token_dim,
  // time info, policy dim) against the runtime manifest.
  assertManifestContract(manifest);
  if (rating) defaultRating = rating;
  // Set the thread count BEFORE creating the session (ORT reads env.wasm.numThreads then).
  const appliedThreads = applyWasmThreads(numThreads);

  const file = manifest.backend_artifact && manifest.backend_artifact[backend];
  if (!file) throw new Error(`manifest.backend_artifact has no entry for backend "${backend}"`);
  const entry = Object.values(manifest.artifacts || {}).find((a) => a.file === file);
  if (!entry) throw new Error(`manifest.artifacts has no entry for file "${file}"`);

  // Intermediate (non-settling) progress notifications share the init request id; the
  // provider routes them to its init-progress handler without resolving the init Promise.
  const report = (phase, loaded, total) =>
    self.postMessage({ id, progress: true, phase, loaded, total });

  // Resolve VERIFIED bytes: IndexedDB cache (skips the ~46 MB download) → integrity gate →
  // on cache corruption, evict + re-fetch → network → gate → persist. The orchestration is
  // ORT-free and lives in maia3-weights-loader (unit-tested incl. the corrupt-cache
  // fallback); here we only feed the result to onnxruntime-web.
  const url = assetBase + file;
  const { buf, fromCache } = await loadVerifiedWeights({ entry, url, report });

  report("session", 0, entry.bytes);
  session = await ort.InferenceSession.create(new Uint8Array(buf), {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  // Echo the URL the weights were ACTUALLY fetched from. The provider/harness can't see
  // the worker's fetch directly, so this is the only observable proof of which origin the
  // .onnx came from — the gate the two-origin harness asserts (cross-origin CDN→worker).
  // `cached` lets the harness/provider tell a warm load from a cold one; `numThreads` is the
  // count actually applied (clamped to 1 without cross-origin isolation) — the observable
  // proof threaded WASM really engaged (Stage 4c validation).
  return { backend, file, bytes: entry.bytes, url, cached: fromCache, numThreads: appliedThreads };
}

// predictions(): policy-only forward → sorted human-move distribution. [] for a
// terminal position; [] for a malformed FEN (nothing to predict — no forward).
async function predictions({ fen, rating }) {
  if (!isValidFen(fen)) return [];
  const elo = rating || defaultRating;
  const tokens = tokensFromFen(fen);
  const out = await session.run(feeds(tokens, 1, [elo], [elo]));
  return buildPredictions(out.logits_move.data, fen);
}

// positionRead(): one forward → BOTH the human-move distribution and the position's WDL
// (side-to-move POV). The coach uses the policy for "obvious vs spread" and the WDL for
// phase-relative sharpness; reading both off the SAME forward keeps it to one inference.
// { predictions: [...], wdl: { win, draw, loss } } | null (malformed FEN).
async function positionRead({ fen, rating }) {
  if (!isValidFen(fen)) return null;
  const elo = rating || defaultRating;
  const out = await session.run(feeds(tokensFromFen(fen), 1, [elo], [elo]));
  return {
    predictions: buildPredictions(out.logits_move.data, fen),
    wdl: wdlCurrent(out.logits_value.data),
  };
}

// moveAssessment(): { humanProbability, winChanceAfter } or null when the FEN is
// malformed or the move is unparseable/illegal (no forward pass in that case).
async function moveAssessment({ fen, moveUci, rating }) {
  if (!isValidFen(fen)) return null;
  const afterTokens = tokensAfterMove(fen, moveUci); // null if illegal/unparseable
  if (afterTokens === null) return null;
  const elo = rating || defaultRating;

  // Human probability: forward on the CURRENT position.
  const outPolicy = await session.run(feeds(tokensFromFen(fen), 1, [elo], [elo]));
  const humanProb = makeHumanProbabilityLookup(outPolicy.logits_move.data, fen)(moveUci);

  // Win chance: forward on the AFTER-MOVE position with self/oppo Elo SWAPPED (the
  // resulting position is the opponent's to move), then invert WDL back to the mover.
  const outValue = await session.run(feeds(afterTokens, 1, [elo], [elo]));
  return { humanProbability: humanProb, winChanceAfter: winChanceAfter(outValue.logits_value.data) };
}

// moveAssessmentBatch(): one shared policy forward + ONE padded value forward over all
// legal candidates. Preserves input order; null in the slot of each malformed/illegal
// move. All-null for a malformed FEN.
async function moveAssessmentBatch({ fen, moves, rating }) {
  const results = new Array(moves.length).fill(null);
  if (!isValidFen(fen) || moves.length === 0) return results;
  const elo = rating || defaultRating;

  // Gather legal candidates + after-move tokens, remembering their original slots.
  // Done BEFORE any forward so an all-illegal move set returns all-null at zero
  // inference cost (the shared policy forward below is only worth running once we
  // know at least one move will consume its human-prob distribution).
  const slots = [];
  const chunks = [];
  for (let i = 0; i < moves.length; i++) {
    const after = tokensAfterMove(fen, moves[i]);
    if (after === null) continue; // illegal/unparseable → null slot stays
    slots.push(i);
    chunks.push(after);
  }
  if (slots.length === 0) return results;

  // Shared current-position policy forward → one human-prob distribution for all.
  const outPolicy = await session.run(feeds(tokensFromFen(fen), 1, [elo], [elo]));
  const humanProbFor = makeHumanProbabilityLookup(outPolicy.logits_move.data, fen);

  // One padded value forward over every legal after-move position (dynamic batch axis).
  const n = slots.length;
  const batch = new Float32Array(n * TOKENS_PER_POSITION);
  for (let k = 0; k < n; k++) batch.set(chunks[k], k * TOKENS_PER_POSITION);
  const elos = new Array(n).fill(elo); // self/oppo swapped — equal here (single rating)
  const outValue = await session.run(feeds(batch, n, elos, elos));
  const valueData = outValue.logits_value.data; // length n*3, row-major

  for (let k = 0; k < n; k++) {
    const slot = slots[k];
    const vlog = [valueData[k * 3], valueData[k * 3 + 1], valueData[k * 3 + 2]];
    results[slot] = { humanProbability: humanProbFor(moves[slot]), winChanceAfter: winChanceAfter(vlog) };
  }
  return results;
}

const HANDLERS = { init, predictions, positionRead, moveAssessment, moveAssessmentBatch };

self.onmessage = async (ev) => {
  const { id, type } = ev.data || {};
  const handler = HANDLERS[type];
  if (!handler) {
    self.postMessage({ id, ok: false, error: `unknown message type "${type}"` });
    return;
  }
  try {
    const result = await handler(ev.data);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    // A single request failing rejects only its Promise; the worker stays alive.
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
