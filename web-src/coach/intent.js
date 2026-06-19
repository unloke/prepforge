// Positional intent detection for the coach — pure chess.js, no engine, no DOM.
//
// The motif layer (tactics.js) says when a move makes a concrete THREAT (fork/pin/skewer).
// This layer fills the gap below that: the quiet, strategic POINT of a move that wins no
// material and forces nothing, but still has a reason — the "why" a club coach would give
// instead of "solid and sound". Five intents, in priority order:
//
//   defend       — rescues a friendly piece the opponent could actually win (SEE-checked)
//   openLine     — clears a diagonal/file for a friendly bishop or rook
//   prophylaxis  — removes a tactic the opponent had been threatening
//   trade        — offers an even swap of equal pieces (simplifying when ahead)
//   kingAttack   — advances against a castled enemy king (pawn storm or piece lift)
//
// detectIntent(fenBefore, fenAfter, uci, san, moverColor) -> intent | null
//   intent = { kind, ... } — a single best intent, the most concrete one that applies.
//
// Engine-free and deliberately conservative: when in doubt it returns null and the
// commentary falls back to its generic "sound move" line, rather than inventing a plan.
import { Chess } from "chess.js";
import { PIECE_VALUE, PIECE_NAME, materialBalance, seeCapture, gamePhase } from "./material.js";
import { describeAnyThreat } from "./tactics.js";

const CENTRAL = new Set(["d4", "e4", "d5", "e5"]);
const BACK_RANK = { w: "1", b: "8" };
const FIANCHETTO_SQ = { w: ["b2", "g2"], b: ["b7", "g7"] };
// The opponent's pawn "base" rank (0-based): the home rank where the shelter / queenside
// base pawns sit. Pressure on a pawn here (b2/g2 for White, b7/g7 for Black) is the kind a
// coach actually names; pressure on a random advanced pawn usually isn't worth a sentence.
const HOME_RANK0 = { w: 0, b: 7 }; // own back rank (0-based) — where own pieces start
const PAWN_HOME0 = { w: 1, b: 6 }; // own pawns' starting rank (0-based)

const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

function fileRank(sq) {
  return [sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 49]; // a1 -> [0,0]
}
function squareOf(file, rank) {
  return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
}
function safeChess(fen) {
  try {
    return new Chess(fen);
  } catch (_) {
    return null;
  }
}
function other(color) {
  return color === "w" ? "b" : "w";
}
function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) return piece.square;
    }
  }
  return null;
}
// First piece met walking from `fromSq` along (df,dr), skipping empties; null if the ray
// runs off the board, plus the squares crossed (for the "reaches into enemy half" test).
function firstAlong(chess, fromSq, df, dr) {
  let [f, r] = fileRank(fromSq);
  const path = [];
  for (;;) {
    f += df;
    r += dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) return { piece: null, path };
    const s = squareOf(f, r);
    path.push(s);
    const piece = chess.get(s);
    if (piece) return { square: s, piece, path };
  }
}

// The unit step (df,dr) from `a` toward `b` if they share a rook/bishop line, else null.
function alignedStep(a, b) {
  const [af, ar] = fileRank(a);
  const [bf, br] = fileRank(b);
  if (af === bf && ar === br) return null;
  const straight = af === bf || ar === br;
  const diagonal = Math.abs(bf - af) === Math.abs(br - ar);
  if (!straight && !diagonal) return null;
  return [Math.sign(bf - af), Math.sign(br - ar)];
}

// The pieces standing between `from` and `to` along their shared line (exclusive of both),
// in order. null when the squares aren't on one straight/diagonal line.
function piecesBetween(chess, from, to) {
  const step = alignedStep(from, to);
  if (!step) return null;
  const [df, dr] = step;
  let [f, r] = fileRank(from);
  const out = [];
  for (;;) {
    f += df;
    r += dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) return out; // ran off the board before reaching `to`
    const s = squareOf(f, r);
    if (s === to) return out;
    const p = chess.get(s);
    if (p) out.push({ square: s, piece: p });
  }
}

// Mover-POV material (pawns, + = mover ahead) once the board is settled.
function moverMaterial(chess, moverColor) {
  const w = materialBalance(chess);
  return moverColor === "w" ? w : -w;
}

// All friendly pieces `moverColor` would lose material on if the opponent grabbed them,
// richest first. SEE-confirmed, so an adequately-defended piece doesn't count.
function ownThreatened(chess, moverColor) {
  const opp = other(moverColor);
  const out = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== moverColor || piece.type === "k") continue;
      if (!chess.attackers(piece.square, opp).length) continue;
      const see = seeCapture(chess, piece.square, opp);
      if (see !== null && see > 0) out.push({ square: piece.square, type: piece.type, worth: PIECE_VALUE[piece.type] || 0, loss: see });
    }
  }
  return out.sort((a, b) => b.loss - a.loss || b.worth - a.worth);
}

// 1) DEFEND — a piece the opponent could win before is safe after (it moved out of the
// firing line, got a defender, or its attacker was blocked/removed).
function detectDefend(before, after, from, moverColor) {
  const opp = other(moverColor);
  const threatened = ownThreatened(before, moverColor);
  if (!threatened.length) return null;
  for (const t of threatened) {
    // The piece itself stepped out of the firing line (we only reach this layer on a
    // good/best move, so the square it moved to isn't a fresh hang).
    if (t.square === from) {
      return { kind: "defend", piece: PIECE_NAME[t.type], sq: t.square, moved: true };
    }
    // The piece stayed put — is it still winnable?
    const pc = after.get(t.square);
    if (!pc || pc.color !== moverColor) continue; // gone (captured into the trade) — not "defended"
    if (!after.attackers(t.square, opp).length) {
      return { kind: "defend", piece: PIECE_NAME[t.type], sq: t.square, moved: false };
    }
    const see = seeCapture(after, t.square, opp);
    if (see === null || see <= 0) {
      return { kind: "defend", piece: PIECE_NAME[t.type], sq: t.square, moved: false };
    }
  }
  return null;
}

// 2) OPEN LINE — the move vacated a square that was blocking a friendly bishop/rook/queen,
// and the freed ray now runs into the enemy half (or onto an enemy piece). When the push
// frees more than one of our pieces (a pawn step can open lines for both the queen and the
// bishop behind it), we credit the CHEAPEST piece: "opens the diagonal for the bishop" is
// the instructive read, where "the queen springs to life" overstated a queen that hardly
// needed the line. We also skip the piece that just moved — a slider sliding along its own
// file hasn't "opened a line for itself", it has simply relocated.
function detectOpenLine(before, after, from, to, moverColor) {
  const enemyHalf = (sq) => {
    const r = fileRank(sq)[1];
    return moverColor === "w" ? r >= 4 : r <= 3; // ranks 5-8 for White, 1-4 for Black
  };
  let best = null; // the cheapest slider whose line the move freed
  for (const row of after.board()) {
    for (const slider of row) {
      if (!slider || slider.color !== moverColor || !DIRS[slider.type]) continue;
      // Never credit a freed QUEEN line. "The queen springs to life down the d-file" was the
      // single most-flagged false note: a central pawn push (d5) reads as space, not as
      // "opening a file for the queen", and the queen rarely needed the line opened. Open
      // lines are worth naming for the long-range minor/rook behind the pawn, not the queen.
      if (slider.type === "q") continue;
      if (slider.square === to) continue; // the piece that just moved, not a freed line
      for (const [df, dr] of DIRS[slider.type]) {
        // Was this ray blocked by the piece that just moved?
        const b = firstAlong(before, slider.square, df, dr);
        if (!b.piece || b.square !== from || b.piece.color !== moverColor) continue;
        // After the move, the freed ray must run somewhere worth mentioning: onto an enemy
        // piece, or at least into the enemy half of the board.
        const a = firstAlong(after, slider.square, df, dr);
        const hitsEnemy = a.piece && a.piece.color === other(moverColor);
        const reaches = hitsEnemy || a.path.some(enemyHalf);
        if (!reaches) continue;
        const diagonal = df !== 0 && dr !== 0;
        const line = diagonal
          ? diagonalLabel(slider.square, df, dr)
          : df === 0
            ? `the ${slider.square[0]}-file`
            : "the rank";
        const pieceName = slider.type === "q" ? "queen" : PIECE_NAME[slider.type];
        const value = PIECE_VALUE[slider.type] || 0;
        if (!best || value < best.value) best = { kind: "openLine", piece: pieceName, line, value };
      }
    }
  }
  if (!best) return null;
  return { kind: "openLine", piece: best.piece, line: best.line };
}
// "the long diagonal" for the two great diagonals, else "the diagonal".
function diagonalLabel(sq, df, dr) {
  const [f, r] = fileRank(sq);
  // Points on a1-h8 satisfy file === rank; on a8-h1, file + rank === 7. Walk one step to
  // see which great diagonal (if any) the freed ray lies on.
  const nf = f + df;
  const nr = r + dr;
  if ((f === r && nf === nr) || (f + r === 7 && nf + nr === 7)) return "the long diagonal";
  return "the diagonal";
}

// 3) PROPHYLAXIS — the opponent had a concrete motif (fork/pin/skewer) that this move
// took off the board.
function detectProphylaxis(before, after, moverColor) {
  const opp = other(moverColor);
  const had = describeAnyThreat(before.fen(), opp);
  if (!had) return null;
  const still = describeAnyThreat(after.fen(), opp);
  if (still && still.kind === had.kind) return null; // same motif survives — nothing prevented
  return { kind: "prophylaxis", stopped: had.kind };
}

// 4) TRADE — a quiet move that attacks an equal enemy piece which can recapture (an even
// swap on offer), with our piece safe where it lands. Simplifying, especially when ahead.
function detectTrade(after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null; // an actual capture is handled as a trade elsewhere
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  if (moved.type === "p" || moved.type === "k") return null;
  const opp = other(moverColor);
  // Our piece must be safe where it sits — an "offer", not a hung piece.
  const safe = seeCapture(after, to, opp);
  if (safe !== null && safe > 0) return null;
  for (const row of after.board()) {
    for (const piece of row) {
      if (!piece || piece.color !== opp || piece.type !== moved.type) continue;
      if (!after.attackers(piece.square, moverColor).includes(to)) continue;
      if (!after.attackers(piece.square, opp).length) continue; // undefended = a win, not a trade
      return { kind: "trade", piece: PIECE_NAME[moved.type], ahead: moverMaterial(after, moverColor) >= 1 };
    }
  }
  return null;
}

// 5) KING ATTACK — the move advances on a castled enemy king: a wing pawn storming forward,
// or a piece lifting into the king's quadrant. Strict, because it is the easiest to overcall.
function detectKingAttack(after, from, to, moverColor) {
  const opp = other(moverColor);
  const kSq = findKing(after, opp);
  if (!kSq) return null;
  const [kf, kr] = fileRank(kSq);
  const backRank = opp === "w" ? 0 : 7;
  if (kr !== backRank && kr !== (opp === "w" ? 1 : 6)) return null; // king has left home — different game
  const wing = kf >= 5 ? "king" : kf <= 2 ? "queen" : null;
  if (!wing) return null; // king still central — no clean "attack the king" read
  const moved = after.get(to);
  if (!moved) return null;
  const [ff, fr] = fileRank(from);
  const [tf, tr] = fileRank(to);
  const forward = moverColor === "w" ? tr > fr : tr < fr; // advancing toward the enemy
  const onWing = wing === "king" ? tf >= 4 : tf <= 3;
  const inEnemyHalf = moverColor === "w" ? tr >= 4 : tr <= 3;
  if (moved.type === "p") {
    // A wing pawn pushing toward the king.
    if (forward && onWing && (wing === "king" ? ff >= 5 : ff <= 2)) {
      return { kind: "kingAttack", via: "pawn storm" };
    }
    return null;
  }
  // A piece arriving in the king's quadrant — but only when it actually bears down on the
  // squares around the king. The old "within two files, in the enemy half" test fired on
  // any centralisation toward the king's side (a bishop landing on a central square that
  // merely happens to point near the king), which read as a phantom "attack on the king".
  // Require the piece to attack at least one square in the king's own ring before we call
  // it a king attack.
  if (forward && onWing && inEnemyHalf && Math.abs(tf - kf) <= 2 && attacksKingRing(after, to, kSq, moverColor)) {
    return { kind: "kingAttack", via: "piece" };
  }
  return null;
}

// Does the piece on `sq` attack any square immediately around `kSq` (the 8-square ring)?
function attacksKingRing(chess, sq, kSq, byColor) {
  const [kf, kr] = fileRank(kSq);
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const f = kf + df;
      const r = kr + dr;
      if (f < 0 || f > 7 || r < 0 || r > 7) continue;
      const ring = squareOf(f, r);
      if (chess.attackers(ring, byColor).includes(sq)) return true;
    }
  }
  return false;
}

// 6) AVOID TRADE — a major piece sidesteps an even swap an equal enemy piece was offering,
// keeping the heavy pieces on. The "decline the queen trade" a club coach would name where
// the engine otherwise just shows a quiet retreat.
function detectAvoidTrade(before, after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  if (moved.type !== "q" && moved.type !== "r") return null; // only "keeping majors on" reads cleanly
  const opp = other(moverColor);
  const val = PIECE_VALUE[moved.type] || 0;
  const sameValueAttacker = (chess, sq) =>
    chess.attackers(sq, opp).some((a) => {
      const ap = chess.get(a);
      return ap && (PIECE_VALUE[ap.type] || 0) === val;
    });
  // An equal enemy piece was attacking us before (a trade on offer)...
  if (!sameValueAttacker(before, from)) return null;
  // ...and it no longer is after the move (we declined it).
  if (sameValueAttacker(after, to)) return null;
  return { kind: "avoidTrade", piece: PIECE_NAME[moved.type] };
}

// 7) FIANCHETTO — a bishop reaching its long-diagonal home (b2/g2/b7/g7), or the wing pawn
// step that prepares it while the bishop still sits at home. A named structural idea the
// generic "solid move" line was burying.
function detectFianchetto(before, after, from, to, moverColor) {
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  if (moved.type === "b" && FIANCHETTO_SQ[moverColor].includes(to)) {
    return { kind: "fianchetto", sq: to };
  }
  if (moved.type === "p") {
    const file = to[0];
    if (file !== "g" && file !== "b") return null;
    const prepFrom = moverColor === "w" ? `${file}2` : `${file}7`;
    const prepTo = moverColor === "w" ? `${file}3` : `${file}6`;
    if (from !== prepFrom || to !== prepTo) return null;
    const bishopHome = file === "g" ? (moverColor === "w" ? "f1" : "f8") : moverColor === "w" ? "c1" : "c8";
    const bp = after.get(bishopHome);
    if (bp && bp.color === moverColor && bp.type === "b") return { kind: "fianchettoPrep" };
  }
  return null;
}

// 8) CENTER — a knight or bishop planted on a central square (d4/e4/d5/e5) where it is
// safe to sit. A knight on a central outpost is one of the most pressing pieces on the
// board; the coach should name it, not fall through to "a tidy, sound move".
function detectCenter(after, to, moverColor) {
  if (!CENTRAL.has(to)) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  if (moved.type !== "n" && moved.type !== "b") return null;
  const see = seeCapture(after, to, other(moverColor));
  if (see !== null && see > 0) return null; // it would just drop — not a happy outpost
  return { kind: "center", piece: PIECE_NAME[moved.type], sq: to, knight: moved.type === "n" };
}

// 9) DEVELOP — bring a back-rank minor into play, or a rook onto an open/half-open file.
// The bread-and-butter opening idea club players want acknowledged ("develops the knight",
// "the rook takes the open c-file"). Only in the opening/middlegame; never a queen (early
// queen sorties aren't development to praise) and never a capture (handled as material).
function detectDevelop(after, from, to, san, moverColor, phase) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  const safe = () => {
    const see = seeCapture(after, to, other(moverColor));
    return see === null || see <= 0;
  };
  // A rook seizing an open/half-open file is worth naming in EVERY phase — an active rook
  // is, if anything, more important in the endgame. (The endgame guard below only excludes
  // minor-piece "development", which reads oddly once the opening is long gone.)
  if (moved.type === "r") {
    const open = fileOpenness(after, to[0], moverColor);
    if (open && safe()) return { kind: "develop", piece: "rook", file: to[0], openFile: open };
    return null;
  }
  if (phase === "endgame") return null;
  const back = BACK_RANK[moverColor];
  if ((moved.type === "n" || moved.type === "b") && from[1] === back && to[1] !== back) {
    if (!safe()) return null;
    return { kind: "develop", piece: PIECE_NAME[moved.type] };
  }
  return null;
}

// "open" (no pawns at all) / "half-open" (no friendly pawns) / null for a file.
function fileOpenness(chess, file, moverColor) {
  let own = 0;
  let enemy = 0;
  for (let r = 1; r <= 8; r++) {
    const p = chess.get(`${file}${r}`);
    if (p && p.type === "p") p.color === moverColor ? (own += 1) : (enemy += 1);
  }
  if (own === 0 && enemy === 0) return "open";
  if (own === 0) return "half-open";
  return null;
}

// 10) CENTER STRIKE — a pawn that challenges an enemy pawn standing in the centre (the
// classic ...c5 vs d4 break). Only when the move itself is the one making the contact.
function detectCenterStrike(before, after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor || moved.type !== "p") return null;
  const [f, r] = fileRank(to);
  const fwd = moverColor === "w" ? 1 : -1;
  for (const df of [-1, 1]) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    const sq = squareOf(nf, r + fwd);
    if (!CENTRAL.has(sq)) continue;
    const pc = after.get(sq);
    if (pc && pc.type === "p" && pc.color === other(moverColor)) return { kind: "centerStrike", sq };
  }
  return null;
}

// 11) SPACE — a central pawn advancing into the opponent's half, grabbing space and taking
// squares away from the enemy (the ...d5 clamp). This is what a club coach calls a central
// push: "gains space, denying Black c6/e6" — NOT "opens the d-file for the queen", which was
// the consistently-wrong reading. Names the two squares the pawn now controls.
function detectSpace(after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor || moved.type !== "p") return null;
  const [f, r] = fileRank(to);
  const [, fr] = fileRank(from);
  const forward = moverColor === "w" ? r > fr : r < fr;
  if (!forward) return null;
  const advanced = moverColor === "w" ? r >= 4 : r <= 3; // reached the 5th rank (White) / 4th (Black)
  const centralFile = f >= 2 && f <= 5; // c..f — a central/space-grabbing push, not a wing pawn
  if (!advanced || !centralFile) return null;
  const see = seeCapture(after, to, other(moverColor));
  if (see !== null && see > 0) return null; // it just drops — not a space grab
  const fwd = moverColor === "w" ? 1 : -1;
  const squares = [];
  for (const df of [-1, 1]) {
    const nf = f + df;
    const nr = r + fwd;
    if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
    squares.push(squareOf(nf, nr));
  }
  return { kind: "space", squares };
}

// 12) PRESSURE — a heavy piece (rook/queen) trains fire on an enemy base pawn (one on its
// home rank: b2/g2/b7/g7 and friends), directly or by stacking behind a friendly heavy piece
// already on the file (a battery). This is the "Rb8 reinforces the threat on b2" idea the
// generic "rook takes the b-file" line was burying — and the user flagged it twice. The pawn
// need NOT be immediately winnable: piling up on the base pawn is the point.
function detectPressure(before, after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor || (moved.type !== "q" && moved.type !== "r")) return null;
  const opp = other(moverColor);
  const homeRank0 = PAWN_HOME0[opp];
  for (const row of after.board()) {
    for (const p of row) {
      if (!p || p.color !== opp || p.type !== "p") continue;
      if (fileRank(p.square)[1] !== homeRank0) continue;
      const direct = after.attackers(p.square, moverColor).includes(to);
      let battery = false;
      if (!direct) {
        const between = piecesBetween(after, to, p.square);
        if (
          between &&
          between.length === 1 &&
          between[0].piece.color === moverColor &&
          (between[0].piece.type === "q" || between[0].piece.type === "r") &&
          after.attackers(p.square, moverColor).includes(between[0].square)
        ) {
          battery = true;
        }
      }
      if (!direct && !battery) continue;
      // "New" pressure only — don't re-announce a piece that was already bearing on the pawn
      // from a different square (it just shuffled). A battery is always worth naming.
      if (!battery && before.attackers(p.square, moverColor).includes(from)) continue;
      const otherAttacker = after.attackers(p.square, moverColor).some((s) => s !== to);
      return { kind: "pressure", piece: PIECE_NAME[moved.type], sq: p.square, file: p.square[0], reinforce: battery || otherAttacker };
    }
  }
  return null;
}

// 13) SUPPORT — a move that adds a defender to a friendly pawn the opponent is attacking and
// that was under-defended. Any piece counts (a king covering h6 is the classic case). The
// "shores up the b2 pawn" / "the king covers h6" a coach says where the engine just shows a
// quiet move.
function detectSupport(before, after, from, to, san, moverColor) {
  if (/x/.test(san || "")) return null;
  const moved = after.get(to);
  if (!moved || moved.color !== moverColor) return null;
  const opp = other(moverColor);
  for (const row of after.board()) {
    for (const p of row) {
      if (!p || p.color !== moverColor || p.type !== "p") continue;
      const attBefore = before.attackers(p.square, opp).length;
      if (!attBefore) continue; // wasn't actually under fire before the move
      if (!after.attackers(p.square, moverColor).includes(to)) continue; // this move doesn't cover it
      const defBefore = before.attackers(p.square, moverColor).length;
      if (defBefore >= attBefore) continue; // it was already adequately held — nothing to shore up
      if (before.attackers(p.square, moverColor).includes(from)) continue; // already defended it before
      return { kind: "support", sq: p.square };
    }
  }
  return null;
}

export function detectIntent(fenBefore, fenAfter, uci, san, moverColor) {
  const before = safeChess(fenBefore);
  const after = safeChess(fenAfter);
  if (!before || !after || !uci) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const phase = gamePhase(fenBefore);

  // Priority: rescue a piece first (its own move, then shoring up an attacked pawn), then
  // stop the opponent's tactic, then the named positional ideas (decline a trade, fianchetto,
  // plant a piece in the centre, challenge the centre, open a line, grab space, pile on a base
  // pawn, offer a trade), the strict king attack, and finally the catch-all "develop a piece"
  // so a quiet opening move still gets a concrete "why".
  return (
    detectDefend(before, after, from, moverColor) ||
    detectSupport(before, after, from, to, san, moverColor) ||
    detectProphylaxis(before, after, moverColor) ||
    detectAvoidTrade(before, after, from, to, san, moverColor) ||
    detectFianchetto(before, after, from, to, moverColor) ||
    detectCenter(after, to, moverColor) ||
    detectCenterStrike(before, after, from, to, san, moverColor) ||
    detectOpenLine(before, after, from, to, moverColor) ||
    detectSpace(after, from, to, san, moverColor) ||
    detectPressure(before, after, from, to, san, moverColor) ||
    detectTrade(after, from, to, san, moverColor) ||
    detectKingAttack(after, from, to, moverColor) ||
    detectDevelop(after, from, to, san, moverColor, phase) ||
    null
  );
}
