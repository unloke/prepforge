// Short, proven reasons for moves the coach otherwise can only grade.
//
// Each detector states one board fact and only when a concrete check proves it: a legal
// capture, a static exchange on one square, and the engine line keeping the pieces where
// the claim puts them. When no check passes the detector returns null and the coach keeps
// its plain verdict. Research and audit: research/coach-precision/REPORT.md, REPORT-r2.md.
//
// A reason is { kind, type, square, from? } and is worded by the caller, which knows
// whose pieces they are:
//   defend  - the move adds a defender to a piece that was en prise ("defends the pawn on b7")
//   escape  - the move takes an attacked, undefended piece to a square nothing attacks
//   block   - the move stops an enemy passed pawn on the square in front of it
import { Chess } from "chess.js";
import { playUci } from "./move-facts.js";
import { capturesOn, seeCapture, PIECE_NAME } from "./material.js";

const ERRORS = new Set(["inaccuracy", "mistake", "blunder"]);
const isError = (f) => ERRORS.has(f.classification?.code);
const other = (c) => (c === "w" ? "b" : "w");

function board(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

function after(fen, uci) {
  const b = board(fen);
  const move = b && uci ? playUci(b, uci) : null;
  return move ? { board: b, move } : null;
}

function pieces(b) {
  return b.board().flat().filter(Boolean);
}

// The piece stays on `sq` through the first `plies` moves of `pv` (which must be that long).
function stays(fen, pv, sq, piece, plies) {
  if (!pv || pv.length < plies) return false;
  const b = board(fen);
  if (!b) return false;
  for (const u of pv.slice(0, plies)) {
    if (!playUci(b, u)) return false;
    const p = b.get(sq);
    if (!p || p.color !== piece.color || p.type !== piece.type) return false;
  }
  return true;
}

// After the opponent's cheapest legal capture on `sq`, the piece on `from` can legally take
// back. attackers() alone counts pinned pieces.
function legalGuard(b, sq, from) {
  const work = board(b.fen());
  const caps = capturesOn(work, sq);
  if (!caps.length) return false;
  work.move(caps[0]);
  return work.moves({ square: from, verbose: true }).some((m) => m.to === sq && m.captured);
}

// What the move `uci` does for its own pieces: escape, defend or block. `pv` starts with `uci`.
function guardReason(fen, uci, pv) {
  const before = board(fen);
  const a = after(fen, uci);
  if (!before || !a || before.isCheck() || a.board.isCheck() || a.move.captured) return null;
  const c = before.turn();
  const enemy = other(c);
  const mv = a.move;
  // Escape: an attacked, undefended piece that the opponent wins by taking goes to a square
  // nothing attacks. seeCapture plays legal moves, so a positive value is a legal capture.
  if (
    mv.piece !== "p" &&
    mv.piece !== "k" &&
    before.attackers(mv.from, c).length === 0 &&
    (seeCapture(before, mv.from, enemy) || 0) > 0 &&
    a.board.attackers(mv.to, enemy).length === 0
  ) {
    return { kind: "escape", type: mv.piece, square: mv.to, from: mv.from };
  }
  // Defend: a piece the opponent wins by taking now costs them material, the moved piece
  // can legally take back, and both pieces are still there in the engine line.
  for (const p of pieces(before)) {
    if (p.color !== c || p.type === "k" || p.square === mv.from) continue;
    if (!((seeCapture(before, p.square, enemy) || 0) > 0)) continue;
    if (!a.board.attackers(p.square, c).includes(mv.to) || !legalGuard(a.board, p.square, mv.to)) continue;
    const now = seeCapture(a.board, p.square, enemy);
    if (now === null || now > 0) continue;
    if (!stays(fen, pv, p.square, p, 4) || !stays(fen, pv, mv.to, { color: mv.color, type: mv.piece }, 2)) continue;
    return { kind: "defend", type: p.type, square: p.square };
  }
  return null;
}

// Block: the move occupies the square in front of an enemy passed pawn and stays there.
function blockReason(fen, uci, pv) {
  const before = board(fen);
  const a = after(fen, uci);
  if (!before || !a || a.move.captured || a.board.isCheck()) return null;
  const mv = a.move;
  const enemy = other(mv.color);
  if ((seeCapture(a.board, mv.to, enemy) || 0) > 0) return null;
  for (const p of pieces(before)) {
    if (p.type !== "p" || p.color !== enemy) continue;
    const rank = Number(p.square[1]);
    const front = p.square[0] + (rank + (enemy === "w" ? 1 : -1));
    if (front !== mv.to || before.get(front)) continue;
    const file = p.square.charCodeAt(0);
    const stopped = pieces(before).some(
      (q) =>
        q.type === "p" &&
        q.color === mv.color &&
        Math.abs(q.square.charCodeAt(0) - file) <= 1 &&
        (enemy === "w" ? Number(q.square[1]) > rank : Number(q.square[1]) < rank),
    );
    if (stopped) continue;
    if (!stays(fen, pv, p.square, p, 4) || !stays(fen, pv, mv.to, { type: mv.piece, color: mv.color }, 4)) continue;
    return { kind: "block", type: "p", square: p.square };
  }
  return null;
}

// A sound move with nothing else to say: what it does for its pieces, or null.
export function soundReason(f) {
  if (!f || isError(f) || !f.fenBefore || !f.uci) return null;
  const pv = f.playedPvUci || [];
  return guardReason(f.fenBefore, f.uci, pv) || blockReason(f.fenBefore, f.uci, pv);
}

// The reason as a verb phrase. `owner` words the pieces: "the" on the user's own read,
// "your"/"their" on the opponent's read (the mover's pieces are "their", the user's "your").
//   escape -> "moves the bishop out of attack"
//   defend -> "defends the pawn on b7"
//   block  -> "blocks the passed pawn on e5"
export function reasonPhrase(r, { mine = "the", theirs = "the" } = {}) {
  if (!r) return "";
  const name = PIECE_NAME[r.type];
  if (r.kind === "escape") return `moves the ${name} out of attack`;
  if (r.kind === "defend") return `defends ${mine} ${name} on ${r.square}`;
  if (r.kind === "block") return `blocks ${theirs} passed pawn on ${r.square}`;
  return "";
}
