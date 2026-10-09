// Whole-game summary for the Analyze coach panel — what to say once a full analysis has
// finished and the board sits on the start position (no move "just played" to review).
// Pure: the saved analysis payload in, two short lines out. Reads only the server's
// per-move classifications, so it always agrees with the move list and the eval graph.

const ERROR_ORDER = ["blunder", "mistake", "inaccuracy"];
const PLURAL = { blunder: "blunders", mistake: "mistakes", inaccuracy: "inaccuracies" };

function plural(n, key) {
  return `${n} ${n === 1 ? key : PLURAL[key]}`;
}

function moveRef(move) {
  const num = move.move_number || Math.ceil((Number(move.ply) || 1) / 2);
  return `${num}${move.side === "black" ? "..." : "."}${move.san}`;
}

function sideOf(m) {
  return m.side === "black" ? "black" : "white";
}

function tallySide(moves, side) {
  const counts = { blunder: 0, mistake: 0, inaccuracy: 0, brilliant: 0, great: 0 };
  for (const m of moves) {
    if (sideOf(m) !== side) continue;
    const cls = String(m.classification || "").toLowerCase();
    if (cls in counts) counts[cls] += 1;
  }
  return counts;
}

function sideLine(label, counts) {
  const errs = ERROR_ORDER.filter((k) => counts[k] > 0).map((k) => plural(counts[k], k));
  const brill = counts.brilliant ? `${counts.brilliant} brilliant` : "";
  const parts = errs.length ? errs : ["no errors"];
  if (brill) parts.push(brill);
  if (counts.great) parts.push(`${counts.great} great`);
  return `${label}: ${parts.join(", ")}.`;
}

// True once a payload carries real engine classifications (a typed/pasted PGN has none).
export function hasClassifiedMoves(analysis) {
  const moves = (analysis && analysis.moves) || [];
  return moves.some((m) => m && m.classification);
}

// buildGameSummary({ moves, selfSide }) -> { text, turningPoint } (null when nothing is
// classified). turningPoint is { ply, label } for the move to jump to, or null.
//   selfSide — "white" | "black" when the user played one side, else null.
export function buildGameSummary({ moves = [], selfSide = null } = {}) {
  if (!moves.length || !moves.some((m) => m && m.classification)) return null;
  const sides = selfSide ? [selfSide, selfSide === "white" ? "black" : "white"] : ["white", "black"];
  const label = (side) => {
    if (selfSide) return side === selfSide ? "You" : "Opponent";
    return side === "white" ? "White" : "Black";
  };
  const lines = sides.map((side) => sideLine(label(side), tallySide(moves, side)));

  // The first move worth looking at: the reviewed side's first blunder, else mistake.
  const reviewed = selfSide ? moves.filter((m) => sideOf(m) === selfSide) : moves;
  let key = null;
  for (const cls of ["blunder", "mistake"]) {
    key = reviewed.find((m) => String(m.classification || "").toLowerCase() === cls);
    if (key) break;
  }
  return {
    text: lines.join(" "),
    turningPoint: key ? { ply: Number(key.ply), label: moveRef(key) } : null,
  };
}
