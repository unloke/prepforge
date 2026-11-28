import { describe, it, expect } from "vitest";
import {
  buildArrowHeadPath,
  buildArrowPath,
  endsUnder,
  eventBrushCode,
  isKnightHop,
  parseArrowToken,
  parseCircleToken,
  scaleMultiPvArrows,
} from "./board-arrows.js";
import { CLASS_GROUP_OF, classBadgeSymbol } from "./move-grades.js";

const centre = (file, rank) => ({ x: file * 12.5 + 6.25, y: (7 - rank) * 12.5 + 6.25 });

const unitVector = (from, to) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
};
const finalLegVector = (from, to) => {
  if (!isKnightHop(from, to)) return unitVector(from, to);
  const corner = Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
    ? { x: to.x, y: from.y }
    : { x: from.x, y: to.y };
  return unitVector(corner, to);
};

// Extract the [x, y] target of every M/L/A command in our closed path.
function pathCoords(d) {
  const out = [];
  for (const m of d.matchAll(/(?:[ML]|A[0-9.]+,[0-9.]+ 0 0 [01] )(-?[0-9.]+),(-?[0-9.]+)/g)) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

describe("board arrows", () => {
  it("draws a straight arrow as one closed polygon with a rounded semicircular tail cap", () => {
    const d = buildArrowPath(centre(4, 1), centre(4, 3)); // e2 -> e4
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    expect(d).toMatch(/A[0-9.]+,[0-9.]+ 0 0 0 [0-9.]+,[0-9.]+ Z$/);
    const pts = pathCoords(d);
    expect(pts).toHaveLength(8); // leftTail, leftNeck, leftWing, tip, rightWing, rightNeck, rightTail, tailArcEnd
    const tip = pts[3];
    expect(tip[0]).toBeCloseTo(centre(4, 3).x, 3);
    expect(tip[1]).toBeGreaterThan(centre(4, 3).y); // stops short of target centre
  });

  it("bends a knight hop into a filleted L (long leg first, smooth inner/outer arcs) in both turn directions", () => {
    const g1 = centre(6, 0);
    const f3 = centre(5, 2);
    const b1 = centre(1, 0);
    const c3 = centre(2, 2);
    expect(isKnightHop(g1, f3)).toBe(true);
    expect(isKnightHop(b1, c3)).toBe(true);
    expect(isKnightHop(centre(4, 1), centre(4, 3))).toBe(false);

    const leftTurn = buildArrowPath(g1, f3);
    const rightTurn = buildArrowPath(b1, c3);
    // 2 corner fillet arcs + 1 semicircular tail cap = 3 SVG arcs
    expect([...leftTurn.matchAll(/A[0-9.]+,[0-9.]+/g)]).toHaveLength(3);
    expect([...rightTurn.matchAll(/A[0-9.]+,[0-9.]+/g)]).toHaveLength(3);

    const pts = pathCoords(leftTurn);
    const tip = pts[5]; // leftTail, leftIn, leftOut, leftNeck, leftWing, tip, ...
    expect(tip[1]).toBeCloseTo(f3.y, 3);
    expect(tip[0]).toBeGreaterThan(f3.x); // arrives horizontally along the short leg
  });
});

describe("arrowhead geometry and shortening", () => {
  it.each([
    ["straight", centre(4, 1), centre(4, 3), false], // e2 -> e4
    ["reversed", centre(4, 3), centre(4, 1), false], // e4 -> e2
    ["knight", centre(6, 0), centre(5, 2), true], // g1 -> f3
  ])("shares exact three-point head vertices between full and stop-head %s arrows", (_name, from, to, knight) => {
    const full = pathCoords(buildArrowPath(from, to, "better"));
    const redrawn = pathCoords(buildArrowHeadPath(from, to, "better"));
    expect(redrawn).toHaveLength(3);
    expect(redrawn).toEqual(knight ? full.slice(4, 7) : full.slice(2, 5));

    const tip = redrawn[1];
    const dir = finalLegVector(from, to);
    const toward = (to.x - tip[0]) * dir.x + (to.y - tip[1]) * dir.y;
    const sideways = (to.x - tip[0]) * -dir.y + (to.y - tip[1]) * dir.x;
    expect(toward).toBeCloseTo(2.35, 3);
    expect(sideways).toBeCloseTo(0, 3);
  });

  it("pulls converging tips back when shorten is enabled while preserving forward shaft on 1-square moves", () => {
    const from = centre(4, 1); // e2
    const to = centre(4, 2); // e3
    const normal = pathCoords(buildArrowPath(from, to, "user"));
    const short = pathCoords(buildArrowPath(from, to, "user", { shorten: true }));
    expect(short[3][1]).toBeGreaterThan(normal[3][1]); // further back (larger y when moving up)
    const tailMidY = (short[0][1] + short[6][1]) / 2;
    const neckMidY = (short[1][1] + short[5][1]) / 2;
    expect(tailMidY - neckMidY).toBeGreaterThan(1);
  });
});

describe("brush tokens and Multi-PV scaling", () => {
  it("parses PGN 4-colour arrow and circle tokens and maps modifier keys cleanly", () => {
    expect(parseArrowToken("Rd4d5")).toEqual({ brush: "R", from: "d4", to: "d5", key: "d4d5", token: "Rd4d5" });
    expect(parseArrowToken("e2e4")).toEqual({ brush: "G", from: "e2", to: "e4", key: "e2e4", token: "Ge2e4" });
    expect(parseArrowToken("e4e4")).toBeNull();
    expect(parseCircleToken("Yb5")).toEqual({ brush: "Y", square: "b5", token: "Yb5" });
    expect(parseCircleToken("d4")).toEqual({ brush: "G", square: "d4", token: "Gd4" });

    expect(eventBrushCode({})).toBe("G");
    expect(eventBrushCode({ shiftKey: true })).toBe("R");
    expect(eventBrushCode({ altKey: true })).toBe("B");
    expect(eventBrushCode({ ctrlKey: true })).toBe("Y");
    expect(eventBrushCode({ shiftKey: true, altKey: true })).toBe("Y");
    expect(eventBrushCode({ ctrlKey: true }, { isMac: true })).toBe("G");
    expect(eventBrushCode({ metaKey: true }, { isMac: true })).toBe("Y");
    expect(eventBrushCode({ shiftKey: true }, { shiftIsTrigger: true })).toBe("G");
    expect(eventBrushCode({ shiftKey: true, altKey: true }, { shiftIsTrigger: true })).toBe("B");
  });

  it("scales Multi-PV engine arrows by win-chance loss and drops losing blunders", () => {
    const pvs = [
      { score_cp: 35, pv_uci: ["e2e4", "e7e5"] },
      { score_cp: 25, pv_uci: ["d2d4", "d7d5"] },
      { score_cp: -110, pv_uci: ["g1f3", "d7d5"] },
      { score_cp: -450, pv_uci: ["f2f4", "e7e5"] }, // > 22% win loss -> excluded
    ];
    const scaled = scaleMultiPvArrows(pvs, "w");
    expect(scaled.map((s) => s.uci)).toEqual(["e2e4", "d2d4", "g1f3"]);
    expect(scaled[0].scale).toBe(1);
    expect(scaled[1].scale).toBeGreaterThan(0.75);
    expect(scaled[2].scale).toBeGreaterThanOrEqual(0.48);
    expect(scaled[2].scale).toBeLessThan(scaled[1].scale);

    // Black to move: lower score_cp is better for Black
    const blackScaled = scaleMultiPvArrows([
      { score_cp: -40, pv_uci: ["c7c5"] },
      { score_cp: -20, pv_uci: ["e7e5"] },
      { score_cp: 350, pv_uci: ["h7h5"] },
    ], "b");
    expect(blackScaled.map((s) => s.uci)).toEqual(["c7c5", "e7e5"]);
  });
});

describe("move grades", () => {
  it("gives Great its own group and glyph", () => {
    expect(CLASS_GROUP_OF.great).toBe("great");
    expect(classBadgeSymbol("great")).toBe("!");
    expect(classBadgeSymbol("brilliant")).toBe("!!");
    expect(classBadgeSymbol("best")).toBe("✓");
    expect(classBadgeSymbol("forced")).toBe("✓");
    expect(classBadgeSymbol("missed_win")).toBe("×");
    expect(classBadgeSymbol("nonsense")).toBe("");
  });
});

describe("collinear arrows", () => {
  it("finds an arrow that ends on a longer arrow's path from the same square", () => {
    const f1 = centre(5, 0);
    const d3 = { from: f1, to: centre(3, 2) };
    const c4 = { from: f1, to: centre(2, 3) };
    const e2 = { from: f1, to: centre(4, 1) };
    const g2 = { from: f1, to: centre(6, 1) };
    expect(endsUnder(d3, c4)).toBe(true);
    expect(endsUnder(e2, c4)).toBe(true);
    expect(endsUnder(c4, d3)).toBe(false);
    expect(endsUnder(g2, c4)).toBe(false);
    expect(endsUnder({ from: centre(6, 0), to: centre(5, 2) }, { from: centre(6, 0), to: centre(4, 4) })).toBe(false);
    const head = pathCoords(buildArrowHeadPath(d3.from, d3.to));
    expect(head).toHaveLength(3);
    const full = pathCoords(buildArrowPath(d3.from, d3.to));
    expect(head[1]).toEqual(full[3]);
  });
});
