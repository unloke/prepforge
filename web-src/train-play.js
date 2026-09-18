// Play vs human session helpers. Pure: history + color + PGN, no DOM.

import { ratingBucketsFor } from "./explorer.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function sideToMove(fen) {
  return String(fen || "").split(/\s+/)[1] === "b" ? "black" : "white";
}

export function resolvePlayColor({
  book = "explorer",
  pickerColor = "white",
  repertoireColor = "white",
  repertoireColors = null,
  availableColors = null,
  luckyFen = null,
} = {}) {
  if (luckyFen) return sideToMove(luckyFen);
  if (book === "repertoire") {
    const colors = Array.isArray(repertoireColors)
      ? repertoireColors
      : Array.isArray(availableColors)
        ? availableColors
        : [repertoireColor];
    const normalized = [...new Set(colors.map((color) => (color === "black" ? "black" : "white")))];
    if (normalized.length === 1) return normalized[0];
    return pickerColor === "black" ? "black" : "white";
  }
  return pickerColor === "black" ? "black" : "white";
}

export function playPoolLabel(rating, buckets = ratingBucketsFor(rating)) {
  const list = Array.isArray(buckets) ? buckets.filter((n) => Number.isFinite(n)) : [];
  if (list.length >= 2) return `${list[0]}–${list[list.length - 1]}`;
  if (list.length === 1) return String(list[0]);
  return "your rating";
}

export function formatPlayTrail(history, startFen = START_FEN) {
  const moves = Array.isArray(history) ? history : [];
  if (!moves.length) return "";
  const parts = String(startFen || START_FEN).trim().split(/\s+/);
  let full = Number(parts[5]) || 1;
  let side = parts[1] === "b" ? "b" : "w";
  const out = [];
  for (const ply of moves) {
    const san = ply && ply.san;
    if (!san) continue;
    if (side === "w") out.push(`${full}. ${san}`);
    else out.push(san);
    if (side === "b") full += 1;
    side = side === "w" ? "b" : "w";
  }
  return out.join(" ");
}

// Undo back to the user's previous decision: drop a trailing opponent ply,
// then drop the user ply that led there. Empty history means the session start.
export function takebackToUserMove(history) {
  const list = Array.isArray(history) ? history.slice() : [];
  if (!list.length) {
    return { history: [], fen: null, nodeId: null, repertoireCursors: null, lastMove: null };
  }
  if (list[list.length - 1].by === "opp") list.pop();
  if (list.length && list[list.length - 1].by === "user") list.pop();
  const last = list[list.length - 1] || null;
  return {
    history: list,
    fen: last ? last.fenAfter : null,
    nodeId: last ? last.nodeIdAfter : null,
    repertoireCursors: last && last.repertoireCursorsAfter ? last.repertoireCursorsAfter : null,
    lastMove: last ? last.uci : null,
  };
}

export function playSessionPgn(play) {
  const session = play || {};
  const startFen = session.startFen || START_FEN;
  const trail = formatPlayTrail(session.history, startFen);
  const youWhite = session.userColor !== "black";
  const headers = [
    `[Event "Play vs human"]`,
    `[White "${youWhite ? "You" : "Opponent"}"]`,
    `[Black "${youWhite ? "Opponent" : "You"}"]`,
  ];
  const placement = String(startFen).trim().split(/\s+/)[0];
  if (placement && placement !== START_FEN.split(" ")[0]) {
    headers.push(`[FEN "${startFen}"]`, `[SetUp "1"]`);
  }
  return `${headers.join("\n")}\n\n${trail || "*"} *`;
}
