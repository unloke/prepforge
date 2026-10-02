// Grounded move facts for the coach. Pure chess.js, no engine calls, no DOM.
//
// Every fact here is something the board or the engine's own line actually shows:
//   - material: read only off the engine's principal variation, counted at a quiet
//     point (no capture pending, no check), never "settled" by a static exchange guess;
//   - threats: only pieces the moved piece can really win right now;
//   - descriptions: castles, develops, central pawn contact, passed pawns, rooks to a
//     fully open file. No pins, space or "opens the diagonal" guesses: those were the
//     reads that kept being wrong.
import { Chess } from "chess.js";
import { PIECE_VALUE, PIECE_NAME, seeCapture } from "./material.js";
import { forkWinsMaterial } from "./tactics.js";

const TYPES = ["q", "r", "b", "n", "p"];
const PLURAL = { p: "pawns", n: "knights", b: "bishops", r: "rooks", q: "queens" };
const COUNT_WORD = ["", "a", "two", "three", "four", "five", "six", "seven", "eight"];
const CENTER = new Set(["d4", "e4", "d5", "e5"]);

function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}

function playUci(chess, uci) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
  } catch (_) {
    return null;
  }
}

function emptyCount() {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

// ---------------------------------------------------------------------------
// Material along an engine line.
// ---------------------------------------------------------------------------

// Walk `ucis` from `fen` and report the material picture at the LAST quiet point within
// `maxPlies`: a position where the side to move is not in check and the next move of the
// line is not a capture. Captures are tallied per side and per piece type (promotions
// count as the promoting side gaining queen-minus-pawn).
//
// With `first`, stop at the FIRST quiet point instead (the move's own exchange only).
// Returns { plies, sans, numberedLine, took: { w, b }, quiet } where `plies` is how many
// moves of the line it takes to reach that quiet point and `quiet` is false when the line
// ran out mid-exchange (callers then make no material claim).
export function lineOutcome(fen, ucis, { maxPlies = 8, first = false } = {}) {
  const chess = safeChess(fen);
  if (!chess || !Array.isArray(ucis) || !ucis.length) return null;
  const took = { w: emptyCount(), b: emptyCount() };
  const sans = [];
  const snaps = []; // tallies after each ply
  const moves = [];
  for (const uci of ucis.slice(0, maxPlies + 2)) {
    const mv = playUci(chess, uci);
    if (!mv) break;
    moves.push(mv);
    sans.push(mv.san);
    if (mv.captured) took[mv.color][mv.captured] += 1;
    if (mv.promotion) {
      took[mv.color][mv.promotion] += 1;
      took[mv.color].p -= 1; // the pawn turns into the new piece
    }
    snaps.push({ took: { w: { ...took.w }, b: { ...took.b } }, check: chess.isCheck() });
  }
  if (!moves.length) return null;
  let stop = -1;
  for (let i = 0; i < Math.min(moves.length, maxPlies); i++) {
    const next = moves[i + 1];
    const pending = snaps[i].check || (next && next.captured);
    if (!pending && (next || !moves[i].captured)) {
      stop = i;
      if (first) break;
    }
  }
  const quiet = stop >= 0;
  const at = quiet ? stop : Math.min(moves.length, maxPlies) - 1;
  return {
    plies: at + 1,
    sans: sans.slice(0, at + 1),
    moves: moves.slice(0, at + 1).map((mv) => ({ san: mv.san, color: mv.color, captured: mv.captured || null })),
    numberedLine: numberLine(fen, sans.slice(0, at + 1)),
    took: snaps[at].took,
    quiet,
  };
}

// Net material for `color` over a lineOutcome: what it took minus what it lost, per type.
export function netFor(outcome, color) {
  const opp = color === "w" ? "b" : "w";
  const out = emptyCount();
  if (!outcome) return out;
  for (const t of TYPES) out[t] = (outcome.took[color][t] || 0) - (outcome.took[opp][t] || 0);
  return out;
}

export function netValue(net) {
  let v = 0;
  for (const t of TYPES) v += (net[t] || 0) * PIECE_VALUE[t];
  return v;
}

function hasCaptures(outcome) {
  if (!outcome) return false;
  return TYPES.some((t) => outcome.took.w[t] || outcome.took.b[t]);
}

function listPhrase(counts) {
  const parts = [];
  // A knight and a bishop together read as "two pieces".
  if ((counts.n || 0) > 0 && (counts.b || 0) > 0) {
    const minors = counts.n + counts.b;
    counts = { ...counts, n: 0, b: 0 };
    parts.push(`${COUNT_WORD[minors] || minors} pieces`);
  }
  for (const t of TYPES) {
    const n = counts[t] || 0;
    if (n <= 0) continue;
    parts.push(n === 1 ? `${COUNT_WORD[1]} ${PIECE_NAME[t]}` : `${COUNT_WORD[n] || n} ${PLURAL[t]}`);
  }
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// "a pawn", "a knight", "the exchange", "a bishop for a pawn" from a net count where the
// gaining side's pieces are positive. "" when there is nothing to name.
export function gainPhrase(net) {
  const gained = emptyCount();
  const lost = emptyCount();
  for (const t of TYPES) {
    if (net[t] > 0) gained[t] = net[t];
    if (net[t] < 0) lost[t] = -net[t];
  }
  const g = listPhrase(gained);
  const l = listPhrase(lost);
  if (!g) return "";
  const minorsLost = lost.n + lost.b;
  if (gained.r === 1 && minorsLost === 1 && !gained.q && !gained.n && !gained.b && !lost.q && !lost.r) {
    return gained.p > lost.p ? "the exchange and a pawn" : "the exchange";
  }
  return l ? `${g} for ${l}` : g;
}

// Pieces traded off evenly in the line ("knights", "queens", "a rook for a bishop and a pawn").
// Only meaningful when the net value is zero but captures happened.
export function tradePhrase(outcome, color) {
  const opp = color === "w" ? "b" : "w";
  const mine = outcome.took[opp]; // what `color` lost
  const theirs = outcome.took[color]; // what `color` took
  const same = TYPES.filter((t) => t !== "p").find((t) => mine[t] && mine[t] === theirs[t]);
  const sameOnly = TYPES.every((t) => (mine[t] || 0) === (theirs[t] || 0));
  if (same && sameOnly) return `trades ${PLURAL[same]}`;
  if (sameOnly) return mine.p ? "trades pawns" : "";
  const gave = listPhrase(mine);
  const got = listPhrase(theirs);
  return gave && got ? `gives ${gave} for ${got}` : "";
}

// "16...e5 17.Bc3 exd4" for a SAN list starting at `fen`.
export function numberLine(fen, sans) {
  if (!sans || !sans.length) return "";
  const parts = String(fen || "").split(" ");
  let num = Number(parts[5]) || 1;
  let white = parts[1] !== "b";
  const out = [];
  sans.forEach((san, i) => {
    if (white) out.push(`${num}.${san}`);
    else out.push(i === 0 ? `${num}...${san}` : san);
    if (!white) num += 1;
    white = !white;
  });
  return out.join(" ");
}

// Trim a numbered line to the plies that matter (up to the last capture), max `cap` plies.
export function shortLine(fen, outcome, cap = 4) {
  if (!outcome) return "";
  return numberLine(fen, outcome.sans.slice(0, Math.min(outcome.plies, cap)));
}

// Only opposite-coloured bishops (plus pawns) left: the classic drawing endgame.
export function oppositeBishopsOnly(fen) {
  const chess = safeChess(fen);
  if (!chess) return false;
  const bishops = { w: [], b: [] };
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.type === "k" || p.type === "p") continue;
      if (p.type !== "b") return false;
      const f = p.square.charCodeAt(0) - 97;
      const r = Number(p.square[1]) - 1;
      bishops[p.color].push((f + r) % 2);
    }
  }
  return bishops.w.length === 1 && bishops.b.length === 1 && bishops.w[0] !== bishops.b[0];
}

export function fenAfterLine(fen, ucis, plies) {
  const chess = safeChess(fen);
  if (!chess) return null;
  for (const uci of (ucis || []).slice(0, plies)) {
    if (!playUci(chess, uci)) return null;
  }
  return chess.fen();
}

// ---------------------------------------------------------------------------
// What the move itself does on the board.
// ---------------------------------------------------------------------------

function isPassed(chess, square, color) {
  const f = square.charCodeAt(0) - 97;
  const r = Number(square[1]);
  const dir = color === "w" ? 1 : -1;
  for (let df = -1; df <= 1; df++) {
    const ff = f + df;
    if (ff < 0 || ff > 7) continue;
    for (let rr = r + dir; rr >= 1 && rr <= 8; rr += dir) {
      const p = chess.get(String.fromCharCode(97 + ff) + rr);
      if (p && p.type === "p" && p.color !== color) return false;
    }
  }
  return true;
}

function fileIsOpen(chess, file) {
  for (let r = 1; r <= 8; r++) {
    const p = chess.get(`${file}${r}`);
    if (p && p.type === "p") return false;
  }
  return true;
}

// Enemy pieces the moved piece can actually win right now (static exchange > 0), richest
// first. Nothing when the moved piece is itself just lost, and never the king.
export function winnableTargets(fenAfter, to, moverColor) {
  const chess = safeChess(fenAfter);
  if (!chess || !to) return [];
  const opp = moverColor === "w" ? "b" : "w";
  if ((seeCapture(chess, to, opp) || 0) > 0) return [];
  const out = [];
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== opp || p.type === "k") continue;
      let hits = false;
      try {
        hits = chess.attackers(p.square, moverColor).includes(to);
      } catch (_) {
        hits = false;
      }
      if (!hits) continue;
      if ((seeCapture(chess, p.square, moverColor) || 0) > 0) out.push({ square: p.square, type: p.type });
    }
  }
  return out.sort((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type]);
}

function targetsPhrase(targets) {
  const named = targets.slice(0, 2).map((t) => `the ${PIECE_NAME[t.type]} on ${t.square}`);
  return named.join(" and ");
}

// What the moved piece now threatens, as a verb phrase ("gives check", "forks the rook
// on a8 and the queen on d8", "hits ..."), or "".
export function threatPhrase(fenBefore, uci, san) {
  const chess = safeChess(fenBefore);
  if (!chess) return "";
  const color = chess.turn();
  let mv = null;
  try {
    mv = chess.move(san);
  } catch (_) {
    mv = uci ? playUci(chess, uci) : null;
  }
  if (!mv || chess.isCheckmate()) return "";
  return threatOf(chess, mv, color);
}

function threatOf(chess, mv, color) {
  const targets = winnableTargets(chess.fen(), mv.to, color);
  if (chess.isCheck()) {
    if (!targets.length) return "gives check";
    const one = targetsPhrase(targets.slice(0, 1));
    return forkWinsMaterial(chess.fen(), mv.to, color) ? `forks the king and ${one}` : `gives check and hits ${one}`;
  }
  if (targets.length >= 2 && forkWinsMaterial(chess.fen(), mv.to, color)) return `forks ${targetsPhrase(targets)}`;
  if (targets.length === 1) return `attacks ${targetsPhrase(targets)}`;
  if (targets.length >= 2) return `hits ${targetsPhrase(targets)}`;
  return "";
}

// A short verb phrase for what a move does, e.g. "develops the knight", "castles",
// "takes the centre", "hits the rook on c2 and the bishop on f4". Engine-free and kept to
// things that are plainly true on the board. "" when there is nothing worth saying.
export function describeMove(fenBefore, uci, san) {
  if (!san) return "";
  const chess = safeChess(fenBefore);
  if (!chess) return "";
  const color = chess.turn();
  let mv = null;
  try {
    mv = chess.move(san);
  } catch (_) {
    mv = uci ? playUci(chess, uci) : null;
  }
  if (!mv) return "";
  const parts = [];
  const name = PIECE_NAME[mv.piece];
  const back = color === "w" ? "1" : "8";

  if (mv.isKingsideCastle?.() || /^O-O(?!-O)/.test(mv.san)) parts.push("castles");
  else if (mv.isQueensideCastle?.() || /^O-O-O/.test(mv.san)) parts.push("castles queenside");
  else if (mv.promotion) parts.push(`promotes to a ${PIECE_NAME[mv.promotion]}`);
  else if (mv.captured) parts.push(`takes the ${PIECE_NAME[mv.captured]} on ${mv.to}`);
  else if ((mv.piece === "n" || mv.piece === "b") && mv.from.endsWith(back) && !mv.to.endsWith(back)) {
    parts.push(`develops the ${name}`);
  } else if (mv.piece === "p") {
    const f = mv.to.charCodeAt(0) - 97;
    const ahead = Number(mv.to[1]) + (color === "w" ? 1 : -1);
    const contact = [-1, 1].some((df) => {
      const sq = String.fromCharCode(97 + f + df) + ahead;
      const p = f + df >= 0 && f + df <= 7 ? chess.get(sq) : null;
      return p && p.type === "p" && p.color !== color && CENTER.has(sq);
    });
    if (contact) parts.push("challenges the centre");
    else if (CENTER.has(mv.to) && !mv.captured) parts.push("takes the centre");
    else if (isPassed(chess, mv.to, color) && gamePhaseLight(chess) === "late") parts.push("pushes the passed pawn");
  } else if (mv.piece === "r" && mv.from[0] !== mv.to[0] && fileIsOpen(chess, mv.to[0])) {
    parts.push(`takes the open ${mv.to[0]}-file`);
  }

  if (chess.isCheckmate()) return parts.length ? `${parts[0]} with mate` : "mates";
  const threat = threatOf(chess, mv, color);
  if (threat) parts.push(threat);
  return joinVerbs(parts);
}

function joinVerbs(parts) {
  if (parts.length <= 1) return parts[0] || "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Few pieces left (the passed-pawn push matters from here on).
function gamePhaseLight(chess) {
  let pieces = 0;
  for (const row of chess.board()) for (const p of row) if (p && p.type !== "k" && p.type !== "p") pieces += 1;
  return pieces <= 6 ? "late" : "early";
}

export { hasCaptures };
