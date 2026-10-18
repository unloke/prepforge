// The reason sentence for an inaccuracy, mistake or blunder: a forced mate in either line when explain speaks it,
// else the best-scored candidate over the selector's threshold that explain speaks, or else the bare sentence
// (research/coach-relations/why/final.py, plus the mate rule: the frozen selector passed over 40 of 47 mates; sol
// preferred the mate on 38 of those 40).
import { Board } from "./board.js";
import { explain } from "./explain.js";
import { cardFacts } from "./facts.js";
import { THRESHOLD, features, score } from "./select.js";

/**
 * card: {fen, grade ("inaccuracy" | "mistake" | "blunder"), played: [uci of the move, ...its engine line],
 * best: [uci...], before / after: White-view {cp, mate} around the move}.
 */
export function why(card) {
  const white = new Board(card.fen).turn;
  const { before: b, after: a } = card;
  const loss = b.cp == null || a?.cp == null ? null : (b.cp - a.cp) * (white ? 1 : -1);
  const c = { ...card, after: a || {}, loss };
  const cands = cardFacts(c.fen, c.played, c.best);
  const s = cands.length ? features(c, cands).map(score) : [];
  const mate = (i) => (cands[i].type === "mate" ? 1 : 0);
  const order = s.map((_, i) => i).sort((x, y) => mate(y) - mate(x) || s[y] - s[x]);
  for (const i of order) {
    if (!mate(i) && s[i] < THRESHOLD) break;
    const e = explain(c, [cands[i]]);
    if (e.chosen.length) return e.text;
  }
  return explain(c, []).text;
}
