// Board annotation arrow geometry, in the overlay's 0..100 viewBox (one square = 12.5).
//
// Each arrow is ONE closed polygon (shaft + head), so the head can never drift off the
// shaft at any stroke width or orientation. A knight-shaped hop (1×2 squares) is
// drawn as an L — long leg first, then the short one — so it reads as the knight's path
// instead of a diagonal through a square it never crosses.

const SQUARE = 12.5;
const TAIL_OFFSET = 3.5; // start off the moving piece's centre so it stays visible
const TIP_INSET = 2.7; // stop inside the target square, short of its centre
const DEFAULT_SHAPE = { shaft: 0.95, head: 2.55, length: 3.45 };
const ROLE_SHAPE = {
  engine: { shaft: 1.05, head: 2.65, length: 3.6 },
  better: DEFAULT_SHAPE,
  user: { shaft: 0.85, head: 2.35, length: 3.2 },
  branch: { shaft: 0.68, head: 2.05, length: 2.85 },
  "branch is-pick": { shaft: 0.94, head: 2.5, length: 3.35 },
};
const shapeFor = (role) => ROLE_SHAPE[String(role || "")] || DEFAULT_SHAPE;

const fmt = (n) => (Math.abs(n) < 5e-4 ? "0" : n.toFixed(3));
const pathOf = (outline) => outline.map((p, i) => `${i ? "L" : "M"}${fmt(p.x)},${fmt(p.y)}`).join(" ") + " Z";

function unit(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, len };
}

export function isKnightHop(from, to) {
  const fx = Math.round(Math.abs(to.x - from.x) / SQUARE);
  const fy = Math.round(Math.abs(to.y - from.y) / SQUARE);
  return (fx === 1 && fy === 2) || (fx === 2 && fy === 1);
}

// The arrow's centre line: [tail, (corner), neck] plus the tip it points at.
function spine(from, to, headLength) {
  const knight = isKnightHop(from, to);
  const corner = knight
    ? Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
      ? { x: to.x, y: from.y }
      : { x: from.x, y: to.y }
    : null;
  const first = corner || to;
  const u0 = unit(from.x, from.y, first.x, first.y);
  const tail = { x: from.x + u0.x * TAIL_OFFSET, y: from.y + u0.y * TAIL_OFFSET };
  const lastFrom = corner || from;
  const u1 = unit(lastFrom.x, lastFrom.y, to.x, to.y);
  const tip = { x: to.x - u1.x * TIP_INSET, y: to.y - u1.y * TIP_INSET };
  const neck = { x: tip.x - u1.x * headLength, y: tip.y - u1.y * headLength };
  return { points: corner ? [tail, corner, neck] : [tail, neck], tip, dir: u1 };
}

// A plain triangular marker: left wing, tip, right wing. The full arrow and a
// redrawn stop head share these exact vertices so a shared endpoint has no seam.
function headPoints(neck, tip, dir, halfHead) {
  const px = -dir.y;
  const py = dir.x;
  return [
    { x: neck.x + px * halfHead, y: neck.y + py * halfHead },
    tip,
    { x: neck.x - px * halfHead, y: neck.y - py * halfHead },
  ];
}

export function buildArrowPath(from, to, role) {
  const shape = shapeFor(role);
  const halfShaft = shape.shaft;
  const { points, tip, dir } = spine(from, to, shape.length);
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const inDir = i > 0 ? unit(a.x, a.y, p.x, p.y) : unit(p.x, p.y, b.x, b.y);
    const outDir = i < points.length - 1 ? unit(p.x, p.y, b.x, b.y) : inDir;
    // Miter join: offset along the bisector of the two normals, scaled so the shaft
    // keeps its width through the bend.
    let nx = -(inDir.y + outDir.y);
    let ny = inDir.x + outDir.x;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen;
    ny /= nlen;
    const cos = nx * -inDir.y + ny * inDir.x;
    const k = halfShaft / (Math.abs(cos) > 0.2 ? cos : 1);
    left.push({ x: p.x + nx * k, y: p.y + ny * k });
    right.push({ x: p.x - nx * k, y: p.y - ny * k });
  }
  const neck = points[points.length - 1];
  const outline = [
    ...left,
    ...headPoints(neck, tip, dir, shape.head),
    ...right.reverse(),
  ];
  return pathOf(outline);
}

// Just the head of the arrow buildArrowPath(from, to) draws, as its own polygon.
export function buildArrowHeadPath(from, to, role) {
  const shape = shapeFor(role);
  const { points, tip, dir } = spine(from, to, shape.length);
  return pathOf(headPoints(points[points.length - 1], tip, dir, shape.head));
}

// True when the straight arrow a ends on the path of the longer straight arrow b from the
// same square (f1-d3 under f1-c4): b's shaft would hide all of a but its head.
export function endsUnder(a, b) {
  if (a.from.x !== b.from.x || a.from.y !== b.from.y) return false;
  if (isKnightHop(a.from, a.to) || isKnightHop(b.from, b.to)) return false;
  const ua = unit(a.from.x, a.from.y, a.to.x, a.to.y);
  const ub = unit(b.from.x, b.from.y, b.to.x, b.to.y);
  return Math.abs(ua.x - ub.x) < 1e-6 && Math.abs(ua.y - ub.y) < 1e-6 && ub.len > ua.len + 1e-6;
}
