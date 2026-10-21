// The board queries the reason path needs, with python-chess's meaning (the research code it was frozen from:
// research/coach-relations): squares 0..63 from a1, colours true (White) / false, square lists in ascending order,
// attacks and attackers pseudo-legal (pinned men attack), legal moves in python-chess's order.

export const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PIECE = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
export const file = (s) => s & 7;
export const rank = (s) => s >> 3;
export const name = (s) => "abcdefgh"[file(s)] + (rank(s) + 1);
export const parse = (n) => "abcdefgh".indexOf(n[0]) + 8 * (Number(n[1]) - 1);
export const rel = (s, c) => (c ? rank(s) : 7 - rank(s));
export const uci = (m) => name(m.from) + name(m.to) + (m.promotion || "");
export const move = (u) => ({ from: parse(u.slice(0, 2)), to: parse(u.slice(2, 4)), promotion: u[4] || null });
export const same = (a, b) => a.from === b.from && a.to === b.to && (a.promotion || null) === (b.promotion || null);

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function at(s, df, dr) {
  const f = file(s) + df, r = rank(s) + dr;
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1;
}

/** Squares strictly between a and b on a rank, file or diagonal ([] when not aligned). */
export function between(a, b) {
  const df = Math.sign(file(b) - file(a)), dr = Math.sign(rank(b) - rank(a));
  const aligned = file(a) === file(b) || rank(a) === rank(b) || Math.abs(file(b) - file(a)) === Math.abs(rank(b) - rank(a));
  if (a === b || !aligned) return [];
  const out = [];
  for (let s = at(a, df, dr); s !== b; s = at(s, df, dr)) out.push(s);
  return out.sort((x, y) => x - y);
}

export class Board {
  constructor(fen) {
    if (fen == null) return;  // filled in by copy()
    const [placement, turn, castling, ep, half, full] = fen.split(" ");
    this.sq = new Array(64).fill(null);
    placement.split("/").forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else this.sq[(7 - i) * 8 + f++] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() };
      }
    });
    this.turn = turn === "w";
    this.castling = castling || "-";
    this.ep = ep && ep !== "-" ? parse(ep) : null;
    this.half = Number(half || 0);
    this.full = Number(full || 1);
  }

  copy() {
    const b = new Board();
    Object.assign(b, { sq: this.sq.slice(), turn: this.turn, castling: this.castling, ep: this.ep, half: this.half, full: this.full });
    return b;
  }

  fen() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = "", n = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.sq[r * 8 + f];
        if (!p) n++;
        else {
          row += (n || "") + (p.color ? p.type.toUpperCase() : p.type);
          n = 0;
        }
      }
      rows.push(row + (n || ""));
    }
    return `${rows.join("/")} ${this.turn ? "w" : "b"} ${this.castling} ${this.ep == null ? "-" : name(this.ep)} ${this.half} ${this.full}`;
  }

  pieceAt(s) { return this.sq[s]; }
  typeAt(s) { return this.sq[s]?.type ?? null; }
  colorAt(s) { return this.sq[s] ? this.sq[s].color : null; }
  is(s, type, color) { const p = this.sq[s]; return !!p && p.type === type && p.color === color; }

  pieces(type, color) {
    const out = [];
    for (let s = 0; s < 64; s++) if (this.is(s, type, color)) out.push(s);
    return out;
  }

  occupied(color) {
    const out = [];
    for (let s = 0; s < 64; s++) if (this.sq[s] && this.sq[s].color === color) out.push(s);
    return out;
  }

  map() {
    const out = [];
    for (let s = 63; s >= 0; s--) if (this.sq[s]) out.push([s, this.sq[s]]);  // python-chess's piece_map order
    return out;
  }

  king(color) {
    for (let s = 0; s < 64; s++) if (this.is(s, "k", color)) return s;
    return null;
  }

  /** Squares the man on s attacks (a slider's ray includes the first man it meets). */
  attacks(s) {
    const p = this.sq[s];
    if (!p) return [];
    const out = [];
    const step = (dirs, slide) => {
      for (const [df, dr] of dirs) {
        for (let t = at(s, df, dr); t >= 0; t = at(t, df, dr)) {
          out.push(t);
          if (!slide || this.sq[t]) break;
        }
      }
    };
    if (p.type === "p") step([[-1, p.color ? 1 : -1], [1, p.color ? 1 : -1]], false);
    else if (p.type === "n") step(KNIGHT, false);
    else if (p.type === "k") step(KING, false);
    else step([...(p.type !== "b" ? ROOK : []), ...(p.type !== "r" ? BISHOP : [])], true);
    return out.sort((a, b) => a - b);
  }

  attackers(color, s) {
    const out = [];
    const take = (t, types) => { const p = this.sq[t]; if (p && p.color === color && types.includes(p.type)) out.push(t); };
    for (const [df, dr] of KNIGHT) { const t = at(s, df, dr); if (t >= 0) take(t, "n"); }
    for (const [df, dr] of KING) { const t = at(s, df, dr); if (t >= 0) take(t, "k"); }
    for (const df of [-1, 1]) { const t = at(s, df, color ? -1 : 1); if (t >= 0) take(t, "p"); }
    for (const [dirs, types] of [[ROOK, "rq"], [BISHOP, "bq"]]) {
      for (const [df, dr] of dirs) {
        for (let t = at(s, df, dr); t >= 0; t = at(t, df, dr)) {
          if (this.sq[t]) { take(t, types); break; }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  attacked(color, s) { return this.attackers(color, s).length > 0; }

  isCheck() {
    const k = this.king(this.turn);
    return k != null && this.attacked(!this.turn, k);
  }

  /** The man on s is pinned to its own king by an enemy slider. */
  isPinned(color, s) {
    const k = this.king(color);
    if (k == null || s === k) return false;
    return this.occupied(!color).some((a) => {
      const t = this.sq[a].type;
      const straight = file(a) === file(k) || rank(a) === rank(k);
      const diagonal = !straight && Math.abs(file(a) - file(k)) === Math.abs(rank(a) - rank(k));
      if (!((t === "q" && (straight || diagonal)) || (t === "r" && straight) || (t === "b" && diagonal))) return false;
      const gap = between(a, k);
      return gap.includes(s) && gap.every((q) => q === s || !this.sq[q]);
    });
  }

  /** The board after move m, legal or not (castling is the king's two-square move). */
  play(m) {
    const b = this.copy(), p = this.sq[m.from], sq = b.sq;
    const capture = this.isCapture(m);
    if (this.isEnPassant(m)) sq[m.to + (p.color ? -8 : 8)] = null;
    if (this.isCastling(m)) {
      const [rf, rt] = m.to > m.from ? [m.from + 3, m.from + 1] : [m.from - 4, m.from - 1];
      sq[rt] = sq[rf];
      sq[rf] = null;
    }
    sq[m.to] = m.promotion ? { type: m.promotion, color: p.color } : p;
    sq[m.from] = null;
    let rights = this.castling;
    if (p.type === "k") rights = rights.replace(p.color ? /[KQ]/g : /[kq]/g, "");
    for (const [s, r] of [[0, "Q"], [7, "K"], [56, "q"], [63, "k"]]) if (m.from === s || m.to === s) rights = rights.replace(r, "");
    b.castling = rights || "-";
    b.ep = p.type === "p" && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : null;
    b.half = p.type === "p" || capture ? 0 : this.half + 1;
    if (!this.turn) b.full = this.full + 1;
    b.turn = !this.turn;
    return b;
  }

  /** Pseudo-legal moves in python-chess's order: pieces, castling, pawn captures, pushes, double pushes, en passant. */
  pseudo() {
    const c = this.turn, out = [], up = c ? 8 : -8;
    const add = (from, to) => {
      if (this.sq[from].type === "p" && (rank(to) === 0 || rank(to) === 7)) for (const q of "qrbn") out.push({ from, to, promotion: q });
      else out.push({ from, to, promotion: null });
    };
    for (let s = 63; s >= 0; s--) {
      const p = this.sq[s];
      if (!p || p.color !== c || p.type === "p") continue;
      for (const t of this.attacks(s).reverse()) if (this.colorAt(t) !== c) add(s, t);
    }
    const k = this.king(c);
    if (k === (c ? 4 : 60) && !this.attacked(!c, k)) {
      for (const [r, letter, path, walk] of [[k + 3, c ? "K" : "k", [k + 1, k + 2], [k + 1, k + 2]],
        [k - 4, c ? "Q" : "q", [k - 1, k - 2, k - 3], [k - 1, k - 2]]]) {
        if (this.castling.includes(letter) && this.is(r, "r", c) && path.every((s) => !this.sq[s])
            && walk.every((s) => !this.attacked(!c, s))) out.push({ from: k, to: walk[1], promotion: null });
      }
    }
    const pawns = [];
    for (let s = 63; s >= 0; s--) if (this.is(s, "p", c)) pawns.push(s);
    for (const s of pawns) for (const t of this.attacks(s).reverse()) if (this.colorAt(t) === !c) add(s, t);
    const single = pawns.map((s) => s + up).filter((t) => t >= 0 && t < 64 && !this.sq[t]).sort((a, b) => b - a);
    for (const t of single) add(t - up, t);
    const double = single.filter((t) => rank(t) === (c ? 2 : 5) && !this.sq[t + up]).map((t) => t + up).sort((a, b) => b - a);
    for (const t of double) add(t - 2 * up, t);
    if (this.ep != null && !this.sq[this.ep] && this.is(this.ep - up, "p", !c)) {
      for (const s of pawns) if (this.attacks(s).includes(this.ep)) out.push({ from: s, to: this.ep, promotion: null });
    }
    return out;
  }

  /** Legal moves, in python-chess's order (in check: king moves first). */
  legal() {
    if (!this._legal) {
      const c = this.turn;
      const safe = (m) => { const b = this.play(m), k = b.king(c); return k == null || !b.attacked(!c, k); };
      let moves = this.pseudo().filter(safe);
      if (this.isCheck()) moves = [...moves.filter((m) => m.from === this.king(c)), ...moves.filter((m) => m.from !== this.king(c))];
      this._legal = moves;
    }
    return this._legal;
  }

  find(m) { return this.legal().find((l) => same(l, m)) || null; }
  isLegal(m) { return !!this.find(m); }

  san(m) {
    const p = this.sq[m.from], after = this.play(m);
    let s;
    if (this.isCastling(m)) s = m.to > m.from ? "O-O" : "O-O-O";
    else if (p.type === "p") {
      s = (this.isCapture(m) ? `${"abcdefgh"[file(m.from)]}x` : "") + name(m.to) + (m.promotion ? `=${m.promotion.toUpperCase()}` : "");
    } else {
      const others = this.legal().filter((l) => l.to === m.to && l.from !== m.from && this.typeAt(l.from) === p.type).map((l) => l.from);
      let d = "";
      if (others.length) {
        const row = others.some((o) => file(o) === file(m.from)), column = !row || others.some((o) => rank(o) === rank(m.from));
        d = (column ? "abcdefgh"[file(m.from)] : "") + (row ? String(rank(m.from) + 1) : "");
      }
      s = p.type.toUpperCase() + d + (this.isCapture(m) ? "x" : "") + name(m.to);
    }
    return s + (after.isCheckmate() ? "#" : after.isCheck() ? "+" : "");
  }

  /** The board after legal move m (null when m is not legal). */
  push(m) {
    return this.isLegal(m) ? this.play(m) : null;
  }

  isEnPassant(m) {
    return this.typeAt(m.from) === "p" && m.to === this.ep && file(m.from) !== file(m.to) && !this.sq[m.to];
  }

  isCapture(m) {
    return (!!this.sq[m.to] && this.sq[m.to].color !== this.colorAt(m.from)) || this.isEnPassant(m);
  }

  isCastling(m) {
    return this.typeAt(m.from) === "k" && Math.abs(file(m.to) - file(m.from)) === 2;
  }

  isCheckmate() { return this.isCheck() && !this.legal().length; }
  isStalemate() { return !this.isCheck() && !this.legal().length; }
  isGameOver() { return !this.legal().length || this.half >= 150 || (this.insufficient(true) && this.insufficient(false)); }

  /** python-chess's has_insufficient_material(color). */
  insufficient(c) {
    const mine = this.occupied(c).map((s) => this.sq[s].type);
    if (mine.some((t) => "prq".includes(t))) return false;
    if (mine.includes("n")) return mine.length <= 2 && this.occupied(!c).every((s) => "kq".includes(this.sq[s].type));
    if (mine.includes("b")) {
      const all = this.map(), shades = new Set(all.filter(([, p]) => p.type === "b").map(([s]) => (file(s) + rank(s)) & 1));
      return shades.size === 1 && !all.some(([, p]) => "pn".includes(p.type));
    }
    return true;
  }

  hasCastlingRights(color) { return (color ? /[KQ]/ : /[kq]/).test(this.castling); }

  /** A copy with the other side to move, as python-chess's `b.turn = c` (the en passant square is dropped). */
  withTurn(color) {
    const b = this.copy();
    b.turn = color;
    b.ep = null;
    return b;
  }

  without(s) {
    const b = this.copy();
    b.sq[s] = null;
    return b;
  }
}
