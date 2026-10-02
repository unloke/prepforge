// Engine line preview: the positions an engine PV walks through from the board's
// position, and the stepping rules for showing them on the board without touching the
// game, the analysis tree or a repertoire. Pure (chess.js only) so the stepping and
// labels test without a DOM; app.js owns the board and the controls.
import { Chess } from "chess.js";

/**
 * Walk `ucis` from `baseFen`. Returns `{ baseFen, plies: [{ uci, san, fen, label }] }`,
 * stopping at the first illegal move, where `label` is the numbered SAN of that ply
 * ("5.O-O", "5...Qxe5"). Null for an unusable FEN or an empty line.
 */
export function buildPvPreview(baseFen, ucis) {
  let chess;
  try {
    chess = new Chess(baseFen);
  } catch (_) {
    return null;
  }
  const plies = [];
  for (const uci of Array.isArray(ucis) ? ucis : []) {
    if (typeof uci !== "string" || uci.length < 4) break;
    const white = chess.turn() === "w";
    const moveNo = chess.moveNumber();
    let mv = null;
    try {
      mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    } catch (_) {
      mv = null;
    }
    if (!mv) break;
    plies.push({ uci, san: mv.san, fen: chess.fen(), label: `${moveNo}${white ? "." : "..."}${mv.san}` });
  }
  return plies.length ? { baseFen, plies } : null;
}

/** Clamp a preview ply (0 = the board's own position, n = the end of the line). */
export function clampPly(preview, ply) {
  const n = preview?.plies?.length || 0;
  return Math.max(0, Math.min(n, Math.round(Number(ply) || 0)));
}

/** The board position for preview ply `ply`: `{ fen, lastMove }`. */
export function previewPosition(preview, ply) {
  const at = clampPly(preview, ply);
  if (!preview || at === 0) return { fen: preview?.baseFen || null, lastMove: null };
  const step = preview.plies[at - 1];
  return { fen: step.fen, lastMove: step.uci };
}

/** Board-bar label while previewing: "Line 1 · 5...Qxe5 · 2/12" (ply 0: "Line 1 · start · 0/12"). */
export function previewLabel(preview, ply, lineIndex = 0) {
  const at = clampPly(preview, ply);
  const n = preview?.plies?.length || 0;
  const where = at === 0 ? "start" : preview.plies[at - 1].label;
  return `Line ${lineIndex + 1} · ${where} · ${at}/${n}`;
}

/**
 * Step the preview for a navigation key / button: "prev" | "next" | "start" | "end".
 * Returns the new ply.
 */
export function stepPreview(preview, ply, action) {
  const n = preview?.plies?.length || 0;
  if (action === "start") return 0;
  if (action === "end") return n;
  if (action === "prev") return clampPly(preview, ply - 1);
  if (action === "next") return clampPly(preview, ply + 1);
  return clampPly(preview, ply);
}
