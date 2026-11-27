import { describe, it, expect } from "vitest";
import { buildArrowHeadPath, buildArrowPath, endsUnder, isKnightHop } from "./board-arrows.js";
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
const fullHead = (pts, knight) => pts.slice(knight ? 3 : 2, knight ? 6 : 5);

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

describe("arrowhead geometry", () => {
  it.each([
    ["straight", centre(4, 1), centre(4, 3), false], // e2 → e4
    ["reversed", centre(4, 3), centre(4, 1), false], // e4 → e2
    ["knight", centre(6, 0), centre(5, 2), true], // g1 → f3
  ])("uses one three-point triangular head for a pink %s arrow", (_name, from, to, knight) => {
    const full = points(buildArrowPath(from, to, "better"));
    const redrawn = points(buildArrowHeadPath(from, to, "better"));
    expect(redrawn).toHaveLength(3);
    expect(redrawn).toEqual(fullHead(full, knight));

    const tip = redrawn[1];
    const dir = finalLegVector(from, to);
    const toward = (to.x - tip[0]) * dir.x + (to.y - tip[1]) * dir.y;
    const sideways = (to.x - tip[0]) * -dir.y + (to.y - tip[1]) * dir.x;
    expect(toward).toBeCloseTo(2.7, 3); // about 0.2 of a square before the target centre
    expect(sideways).toBeCloseTo(0, 3);
    expect(Math.abs(to.x - tip[0])).toBeLessThan(6.25);
    expect(Math.abs(to.y - tip[1])).toBeLessThan(6.25);
  });

  it("keeps a forward shaft on the shortest orthogonal move", () => {
    const from = centre(4, 1); // e2
    const to = centre(4, 2); // e3
    const pts = points(buildArrowPath(from, to, "better"));
    const tailMid = [(pts[0][0] + pts[6][0]) / 2, (pts[0][1] + pts[6][1]) / 2];
    const neckMid = [(pts[1][0] + pts[5][0]) / 2, (pts[1][1] + pts[5][1]) / 2];
    const dir = unitVector(from, to);
    const forward = (neckMid[0] - tailMid[0]) * dir.x + (neckMid[1] - tailMid[1]) * dir.y;
    expect(forward).toBeGreaterThan(1);
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
    expect(endsUnder(c4, d3)).toBe(false); // the longer one is not hidden
    expect(endsUnder(g2, c4)).toBe(false); // other diagonal
    expect(endsUnder({ from: centre(6, 0), to: centre(5, 2) }, { from: centre(6, 0), to: centre(4, 4) })).toBe(false); // knight hop
    const head = points(buildArrowHeadPath(d3.from, d3.to));
    expect(head).toHaveLength(3);
    const full = points(buildArrowPath(d3.from, d3.to));
    expect(head[1]).toEqual(full[3]); // same tip as the full arrow
  });
});
