// Short, proven reasons for moves the coach otherwise can only grade.
//
// Each detector states one board fact and only when a concrete check proves it: a legal
// capture, a static exchange on one square, and the engine line keeping the pieces where
// the claim puts them. When no check passes the detector returns null and the coach keeps
// its plain verdict. Research and audit: research/coach-precision/REPORT.md, REPORT-r2.md.
//
// A reason is { kind, type, square, reply? } and is worded by the caller, which knows
// whose pieces they are:
//   defend  - the move adds a defender to a piece that was en prise ("defends the pawn on b7")
//   escape  - the move takes an attacked, undefended piece to a square nothing attacks
//   block   - the move stops an enemy passed pawn on the square in front of it
//   attack  - a move newly attacks a piece it can win, or a pawn that drives a piece back
//             (best-move and reply reasons)
//   stops   - the better move makes the opponent's reply illegal ("stops 28.f5")
import { Chess } from "chess.js";
import { playUci, winnableTargets } from "./move-facts.js";
import { seeCapture, PIECE_NAME, PIECE_VALUE } from "./material.js";

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
  const caps = work.moves({ verbose: true }).filter((m) => m.to === sq && m.captured);
  if (!caps.length) return false;
  caps.sort((a, c) => PIECE_VALUE[a.piece] - PIECE_VALUE[c.piece]);
  work.move(caps[0]);
  return work.moves({ verbose: true }).some((m) => m.from === from && m.to === sq && m.captured);
}

// `color` could legally capture on `sq` with the piece on `from` if it were its turn.
function legalHit(b, from, sq, color) {
  const parts = b.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  const work = board(parts.join(" "));
  return !!work && work.moves({ verbose: true }).some((m) => m.from === from && m.to === sq && m.captured);
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

// An error: the reply it allows newly attacks a piece the reply can win, and the same reply
// after the better move does not (illegal there, or the target is safe).
export function replyReason(f) {
  if (!f || !isError(f) || f.isBest || !f.replyUci || !f.bestUci || f.bestUci === f.uci) return null;
  const played = after(f.fenBefore, f.uci);
  const best = after(f.fenBefore, f.bestUci);
  if (!played || !best) return null;
  const reply = after(played.board.fen(), f.replyUci);
  if (!reply || reply.board.isCheck()) return null;
  const alt = after(best.board.fen(), f.replyUci);
  for (const t of winnableTargets(reply.board.fen(), reply.move.to, reply.move.color)) {
    if (!legalHit(reply.board, reply.move.to, t.square, reply.move.color)) continue;
    const victim = played.board.get(t.square);
    if (!victim || victim.color !== played.move.color) continue;
    if (played.board.attackers(t.square, reply.move.color).includes(reply.move.from)) continue; // already attacked
    const there = best.board.get(t.square);
    if (!there || there.type !== t.type || there.color !== victim.color) continue;
    if (alt && winnableTargets(alt.board.fen(), alt.move.to, alt.move.color).some((x) => x.square === t.square)) continue;
    return { kind: "attack", type: t.type, square: t.square, reply: f.replySan };
  }
  return pawnChase(f, played, best, reply);
}

// The reply is a pawn that attacks a piece, and the piece retreats next in the engine
// line. The piece may be defended (no material at stake): the pawn still drives it back.
// The same pawn move after the better move must not hit the same piece.
function pawnChase(f, played, best, reply) {
  const c = played.move.color;
  if (reply.move.piece !== "p" || (seeCapture(reply.board, reply.move.to, c) || 0) > 0) return null;
  const back = after(reply.board.fen(), (f.playedPvUci || [])[2]);
  if (!back || back.move.piece === "p" || back.move.piece === "k" || back.move.captured) return null;
  const sq = back.move.from;
  const piece = played.board.get(sq);
  if (!piece || piece.color !== c || !legalHit(reply.board, reply.move.to, sq, reply.move.color)) return null;
  if (played.board.attackers(sq, reply.move.color).includes(reply.move.from)) return null; // already attacked
  if (reply.board.attackers(back.move.to, reply.move.color).includes(reply.move.to)) return null; // not clear of it
  // Where the same piece stands after the better move.
  const origin = sq === played.move.to ? played.move.from : sq;
  const there = best.move.from === origin ? best.move.to : origin;
  const same = best.board.get(there);
  if (!same || same.type !== piece.type || same.color !== c) return null;
  const alt = after(best.board.fen(), f.replyUci);
  if (alt && legalHit(alt.board, alt.move.to, there, alt.move.color)) return null;
  return { kind: "attack", type: piece.type, square: sq, reply: f.replySan };
}

// The attack is what the line is about: the opponent's reply moves the attacked piece, or
// the attacker's side takes it within its next two moves of `pv` (which starts with the move).
function attackAnswered(fen, pv, square) {
  const b = board(fen);
  if (!b || !pv || pv.length < 2) return false;
  for (let i = 0; i < Math.min(pv.length, 5); i++) {
    const mv = playUci(b, pv[i]);
    if (!mv) return false;
    if (i === 1 && mv.from === square) return true;
    if (i % 2 === 0 && i > 0 && mv.to === square && mv.captured) return true;
  }
  return false;
}

// An error: what the better move would have done (attack, defend or escape), when the
// played move doesn't do the same and the engine lines show it matters: the better line
// makes the opponent answer the attack, or the played line takes the piece left en prise.
// A true fact that the lines ignore ("Rd7 attacks a7" when Rd7 is about dodging a fork)
// is not a reason.
export function betterReason(f) {
  if (!f || !isError(f) || f.isBest || !f.bestUci || f.bestUci === f.uci) return null;
  const best = after(f.fenBefore, f.bestUci);
  if (!best) return null;
  if (!best.board.isCheck()) {
    const color = best.move.color;
    const t = winnableTargets(best.board.fen(), best.move.to, color).find((x) => legalHit(best.board, best.move.to, x.square, color));
    if (t) {
      const before = board(f.fenBefore);
      const already = before.attackers(t.square, color).includes(best.move.from);
      const played = after(f.fenBefore, f.uci);
      const same = played && winnableTargets(played.board.fen(), played.move.to, played.move.color).some((x) => x.square === t.square);
      if (!already && played && !same && attackAnswered(f.fenBefore, f.bestPvUci, t.square)) {
        return { kind: "attack", type: t.type, square: t.square };
      }
    }
  }
  const guard = guardReason(f.fenBefore, f.bestUci, f.bestPvUci || []);
  if (!guard) return stopsReason(f, best);
  const own = guardReason(f.fenBefore, f.uci, f.playedPvUci || []);
  if (own && own.kind === guard.kind && own.type === guard.type) return null;
  // The played line's reply takes the piece the better move would have looked after.
  const target = guard.kind === "escape" ? guard.from : guard.square;
  const played = after(f.fenBefore, f.uci);
  const reply = played && f.replyUci ? after(played.board.fen(), f.replyUci) : null;
  if (!reply || reply.move.to !== target || !reply.move.captured) return stopsReason(f, best);
  return guard;
}

// The better move makes the engine's reply to the error illegal: a quiet reply to a square
// that was empty, by the same piece, and not merely postponed by a check.
function stopsReason(f, best) {
  if (!f.replyUci || best.board.isCheck()) return null;
  const played = after(f.fenBefore, f.uci);
  const reply = played && after(played.board.fen(), f.replyUci);
  if (!reply || reply.move.captured || reply.move.promotion) return null;
  const before = board(f.fenBefore);
  if (before.get(reply.move.to)) return null;
  const p = before.get(reply.move.from);
  const q = best.board.get(reply.move.from);
  if (!p || !q || p.type !== q.type || p.color !== q.color || p.color === played.move.color) return null;
  if (after(best.board.fen(), f.replyUci)) return null;
  const [, turn, , , , n] = played.board.fen().split(" ");
  return { kind: "stops", reply: `${n}${turn === "w" ? "." : "..."}${reply.move.san}` };
}

// The reason as a verb phrase. `owner` words the pieces: "the" on the user's own read,
// "your"/"their" on the opponent's read (the mover's pieces are "their", the user's "your").
//   escape -> "moves the bishop out of attack"
//   defend -> "defends the pawn on b7"
//   block  -> "blocks the passed pawn on e5"
//   attack -> "attacks the knight on g5"
export function reasonPhrase(r, { mine = "the", theirs = "the" } = {}) {
  if (!r) return "";
  const name = PIECE_NAME[r.type];
  if (r.kind === "escape") return `moves the ${name} out of attack`;
  if (r.kind === "defend") return `defends ${mine} ${name} on ${r.square}`;
  if (r.kind === "block") return `blocks ${theirs} passed pawn on ${r.square}`;
  if (r.kind === "attack") return `attacks ${theirs} ${name} on ${r.square}`;
  if (r.kind === "stops") return `stops ${r.reply}`;
  return "";
}

// "attacks ..." -> "attacking ...", for "Bh5 was the move, attacking ...".
export function reasonParticiple(phrase) {
  return String(phrase || "").replace(/^(moves|defends|blocks|attacks|stops) /, (_, v) => `${{ moves: "moving", stops: "stopping" }[v] || `${v.slice(0, -1)}ing`} `);
}
