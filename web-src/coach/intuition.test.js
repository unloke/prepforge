import { describe, it, expect } from "vitest";

import {
  computeIntuition,
  attachIntuition,
  wdlSharpness,
  sharpnessBand,
  SHARPNESS_BANDS,
} from "./intuition.js";

// A starting-ish position FEN where the moves below are legal, so SAN resolves.
const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("computeIntuition — policy (obviousness)", () => {
  it("returns null without any usable signal", () => {
    expect(computeIntuition({ predictions: [], fenBefore: FEN })).toBeNull();
    expect(computeIntuition({ predictions: null, fenBefore: FEN })).toBeNull();
  });

  it("reads a single dominant move as an OBVIOUS position", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.82 },
      { move_uci: "d2d4", probability: 0.1 },
      { move_uci: "g1f3", probability: 0.08 },
    ];
    const intu = computeIntuition({ predictions, fenBefore: FEN, playedUci: "e2e4", bestUci: "e2e4" });
    expect(intu.texture).toBe("obvious");
    expect(intu.obviousSan).toBe("e4");
    expect(intu.obviousIsBest).toBe(true);
    expect(intu.playedWasObvious).toBe(true);
  });

  it("a spread of moves is NOT 'obvious' (texture normal)", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.3 },
      { move_uci: "d2d4", probability: 0.28 },
      { move_uci: "g1f3", probability: 0.22 },
      { move_uci: "c2c4", probability: 0.2 },
    ];
    const intu = computeIntuition({ predictions, fenBefore: FEN, playedUci: "d2d4", bestUci: "c2c4" });
    expect(intu.texture).toBe("normal");
    expect(intu.obviousIsBest).toBe(false);
  });

  it("flags a surprising human choice (low played probability)", () => {
    const predictions = [
      { move_uci: "e2e4", probability: 0.7 },
      { move_uci: "d2d4", probability: 0.22 },
      { move_uci: "g1f3", probability: 0.08 },
    ];
    const intu = computeIntuition({ predictions, fenBefore: FEN, playedUci: "g1f3", bestUci: "e2e4" });
    expect(intu.playedWasObvious).toBe(false);
    expect(intu.surprise).toBe(true);
  });
});

describe("WDL sharpness (phase-relative)", () => {
  it("rises as the position becomes balanced+decisive (low draw, W~L)", () => {
    const balanced = wdlSharpness(490, 490); // W=L=0.49, draw ~0.02
    const oneSided = wdlSharpness(900, 50); // clearly winning
    const drawish = wdlSharpness(150, 150); // W=L low, big draw
    expect(balanced).toBeGreaterThan(oneSided);
    expect(balanced).toBeGreaterThan(drawish);
  });

  it("accepts permille or fraction inputs equivalently", () => {
    expect(wdlSharpness(490, 490)).toBeCloseTo(wdlSharpness(0.49, 0.49), 6);
  });

  it("bands the SAME raw score differently by phase (calibrated cutoffs)", () => {
    // A score of 100 is below the opening's 'calm' cutoff, but well above the endgame's
    // 'sharp' cutoff — the whole point of reading sharpness relative to the phase.
    expect(sharpnessBand(100, "opening")).toBe("calm");
    expect(sharpnessBand(100, "endgame")).toBe("sharp");
    // Sanity: thresholds are monotone within each phase.
    for (const phase of Object.keys(SHARPNESS_BANDS)) {
      const b = SHARPNESS_BANDS[phase];
      expect(b.calm).toBeLessThan(b.lively);
      expect(b.lively).toBeLessThan(b.sharp);
      expect(sharpnessBand(b.sharp + 1, phase)).toBe("sharp");
      expect(sharpnessBand(b.calm - 1, phase)).toBe("calm");
    }
  });

  it("computeIntuition attaches a phase-relative sharpness band from WDL", () => {
    const intu = computeIntuition({
      predictions: [{ move_uci: "e2e4", probability: 0.4 }],
      fenBefore: FEN,
      wdl: { win: 490, draw: 20, loss: 490 },
      phase: "middlegame",
    });
    expect(intu.sharpness.score).toBeGreaterThan(SHARPNESS_BANDS.middlegame.sharp);
    expect(intu.sharpness.band).toBe("sharp");
    expect(intu.sharpness.phase).toBe("middlegame");
  });

  it("a drawish endgame reads as calm", () => {
    const intu = computeIntuition({
      predictions: [{ move_uci: "e2e4", probability: 0.4 }],
      fenBefore: FEN,
      wdl: { win: 60, draw: 900, loss: 40 },
      phase: "endgame",
    });
    expect(intu.sharpness.band).toBe("calm");
  });
});

describe("attachIntuition", () => {
  it("accepts the worker's { predictions, wdl } object", () => {
    const features = { fenBefore: FEN, uci: "e2e4", bestUci: "e2e4", phase: "opening" };
    attachIntuition(features, {
      predictions: [{ move_uci: "e2e4", probability: 0.9 }],
      wdl: { win: 500, draw: 20, loss: 480 },
    });
    expect(features.intuition).toMatchObject({ texture: "obvious", obviousSan: "e4" });
    expect(features.intuition.sharpness).toBeTruthy();
  });

  it("still accepts a bare predictions array (legacy, no WDL)", () => {
    const features = { fenBefore: FEN, uci: "e2e4", bestUci: "e2e4", phase: "opening" };
    attachIntuition(features, [{ move_uci: "e2e4", probability: 0.9 }]);
    expect(features.intuition.texture).toBe("obvious");
    expect(features.intuition.sharpness).toBeNull();
  });
});
