import { describe, it, expect } from "vitest";

import { MOVE_TO_INDEX, mirrorMove, legalMoveIndices } from "./maia3-tokenizer.js";
import {
  legalMaskedProbs,
  buildPredictions,
  humanProbability,
  makeHumanProbabilityLookup,
  softmax3,
  probabilitiesToPermille,
  winChanceAfter,
} from "./maia3-inference.js";

const POLICY_DIM = 4352;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Fool's mate: White is to move and checkmated (no legal moves).
const CHECKMATE_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
// Black to move, stalemated (king a8, white Qb6 + Kh1): no legal move, not in check.
const STALEMATE_FEN = "k7/8/1Q6/8/8/8/8/7K b - - 0 1";

// A zeroed policy vector with chosen logits at the given UCI moves (in the model's
// side-to-move frame — caller passes already-framed vocab uci).
function policyWith(entries) {
  const logits = new Float32Array(POLICY_DIM);
  for (const [vocabUci, value] of entries) {
    const idx = MOVE_TO_INDEX.get(vocabUci);
    if (idx === undefined) throw new Error(`no vocab index for ${vocabUci}`);
    logits[idx] = value;
  }
  return logits;
}

describe("legalMaskedProbs", () => {
  it("is empty for an empty legal set (no -Infinity/NaN softmax)", () => {
    expect(legalMaskedProbs(new Float32Array(POLICY_DIM), []).size).toBe(0);
  });

  it("softmaxes over only the legal indices and sums to 1", () => {
    const legal = legalMoveIndices(START_FEN); // white to move, no mirror
    const logits = new Float32Array(POLICY_DIM);
    const e2e4 = MOVE_TO_INDEX.get("e2e4");
    logits[e2e4] = 10; // dominate
    const probs = legalMaskedProbs(logits, legal);
    expect(probs.size).toBe(legal.length);
    const sum = [...probs.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    // e2e4 dominates a 20-move uniform-ish field.
    expect(probs.get(e2e4)).toBeGreaterThan(0.9);
  });
});

describe("buildPredictions terminal contract", () => {
  it("returns [] at checkmate (no legal moves)", () => {
    expect(buildPredictions(new Float32Array(POLICY_DIM), CHECKMATE_FEN)).toEqual([]);
  });

  it("returns [] at stalemate (no legal moves)", () => {
    expect(buildPredictions(new Float32Array(POLICY_DIM), STALEMATE_FEN)).toEqual([]);
  });

  it("sorts legal moves by probability desc with 1-based ranks and real UCI", () => {
    const logits = policyWith([
      ["e2e4", 10],
      ["d2d4", 5],
    ]);
    const preds = buildPredictions(logits, START_FEN);
    expect(preds.length).toBe(legalMoveIndices(START_FEN).length); // all legal moves
    expect(preds[0]).toMatchObject({ move_uci: "e2e4", rank: 1 });
    expect(preds[1]).toMatchObject({ move_uci: "d2d4", rank: 2 });
    expect(preds[0].probability).toBeGreaterThan(preds[1].probability);
    // ranks are dense 1..n
    preds.forEach((p, i) => expect(p.rank).toBe(i + 1));
  });

  it("honors topN", () => {
    const logits = policyWith([["e2e4", 10], ["d2d4", 5]]);
    const preds = buildPredictions(logits, START_FEN, { topN: 2 });
    expect(preds.map((p) => p.move_uci)).toEqual(["e2e4", "d2d4"]);
  });
});

describe("humanProbability (side-to-move mirror frame)", () => {
  it("matches the legal-masked prob for a white-to-move move", () => {
    const legal = legalMoveIndices(START_FEN);
    const logits = policyWith([["e2e4", 3], ["d2d4", 1]]);
    const expected = legalMaskedProbs(logits, legal).get(MOVE_TO_INDEX.get("e2e4"));
    expect(humanProbability(logits, START_FEN, "e2e4")).toBeCloseTo(expected, 9);
  });

  it("returns 0 for a move that isn't legal in the position", () => {
    // e2e5 is a valid vocab entry but not legal from the start.
    expect(humanProbability(new Float32Array(POLICY_DIM), START_FEN, "e2e5")).toBe(0);
  });

  it("looks up black-to-move moves through the mirrored vocab frame", () => {
    // After 1.e4, Black to move. The real move e7e5 lives in the vocab under its
    // mirrored (white-frame) name e2e4 — a naive un-mirrored lookup would miss it.
    const blackFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const logits = policyWith([[mirrorMove("e7e5"), 5]]); // mirrorMove("e7e5") === "e2e4"
    const lookup = makeHumanProbabilityLookup(logits, blackFen);
    expect(lookup("e7e5")).toBeGreaterThan(0.5);
    expect(lookup("g8f6")).toBeLessThan(lookup("e7e5"));
  });
});

describe("softmax3 / probabilitiesToPermille (WDL helpers)", () => {
  it("softmax3 sums to 1 and is uniform for equal logits", () => {
    const p = softmax3([0, 0, 0]);
    expect(p[0] + p[1] + p[2]).toBeCloseTo(1, 9);
    expect(p[0]).toBeCloseTo(1 / 3, 9);
  });

  it("permille sums to exactly 1000 via largest-remainder", () => {
    expect(probabilitiesToPermille([0.5, 0.3, 0.2])).toEqual([500, 300, 200]);
    const thirds = probabilitiesToPermille([1 / 3, 1 / 3, 1 / 3]);
    expect(thirds.reduce((a, b) => a + b, 0)).toBe(1000);
    // 333.33 each → ints 333/333/333, remainder 1 to the first (stable tie order).
    expect(thirds).toEqual([334, 333, 333]);
  });

  it("clamps negatives to 0 before scaling (no renormalization)", () => {
    // -0.1 → 0; 0.6/0.5 truncate to 600/500. Sum already ≥ 1000 so no leftover to
    // distribute (matches the Python helper, which assumes inputs ~sum to 1).
    expect(probabilitiesToPermille([-0.1, 0.6, 0.5])).toEqual([0, 600, 500]);
  });
});

describe("winChanceAfter (invert_wdl + permille, mover perspective)", () => {
  it("≈0.5 for an even after-move value", () => {
    // [loss,draw,win] equal → permille(win,draw,loss)=[334,333,333]; invert → mover
    // win=permilleLoss=333, draw=333 → (333 + 0.5*333)/1000.
    expect(winChanceAfter([0, 0, 0])).toBeCloseTo(0.4995, 6);
  });

  it("→1 when the AFTER position is lost for the side to move there (mover wins)", () => {
    // Strong loss for the opponent-to-move → mover's win chance ≈ 1.
    expect(winChanceAfter([10, -10, -10])).toBeCloseTo(1, 6);
  });

  it("→0 when the AFTER position is won for the side to move there (mover loses)", () => {
    expect(winChanceAfter([-10, -10, 10])).toBeCloseTo(0, 6);
  });
});
