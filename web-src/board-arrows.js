// Board annotation geometry and brush parsing, in the overlay's 0..100 viewBox (one square = 12.5).
//
// Each arrow is ONE closed path (rounded pill tail + shaft + proportional head), so the head
// never drifts off the shaft and crossing arrows never double-composite shaft/head seams.
// Knight hops (1×2 squares) follow a long-leg-first L with a concentric circular fillet at the
// 90° bend instead of a sharp miter spike.

const SQUARE = 12.5;
const TAIL_OFFSET = 3.15;
const TIP_INSET = 2.35;
const TIP_SHORT_INSET = 4.35;
const CORNER_RADIUS = 3.1;
export const CIRCLE_RADIUS = 5.42;

export const BRUSH_CODES = Object.freeze(["G", "R", "B", "Y"]);
export const DEFAULT_BRUSH = "G";

const ARROW_TOKEN_RE = /^([GRBY])?([a-h][1-8])([a-h][1-8])[qrbn]?$/;
const CIRCLE_TOKEN_RE = /^([GRBY])?([a-h][1-8])$/;

const DEFAULT_SHAPE = { shaft: 0.98, head: 2.52, length: 3.38 };
const ROLE_SHAPE = {
  engine: { shaft: 1.12, head: 2.75, length: 3.65 },
  better: { shaft: 1.0, head: 2.55, length: 3.42 },
  user: { shaft: 0.96, head: 2.48, length: 3.32 },
  branch: { shaft: 0.68, head: 2.0, length: 2.78 },
  "branch is-pick": { shaft: 0.98, head: 2.5, length: 3.35 },
};

function shapeFor(role, scale = 1) {
  const base = ROLE_SHAPE[String(role || "")] || DEFAULT_SHAPE;
  const k = Number.isFinite(scale) ? Math.max(0.45, Math.min(1.25, scale)) : 1;
  if (k === 1) return base;
  const hk = 0.3 + 0.7 * k;
  return { shaft: base.shaft * k, head: base.head * hk, length: base.length * hk };
}

const fmt = (n) => (Math.abs(n) < 5e-4 ? "0" : n.toFixed(3));
const pt = (p) => `${fmt(p.x)},${fmt(p.y)}`;

function unit(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len, len };
}

export function parseArrowToken(raw) {
  if (typeof raw !== "string") return null;
  const m = ARROW_TOKEN_RE.exec(raw.trim());
  if (!m || m[2] === m[3]) return null;
  const brush = m[1] || DEFAULT_BRUSH;
  return { brush, from: m[2], to: m[3], key: `${m[2]}${m[3]}`, token: `${brush}${m[2]}${m[3]}` };
}

export function parseCircleToken(raw) {
  if (typeof raw !== "string") return null;
  const m = CIRCLE_TOKEN_RE.exec(raw.trim());
  if (!m) return null;
  const brush = m[1] || DEFAULT_BRUSH;
  return { brush, square: m[2], token: `${brush}${m[2]}` };
}

export function toggleArrowList(arrows, from, to, brush = DEFAULT_BRUSH) {
  const next = Array.isArray(arrows) ? arrows.slice() : [];
  const key = `${from}${to}`;
  const idx = next.findIndex((item) => parseArrowToken(item)?.key === key);
  if (idx !== -1) {
    const existing = parseArrowToken(next[idx]);
    next.splice(idx, 1);
    if (existing?.brush !== brush) next.push(`${brush}${key}`);
  } else {
    next.push(`${brush}${key}`);
  }
  return next;
}

export function toggleCircleSet(highlights, squareName, brush = DEFAULT_BRUSH) {
  const next = new Set(highlights);
  for (const item of next) {
    const parsed = parseCircleToken(item);
    if (parsed?.square === squareName) {
      next.delete(item);
      if (parsed.brush !== brush) next.add(`${brush}${squareName}`);
      return next;
    }
  }
  next.add(`${brush}${squareName}`);
  return next;
}

export function eventBrushCode(event, { shiftIsTrigger = false, isMac = false } = {}) {
  if (!event) return DEFAULT_BRUSH;
  const shift = Boolean(event.shiftKey) && !shiftIsTrigger;
  const alt = Boolean(event.altKey) || Boolean(event.getModifierState?.("AltGraph"));
  const ctrl = Boolean(event.ctrlKey) && !isMac;
  const meta = Boolean(event.metaKey);
  if ((shift && (alt || meta || ctrl)) || (alt && (ctrl || meta))) return "Y";
  if (ctrl || meta) return shiftIsTrigger ? "R" : "Y";
  if (alt) return "B";
  if (shift) return "R";
  return DEFAULT_BRUSH;
}

export function isKnightHop(from, to) {
  const fx = Math.round(Math.abs(to.x - from.x) / SQUARE);
  const fy = Math.round(Math.abs(to.y - from.y) / SQUARE);
  return (fx === 1 && fy === 2) || (fx === 2 && fy === 1);
}

function spine(from, to, headLength, shorten = false) {
  const knight = isKnightHop(from, to);
  const baseInset = shorten ? TIP_SHORT_INSET : TIP_INSET;
  if (!knight) {
    const u = unit(from.x, from.y, to.x, to.y);
    const maxUsed = u.len - TAIL_OFFSET - 1.2;
    const tipInset = Math.min(baseInset, Math.max(1.5, maxUsed - headLength));
    const tail = { x: from.x + u.x * TAIL_OFFSET, y: from.y + u.y * TAIL_OFFSET };
    const tip = { x: to.x - u.x * tipInset, y: to.y - u.y * tipInset };
    const neck = { x: tip.x - u.x * headLength, y: tip.y - u.y * headLength };
    return { knight: false, tail, neck, tip, u0: u, u1: u };
  }
  const corner = Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
    ? { x: to.x, y: from.y }
    : { x: from.x, y: to.y };
  const u0 = unit(from.x, from.y, corner.x, corner.y);
  const u1 = unit(corner.x, corner.y, to.x, to.y);
  const maxShortUsed = u1.len - 2.2;
  const tipInset = Math.min(baseInset, Math.max(1.5, maxShortUsed - headLength));
  const tail = { x: from.x + u0.x * TAIL_OFFSET, y: from.y + u0.y * TAIL_OFFSET };
  const tip = { x: to.x - u1.x * tipInset, y: to.y - u1.y * tipInset };
  const neck = { x: tip.x - u1.x * headLength, y: tip.y - u1.y * headLength };
  const shortNeckDist = u1.len - tipInset - headLength;
  return { knight: true, tail, corner, neck, tip, u0, u1, shortNeckDist };
}

function headPoints(neck, tip, dir, halfHead) {
  const px = -dir.y;
  const py = dir.x;
  return [
    { x: neck.x + px * halfHead, y: neck.y + py * halfHead },
    tip,
    { x: neck.x - px * halfHead, y: neck.y - py * halfHead },
  ];
}

export function buildArrowPath(from, to, role, options = {}) {
  const shape = shapeFor(role, options.scale);
  const w = shape.shaft;
  const s = spine(from, to, shape.length, Boolean(options.shorten));
  const [leftWing, tip, rightWing] = headPoints(s.neck, s.tip, s.u1, shape.head);
  const nL0 = { x: -s.u0.y, y: s.u0.x };
  const leftTail = { x: s.tail.x + nL0.x * w, y: s.tail.y + nL0.y * w };
  const rightTail = { x: s.tail.x - nL0.x * w, y: s.tail.y - nL0.y * w };

  if (!s.knight) {
    const leftNeck = { x: s.neck.x + nL0.x * w, y: s.neck.y + nL0.y * w };
    const rightNeck = { x: s.neck.x - nL0.x * w, y: s.neck.y - nL0.y * w };
    return (
      `M${pt(leftTail)} L${pt(leftNeck)} L${pt(leftWing)} L${pt(tip)} ` +
      `L${pt(rightWing)} L${pt(rightNeck)} L${pt(rightTail)} ` +
      `A${fmt(w)},${fmt(w)} 0 0 0 ${pt(leftTail)} Z`
    );
  }

  const nL1 = { x: -s.u1.y, y: s.u1.x };
  const radius = Math.min(CORNER_RADIUS, Math.max(w + 0.3, s.shortNeckDist - 0.35));
  const pIn = { x: s.corner.x - s.u0.x * radius, y: s.corner.y - s.u0.y * radius };
  const pOut = { x: s.corner.x + s.u1.x * radius, y: s.corner.y + s.u1.y * radius };
  const leftIn = { x: pIn.x + nL0.x * w, y: pIn.y + nL0.y * w };
  const rightIn = { x: pIn.x - nL0.x * w, y: pIn.y - nL0.y * w };
  const leftOut = { x: pOut.x + nL1.x * w, y: pOut.y + nL1.y * w };
  const rightOut = { x: pOut.x - nL1.x * w, y: pOut.y - nL1.y * w };
  const leftNeck = { x: s.neck.x + nL1.x * w, y: s.neck.y + nL1.y * w };
  const rightNeck = { x: s.neck.x - nL1.x * w, y: s.neck.y - nL1.y * w };

  const turn = s.u0.x * s.u1.y - s.u0.y * s.u1.x;
  const rLeft = turn > 0 ? Math.max(0.2, radius - w) : radius + w;
  const rRight = turn > 0 ? radius + w : Math.max(0.2, radius - w);
  const sweepLeft = turn > 0 ? 1 : 0;
  const sweepRightBack = turn > 0 ? 0 : 1;

  return (
    `M${pt(leftTail)} L${pt(leftIn)} ` +
    `A${fmt(rLeft)},${fmt(rLeft)} 0 0 ${sweepLeft} ${pt(leftOut)} ` +
    `L${pt(leftNeck)} L${pt(leftWing)} L${pt(tip)} L${pt(rightWing)} L${pt(rightNeck)} ` +
    `L${pt(rightOut)} A${fmt(rRight)},${fmt(rRight)} 0 0 ${sweepRightBack} ${pt(rightIn)} ` +
    `L${pt(rightTail)} A${fmt(w)},${fmt(w)} 0 0 0 ${pt(leftTail)} Z`
  );
}

export function buildArrowHeadPath(from, to, role, options = {}) {
  const shape = shapeFor(role, options.scale);
  const s = spine(from, to, shape.length, Boolean(options.shorten));
  const [leftWing, tip, rightWing] = headPoints(s.neck, s.tip, s.u1, shape.head);
  return `M${pt(leftWing)} L${pt(tip)} L${pt(rightWing)} Z`;
}

export function endsUnder(a, b) {
  if (a.from.x !== b.from.x || a.from.y !== b.from.y) return false;
  if (isKnightHop(a.from, a.to) || isKnightHop(b.from, b.to)) return false;
  const ua = unit(a.from.x, a.from.y, a.to.x, a.to.y);
  const ub = unit(b.from.x, b.from.y, b.to.x, b.to.y);
  return Math.abs(ua.x - ub.x) < 1e-6 && Math.abs(ua.y - ub.y) < 1e-6 && ub.len > ua.len + 1e-6;
}

// White-POV centipawn / mate -> mover's win chance [0..1], used to scale Multi-PV arrows
// like Lichess/En Croissant: near-equal alternatives stay wide; losing lines drop off.
export function pvWinChance(pv, sideToMove = "w") {
  let whiteWin = 0.5;
  if (typeof pv?.mate_in === "number" && pv.mate_in !== 0) {
    const step = Math.min(0.04, Math.abs(pv.mate_in) * 0.002);
    whiteWin = pv.mate_in > 0 ? 1 - step : step;
  } else if (typeof pv?.score_cp === "number" && Number.isFinite(pv.score_cp)) {
    whiteWin = 1 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, pv.score_cp))));
  }
  return sideToMove === "b" ? 1 - whiteWin : whiteWin;
}

const MULTIPV_MAX_WIN_LOSS = 0.22;

export function scaleMultiPvArrows(pvs, sideToMove = "w") {
  if (!Array.isArray(pvs) || !pvs.length) return [];
  const seen = new Set();
  const bestWin = pvWinChance(pvs[0], sideToMove);
  const out = [];
  for (let i = 0; i < pvs.length; i++) {
    const uci = pvs[i]?.pv_uci?.[0];
    if (typeof uci !== "string" || uci.length < 4) continue;
    const key = uci.slice(0, 4);
    if (seen.has(key)) continue;
    if (i === 0) {
      seen.add(key);
      out.push({ uci, scale: 1, rank: 1 });
      continue;
    }
    const loss = Math.max(0, bestWin - pvWinChance(pvs[i], sideToMove));
    if (loss > MULTIPV_MAX_WIN_LOSS) continue;
    seen.add(key);
    const scale = Number((0.82 - (loss / MULTIPV_MAX_WIN_LOSS) * 0.34).toFixed(3));
    out.push({ uci, scale: Math.max(0.48, scale), rank: i + 1 });
  }
  return out;
}
