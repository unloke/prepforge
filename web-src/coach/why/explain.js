// The sentence for one candidate reason (or the bare sentence for none), frozen from
// research/coach-relations/explain.py and run without engine reads. Only the paths the frozen selector reaches are
// here: one candidate at a time, and no type the cuts drop.
import { Board, PIECE, VAL, between, file, move, name, parse, rel } from "./board.js";
import { castleState, walk } from "./facts.js";

const COUNT = { 2: "two", 3: "three", 4: "four" };
const NUMBER = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight" };
const GRADE = { blunder: "Blunder.", mistake: "Mistake." };
const SILENT = new Set(["enter", "king_exposed"]);
const DETECT = new Set(["attacks", "loose", "pin", "undeveloped", "center", "blocks_pawn", "double", "check", "king_pawn",
  "defender_moved", "exchange", "twice", "king_active", "square"]);
const SMALL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const HORIZON = 10;  // plies of the engine line a reason may come from or quote
const WINDOW = 6;  // plies after an exchange in which a taking back still belongs to it
const MIN_PLIES = 4;
const CAP = { bishop_pair: 150, queen_chased: 400 };  // the largest loss (centipawns) these quiet facts may explain
const color = (white) => (white ? "White" : "Black");
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

/** ["q", "p"] -> "the queen and a pawn"; ["p", "p"] -> "two pawns". */
function pieces(list) {
  return [...new Set(list)].map((p) => {
    const n = list.filter((x) => x === p).length;
    if (p[0] === "=") return `a new ${PIECE[p[1]]}`;
    if (n > 1) return `${COUNT[n] || n} ${PIECE[p]}s`;
    return "qk".includes(p) ? `the ${PIECE[p]}` : `a ${PIECE[p]}`;
  }).join(" and ");
}

/** One engine line: boards, moves and SAN from the root. */
class Line {
  constructor(fen, pv) {
    let b = new Board(fen);
    this.boards = [b];
    this.moves = [];
    this.sans = [];
    for (const u of pv) {
      const m = typeof u === "string" ? move(u) : u;
      const next = b.push(m);
      if (!next) break;
      this.sans.push(b.san(m));
      this.moves.push(m);
      b = next;
      this.boards.push(b);
    }
  }

  /** Plies a..b, numbered: 27.Nd7 Qc6 28.Qf3, or 27...Nd7 28.Qc6. */
  seq(a, b) {
    return range(a, Math.min(b, this.sans.length)).map((i) => {
      const pb = this.boards[i - 1], san = this.sans[i - 1];
      return pb.turn ? `${pb.full}.${san}` : i === a ? `${pb.full}...${san}` : san;
    }).join(" ");
  }

  after(a, b) { return b >= a ? ` after ${this.seq(a, b)}` : ""; }
  paren(a, b) { return b >= a ? ` (${this.seq(a, b)})` : ""; }

  /** "the bishop on g4", or "the king". */
  name(ply, sq) {
    for (const b of [this.boards[ply], this.boards[Math.max(0, ply - 1)]]) {
      const p = b.pieceAt(parse(sq));
      if (p) return p.type === "k" ? "the king" : `the ${PIECE[p.type]} on ${sq}`;
    }
    return sq;
  }
}

/** How much of an engine line the facts look at: MIN_PLIES, then on through checks, captures and delayed recaptures. */
function horizon(fen, pv) {
  let b = new Board(fen);
  const ms = pv.slice(0, HORIZON).map(move), caps = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const delayed = caps[caps.length - 1] === true && i + 1 < ms.length && ms[i + 1].to === ms[i - 1].to;
    if (i >= MIN_PLIES && !(b.isCheck() || b.isCapture(m) || delayed)) return i;
    caps.push(b.isCapture(m));
    b = b.push(m);
  }
  return ms.length;
}

const kingsFirst = (ln, k, squares) => [...squares].sort((a, b) => (ln.name(k, a) !== "the king") - (ln.name(k, b) !== "the king"));

/** The cheapest enemy man that attacks the man on sq. */
function attacker(b, sq) {
  const q = parse(sq), p = b.pieceAt(q);
  const hits = p ? b.attackers(!p.color, q) : [];
  if (!hits.length) return null;
  const v = (s) => SMALL[b.typeAt(s)] ?? 99;
  return name(hits.reduce((x, y) => (v(y) < v(x) ? y : x)));
}

/** The bishop, rook or queen that pins the man on sq to the man on behind. */
function pinner(b, sq, behind) {
  const q = parse(sq), r = parse(behind);
  const s = b.attackers(!b.colorAt(q), q).find((s) => ["b", "r", "q"].includes(b.typeAt(s)) && between(s, r).includes(q));
  return s == null ? null : name(s);
}

function detected(f, ln, a, root, row) {
  const t = f.type, played = f.line === "played", sq = f.at;
  if (f.ply > ln.moves.length) ln = new Line(row.fen, row.full[f.line]);
  const k = Math.max(1, Math.min(f.ply, ln.moves.length));
  const b = ln.boards[k];
  let last = k;
  const nm = (s) => ln.name(k, s);
  const names = (ss) => {  // "the knights on b1 and g1 and the bishop on c1"
    const kinds = new Map();
    for (const s of ss) {
      const n = nm(s), kind = n.includes(" on ") ? n.slice(0, n.lastIndexOf(" on ")) : n;
      if (!kinds.has(kind)) kinds.set(kind, []);
      kinds.get(kind).push(s);
    }
    return [...kinds].map(([n, q]) => (q.length > 1 ? `${n}s on ${q.join(" and ")}` : n !== "the king" ? `${n} on ${q[0]}` : n)).join(" and ");
  };
  const victim = played ? root.turn : !root.turn;  // whose men the attack, loose and pin facts are about
  const gains = color(!victim);
  let own = null, vp = null, clause = null;
  if (t === "attacks") {
    const to = ln.moves[k - 1].to;
    const x = b.attackers(!victim, parse(sq[0])).includes(to) ? name(to) : attacker(b, sq[0]);
    clause = `${nm(x)} attacks ${nm(sq[0])}`;
    own = `exposes ${nm(sq[0])} to ${nm(x)}`;
    vp = `attacks ${nm(sq[0])}` + (x === name(to) ? "" : ` with ${nm(x)}`);
  } else if (t === "loose") {
    const x = attacker(b, sq[0]);
    clause = `${nm(sq[0])} can be won by ${nm(x)}`;
    own = vp = `leaves ${nm(sq[0])} open to ${nm(x)}`;
  } else if (t === "pin") {
    const x = pinner(b, sq[0], sq[1]);
    clause = `${nm(x)} pins ${nm(sq[0])} to ${nm(sq[1])}`;
    own = `leaves ${nm(sq[0])} pinned to ${nm(sq[1])}`;
    vp = `pins ${nm(sq[0])} to ${nm(sq[1])}`;
  } else if (t === "undeveloped") {
    own = `leaves ${names(sq)} at home`;
  } else if (t === "center") {
    const middle = "de".includes(sq[0][0]);  // c- and f-pawns gain space; d- and e-pawns take the centre
    clause = middle ? `${gains} takes the centre` : `${gains} gains space with a pawn on ${sq[0]}`;
    vp = middle ? "takes the centre" : "gains space";
  } else if (t === "blocks_pawn") {
    own = `blocks the ${sq[1][0]}-pawn on ${sq[1]}`;
  } else if (t === "double") {
    clause = `${nm(sq[0])} attacks ${names(sq.slice(1))} at once`;
    vp = `attacks ${names(sq.slice(1))} at once`;
  } else if (t === "check") {
    clause = `${gains} gives check`;
    vp = "gives check";
  } else if (t === "king_pawn") {
    own = file(parse(sq[2])) === 4 ? "weakens the kingside pawns" : `weakens the pawns in front of the ${color(root.turn).toLowerCase()} king`;
  } else if (t === "defender_moved") {
    own = `leaves ${names(sq.slice(1))} without a defender`;
  } else if (t === "exchange") {
    last = Math.min(k + 1, ln.moves.length);
    const m = ln.moves[k - 1];
    const gone = PIECE[ln.boards[k - 1].typeAt(m.to)], taker = PIECE[b.typeAt(m.to)];
    own = vp = gone === taker ? `trades ${gone}s` : `trades a ${taker} for a ${gone}`;
    clause = gone === taker ? `the ${gone}s come off` : `a ${taker} is traded for a ${gone}`;
  } else if (t === "twice") {
    return [`allows ${ln.seq(Math.max(a, 2), k)}, moving the ${PIECE[b.typeAt(parse(sq[1]))]} twice`, k];
  } else if (t === "king_active") {
    clause = `the ${gains.toLowerCase()} king reaches ${sq[sq.length - 1]}`;
    vp = "brings the king towards the centre";
  } else {  // square: the line up to the opponent's move onto it, and why that square
    const best = new Board(row.fen).san(move(row.full.best[0]));
    const why = f.how === "given" ? `${sq[0]} is no longer guarded` : `${best} would have guarded ${sq[0]}`;
    return [`allows ${ln.seq(Math.max(a, 2), k)}: ${why}`, k];
  }
  if (k === 1 && (played ? own : vp)) return [played ? own : vp, last];
  return [`${played ? "allows" : "leads to"} ${ln.seq(Math.max(a, 2), last)}, when ${clause}`, last];
}

function phrase(f, ln, ext, a, root, row) {
  const t = f.type, played = f.line === "played";
  if ((f.ply || 0) > ln.moves.length) ln = new Line(row.fen, row.full[f.line]);
  if (played) a = Math.max(a, 2);
  const k = Math.max(1, Math.min(f.ply, ln.moves.length));
  const sq = [...(f.at || [])], c = f.side === "white";
  if (t === "mate") {
    const n = played ? Math.floor(k / 2) : Math.floor((k + 1) / 2);
    // quoted up to the horizon; a longer mate is cut there
    const line = k - a < HORIZON ? `: ${ln.seq(a, k)}` : `: ${ln.seq(a, a + HORIZON - 1)} and mate follows`;
    return [`${played ? "allows mate in" : "mates in"} ${NUMBER[n] || n}${line}`, k];
  }
  if (t === "material") {
    const what = pieces(f.won) + (f.lost.length ? ` for ${pieces(f.lost)}` : "");
    // quote the line to the winner's last capture of a man it wins, or on until the stated count stands after the reply
    const w = f.side === "white";
    const caps = range(a, f.end).filter((j) => ext.boards[j - 1].turn === w && ext.boards[j - 1].isCapture(ext.moves[j - 1]));
    const won = caps.filter((j) => f.won.includes(ext.boards[j - 1].typeAt(ext.moves[j - 1].to) ?? "p"));
    const count = (j) => balance(ext.boards[j], w) - balance(ext.boards[0], w);
    const from = won.length ? Math.max(...won) : f.end;
    let q = caps.find((j) => j >= from && count(Math.min(j + 1, ext.moves.length)) === f.net) ?? f.end;
    if (q < ext.moves.length && count(q) !== f.net && ext.moves[q].to !== ext.moves[q - 1].to) q += 1;
    return [played ? `loses ${what}${ext.after(a, q)}` : `wins ${what}${ext.paren(a, q)}`, q];
  }
  if (t === "fork") {
    const targets = kingsFirst(ln, k, f.targets).map((s) => ln.name(k, s)).join(" and ");
    if (played) return [`allows ${ln.seq(a, k)}, forking ${targets}`, k];
    return [k === 1 ? `forks ${targets}${ln.paren(a, k)}` : `sets up ${ln.seq(k, k)}, forking ${targets}${ln.paren(a, k)}`, k];
  }
  if (t === "castling") {
    const [, ply] = castleState(walk(row.fen, row[f.line]).map(([b, , m]) => [b, m]), c);
    const b = Math.min(ply, ln.moves.length), who = color(c);
    return [played ? `allows ${ln.seq(a, b)}, and the ${who.toLowerCase()} king can no longer castle`
      : `drives the ${who.toLowerCase()} king out${ln.paren(a, b)}, so ${who} can no longer castle`, b];
  }
  const what = f.what, by = PIECE[f.by] || "piece";
  const moves = played ? ln.after(a, k) : ln.paren(a, k);
  if (t === "promotion") {
    const full = new Line(row.fen, row.full[f.line]);
    const ps = f.pawn_plies;
    const ms = (ps.length <= 3 ? ps : [ps[0], ps[ps.length - 1]]).map((j) => full.seq(j, j));
    const said = ms.length > 1 ? `${ms.slice(0, -1).join(", ")} and ${ms[ms.length - 1]}` : ms[0];
    const pawn = `the ${name(full.moves[ps[0] - 1].from)[0]}-pawn`;  // named by its file at the start
    return [`${played ? "lets" : "gets"} ${pawn} through to promote: ${said}`, ps[ps.length - 1]];
  }
  if (t === "queen_chased") {
    const full = new Line(row.fen, row.full[f.line]);
    const [a1, a2] = f.chasers;
    const chase = `${full.seq(a1, a1)} and ${full.seq(a2, a2)}`;
    if (played || a1 > 1) return [`lets ${chase} chase ${played ? "the" : `the ${color(c).toLowerCase()}`} queen back to ${sq[0]}`, a2 + 1];
    return [`chases the ${color(c).toLowerCase()} queen back to ${sq[0]} with ${chase}`, a2 + 1];
  }
  if (t === "bishop_pair") {
    let w = `a knight for the bishop on ${sq[0]}, leaving ${color(c)} the bishop pair`;
    if (f.doubled) w += ` and ${color(!c)} doubled ${f.doubled}-pawns`;
    return [played ? `lets ${ln.seq(a, k)} trade ${w}` : `trades ${w}${ln.paren(a, k)}`, k];
  }
  if (t === "outpost") {
    const verb = played ? `lets the ${color(c).toLowerCase()} ${by} settle on ${sq[0]}` : `puts the ${by} on ${sq[0]}`;
    return [`${verb}, an outpost no pawn can challenge${moves}`, k];
  }
  if (t === "piece_harassed") {
    const [fr, to] = sq;
    let kind = what;
    if (kind === "chased" && !ln.boards[k - 1].attacked(!c, parse(fr))) kind = "round_trip";
    const back = rel(parse(to), c) < rel(parse(fr), c) ? " back" : "";
    const who = color(c).toLowerCase();
    if (!played) {
      return [kind === "round_trip" ? `makes the ${who} ${by} go to ${fr} and straight back to ${to}${moves}`
        : `chases the ${who} ${by} from ${fr}${back} to ${to}${moves}`, k];
    }
    const verb = { early_queen: `brings the queen out to ${fr} too early: a piece comes to ${to} with tempo`,
      kick: `lets a pawn drive the ${by} on ${fr} back to ${to}`, chased: `lets the ${by} on ${fr} be chased${back} to ${to}`,
      round_trip: `sends the ${by} to ${fr} and straight back to ${to}` }[kind];
    return [verb + moves + (kind === "chased" ? ", losing time" : ""), k];
  }
  if (t === "pawn_weakness") {
    if (what === "hole") return [`gives up ${sq[1]} to a ${color(!c).toLowerCase()} ${by}: no pawn can cover it any more`, 1];
    const fl = sq[0][0];
    const verb = { doubled: played ? `leaves doubled pawns on the ${fl}-file` : `saddles ${color(c)} with doubled pawns on the ${fl}-file`,
      undoubled: played ? `lets ${color(c)} undouble the ${fl}-pawns` : `undoubles the ${fl}-pawns`,
      isolated: played ? `leaves an isolated pawn on ${sq[0]}` : `leaves ${color(c)} with an isolated pawn on ${sq[0]}` }[what];
    return [verb + moves, k];
  }
  if (t === "restricted") return [`leaves the ${color(c).toLowerCase()} ${by} on ${sq[0]} with no safe square${moves}`, k];
  if (DETECT.has(t)) return detected(f, ln, a, root, row);
  // draw_risk
  if (what === "stalemate") return [`runs into stalemate${moves}`, k];
  return [`lets ${color(!c)} give perpetual check${moves}`, k];
}

const balance = (b, c) => b.map().reduce((s, [, p]) => (p.type === "k" ? s : s + SMALL[p.type] * (p.color === c ? 1 : -1)), 0);

/** The capture that settles the line's material within h plies and any exchange finished late (null: too deep). */
function settled(ln, h) {
  const n = ln.moves.length;
  const caps = range(1, n).filter((i) => ln.boards[i - 1].isCapture(ln.moves[i - 1]) || ln.moves[i - 1].promotion);
  const calm = (j) => j === 0 || !(caps.includes(j) || ln.boards[j].isCheck());
  const settle = (r) => range(r, n).find(calm) ?? n;
  const b0 = balance(ln.boards[0], true);
  const lastUpTo = (x) => Math.max(0, ...caps.filter((i) => i <= x));
  let end = lastUpTo(h);
  for (;;) {
    const q = settle(end);
    const gain = balance(ln.boards[q], true) - b0;
    const r = caps.find((r) => q < r && r <= q + WINDOW && Math.abs(balance(ln.boards[settle(r)], true) - b0) < Math.abs(gain));
    if (r === undefined) return lastUpTo(q);
    const back = settle(r);
    if (back > HORIZON + 2 * WINDOW) return null;
    end = lastUpTo(back);
  }
}

/** True when the line ends on the capture at ply end and the side to move can take back on that square. */
function edge(ln, end) {
  const b = ln.boards[end];
  return end > 0 && end === ln.moves.length && b.legal().some((m) => m.to === ln.moves[end - 1].to && b.isCapture(m));
}

/** True when the losing side gives a pawn away in the line (an engine gambit too abstract to call a win). */
function gifted(ln, end, line) {
  for (let j = 2; j <= end; j++) {
    const m = ln.moves[j - 1], prev = ln.moves[j - 2], b = ln.boards[j - 2];
    if (j - 1 >= (line === "played" ? 3 : 2) && b.typeAt(prev.from) === "p" && !b.isCapture(prev) && m.to === prev.to
        && ln.boards[j - 1].isCapture(m) && !(j < ln.moves.length && ln.moves[j].to === m.to)) return true;
  }
  return false;
}

/** The material fact counted from the root to the settling capture, or null when even or for the wrong side. */
function recount(f, ext) {
  const end = settled(ext, ext.h);
  if (end === null) return null;
  const gone = {};
  for (const c of [true, false]) for (const t of Object.keys(SMALL)) gone[`${c}${t}`] = ext.boards[0].pieces(t, c).length - ext.boards[end].pieces(t, c).length;
  const net = Object.keys(SMALL).reduce((s, t) => s + SMALL[t] * (gone[`false${t}`] - gone[`true${t}`]), 0);
  const w = net > 0;
  if (!net || (w === ext.boards[0].turn) !== (f.line === "best") || (Math.abs(net) < 3 && gifted(ext, end, f.line))) return null;
  if (ext.boards[end].turn !== w && edge(ext, end)) return null;
  const list = (c, sign) => Object.keys(SMALL).flatMap((t) => Array(Math.max(0, sign * gone[`${c}${t}`])).fill(sign > 0 ? t : `=${t}`));
  const won = [...list(!w, 1), ...list(w, -1)], lost = [...list(w, 1), ...list(!w, -1)];
  for (const t of [...won]) {  // like for like cancels out
    const i = lost.indexOf(t);
    if (i >= 0) { won.splice(won.indexOf(t), 1); lost.splice(i, 1); }
  }
  return { ...f, side: color(w).toLowerCase(), net: Math.abs(net), won: won.reverse(), lost: lost.reverse(), end };
}

/** How the material fact's first won man falls when it falls for losing its last guard: [kind, ply, guard, victim, capture ply]. */
function defender(f, ln) {
  const w = f.side === "white";
  let c = 1, b, m, x;
  for (; c <= f.end; c++) {
    b = ln.boards[c - 1];
    m = ln.moves[c - 1];
    x = b.pieceAt(m.to);
    if (b.turn === w && x && x.color !== w && f.won.includes(x.type)) break;
  }
  if (c > f.end) return null;
  const s = m.to;
  if (b.attacked(!w, s)) return null;
  for (let j = c - 2; j >= 0; j--) {
    const bj = ln.boards[j], mj = ln.moves[j];
    if (s === mj.from || s === mj.to) return null;
    const guards = bj.attackers(!w, s);
    if (!guards.length) continue;
    // the man must have been safe with its guard: never more attackers than guards from then on, none cheaper than it
    for (let i = j; i < c; i++) {
      const att = ln.boards[i].attackers(w, s);
      if (att.length > guards.length || att.some((q) => VAL[ln.boards[i].typeAt(q)] < VAL[x.type])) return null;
    }
    if (bj.turn !== w && guards.includes(mj.from)) {
      if (j === 0 && f.line === "played") return ["abandon", 1, mj.from, s, c];
      const lure = j ? ln.moves[j - 1] : null;
      if (lure && mj.to === lure.to) return ["lure", j, mj.from, s, c];
      const fresh = lure ? bj.attacks(lure.to).includes(mj.from) && !ln.boards[j - 1].attacked(w, mj.from) : false;
      if (lure && (bj.isCheck() || fresh)) return ["drive", j, mj.from, s, c];
    } else if (bj.turn === w && guards.includes(mj.to) && bj.isCapture(mj)) {
      return ["remove", j + 1, mj.to, s, c];
    }
    return null;
  }
  return null;
}

/** True when the castling fact's king move answers a check that only a king move meets. */
function forcedOut(f, row) {
  const c = f.side === "white", pv = row.full[f.line];
  const [, ply] = castleState(walk(row.fen, pv).map(([b, , m]) => [b, m]), c);
  const b = new Line(row.fen, pv).boards[ply - 1];
  return b.isCheck() && b.legal().every((m) => b.typeAt(m.from) === "k");
}

/** True when the fork wins something in the line: the forking side takes a target within its next two moves and is ahead. */
function pays(f, ln) {
  const i = f.ply;
  if (i > ln.moves.length) return false;
  const w = ln.boards[i - 1].turn, after = ln.boards[i];
  let tracked = new Set(f.targets.map(parse).filter((s) => after.typeAt(s) !== "k"));
  for (let j = i + 1; j <= Math.min(i + 4, ln.moves.length); j++) {
    const b = ln.boards[j - 1], m = ln.moves[j - 1];
    if (b.turn === w && tracked.has(m.to)) {
      let end = j;
      while (end < ln.moves.length && ln.boards[end].isCapture(ln.moves[end])) end++;
      return balance(ln.boards[end], w) > balance(ln.boards[i - 1], w);
    }
    if (b.turn !== w && tracked.has(m.from)) tracked = new Set([...tracked].filter((s) => s !== m.from).concat(m.to));
  }
  return false;
}

function said(cands, row, ext) {
  const out = [];
  for (let f of cands) {
    if (f.type === "material") f = recount(f, ext[f.line]);
    if (f && f.type === "fork" && !pays(f, ext[f.line])) continue;
    if (f && !SILENT.has(f.type) && f.what !== "chain" && (f.type !== "castling" || forcedOut(f, row))
        && (row.loss || 0) <= (CAP[f.type] ?? 1e6)) out.push(f);
  }
  return out;
}

const hits = (b, sq, c) => b.attacks(sq).filter((t) => b.colorAt(t) === c && b.typeAt(t) !== "k");

/** The attack on sq made by ply i matters: ply i+1 moves the man away, or the attacker's side takes on sq at ply i+2 or i+4. */
function answered(ln, i, sq) {
  if (i < ln.moves.length && ln.moves[i].from === sq) return true;
  return [i + 2, i + 4].some((j) => j <= ln.moves.length && ln.moves[j - 1].to === sq && ln.boards[j - 1].isCapture(ln.moves[j - 1]));
}

/** With no fact: [what the played move allows, what the best move does], each "" when nothing concrete holds. */
function quiet(lines, ext, root) {
  const pl = lines.played, bl = lines.best, me = root.turn;
  let allows = "";
  if (pl.moves.length > 1) {
    const r = pl.moves[1], b1 = pl.boards[1], b2 = pl.boards[2];
    if (b2.isCheck() || (b1.isCapture(r) && r.to !== pl.moves[0].to)) allows = `allows ${pl.seq(2, 2)}`;  // not a plain recapture
    else if (pl.moves.length > 2) {
      const fresh = hits(b2, r.to, me).filter((t) => !b1.attacks(r.from).includes(t) && answered(pl, 2, t) && b2.typeAt(t) !== "p");
      if (fresh.length) allows = `allows ${pl.seq(2, 2)}, which attacks ${pl.name(2, name(fresh[0]))}`;
    }
  }
  const ep = ext.played, eb = ext.best;
  const ends = { played: settled(ep, ep.h), best: settled(eb, eb.h) };
  if (ends.played !== null && ends.best !== null) {
    const d = balance(eb.boards[ends.best], me) - balance(ep.boards[ends.played], me);
    if (d >= 1 && !gifted(eb, ends.best, "best") && !gifted(ep, ends.played, "played") && !edge(eb, ends.best) && !edge(ep, ends.played)) {
      const words = { 1: "a pawn", 2: "two pawns", 3: "a piece", 5: "a rook", 9: "a queen" }[d] || `${d} pawns' worth`;
      return [allows, `it comes out ${words} better${eb.paren(1, ends.best)}`];
    }
  }
  const b1 = bl.boards[1];
  if (pl.moves.length > 1 && !b1.isCheck()) {
    const r = pl.moves[1], q = b1.pieceAt(r.from), p = pl.boards[1].pieceAt(r.from);
    if (!pl.boards[1].isCapture(r) && !root.pieceAt(r.to) && q && p && q.type === p.type && q.color === p.color && !b1.isLegal(r)) {
      return [allows, `it stops ${pl.seq(2, 2)}`];
    }
  }
  const m = bl.moves[0];
  const fresh = hits(b1, m.to, !me).filter((t) => !root.attacks(m.from).includes(t) && answered(bl, 1, t) && b1.typeAt(t) !== "p");
  if (fresh.length && !b1.isCheck()) return [allows, `it attacks ${bl.name(1, name(fresh[0]))}`];
  return [allows, ""];
}

/** {text, chosen}: the sentence for the candidates given (at most one is used), or the bare sentence. */
export function explain(card, cands) {
  const root = new Board(card.fen);
  const h = Math.max(horizon(card.fen, card.played), horizon(card.fen, card.best));
  const row = { fen: card.fen, loss: card.loss, played: card.played.slice(0, h), best: card.best.slice(0, h),
    full: { played: card.played, best: card.best } };
  const ext = { played: new Line(card.fen, card.played), best: new Line(card.fen, card.best) };
  const lines = { played: new Line(card.fen, row.played), best: new Line(card.fen, row.best) };
  for (const k of ["played", "best"]) ext[k].h = lines[k].moves.length;
  const P = lines.played.sans[0], B = lines.best.sans[0];
  const facts = said(cands, row, ext).filter((c) => c.type !== "allows" && !c.mechanism).slice(0, 1);
  const grade = GRADE[card.grade];
  const out = [];
  let shownBest = false, better = "";
  for (const f of facts) {
    const line = f.line, ln = lines[line], el = ext[line];
    let [verb, last] = phrase(f, ln, el, 1, root, row);
    const guard = f.type === "material" ? defender(f, el) : null;
    if (guard) {  // the material falls for losing its guard: say how, in as few moves as show it
      const [kind, k, g, v, c] = guard;
      const man = el.name(c - 1, name(v)), gd = el.name(["lure", "drive"].includes(kind) ? k : k - 1, name(g));
      const simple = f.won.length === 1 && f.won[0] === el.boards[c - 1].typeAt(v) && !f.lost.length;
      const gain = line === "played" ? "loses" : "wins";
      if (kind === "abandon") verb = simple ? `leaves ${man} undefended: ${el.seq(2, c)}` : `leaves ${man} undefended and ${verb}`;
      else if (simple && k === 1) {
        verb = { lure: `pulls ${gd} away from ${man} and wins it`, drive: `drives ${gd} away from ${man} and wins it`,
          remove: `takes ${gd}, the last guard of ${man}, and wins it` }[kind];
      } else if (simple) {
        verb = `${gain} ${man} once ${el.seq(k, k)} ` + { lure: `pulls ${gd} away`, drive: `drives ${gd} away`, remove: `takes ${gd}, its last guard` }[kind];
      } else {  // the count, and the move that undoes the guard instead of the whole line
        const how = { lure: `pulls ${gd} away from ${man}`, drive: `drives ${gd} away from ${man}`, remove: `takes ${gd}, the last guard of ${man}` }[kind];
        const count = `${gain} ${pieces(f.won)}` + (f.lost.length ? ` for ${pieces(f.lost)}` : "");
        verb = k === 1 ? `${how} and ${count}` : `${count}: ${el.seq(k, k)} ${how}`;
      }
    }
    const body = line === "played" ? verb : f.type === "mate" ? `misses mate in ${verb.split("mates in ")[1]}` : `misses ${B}, which ${verb}`;
    out.push(grade ? `${grade} ${P} ${body}.` : `${P} ${body}.`);
    shownBest = line === "best" && last > 0;
  }
  if (!facts.length) {
    let allows;
    [allows, better] = quiet(lines, ext, root);
    out.push(grade ? `${grade} ${P} ${allows || "is not the best move"}.` : `${P} is slightly inaccurate${allows ? `: it ${allows}` : ""}.`);
  }
  if (!shownBest) out.push(`${B} was the move${better ? `: ${better}` : ""}.`);
  return { text: out.join(" "), chosen: facts };
}
