import { describe, it, expect } from "vitest";
import { buildArrowPath, isKnightHop } from "./board-arrows.js";
import { CLASS_GROUP_OF, classBadgeSymbol } from "./move-grades.js";

const centre = (file, rank) => ({ x: file * 12.5 + 6.25, y: (7 - rank) * 12.5 + 6.25 });
const points = (d) =>
  d
    .replace(/ Z$/, "")
    .split(" ")
    .map((cmd) => cmd.slice(1).split(",").map(Number));

describe("board arrows", () => {
  it("draws a straight arrow as one closed shaft-and-head polygon", () => {
    const d = buildArrowPath(centre(4, 1), centre(4, 3)); // e2 → e4
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith(" Z")).toBe(true);
    const pts = points(d);
    expect(pts).toHaveLength(7); // 2 shaft points per side + 3 head points
    const tip = pts[3];
    expect(tip[0]).toBeCloseTo(centre(4, 3).x, 3);
    expect(tip[1]).toBeGreaterThan(centre(4, 3).y); // stops just short of the centre
  });

  it("bends a knight hop into an L, long leg first", () => {
    const from = centre(6, 0); // g1
    const to = centre(5, 2); // f3
    expect(isKnightHop(from, to)).toBe(true);
    expect(isKnightHop(centre(4, 1), centre(4, 3))).toBe(false);
    const pts = points(buildArrowPath(from, to));
    expect(pts).toHaveLength(9); // an extra corner point on each side
    const tip = pts[4];
    expect(tip[1]).toBeCloseTo(to.y, 3);
    expect(tip[0]).toBeGreaterThan(to.x); // the short leg arrives sideways
  });
});

describe("move grades", () => {
  it("gives Great its own group and glyph", () => {
    expect(CLASS_GROUP_OF.great).toBe("great");
    expect(classBadgeSymbol("great")).toBe("!");
    expect(classBadgeSymbol("brilliant")).toBe("!!");
    expect(classBadgeSymbol("best")).toBe("✓");
    expect(classBadgeSymbol("missed_win")).toBe("×");
    expect(classBadgeSymbol("nonsense")).toBe("");
  });
});

describe("collinear arrows", () => {
  it("finds an arrow that ends on a longer arrow's path from the same square", async () => {
    const { endsUnder, buildArrowHeadPath } = await import("./board-arrows.js");
    const f1 = centre(5, 0);
    const d3 = { from: f1, to: centre(3, 2) };
    const c4 = { from: f1, to: centre(2, 3) };
    const e2 = { from: f1, to: centre(4, 1) };
    const g2 = { from: f1, to: centre(6, 1) };
    expect(endsUnder(d3, c4)).toBe(true);
    expect(endsUnder(e2, c4)).toBe(true);
    expect(endsUnder(c4, d3)).toBe(false); // the longer one is not hidden
    expect(endsUnder(g2, c4)).toBe(false); // other diagonal
    expect(endsUnder({ from: centre(6, 0), to: centre(5, 2) }, { from: centre(6, 0), to: centre(4, 4) })).toBe(false); // knight hop
    const head = points(buildArrowHeadPath(d3.from, d3.to));
    expect(head).toHaveLength(3);
    const full = points(buildArrowPath(d3.from, d3.to));
    expect(head[1]).toEqual(full[3]); // same tip as the full arrow
  });
});
