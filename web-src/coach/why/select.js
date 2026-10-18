// The frozen selector (research/coach-relations/why/sel.py, final.py): one feature row per candidate, scored by the
// gradient-boosted trees in model.js (sklearn's HistGradientBoosting, exported by why/export_js.py), and the score
// under which no candidate speaks.
import { Board } from "./board.js";
import { man } from "./facts.js";
import MODEL from "./model.js";

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const THRESHOLD = MODEL.threshold;

/** White-view {cp, mate} as the mover's centipawns, mates at ±1000. */
function cp(s, white) {
  const v = s.mate != null ? (s.mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, s.cp));
  return white ? v : -v;
}

export function features(card, cands) {
  const b = new Board(card.fen), white = b.turn;
  const loss = cp(card.before, white) - cp(card.after, white);
  const total = b.map().reduce((a, [, p]) => a + VAL[p.type], 0);
  const n = {};
  for (const c of cands) n[c.type] = (n[c.type] || 0) + 1;
  const lines = { played: card.played, best: card.best };
  // the squares of the first two moves of each line: does the fact touch the move itself or the reply?
  const touched = [];
  for (const ln of ["played", "best"]) {
    for (const j of [0, 1]) {
      const u = lines[ln][j];
      touched.push(u ? new Set([u.slice(0, 2), u.slice(2, 4)]) : new Set());
    }
  }
  return cands.map((c) => {
    const m = man(c, card.fen, lines);
    return [MODEL.types.indexOf(c.type), c.line === "best" ? 1 : 0, c.ply || 0, cands.length, n[c.type], m ?? -1, loss,
      b.full, total, c.net || 0, ...touched.map((s) => ((c.at || []).some((q) => s.has(q)) ? 1 : 0))];
  });
}

export function score(features) {
  const row = [MODEL.codes.includes(features[0]) ? MODEL.codes.indexOf(features[0]) : NaN, ...features.slice(1)];
  let raw = MODEL.baseline;
  for (const tree of MODEL.trees) {
    let node = tree[0];
    while (typeof node !== "number") {  // a leaf is its value; the type (feature 0) splits on a bitset of codes
      const [f, t, missingLeft, left, right] = node, x = row[f];
      const goLeft = Number.isNaN(x) ? missingLeft === 1 : f === 0 ? ((t >>> x) & 1) === 1 : x <= t;
      node = tree[goLeft ? left : right];
    }
    raw += node;
  }
  return 1 / (1 + Math.exp(-raw));
}
