// Does a fork actually win material? A one-ply defensive check, split out of
// tactics.js so the eager move descriptions (explain.js -> move-facts.js) can use it
// without bundling the pin/skewer detector.
import { Chess } from "chess.js";
import { PIECE_VALUE } from "./material.js";

function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

// The material the forking piece on `attackerSq` can still win against the BEST defence the
// opponent (to move in `fen`) has. A genuine fork wins because the opponent can't save both
// targets with one move; a phantom fork (e.g. a knight "forking" the queen and a bishop that
// the queen's escape square also defends) collapses to ~nothing once the opponent replies.
// Returns the worst-case (over all opponent replies) best capture the forker nets, in pawns.
//
// This is a one-ply defensive search — pure chess.js, cheap (~legal-move count) — and it is
// what lets the coach stop announcing "Ne5 forks the queen and the bishop, one of them drops"
// on a position where 1...Qe2 calmly covers both.
function forkerGainNow(chess, attackerSq, moverColor) {
  const attacker = chess.get(attackerSq);
  if (!attacker) return 0;
  const enemy = moverColor === "w" ? "b" : "w";
  let best = 0;
  for (const row of chess.board()) {
    for (const victim of row) {
      if (!victim || victim.color !== enemy || victim.type === "k") continue;
      if (!chess.attackers(victim.square, moverColor).includes(attackerSq)) continue;
      // SEE off the cheapest attacker is a fair proxy for "is grabbing this profitable".
      const see = squareGainFor(chess, victim.square, moverColor, attacker);
      if (see > best) best = see;
    }
  }
  return best;
}

// Profit (pawns) of winning the piece on `sq`: undefended → its full worth; otherwise its
// worth minus the forker's (only positive when the forker is the cheaper piece). A coarse but
// safe read — it never over-credits a defended target.
function squareGainFor(chess, sq, moverColor, attacker) {
  const victim = chess.get(sq);
  if (!victim) return 0;
  const v = PIECE_VALUE[victim.type] || 0;
  const enemy = moverColor === "w" ? "b" : "w";
  const defenders = chess.attackers(sq, enemy);
  if (!defenders.length) return v;
  const aVal = PIECE_VALUE[attacker.type] || 0;
  return v > aVal ? v - aVal : 0;
}

export function forkWinsMaterial(fen, attackerSq, moverColor) {
  const chess = safeChess(fen);
  if (!chess) return true; // can't verify → don't suppress
  const enemy = moverColor === "w" ? "b" : "w";
  if (chess.turn() !== enemy) return true; // not the opponent's move as expected → don't suppress
  let moves;
  try {
    moves = chess.moves({ verbose: true });
  } catch (_) {
    return true;
  }
  if (!moves.length) return true; // opponent is mated/stalemated → the "fork" did its job
  let worst = Infinity;
  for (const m of moves) {
    chess.move(m);
    const still = chess.get(attackerSq);
    const gain = still && still.color === moverColor ? forkerGainNow(chess, attackerSq, moverColor) : 0;
    chess.undo();
    if (gain < worst) worst = gain;
    if (worst < 2) return false; // the opponent has a reply that saves all but <a minor → no real fork
  }
  return worst >= 2;
}
