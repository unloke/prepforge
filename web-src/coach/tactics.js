// Tactic detection for the coach — pure chess.js, no engine, no DOM.
//
// The motif layer the commentary leans on to say *why* a move is strong (or what the
// opponent now threatens): the move "forks the rook and queen", "pins the knight to the
// king", "skewers the queen, winning the rook behind it". Everything here reads a single
// position and reports the concrete geometry a club player would point at — it does not
// search, so it is fast and testable headlessly.
//
//   detectTactics(fen, moverColor) -> { forks[], pins[], skewers[] }
//   describeThreat(fen, uci, moverColor) -> motif created by the moved piece, or null
//   describeAnyThreat(fen, moverColor)   -> the richest motif on the board, or null
//
// A "motif" the commentary consumes is normalised to plain labels:
//   { kind: "fork",   targets: "the rook and the queen" | "both knights" }
//   { kind: "pin",    front: "knight", back: "queen" | "king", absolute: bool }
//   { kind: "skewer", front: "queen",  back: "rook" }
import { Chess } from "chess.js";
import { PIECE_VALUE, PIECE_NAME } from "./material.js";

const PLURAL = { p: "pawns", n: "knights", b: "bishops", r: "rooks", q: "queens", k: "kings" };

// Slider rays, by piece type (queen = bishop + rook).
const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

function fileRank(sq) {
  return [sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 49]; // a1 -> [0,0]
}
function square(file, rank) {
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}

function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

// First piece met walking from `fromSq` along (df,dr), skipping empty squares.
function firstPieceAlong(chess, fromSq, df, dr) {
  let [f, r] = fileRank(fromSq);
  for (;;) {
    f += df;
    r += dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    const s = square(f, r);
    const piece = chess.get(s);
    if (piece) return { square: s, piece };
  }
}

// Every enemy piece `moverColor` attacks more than once with a single piece, where each
// target is actually winnable (the king, undefended, or worth more than the attacker).
// A piece that hits two such targets at once is a fork / double attack.
function detectForks(chess, moverColor) {
  const enemy = moverColor === "w" ? "b" : "w";
  const byAttacker = new Map(); // attackerSquare -> Map(victimSquare -> {square,type,worth})

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== enemy) continue;
      const attackers = chess.attackers(piece.square, moverColor);
      if (!attackers.length) continue;
      const worth = PIECE_VALUE[piece.type] || 0;
      const defended = piece.type === "k" ? false : chess.attackers(piece.square, enemy).length > 0;
      for (const aSq of attackers) {
        const aPiece = chess.get(aSq);
        if (!aPiece || aPiece.type === "k") continue; // a king "forking" isn't a real threat
        const aVal = PIECE_VALUE[aPiece.type] || 0;
        const winnable = piece.type === "k" || worth > aVal || (!defended && worth >= aVal);
        if (!winnable) continue;
        if (!byAttacker.has(aSq)) byAttacker.set(aSq, new Map());
        byAttacker.get(aSq).set(piece.square, { square: piece.square, type: piece.type, worth });
      }
    }
  }

  const prio = (t) => (t.type === "k" ? 100 : t.worth);
  const forks = [];
  for (const [aSq, victims] of byAttacker) {
    if (victims.size < 2) continue;
    const targets = [...victims.values()].sort((a, b) => prio(b) - prio(a));
    forks.push({ from: aSq, attackerType: chess.get(aSq).type, targets });
  }
  return forks;
}

// Pins and skewers — a mover slider with two enemy pieces lined up behind one another on
// the same ray. Front cheaper than back (or back = king) is a pin; front dearer than a
// still-valuable back is a skewer (the "x-ray win" the user described).
function detectPinsSkewers(chess, moverColor) {
  const pins = [];
  const skewers = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== moverColor || !DIRS[piece.type]) continue;
      for (const [df, dr] of DIRS[piece.type]) {
        const front = firstPieceAlong(chess, piece.square, df, dr);
        if (!front || front.piece.color === moverColor) continue;
        // A pinned PAWN is almost never the point of a move — "the pawn is dead pinned to
        // the king/knight" read as a fake brag on moves whose real idea lay elsewhere, and
        // often the pin pre-existed the move. Only pin a real piece down.
        if (front.piece.type === "p") continue;
        const back = firstPieceAlong(chess, front.square, df, dr);
        if (!back || back.piece.color === moverColor) continue;
        // Not a real pin/skewer if the front piece can simply capture the (undefended)
        // attacker: a rook landing in front of a queen ("Rxc8") with nothing guarding the
        // rook isn't skewering anything — the queen just takes it. Only when the attacking
        // slider is itself defended is the front piece genuinely stuck on the line.
        const enemy = front.piece.color;
        if (chess.attackers(piece.square, enemy).length && !chess.attackers(piece.square, moverColor).length) {
          continue;
        }
        const v1 = PIECE_VALUE[front.piece.type] || 0;
        const v2 = PIECE_VALUE[back.piece.type] || 0;
        const common = {
          from: piece.square,
          attackerType: piece.type,
          front: { square: front.square, type: front.piece.type },
          back: { square: back.square, type: back.piece.type },
        };
        if (back.piece.type === "k" || v2 > v1) {
          pins.push({ ...common, absolute: back.piece.type === "k" });
        } else if (v1 > v2 && v2 >= 3) {
          skewers.push(common);
        }
      }
    }
  }
  return { pins, skewers };
}

export function detectTactics(fen, moverColor) {
  const chess = safeChess(fen);
  if (!chess) return { forks: [], pins: [], skewers: [] };
  const { pins, skewers } = detectPinsSkewers(chess, moverColor);
  return { forks: detectForks(chess, moverColor), pins, skewers };
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

// "the rook and the queen" / "both knights" — the two richest fork targets, named.
function forkLabel(targets) {
  const a = targets[0].type;
  const b = targets[1].type;
  if (a === b) return `both ${PLURAL[a]}`;
  return `the ${PIECE_NAME[a]} and the ${PIECE_NAME[b]}`;
}

function normaliseFork(fork) {
  return { kind: "fork", targets: forkLabel(fork.targets) };
}
function normalisePin(pin) {
  return { kind: "pin", front: PIECE_NAME[pin.front.type], back: PIECE_NAME[pin.back.type], absolute: !!pin.absolute };
}
function normaliseSkewer(sk) {
  return { kind: "skewer", front: PIECE_NAME[sk.front.type], back: PIECE_NAME[sk.back.type] };
}

// The motif the just-moved piece creates (its destination is the attacking square).
// Fork beats skewer beats pin when more than one is present — pick the most forcing.
export function describeThreat(fen, uci, moverColor) {
  const to = uci ? uci.slice(2, 4) : null;
  if (!to) return null;
  const t = detectTactics(fen, moverColor);
  const fork = t.forks.find((x) => x.from === to);
  // Only call it a fork if it actually wins material against the best defence — a double
  // attack the opponent can parry with one move (saving both) isn't a fork worth bragging on.
  if (fork && forkWinsMaterial(fen, to, moverColor)) return normaliseFork(fork);
  const skewer = t.skewers.find((x) => x.from === to);
  if (skewer) return normaliseSkewer(skewer);
  const pin = t.pins.find((x) => x.from === to);
  if (pin) return normalisePin(pin);
  return null;
}

// The richest motif anywhere for `moverColor` — used to spell out what a side now
// threatens regardless of which piece set it up ("Now Black forks the rook and king").
export function describeAnyThreat(fen, moverColor) {
  const t = detectTactics(fen, moverColor);
  if (t.forks.length) {
    const best = t.forks.slice().sort((a, b) => b.targets[0].worth - a.targets[0].worth)[0];
    return normaliseFork(best);
  }
  if (t.skewers.length) return normaliseSkewer(t.skewers[0]);
  if (t.pins.length) {
    const abs = t.pins.find((p) => p.absolute);
    return normalisePin(abs || t.pins[0]);
  }
  return null;
}
