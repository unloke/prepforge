// moveAssessmentMany runs the browser Maia3 session on the UNIQUE model inputs of one
// request: a move's before-position and the previous move's after-position are the same
// input, so a game's consecutive plies mostly share rows. The fake session below is a pure
// function of each input row, so the deduplicated pass must reproduce, slot for slot, what
// the old two-pass implementation (kept here as the reference) produced from the same rows.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { tokensFromFen, tokensAfterMove, NUM_SQUARES, TOKEN_DIM } from "./maia3-tokenizer.js";
import { buildPredictions, makeHumanProbabilityLookup, winChanceAfter } from "./maia3-inference.js";

const state = vi.hoisted(() => ({ runs: [], session: null }));

vi.mock("onnxruntime-web/webgpu", () => {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const digest = (tokens, offset, count) => {
    let h = 2166136261;
    for (let i = 0; i < count; i++) {
      h = Math.imul(h ^ Math.round(tokens[offset + i] * 12), 16777619) >>> 0;
    }
    return h;
  };
  const ROW = NUM_SQUARES * TOKEN_DIM;
  class InferenceSession {
    static async create() {
      state.session = {
        run: async (feeds) => {
          const n = feeds.tokens.dims[0];
          const move = new Float32Array(n * 4352);
          const value = new Float32Array(n * 3);
          for (let r = 0; r < n; r++) {
            const h = digest(feeds.tokens.data, r * ROW, ROW);
            for (let i = 0; i < 4352; i++) move[r * 4352 + i] = ((h + i) % 17) - 8;
            value[r * 3] = (h % 1000) / 100;
            value[r * 3 + 1] = ((h >>> 10) % 1000) / 100;
            value[r * 3 + 2] = ((h >>> 20) % 1000) / 100;
          }
          state.runs.push({ rows: n });
          return { logits_move: { data: move }, logits_value: { data: value } };
        },
      };
      return state.session;
    }
  }
  return { env: { wasm: {}, logLevel: "error" }, Tensor, InferenceSession };
});

vi.mock("./maia3-weights-loader.js", () => ({
  loadVerifiedWeights: async () => ({ buf: new ArrayBuffer(8), fromCache: true }),
}));

const MANIFEST = {
  history: 8,
  token_dim: 97,
  include_time_info: false,
  io: { logits_move_dim: 4352 },
  backend_artifact: { wasm: "fake.onnx" },
  artifacts: { wasm: { file: "fake.onnx", bytes: 8, sha256: "00" } },
};

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

let HANDLERS;

beforeAll(async () => {
  globalThis.self = { postMessage() {}, crossOriginIsolated: false };
  ({ HANDLERS } = await import("./maia3-worker.js"));
  await HANDLERS.init({ id: 1, assetBase: "http://test/", manifest: MANIFEST, backend: "wasm", defaultRating: 1800 });
});

const feedsFor = (rows) => {
  const data = new Float32Array(rows.length * NUM_SQUARES * TOKEN_DIM);
  rows.forEach((tokens, k) => data.set(tokens, k * NUM_SQUARES * TOKEN_DIM));
  return { tokens: { data, dims: [rows.length, NUM_SQUARES, TOKEN_DIM] } };
};

// The implementation this change replaced: one policy forward over every before-position,
// one value forward over every after-position.
const isValidFen = (fen) => {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
};

async function twoPassReference(items) {
  const results = new Array(items.length).fill(null);
  const slots = [];
  for (let i = 0; i < items.length; i++) {
    const { fen, moveUci } = items[i] || {};
    if (!isValidFen(fen)) continue;
    const after = tokensAfterMove(fen, moveUci);
    if (after === null) continue;
    slots.push(i);
  }
  if (!slots.length) return results;
  const befores = slots.map((slot) => tokensFromFen(items[slot].fen));
  const afters = slots.map((slot) => tokensAfterMove(items[slot].fen, items[slot].moveUci));
  const outPolicy = await state.session.run(feedsFor(befores));
  const outValue = await state.session.run(feedsFor(afters));
  const n = slots.length;
  const moveData = outPolicy.logits_move.data;
  const perMove = moveData.length / n;
  const valueData = outValue.logits_value.data;
  slots.forEach((slot, k) => {
    const { fen, moveUci } = items[slot];
    const logits = moveData.subarray(k * perMove, (k + 1) * perMove);
    const lookup = makeHumanProbabilityLookup(logits, fen);
    results[slot] = {
      humanProbability: lookup(moveUci),
      naturalUci: buildPredictions(logits, fen, { topN: 1 })[0]?.move_uci ?? null,
      winChanceAfter: winChanceAfter([valueData[k * 3], valueData[k * 3 + 1], valueData[k * 3 + 2]]),
    };
  });
  return results;
}

describe("moveAssessmentMany", () => {
  it("runs ONCE on the unique inputs of consecutive plies and matches the two-pass path", async () => {
    const items = [
      { fen: START, moveUci: "e2e4" },
      { fen: AFTER_E4, moveUci: "c7c5" },
      { fen: AFTER_E5, moveUci: "g1f3" },
    ];
    state.runs.length = 0;
    const got = await HANDLERS.moveAssessmentMany({ items, rating: 1800 });
    // START · AFTER_E4 · AFTER_E5 · after(Nf3) — two of the six rows are shared.
    expect(state.runs).toEqual([{ rows: 4 }]);
    const expected = await twoPassReference(items);
    expect(got).toEqual(expected);
  });

  it("reads both heads from one shared row: identical inputs, illegal and malformed slots", async () => {
    const items = [
      { fen: START, moveUci: "e2e4" },
      { fen: START, moveUci: "e2e4" }, // same model inputs again
      { fen: START, moveUci: "e2e5" }, // illegal move → null slot, no row
      { fen: "not a fen", moveUci: "e2e4" }, // malformed FEN → null slot
      { fen: AFTER_E4, moveUci: "c7c5" },
      { fen: START, moveUci: "d2d4" }, // same before-position, different after
    ];
    state.runs.length = 0;
    const got = await HANDLERS.moveAssessmentMany({ items, rating: 1800 });
    expect(got).toHaveLength(items.length);
    expect(got[2]).toBeNull();
    expect(got[3]).toBeNull();
    expect(got[1]).toEqual(got[0]);
    expect(got[5].humanProbability).not.toBe(got[0].humanProbability);
    // START · after(e4) · after(c5) · after(d4) — 4 rows for 5 usable items.
    expect(state.runs).toEqual([{ rows: 4 }]);
    expect(got).toEqual(await twoPassReference(items));
  });

  it("keeps the caller's order and returns all-null without a forward when nothing is usable", async () => {
    const items = [
      { fen: "nope", moveUci: "e2e4" },
      { fen: START, moveUci: "e2e5" },
      null,
    ];
    state.runs.length = 0;
    await expect(HANDLERS.moveAssessmentMany({ items, rating: 1800 })).resolves.toEqual([null, null, null]);
    expect(state.runs).toEqual([]);
  });
});
