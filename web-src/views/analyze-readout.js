// The eval chart's hover readout: where it sits beside the pointer and what it
// says (move, evaluation, grade). Pure functions of their arguments.
import { html } from "../html.js";
import { classBadgeSymbol } from "../move-grades.js";
import { moveTokenHtml } from "../move-text.js";

// The hover readout keeps this far from the pointer's own column, and this
// far off the band's edge on the side it takes.
const READOUT_GAP = 12;
const READOUT_EDGE = 3;
// Checkmate-on-board sentinel (game-analyzer terminalEval / engine.py mate_score).
const CHECKMATE_CP = 10000;

// Where the hovered point's readout sits, in the wrap's coordinates. It takes
// the side of the plot away from the pointer and the half of the band away
// from the point, so neither the column being pointed at nor the curve it
// names is ever under it. A phone's plot is narrower than the longest readout
// ("8. O-O-O · −2.35 · ?! Inaccuracy" is 166px of a 276px graph): clamping the
// box back inside the plot slid it across the pointer at dead centre, so the
// side is chosen by the room it has and the readout is clipped to that room.
// `cursorPx` and `pointY` are in plot pixels, read off the live box.
export function placeEvalReadout(plotW, plotH, cursorPx, width, height, pointY) {
  const [leftRoom, rightRoom] = [cursorPx - READOUT_GAP, plotW - cursorPx - READOUT_GAP].map((r) => Math.max(0, r));
  // The side away from the pointer, unless only the other side can hold the
  // readout uncut; failing both, the roomier one.
  const preferLeft = cursorPx >= plotW / 2;
  const [farRoom, nearRoom] = preferLeft ? [leftRoom, rightRoom] : [rightRoom, leftRoom];
  const onLeft = farRoom >= width ? preferLeft : nearRoom >= width ? !preferLeft : farRoom >= nearRoom;
  const room = onLeft ? leftRoom : rightRoom;
  const top = pointY <= plotH / 2 ? plotH - height - READOUT_EDGE : READOUT_EDGE;
  return { left: onLeft ? Math.max(0, cursorPx - READOUT_GAP - Math.min(width, room)) : cursorPx + READOUT_GAP, maxWidth: room, top };
}

// Engine evaluation as players read it: "+1.4" / "−0.3" in pawns (White's
// point of view), "#3" / "#-2" for forced mates, "1-0" / "0-1" once the
// board itself is checkmate.
export function formatPointEval(point) {
  if (point.mate_in != null && point.mate_in !== 0) {
    return point.mate_in > 0 ? `#${point.mate_in}` : `#-${Math.abs(point.mate_in)}`;
  }
  // A position that IS checkmate is stored as score_cp = ±100000 (no line to
  // search); reading that as pawns printed "+1000.0".
  if (point.score_cp != null && Math.abs(point.score_cp) >= CHECKMATE_CP) {
    return point.score_cp > 0 ? "1-0" : "0-1";
  }
  // Older reports carry mate only as score_cp = null with bounded_score_cp = ±1000.
  if (point.score_cp == null && Math.abs(point.bounded_score_cp || 0) >= 1000) {
    return point.bounded_score_cp > 0 ? "+M" : "−M";
  }
  const cp = point.score_cp != null ? point.score_cp : point.bounded_score_cp;
  if (cp === null || cp === undefined) return "0.00";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(2)}`;
}

// Tooltip body for one ply — move, evaluation, and classification as TEXT
// (plus the class glyph), so the readout never depends on colour alone.
// With the game's move for that ply, the SAN is a move token: the chart's hover
// peeks at the position after it (the readout itself takes no pointer).
// The departure notch: the one moment with no eval event, so a thin line from the
// chart's top edge down to the curve at that ply.
export function departureNotch(x, y) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", "eval-departure");
  line.setAttribute("x1", String(x));
  line.setAttribute("x2", String(x));
  line.setAttribute("y1", "0");
  line.setAttribute("y2", String(y));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  line.setAttribute("aria-hidden", "true");
  return line;
}

export function evalChartTooltipHtml(point, { isCurrent = false, move = null, leftPrep = false } = {}) {
  if (!point) return "";
  const raw = String(point.classification || "").toLowerCase();
  const label = raw ? raw.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
  const glyph = raw ? classBadgeSymbol(point.classification) : "";
  const san = String(point.san || "?");
  const moveNo = point.ply > 0 ? `${Math.ceil(point.ply / 2)}${point.ply % 2 ? "." : "…"} ` : "";
  const sanHtml = move?.fen_before && move.uci && move.san === point.san
    ? moveTokenHtml(move.fen_before, [move.uci], 0, san, { focusable: false })
    : san;
  return (
    html`${moveNo}<b>${sanHtml}</b> · ${formatPointEval(point)}${label ? ` · ${glyph} ${label}` : ""}${leftPrep ? " · left prep" : ""}${isCurrent ? " · current" : ""}`
  );
}
