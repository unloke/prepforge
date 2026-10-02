// Tactic names for the coach's commentary (lazy coach chunk only): the fork, pin or
// skewer a move executes, and the piece an error leaves hanging.
import { Chess } from "chess.js";
import { PIECE_NAME } from "./material.js";
import { detectTactics } from "./tactics.js";
import { threatOf, playUci } from "./move-facts.js";

function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

// The tactic a move executes, as a verb phrase: a fork that wins material against every
// defence, or a pin / skewer set up by the moved piece ("pins the knight to the king",
// "skewers the queen and the rook behind it"). "" for none. Pins and skewers are geometry
// only, so callers name them only when the engine line confirms the move wins material.
export function motifPhrase(fenBefore, uci, san) {
  const chess = safeChess(fenBefore);
  if (!chess || (!uci && !san)) return "";
  const color = chess.turn();
  let mv = null;
  try {
    mv = san ? chess.move(san) : null;
  } catch (_) {
    mv = null;
  }
  if (!mv && uci) mv = playUci(chess, uci);
  if (!mv || chess.isCheckmate()) return "";
  const threat = threatOf(chess, mv, color);
  if (/^forks /.test(threat)) return threat;
  const t = detectTactics(chess.fen(), color);
  const skewer = t.skewers.find((x) => x.from === mv.to);
  if (skewer) return `skewers the ${PIECE_NAME[skewer.front.type]} and the ${PIECE_NAME[skewer.back.type]} behind it`;
  const pins = t.pins.filter((x) => x.from === mv.to);
  const pin = pins.find((x) => x.absolute) || pins[0];
  return pin ? `pins the ${PIECE_NAME[pin.front.type]} to the ${PIECE_NAME[pin.back.type]}` : "";
}

// "forks ..." -> "forking ...", for "Nd5 was the move, forking ...".
export function participle(phrase) {
  return String(phrase || "").replace(/^(fork|pin|skewer)s/, (_, v) => `${v}${v === "pin" ? "n" : ""}ing`);
}

// The piece `replyUci` captures on a square the mover left with no defender, as
// { type, square }, or null: the "hanging piece" an error gives away.
export function hangingCapture(fenAfter, replyUci) {
  const chess = safeChess(fenAfter);
  if (!chess || !replyUci) return null;
  const sq = replyUci.slice(2, 4);
  const victim = chess.get(sq);
  if (!victim || victim.color === chess.turn() || victim.type === "p" || victim.type === "k") return null;
  let defenders = [];
  try {
    defenders = chess.attackers(sq, victim.color);
  } catch (_) {
    return null;
  }
  return defenders.length ? null : { type: victim.type, square: sq };
}
