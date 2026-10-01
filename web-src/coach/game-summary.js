// Whole-game summary for the Analyze coach panel — what to say once a full analysis has
// finished and the board sits on the start position (no move "just played" to review).
// Pure: the saved analysis payload in, one short paragraph out. Reads only the server's
// per-move classifications, so it always agrees with the move list and the eval graph.

const ERROR_ORDER = ["blunder", "mistake", "inaccuracy"];
const PLURAL = { blunder: "blunders", mistake: "mistakes", inaccuracy: "inaccuracies" };

function plural(n, key) {
  return `${n} ${n === 1 ? key : PLURAL[key]}`;
}

function moveRef(move) {
  const num = move.move_number || Math.ceil((Number(move.ply) || 1) / 2);
  return `${num}${move.side === "black" ? "..." : "."} ${move.san}`;
}

function tallySide(moves, side) {
  const counts = { blunder: 0, mistake: 0, inaccuracy: 0, brilliant: 0 };
  for (const m of moves) {
    if ((m.side === "black" ? "black" : "white") !== side) continue;
    const cls = String(m.classification || "").toLowerCase();
    if (cls in counts) counts[cls] += 1;
  }
  return counts;
}

function sideLine(label, counts) {
  const errs = ERROR_ORDER.filter((k) => counts[k] > 0).map((k) => plural(counts[k], k));
  const brill = counts.brilliant ? `${counts.brilliant} brilliant move${counts.brilliant === 1 ? "" : "s"}` : "";
  if (!errs.length) return `${label} played cleanly${brill ? `, with ${brill}` : ""}.`;
  const list = errs.length > 1 ? `${errs.slice(0, -1).join(", ")} and ${errs[errs.length - 1]}` : errs[0];
  return `${label}: ${list}${brill ? `, plus ${brill}` : ""}.`;
}

// True once a payload carries real engine classifications (a typed/pasted PGN has none).
export function hasClassifiedMoves(analysis) {
  const moves = (analysis && analysis.moves) || [];
  return moves.some((m) => m && m.classification);
}

// buildGameSummary({ moves, selfSide }) -> string ("" when there is nothing classified).
//   selfSide — "white" | "black" when the user played one side ("You (Black): ..."), else null.
export function buildGameSummary({ moves = [], selfSide = null } = {}) {
  if (!moves.length || !moves.some((m) => m && m.classification)) return "";
  const sides = selfSide ? [selfSide, selfSide === "white" ? "black" : "white"] : ["white", "black"];
  const label = (side) => {
    const name = side === "white" ? "White" : "Black";
    if (!selfSide) return name;
    return side === selfSide ? `You (${name})` : `Your opponent (${name})`;
  };
  const lines = sides.map((side) => sideLine(label(side), tallySide(moves, side)));

  // The turning point to look at first: the reviewed side's first blunder (else mistake).
  const reviewed = selfSide ? moves.filter((m) => (m.side === "black" ? "black" : "white") === selfSide) : moves;
  let key = null;
  for (const cls of ["blunder", "mistake"]) {
    key = reviewed.find((m) => String(m.classification || "").toLowerCase() === cls);
    if (key) break;
  }
  const pointer = key
    ? ` Start with ${moveRef(key)}, ${selfSide ? "your" : "the"} first ${String(key.classification).toLowerCase()}: click its dot on the graph.`
    : " Step through the moves to see the coach's read of each one.";
  return `Analysis done. ${lines.join(" ")}${pointer}`;
}
