import { describe, it, expect } from "vitest";
import { buildPvPreview, clampPly, previewPosition, previewLabel, stepPreview } from "./pv-preview.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

describe("engine line preview", () => {
  it("walks the line from the board's position with numbered labels", () => {
    const p = buildPvPreview(AFTER_E4, ["e7e5", "g1f3", "b8c6"]);
    expect(p.baseFen).toBe(AFTER_E4);
    expect(p.plies.map((x) => x.label)).toEqual(["1...e5", "2.Nf3", "2...Nc6"]);
    expect(p.plies[2].fen).toBe("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
  });

  it("stops at the first illegal move and rejects an empty or unusable line", () => {
    expect(buildPvPreview(START, ["e2e4", "e2e4", "g8f6"]).plies).toHaveLength(1);
    expect(buildPvPreview(START, [])).toBe(null);
    expect(buildPvPreview("not a fen", ["e2e4"])).toBe(null);
  });

  it("shows the board's own position at ply 0 and the line's moves after it", () => {
    const p = buildPvPreview(START, ["e2e4", "e7e5"]);
    expect(previewPosition(p, 0)).toEqual({ fen: START, lastMove: null });
    expect(previewPosition(p, 1)).toEqual({ fen: AFTER_E4, lastMove: "e2e4" });
    expect(previewPosition(p, 9).lastMove).toBe("e7e5");
  });

  it("steps forward and back inside the line without leaving it", () => {
    const p = buildPvPreview(START, ["e2e4", "e7e5", "g1f3"]);
    expect(stepPreview(p, 1, "next")).toBe(2);
    expect(stepPreview(p, 3, "next")).toBe(3);
    expect(stepPreview(p, 1, "prev")).toBe(0);
    expect(stepPreview(p, 0, "prev")).toBe(0);
    expect(stepPreview(p, 2, "start")).toBe(0);
    expect(stepPreview(p, 0, "end")).toBe(3);
    expect(clampPly(p, -4)).toBe(0);
  });

  it("labels where the preview is", () => {
    const p = buildPvPreview(START, ["e2e4", "e7e5"]);
    expect(previewLabel(p, 2, 0)).toBe("Line 1 · 1...e5 · 2/2");
    expect(previewLabel(p, 0, 1)).toBe("Line 2 · start · 0/2");
  });
});
