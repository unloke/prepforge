// Where a Scout line leaves a repertoire, and whether that is on the preparing
// side's own move. A line taken from the opponent's games carries the moves THEIR
// opponents chose; where your tree already plays something else at your own turn,
// writing the line would add a second move of yours beside it.

import { fenAfterLine, lineCoverage, uciToSan } from "./scout.js";

const moverAt = (ply) => (ply % 2 === 0 ? "white" : "black");

/** "1.e4" for White's move at ply 0, "1…c5" for Black's at ply 1. */
export function plyMoveLabel(ply, san) {
  const moveNo = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? `${moveNo}.${san}` : `${moveNo}…${san}`;
}

/**
 * The first move of `lineUcis` the tree lacks: { ply, onYourMove, lineUci, lineLabel,
 * yourUci, yourLabel }, where `yourUci` is the move the tree already plays there on
 * your own turn (null on theirs, or where you have no move yet). Null when covered.
 */
export function lineGap(lookup, lineUcis, myColor) {
  const ucis = lineUcis || [];
  if (!lookup || !ucis.length) return null;
  const { covered, deepestNodeId } = lineCoverage(lookup, ucis);
  if (covered >= ucis.length) return null;
  const onYourMove = moverAt(covered) === myColor;
  const children = onYourMove ? lookup.childUci.get(deepestNodeId) : null;
  const yours = children?.size
    ? [...children.entries()].sort(([, a], [, b]) => Number(b.is_mainline) - Number(a.is_mainline))[0]
    : null;
  const yourUci = yours?.[0] ?? null;
  const fen = fenAfterLine(ucis.slice(0, covered));
  const label = (uci) => plyMoveLabel(covered, uciToSan(fen, uci) || uci);
  const lineUci = ucis[covered];
  return { ply: covered, onYourMove, lineUci, lineLabel: label(lineUci), yourUci, yourId: yours?.[1]?.id ?? null,
    yourLabel: yourUci ? label(yourUci) : null };
}

/** The gap, when it would put a second move of yours beside one the tree has. */
export function ownMoveDivergence(lookup, lineUcis, myColor) {
  const gap = lineGap(lookup, lineUcis, myColor);
  return gap?.yourUci ? gap : null;
}

/** A copy of `lookup` that the batch check can grow without touching the original. */
export function copyLookup(lookup) {
  return { rootId: lookup.rootId, childUci: new Map([...lookup.childUci].map(([id, kids]) => [id, new Map(kids)])) };
}

/**
 * Adds a line to `lookup` in place, as if written: each move the tree lacks becomes a
 * child of the one before it. A batch checks each line against the lines before it.
 */
export function addLineToLookup(lookup, lineUcis) {
  let nodeId = lookup.rootId;
  (lineUcis || []).forEach((uci, i) => {
    if (!lookup.childUci.has(nodeId)) lookup.childUci.set(nodeId, new Map());
    const kids = lookup.childUci.get(nodeId);
    if (!kids.has(uci)) kids.set(uci, { id: `queued:${nodeId}:${i}:${uci}`, is_mainline: kids.size === 0, is_enabled: true });
    nodeId = kids.get(uci).id;
  });
  return lookup;
}

/** Whether two divergences are the same branch: same place, same move of yours, same new move. */
export function sameDivergence(a, b) {
  return Boolean(a && b && a.ply === b.ply && a.lineUci === b.lineUci && a.yourUci === b.yourUci);
}

/** One preview line for a divergence: "branches from your 1…c5 (adds 1…e5)". */
export function divergenceNote(divergence) {
  return `branches from your ${divergence.yourLabel} (adds ${divergence.lineLabel})`;
}

/**
 * Report text for a partly covered line (`line.gap` from lineGap): on your own move it
 * names the move your prep plays instead; on theirs, the move it has no answer to.
 */
export function prepGapText(line) {
  const where = line.repName || "your prep";
  const gap = line.gap;
  if (!gap) return `Gap in ${where} after ${line.covered} plies`;
  if (gap.yourLabel) return `Branches from your ${gap.yourLabel} in ${where} (line plays ${gap.lineLabel})`;
  if (gap.onYourMove) return `Gap in ${where}: no move of yours chosen at move ${Math.floor(gap.ply / 2) + 1}`;
  return `Gap in ${where}: no answer to their ${gap.lineLabel}`;
}

/**
 * The repertoire (of `reps`, all of one colour) whose tree follows `lines` furthest
 * in total; null when none follows any. `lookups` is [{ rep, lookup }].
 */
export function bestCoveringRepertoireId(reps, lookups, lines) {
  const ids = new Set((reps || []).map((r) => r.id));
  let best = null;
  for (const { rep, lookup } of lookups || []) {
    if (!ids.has(rep?.id) || !lookup) continue;
    let plies = 0;
    for (const line of lines || []) plies += lineCoverage(lookup, line.ucis || []).covered;
    if (plies > 0 && (!best || plies > best.plies)) best = { id: rep.id, plies };
  }
  return best?.id ?? null;
}
