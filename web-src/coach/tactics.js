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
        const back = firstPieceAlong(chess, front.square, df, dr);
        if (!back || back.piece.color === moverColor) continue;
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
  if (fork) return normaliseFork(fork);
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
