// A card's candidate reasons: relations that differ between the played and best engine lines, frozen from
// research/coach-relations (enumerate.py, tactics.py, positional.py, why/detect.py, less why/cut.py's cuts) and
// run without engine reads. Types the cuts drop whole are not computed. Facts come back in the frozen order.
import { Board, VAL, between, file, move, name, parse, rank, rel } from "./board.js";

const VALUE = { n: 3, b: 3, r: 5, q: 9 };
const ORDER = ["mate", "forced_mate", "mate_threat", "material", "fork", "king_exposed", "shield", "trades", "open_file",
  "enter", "outpost", "piece_harassed", "restricted", "pawn_weakness", "passed_pawn", "bishop_pair", "queen_chased",
  "promotion", "allows", "draw_risk", "castling"];
const PLIES = 4;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const minBy = (xs, f) => xs.reduce((a, b) => (f(b) < f(a) ? b : a));
const lower = (p) => p.type;

/** Boards along a line, each with {square: root-square id} and the move that led there; stops at an illegal move. */
export function walk(fen, pv) {
  let b = new Board(fen);
  let ids = new Map(b.map().map(([s]) => [s, name(s)]));
  const nodes = [[b, ids, null]];
  for (const u of pv) {
    const m = move(u);
    const next = b.push(m);
    if (!next) break;
    ids = new Map(ids);
    const moved = ids.get(m.from);
    ids.delete(m.from);
    ids.delete(m.to);
    if (b.isEnPassant(m)) ids.delete(b.turn ? m.to - 8 : m.to + 8);
    if (b.isCastling(m)) {
      const r = rank(m.from);
      const [rf, rt] = file(m.to) === 6 ? [7, 5] : [0, 3];
      ids.set(r * 8 + rt, ids.get(r * 8 + rf));
      ids.delete(r * 8 + rf);
    }
    ids.set(m.to, moved);
    b = next;
    nodes.push([b, ids, m]);
  }
  return nodes;
}

// --- tactics.py --------------------------------------------------------------

function taken(b, m) {
  const x = b.pieceAt(m.to);
  return x ? VAL[x.type] : b.isEnPassant(m) ? 1 : 0;
}

function moveEvents(pb, b, m, ids, add, i) {
  const c = pb.turn, to = m.to, p = b.pieceAt(to), v = VAL[p.type];
  // fork: skip when the forking piece just hangs to a cheaper attacker or is simply undefended
  const attackers = b.attackers(!c, to);
  const safe = !attackers.length || (b.attacked(c, to) && Math.min(...attackers.map((s) => VAL[b.typeAt(s)])) >= v);
  if (safe || b.isCheck()) {
    const targets = b.attacks(to).filter((t) => b.colorAt(t) === !c && (b.typeAt(t) === "k" || VAL[b.typeAt(t)] > v
      || (VAL[b.typeAt(t)] >= 3 && !b.attacked(!c, t))));
    if (targets.length >= 2) {
      add("fork", ids.get(to), i, { targets: targets.map(name), check: b.isCheck(), at: [name(to), ...targets.map(name)] });
    }
  }
}

/** material events for runs of consecutive captures (a later recapture of the same man on the same square joins its run). */
function exchanges(nodes, last, add) {
  let runs = [];
  for (let i = 1; i < nodes.length; i++) {
    const m = nodes[i][2];
    if (!(nodes[i - 1][0].isCapture(m) || m.promotion)) continue;
    let k = null;
    for (let j = runs.length - 1; j >= 0; j--) {
      const end = nodes[runs[j][runs[j].length - 1]];
      if (m.to === end[2].to && nodes[i - 1][1].get(m.to) === end[1].get(m.to)) { k = j; break; }
    }
    if (k !== null) runs = [...runs.slice(0, k), [...runs.slice(k).flat(), i]];
    else if (runs.length && i === runs[runs.length - 1][runs[runs.length - 1].length - 1] + 1) runs[runs.length - 1].push(i);
    else runs.push([i]);
  }
  for (const run of runs) {
    const first = nodes[run[0] - 1][0].turn;
    let won = [], lost = [], net = 0;
    for (const j of run) {
      const pb = nodes[j - 1][0], m = nodes[j][2];
      const x = pb.pieceAt(m.to);
      const got = pb.isCapture(m) ? [x ? lower(x) : "p"] : [];
      const v = taken(pb, m) + (m.promotion ? VAL[m.promotion] - 1 : 0);
      (pb.turn === first ? won : lost).push(...got, ...(m.promotion ? [`=${m.promotion}`] : []));
      net += pb.turn === first ? v : -v;
    }
    if (!net || nodes[run[run.length - 1]][0].isCheckmate()) continue;  // a mating capture is the mate
    const side = net > 0 ? first : !first;
    if (net < 0) [won, lost] = [lost, won];
    for (const p of [...won]) {  // like for like cancels out: Q and R for Q is a rook
      const i = lost.indexOf(p);
      if (i >= 0) { won.splice(won.indexOf(p), 1); lost.splice(i, 1); }
    }
    const j = run.find((j) => nodes[j - 1][0].turn === side);
    add("material", nodes[j][1].get(nodes[j][2].to), Math.min(j, last), { side: side ? "white" : "black", net: Math.abs(net),
      won, lost, at: j <= last ? [name(nodes[j][2].to)] : [] });
  }
}

function kingZone(b) {
  const out = new Map();
  for (const c of [true, false]) {
    const k = b.king(c);
    out.set(k, [...b.attacks(k), k].filter((s) => b.attacked(!c, s)).length);
  }
  return out;
}

// --- enumerate.py ------------------------------------------------------------

function events(fen, pv) {
  const nodes = walk(fen, pv);
  const at = nodes.map(([, ids]) => new Map([...ids].map(([sq, pid]) => [pid, name(sq)])));
  const out = [];
  const add = (type, piece, ply, extra = {}) => {
    const names = [piece, ...("other" in extra ? [extra.other] : [])];
    out.push({ type, piece, ply, ...extra, at: extra.at ?? names.map((n) => at[ply].get(n) || at[ply - 1].get(n)) });
  };
  for (let i = 1; i < nodes.length; i++) {
    const [pb] = nodes[i - 1], [b, ids, m] = nodes[i];
    moveEvents(pb, b, m, ids, add, i);
    const p = b.pieceAt(m.to);
    if (p.type in VALUE && rel(m.to, p.color) >= 5 && !b.attackers(!p.color, m.to).some((s) => b.is(s, "p", !p.color))) {
      add("enter", ids.get(m.to), i, { square: name(m.to), capture: pb.isCapture(m), check: b.isCheck() });
    }
  }
  const [b, ids, m] = nodes[nodes.length - 1];
  if (b.isCheckmate()) add("mate", ids.get(m.to), nodes.length - 1, { at: [name(m.to)] });
  exchanges(nodes, nodes.length - 1, add);
  const kz = nodes.map(([nb, nids]) => new Map([...kingZone(nb)].map(([k, n]) => [nids.get(k), n])));
  return { out, at, kz };
}

const pyRound1 = (d) => {
  const x = d * 10, f = Math.floor(x);
  return (Math.abs(x - f - 0.5) < 1e-9 ? (f % 2 ? f + 1 : f) : Math.round(x)) / 10;
};

/** Kings with at least two more attacked squares around them on average in line a than in line b. */
function exposed(a, b, at) {
  const out = [];
  for (const pid of a[0].keys()) {
    const plies = [];
    for (let i = 1; i < Math.min(a.length, b.length); i++) if (a[i].has(pid) && b[i].has(pid)) plies.push(i);
    if (!plies.length) continue;
    const gap = (i) => a[i].get(pid) - b[i].get(pid);
    const d = Math.max(...[plies, plies.slice(0, 2)].map((span) => sum(span.map(gap)) / span.length));
    if (d >= 2) {
      const w = plies.reduce((x, y) => (gap(y) > gap(x) ? y : x));
      out.push({ type: "king_exposed", piece: pid, ply: plies[0], fewer: pyRound1(d), worst: w, here: a[w].get(pid),
        there: b[w].get(pid), at: [at[plies[0]].get(pid)] });
    }
  }
  return out;
}

function candidates(fen, played, best) {
  const ev = { played: events(fen, played), best: events(fen, best) };
  const other = { played: "best", best: "played" };
  const root = new Board(fen);
  for (const line of ["played", "best"]) ev[line].out.push(...exposed(ev[line].kz, ev[other[line]].kz, ev[line].at));
  const key = (e) => (e.type === "material" ? JSON.stringify([e.type, e.side, [...e.won].sort(), [...e.lost].sort()])
    : JSON.stringify([e.type, e.piece]));
  const keys = { played: new Set(ev.played.out.map(key)), best: new Set(ev.best.out.map(key)) };
  let out = [];
  for (const line of ["played", "best"]) {
    for (const e of ev[line].out) if (e.piece === null || !keys[other[line]].has(key(e))) out.push({ line, ...e });
  }
  const mover = root.turn ? "white" : "black";
  // the best line is good for the mover, so the opponent winning material there is an unfinished sacrifice
  out = out.filter((c) => !(c.type === "material" && c.line === "best" && c.side !== mover));
  const mating = new Set(out.filter((c) => c.type === "mate").map((c) => c.line));
  out = out.filter((c) => !(["material", "enter"].includes(c.type) && mating.has(c.line)));
  // entering or forking explains a line only for the side that line favours
  out = out.filter((c) => !["enter", "fork"].includes(c.type) || (root.colorAt(parse(c.piece)) === root.turn) === (c.line === "best"));
  const tac = new Set(out.filter((c) => ["material", "mate"].includes(c.type)).map((c) => c.line));
  out = out.filter((c) => !((tac.has(c.line) && c.type === "enter" && c.capture && !c.check)
    || (mating.has(c.line) && c.type === "fork" && c.check)));
  for (const c of out) if (c.type === "fork" && c.check && tac.has(c.line)) c.mechanism = true;
  out.push(...positionalFacts(fen, played, best));
  if (out.some((c) => ["material", "mate"].includes(c.type))) {
    const quiet = ["outpost", "piece_harassed", "restricted", "pawn_weakness", "bishop_pair", "queen_chased", "promotion", "allows"];
    out = out.filter((c) => !quiet.includes(c.type));
  }
  if (out.some((c) => c.type === "mate")) out = out.filter((c) => !["draw_risk", "castling"].includes(c.type));
  else if (out.some((c) => c.type === "material")) out = out.filter((c) => c.type !== "king_exposed");
  const rankOf = (c) => [ORDER.indexOf(c.type), c.line !== "played" ? 1 : 0, c.ply];
  return out.map((c, i) => [rankOf(c), i, c]).sort(([a, i], [b, j]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || i - j)
    .map(([, , c]) => c);
}

// --- positional.py -----------------------------------------------------------

const plainWalk = (fen, pv) => walk(fen, pv).map(([b, , m]) => [b, m]);
const material = (b, c) => sum(b.map().filter(([, p]) => p.type !== "k").map(([, p]) => VAL[p.type] * (p.color === c ? 1 : -1)));
const fact = (type, line, ply, color, squares, what = {}) =>
  ({ type, line, ply, piece: null, side: color ? "white" : "black", at: squares.map(name), ...what });

function isOutpost(b, sq, c) {
  const p = b.pieceAt(sq);
  if (!p || p.color !== c || !["n", "b"].includes(p.type)) return false;
  if (![2, 3, 4, 5].includes(file(sq)) || ![3, 4, 5].includes(rel(sq, c))) return false;
  if (b.pieces("p", !c).some((e) => Math.abs(file(e) - file(sq)) === 1 && rel(e, c) > rel(sq, c))) return false;
  if (!b.attackers(c, sq).some((a) => b.typeAt(a) === "p")) return false;
  return b.attackers(c, sq).length >= b.attackers(!c, sq).length;
}

function outposts(lines, mover) {
  const out = [];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const nodes = lines[line], b0 = nodes[0][0];
    for (let i = 1; i < nodes.length; i++) {
      const [b, m] = nodes[i], p = b.pieceAt(m.to), sq = m.to;
      if ((p.color === mover) === (line === "played")) continue;
      if (isOutpost(b, sq, p.color) && isOutpost(nodes[nodes.length - 1][0], sq, p.color) && !isOutpost(b0, sq, p.color)
          && !lines[other].slice(1).some(([ob]) => isOutpost(ob, sq, p.color))) {
        out.push(fact("outpost", line, i, p.color, [sq], { by: p.type }));
        break;
      }
    }
  }
  return out;
}

function chased(nodes) {
  const hits = [];
  for (let i = 1; i < nodes.length - 2; i++) {
    const [[b0], [b1, m1], [b2, m2], [b3, m3]] = nodes.slice(i - 1, i + 3);
    const sq = m1.to, p = b1.pieceAt(m1.to);
    if (["p", "k"].includes(p.type) || m3.from !== sq || b2.isCapture(m3) || b3.isCheck()) continue;
    const cheaper = (b) => b.attackers(!p.color, sq).filter((a) => VAL[b.typeAt(a)] < VAL[p.type]);
    if (cheaper(b2).length && !cheaper(b1).length && !b1.isCapture(m2)) hits.push([i + 2, p.color, p.type, sq, m3.to, "chased"]);
    else if (i === 1 && p.type === "q" && rel(m1.from, p.color) === 0 && !b0.isCapture(m1) && rel(sq, p.color) >= 3
             && rel(m3.to, p.color) <= 1 && !b1.isCapture(m2)) hits.push([i + 2, p.color, p.type, sq, m3.to, "chased"]);
  }
  for (let i = 1; i < nodes.length; i++) {
    const b0 = nodes[i - 1][0], m = nodes[i][1], p = b0.pieceAt(m.from);
    if (["p", "k"].includes(p.type) || b0.isCapture(m) || nodes[i][0].isCheck()) continue;
    const sq = m.from;
    let at = m.to;
    for (let j = i + 2; j < nodes.length; j += 2) {  // follow the piece while it moves without capturing or checking
      const bj = nodes[j - 1][0], mj = nodes[j][1];
      const here = bj.pieceAt(at);
      if (!here || here.type !== p.type || here.color !== p.color) break;
      if (mj.from !== at) continue;
      if (bj.isCapture(mj) || nodes[j][0].isCheck()) break;
      if (mj.to === sq && rel(at, p.color) > rel(sq, p.color) && !hits.some((h) => h[0] === j && h[1] === p.color)) {
        hits.push([j, p.color, p.type, at, sq, "round_trip"]);
        break;
      }
      at = mj.to;
    }
  }
  if (nodes.length >= 3) {
    const [[b0], [b1, m1], [b2, m2]] = nodes;
    const kicker = b1.pieceAt(m1.to), victim = b1.pieceAt(m2.from);
    if (kicker.type === "p" && !b0.isCapture(m1) && ["n", "b"].includes(victim.type) && b1.attacks(m1.to).includes(m2.from)
        && !b1.isCapture(m2) && !b2.isCheck() && rel(m2.from, victim.color) >= 3 && rel(m2.to, victim.color) < rel(m2.from, victim.color)) {
      hits.push([2, victim.color, victim.type, m2.from, m2.to, "kick"]);
    }
  }
  if (nodes.length >= 2) {
    const [[b0], [b1, m1]] = nodes;
    const q = b1.pieceAt(m1.to), home = b0.turn ? parse("d1") : parse("d8");
    if (q.type === "q" && m1.from === home && !b1.isCheck() && rel(m1.to, q.color) >= 3) {
      const undeveloped = [...b1.pieces("n", !q.color), ...b1.pieces("b", !q.color)].sort((a, b) => a - b).filter((s) => rel(s, !q.color) === 0);
      if (undeveloped.length >= 3 && !hits.some((h) => h[3] === m1.to)) {
        for (const m of b1.legal()) {
          if (!undeveloped.includes(m.from) || b1.isCapture(m)) continue;
          const t = b1.push(m);
          if (t.attacks(m.to).includes(m1.to) && (!t.attacked(q.color, m.to) || t.attacked(!q.color, m.to))) {
            hits.push([1, q.color, "q", m1.to, m.to, "early_queen"]);
            break;
          }
        }
      }
    }
  }
  return hits;
}

function harassed(lines, mover) {
  const found = { played: chased(lines.played), best: chased(lines.best) };
  const out = [];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const seen = new Set(found[other].map((h) => JSON.stringify(h.slice(1, 4))));
    for (const [ply, c, pt, sq, to, kind] of found[line]) {
      if (seen.has(JSON.stringify([c, pt, sq])) || (c === mover) !== (line === "played")) continue;
      out.push(fact("piece_harassed", line, ply, c, [sq, to], { what: kind, by: pt }));
    }
  }
  return out;
}

/** What `enemy` wins by capturing on sq, lowest-value attacker first, each side free to stop. */
export function see(b, sq, enemy) {
  const tb = b.withTurn(enemy);
  const target = tb.pieceAt(sq);
  const caps = target ? tb.legal().filter((m) => m.to === sq) : [];
  if (!caps.length) return 0;
  const m = minBy(caps, (m) => VAL[tb.typeAt(m.from)]);
  return Math.max(0, VAL[target.type] - see(tb.push(m), sq, !enemy));
}

const pawnControl = (b, c, sq) => b.pieces("p", c).some((p) => Math.abs(file(p) - file(sq)) === 1 && rel(p, c) < rel(sq, c));

function targetable(b, sq, c) {
  if (b.attackers(!c, sq).some((a) => !["p", "k"].includes(b.typeAt(a)))) return true;
  const tb = b.withTurn(!c);
  return tb.legal().some((m) => {
    if (["p", "k"].includes(tb.typeAt(m.from)) || tb.isCapture(m)) return false;
    const t = tb.push(m);
    return t.attacks(m.to).includes(sq) && see(t, m.to, c) === 0;
  });
}

function minorReaches(b, sq, c) {
  const tb = b.withTurn(!c);
  const held = (t) => t.attackers(!c, sq).length >= t.attackers(c, sq).length;
  for (const start of [...b.pieces("n", !c), ...b.pieces("b", !c)]) {
    if (start === sq) return b.typeAt(sq);
    for (const m1 of tb.legal().filter((m) => m.from === start)) {
      if (m1.to !== sq && (tb.isCapture(m1) || tb.attackers(c, m1.to).some((a) => tb.typeAt(a) === "p"))) continue;
      const t = tb.push(m1);
      let ok;
      if (m1.to === sq) ok = held(t);
      else {
        const t2 = t.withTurn(!c), m2 = { from: m1.to, to: sq, promotion: null };
        ok = t2.isLegal(m2) && held(t2.push(m2));
      }
      if (ok) return b.typeAt(start);
    }
  }
  return null;
}

function isolated(b, c) {
  const pawns = b.pieces("p", c), files = new Set(pawns.map(file));
  return pawns.filter((s) => !files.has(file(s) - 1) && !files.has(file(s) + 1));
}

function doubled(b, c) {
  const fs = b.pieces("p", c).map(file);
  return new Set(fs.filter((f) => fs.filter((g) => g === f).length > 1));
}

const filesOf = (squares) => new Set(squares.map(file));

function pawnWeakness(lines, mover) {
  const out = [];
  const k = Math.min(lines.played.length, lines.best.length) - 1;
  const b0 = lines.played[0][0];
  if (k >= 1) {
    const [b1, m1] = lines.played[1];
    if (b0.typeAt(m1.from) === "p" && !b0.isCapture(m1) && !b1.isCheck()) {
      // a broken chain (never spoken, but a candidate the selector counts)
      for (const t of b0.attacks(m1.from).filter((s) => b0.is(s, "p", mover))) {
        if (rel(t, mover) >= 2 && !b1.attackers(mover, t).some((a) => b1.typeAt(a) === "p") && lines.best[1][1].from !== t
            && lines.played[k][0].is(t, "p", mover)) {
          out.push(fact("pawn_weakness", "played", 1, mover, [m1.to, t], { what: "chain" }));
          break;
        }
      }
      // a hole: the pushed pawn was the only one that could cover a square, and by the end of the line none can
      const end = lines.played[lines.played.length - 1][0], endBest = lines.best[lines.best.length - 1][0];
      const others = b0.without(m1.from);
      for (let sq = 0; sq < 64; sq++) {
        if (Math.abs(file(sq) - file(m1.from)) !== 1 || ![2, 3, 4, 5].includes(file(sq)) || ![3, 4, 5].includes(rel(sq, !mover))
            || !(rel(m1.from, mover) < rel(sq, mover) && rel(sq, mover) <= rel(m1.to, mover) + 1)
            || material(end, mover) < material(b0, mover) || end.typeAt(sq) === "p") continue;
        if (pawnControl(b0, mover, sq) && !pawnControl(others, mover, sq) && !pawnControl(end, mover, sq)
            && pawnControl(endBest, mover, sq) && pawnControl(end, !mover, sq)) {
          const pt = minorReaches(end, sq, mover);
          if (pt) {
            out.push(fact("pawn_weakness", "played", 1, mover, [m1.to, sq], { what: "hole", by: pt }));
            break;
          }
        }
      }
    }
  }
  const ends = { played: lines.played[lines.played.length - 1][0], best: lines.best[lines.best.length - 1][0] };
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    for (const c of [mover, !mover]) {
      const hurt = (c === mover) === (line === "played");
      const d = doubled(ends[line], c), od = doubled(ends[other], c), d0 = doubled(b0, c);
      const pick = hurt ? [...d].filter((f) => !od.has(f) && !d0.has(f)) : [...od].filter((f) => !d.has(f) && d0.has(f));
      for (const f of pick.sort((a, b) => a - b)) {
        const pawns = ends[line].pieces("p", c).filter((s) => file(s) === f);
        if (!pawns.length) continue;
        if (hurt && pawns.some((s) => ends[line].attackers(!c, s).length > ends[line].attackers(c, s).length)) continue;
        const nodes = lines[line];
        if (!hurt && !nodes.slice(1).some(([, m], j) => nodes[j][0].turn === c && nodes[j][0].typeAt(m.from) === "p"
            && file(m.from) === f && nodes[j][0].isCapture(m))) continue;
        const ply = nodes.findIndex(([b]) => doubled(b, c).has(f) === hurt);
        out.push(fact("pawn_weakness", line, ply, c, pawns, { what: hurt ? "doubled" : "undoubled" }));
      }
    }
  }
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const c = line === "played" ? mover : !mover;
    const bk = lines[line][k][0], ok = lines[other][k][0];
    const i0 = isolated(b0, c), io = isolated(ok, c);
    for (const sq of isolated(bk, c).filter((s) => !i0.includes(s) && !io.includes(s))) {
      const att = bk.attackers(!c, sq).length, dfn = bk.attackers(c, sq).length, f = file(sq);
      const last = lines[line][lines[line].length - 1][0];
      if ([2, 3, 4, 5].includes(f) && (att > dfn || ([3, 4].includes(f) && dfn === 0))) {
        out.push(fact("pawn_weakness", line, k, c, [sq], { what: "isolated" }));
      } else if (![2, 3, 4, 5].includes(f) && dfn <= att && !doubled(bk, c).has(f) && !filesOf(i0).has(f) && !filesOf(io).has(f)
                 && !Object.values(lines).some((n) => n[n.length - 1][0].isCheckmate()) && last.is(sq, "p", c)
                 && Math.min(material(bk, c), material(last, c)) >= material(b0, c) && targetable(bk, sq, c)) {
        out.push(fact("pawn_weakness", line, k, c, [sq], { what: "isolated" }));
      }
    }
  }
  return out;
}

function restricted(b, sq) {
  const p = b.pieceAt(sq);
  if (!p || ["p", "k"].includes(p.type) || rel(sq, p.color) === 0 || b.isGameOver()) return false;
  const c = p.color, v = VAL[p.type];
  const tb = b.withTurn(c);
  if (tb.isCheck() || tb.isPinned(c, sq)) return false;
  for (const m of tb.legal().filter((m) => m.from === sq)) {
    const won = tb.isCapture(m) ? VAL[tb.typeAt(m.to)] ?? 1 : 0;
    if (see(tb.push(m), m.to, !c) <= won) return false;
  }
  if (b.attackers(!c, sq).some((a) => VAL[b.typeAt(a)] < v)) return true;
  const ob = tb.withTurn(!c);
  return ob.legal().some((m) => {
    if (ob.isCapture(m)) return false;
    const t = ob.push(m);
    return see(t, m.to, c) === 0 && t.attackers(!c, sq).some((a) => VAL[t.typeAt(a)] < v && see(t, a, c) === 0);
  });
}

function restrictedPieces(lines, mover) {
  const out = [];
  const k = Math.min(lines.played.length, lines.best.length) - 1;
  if (k < 1 || Object.values(lines).some((n) => n[n.length - 1][0].isCheckmate())) return out;
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const c = line === "played" ? mover : !mover;
    const bk = lines[line][k][0], ok = lines[other][k][0], end = lines[line][lines[line].length - 1][0];
    for (const sq of bk.occupied(c)) {
      const pt = bk.typeAt(sq);
      if (restricted(bk, sq) && (end === bk || restricted(end, sq)) && !ok.pieces(pt, c).some((o) => restricted(ok, o))) {
        out.push(fact("restricted", line, k, c, [sq], { by: pt }));
      }
    }
  }
  return out;
}

function drawRisk(lines, mover) {
  const out = [];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const n = lines[line], o = lines[other];
    if (n[n.length - 1][0].isStalemate() && !o[o.length - 1][0].isStalemate()) {
      out.push(fact("draw_risk", line, n.length - 1, mover, [], { what: "stalemate" }));
    }
  }
  const checks = {};
  for (const [line, n] of Object.entries(lines)) {
    checks[line] = [];
    for (let i = 1; i < n.length; i++) if (n[i - 1][0].turn !== mover && n[i][0].isCheck()) checks[line].push(i);
  }
  const p = lines.played, last = (p.length - 1) % 2 === 0 ? p.length - 1 : p.length - 2;
  if (checks.played.length >= 2 && !checks.best.length && checks.played.includes(last)
      && Math.max(material(p[p.length - 1][0], mover), material(lines.best[lines.best.length - 1][0], mover)) >= 2) {
    out.push(fact("draw_risk", "played", checks.played[checks.played.length - 1], mover, [p[p.length - 1][0].king(mover)], { what: "perpetual" }));
  }
  return out;
}

/** [state, ply] for colour c along a line: castled, kept, lost (a king move) or gone (lost any other way). */
export function castleState(nodes, c) {
  let b = nodes[0][0];
  for (let i = 1; i < nodes.length; i++) {
    const m = nodes[i][1];
    if (b.turn === c && b.isCastling(m)) return ["castled", i];
    const king = b.turn === c && m.from === b.king(c);
    b = nodes[i][0];
    if (!b.hasCastlingRights(c)) return [king ? "lost" : "gone", i];
  }
  return ["kept", nodes.length - 1];
}

function castling(lines, mover) {
  const out = [];
  const root = lines.played[0][0];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const c = line === "played" ? mover : !mover;
    if (!root.hasCastlingRights(c)) continue;
    const [state, ply] = castleState(lines[line], c);
    const ostate = castleState(lines[other], c)[0];
    if (state === "lost" && ["castled", "kept"].includes(ostate)) {
      const last = lines[line].length - 1;
      out.push(fact("castling", line, Math.min(ply, last), c, [lines[line][Math.min(ply, last)][0].king(c)]));
    }
  }
  return out;
}

function queenChases(nodes, c, loose = false) {
  const qs = nodes[0][0].pieces("q", c);
  if (qs.length !== 1) return null;
  let q = qs[0];
  const start = q, hits = [];
  const cheaper = (b, sq) => b.attackers(!c, sq).some((a) => VAL[b.typeAt(a)] < VAL.q);
  for (let i = 1; i < Math.min(nodes.length - 1, 10); i++) {
    const [pb] = nodes[i - 1], [b, m] = nodes[i], [nb, r] = nodes[i + 1];
    if (pb.turn === c && m.from === q) q = m.to;
    else if (pb.turn !== c && m.to === q) return null;
    else if (pb.turn !== c && cheaper(b, q) && !cheaper(pb, q) && r.from === q && !b.isCapture(r) && !nb.isCheck()) {
      hits.push(i);
      if (hits.length === 2) {
        const to = r.to;
        return hits[0] <= 4 && (rel(to, c) <= 1 || to === start || loose) ? [hits, to] : null;
      }
    }
  }
  return null;
}

function queenChased(lines, mover) {
  const out = [];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const c = line === "played" ? mover : !mover;
    const hit = queenChases(lines[line], c);
    if (hit && !queenChases(lines[other], c, true)) {
      const [[a1, a2], q] = hit;
      out.push(fact("queen_chased", line, a2 + 1, c, [q], { chasers: [a1, a2] }));
    }
  }
  return out;
}

function passed(b, c) {
  return b.pieces("p", c).filter((s) => !b.pieces("p", !c).some((e) => Math.abs(file(e) - file(s)) <= 1 && rel(e, c) > rel(s, c)));
}

function promotes(nodes, c) {
  const root = nodes[0][0];
  for (let i = 1; i < Math.min(nodes.length, 17); i++) {
    const pb = nodes[i - 1][0], m = nodes[i][1];
    if (pb.turn === c && m.promotion) {
      const plies = [i];
      let sq = m.from;
      for (let j = i - 1; j > 0; j--) {  // walk the pawn back to its root square
        if (nodes[j][1].to === sq && nodes[j - 1][0].typeAt(nodes[j][1].from) === "p") {
          plies.unshift(j);
          sq = nodes[j][1].from;
        }
      }
      if (!passed(root, c).includes(sq)) return null;
      return material(nodes[nodes.length - 1][0], c) - material(root, c) >= 3 ? [plies, i] : null;
    }
  }
  return null;
}

function promotion(lines, mover) {
  const out = [];
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const c = line === "played" ? !mover : mover;
    const hit = promotes(lines[line], c);
    if (hit && !promotes(lines[other], c)) {
      const [plies, i] = hit;
      out.push(fact("promotion", line, i, c, [lines[line][i][1].to], { pawn_plies: plies }));
    }
  }
  return out;
}

function allows(lines, mover) {
  const pl = lines.played, bl = lines.best;
  if (pl.length < 3 || bl.length < 3) return [];
  const r = pl[2][1], bb = bl[1][0];
  const same = (a, b) => a.from === b.from && a.to === b.to && a.promotion === b.promotion;
  if (pl[1][0].isCapture(r) || pl[1][0].isCheck() || same(bl[2][1], r) || !bb.isLegal(r)) return [];
  const win = (b) => Math.max(0, ...b.occupied(!mover).filter((sq) => b.typeAt(sq) !== "k").map((sq) => see(b, sq, mover)));
  const after = bb.push(r);
  const sq = r.to, gain = see(after, sq, mover);
  if (gain < 3 || win(pl[2][0]) > 0) return [];
  const took = minBy(after.legal().filter((m) => m.to === sq), (m) => VAL[after.typeAt(m.from)]);
  return [fact("allows", "played", 2, !mover, [sq], { reply: name(r.from) + name(r.to) + (r.promotion || ""),
    took: name(took.from) + name(took.to) + (took.promotion || "") })];
}

function bishopPair(lines, mover) {
  const out = [];
  const pair = (b, c) => b.pieces("b", c).length >= 2;
  for (const [line, other] of [["played", "best"], ["best", "played"]]) {
    const f = line === "played" ? !mover : mover;
    const nodes = lines[line], oend = lines[other][lines[other].length - 1][0];
    for (let i = 1; i < Math.min(5, nodes.length - 1); i++) {
      const [pb] = nodes[i - 1], [b, m] = nodes[i], [, r] = nodes[i + 1];
      if (pb.turn === f && pb.typeAt(m.from) === "n" && pb.typeAt(m.to) === "b" && r.to === m.to && pair(pb, !f)
          && nodes.slice(i + 1).every(([nb]) => pair(nb, f) && !pair(nb, !f)) && !(pair(oend, f) && !pair(oend, !f))) {
        const fl = file(m.to);
        const dbl2 = (x) => x.pieces("p", !f).filter((s) => file(s) === fl).length >= 2;
        const pawn = b.typeAt(r.from) === "p";
        const dbl = pawn && !dbl2(b) && nodes.slice(i + 1).every(([nb]) => dbl2(nb)) && !dbl2(oend);
        out.push(fact("bishop_pair", line, i, f, [m.to], { doubled: dbl ? "abcdefgh"[fl] : null }));
        break;
      }
    }
  }
  return out;
}

function positionalFacts(fen, played, best) {
  const lines = { played: plainWalk(fen, played), best: plainWalk(fen, best) };
  const mover = new Board(fen).turn;
  return [...outposts(lines, mover), ...harassed(lines, mover), ...restrictedPieces(lines, mover), ...pawnWeakness(lines, mover),
    ...bishopPair(lines, mover), ...queenChased(lines, mover), ...promotion(lines, mover), ...allows(lines, mover),
    ...drawRisk(lines, mover), ...castling(lines, mover)];
}

// --- why/detect.py -----------------------------------------------------------

const gain = (b, sq, by) => {
  const p = b.pieceAt(sq);
  return p && p.color !== by && p.type !== "k" ? see(b, sq, by) : 0;
};

function attacks(nodes, side) {
  const out = new Map();
  for (let i = 1; i <= Math.min(2, nodes.length - 1); i++) {
    const [pb] = nodes[i - 1], [b, ids, m] = nodes[i];
    if (pb.turn === side || pb.isCapture(m)) continue;
    for (const sq of b.attacks(m.to).filter((s) => b.colorAt(s) === side)) {
      if (!out.has(ids.get(sq)) && gain(b, sq, !side) > 0 && !(pb.pieceAt(sq) && gain(pb, sq, !side) > 0)) out.set(ids.get(sq), i);
    }
  }
  return out;
}

function loose(nodes, side) {
  const out = new Map();
  nodes.slice(0, PLIES + 1).forEach(([b, ids], i) => {
    if (!i || b.turn === side) return;
    out.set(i, new Set(b.occupied(side).filter((sq) => gain(b, sq, !side) > 0 && i + 1 < nodes.length && nodes[i + 1][2].to === sq
      && !(nodes[i][2].to === sq && nodes[i - 1][0].isCapture(nodes[i][2]))).map((sq) => ids.get(sq))));
  });
  return out;
}

function pinned(b, side) {
  const out = new Map();
  for (const a of b.occupied(!side).filter((s) => ["b", "r", "q"].includes(b.typeAt(s)))) {
    const seen = b.attacks(a);
    for (const sq of seen.filter((s) => b.colorAt(s) === side && b.typeAt(s) !== "k")) {
      const t = b.without(sq);
      for (const q of t.attacks(a).filter((s) => !seen.includes(s) && t.colorAt(s) === side)) {
        if (between(a, q).includes(sq) && VAL[t.typeAt(q)] > VAL[b.typeAt(sq)] && !b.attacks(sq).includes(a)
            && VAL[t.typeAt(q)] > VAL[b.typeAt(a)] && (b.typeAt(sq) !== "p" || t.typeAt(q) === "k")) out.set(sq, q);
      }
    }
  }
  return out;
}

function pins(nodes, side) {
  const root = new Set([...pinned(nodes[0][0], side).keys()].map((sq) => nodes[0][1].get(sq)));
  const out = new Map();
  nodes.slice(0, PLIES + 1).forEach(([b, ids], i) => {
    if (!i) return;
    out.set(i, new Map([...pinned(b, side)].filter(([sq]) => !root.has(ids.get(sq))).map(([sq, q]) => [ids.get(sq), name(q)])));
  });
  return out;
}

const HOME = [["n", ["b1", "g1"]], ["b", ["c1", "f1"]]];
const mirror = (s) => s ^ 56;

function homeMinors(b, side) {
  const out = [];
  for (const [t, sqs] of HOME) for (const s0 of sqs) {
    const sq = side ? parse(s0) : mirror(parse(s0));
    if (b.is(sq, t, side)) out.push(sq);
  }
  return out;
}

function undeveloped(fen, played, best) {
  const root = new Board(fen), home = homeMinors(root, root.turn);
  const develops = (u) => { const m = move(u); return home.includes(m.from) || root.isCastling(m); };
  return home.length >= 2 && !develops(played[0]) && develops(best[0])
    ? [{ line: "played", type: "undeveloped", piece: null, ply: 1, at: home.map(name) }] : [];
}

const CENTER = [2, 3, 4, 5].flatMap((f) => [3, 4].map((r) => r * 8 + f));

function center(nodes, side) {
  const out = new Map();
  for (let i = 1; i <= Math.min(PLIES, nodes.length - 1); i++) {
    const [pb] = nodes[i - 1], [, , m] = nodes[i];
    if (pb.turn !== side || pb.typeAt(m.from) !== "p") continue;
    if (CENTER.includes(m.to) && !pb.isCapture(m) && !out.has(name(m.to))) out.set(name(m.to), i);
  }
  return out;
}

function blocksPawn(fen, played, best) {
  const root = new Board(fen), side = root.turn, ahead = side ? 8 : -8;
  const blocked = (u) => {
    const front = move(u).to - ahead;
    return front >= 0 && front < 64 && rank(front) === (side ? 1 : 6) && file(front) >= 2 && file(front) <= 4 && root.is(front, "p", side);
  };
  const m = move(played[0]);
  if (["n", "b"].includes(root.typeAt(m.from)) && blocked(played[0]) && !blocked(best[0])) {
    return [{ line: "played", type: "blocks_pawn", piece: name(m.from), ply: 1, at: [name(m.to), name(m.to - ahead)] }];
  }
  return [];
}

function double(nodes, side) {
  const out = new Map();
  for (let i = 1; i <= Math.min(PLIES, nodes.length - 1); i++) {
    const [pb] = nodes[i - 1], [b, , m] = nodes[i];
    if (pb.turn !== side || ![null, "p"].includes(pb.typeAt(m.to))) continue;  // a piece taken is the point
    const v = VAL[b.typeAt(m.to)];
    const hits = b.attacks(m.to).filter((sq) => b.colorAt(sq) === !side
      && (b.typeAt(sq) === "k" || VAL[b.typeAt(sq)] > v || !b.attacked(!side, sq)));
    if (hits.length >= 2 && !out.has(name(m.to))) out.set(name(m.to), [i, hits.map(name)]);
  }
  return out;
}

function firstCheck(nodes, side) {
  for (let i = 1; i < Math.min(PLIES + 1, nodes.length); i++) {
    const [b, , m] = nodes[i];
    if (b.turn !== side && b.isCheck()) return [i, name(m.to)];
  }
  return null;
}

function moverMoves(fen, played, best) {
  const root = new Board(fen), side = root.turn, out = [];
  const k = root.king(side);
  const files = file(k) === 4 && rank(k) === (side ? 0 : 7) ? [5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7].filter((f) => Math.abs(f - file(k)) <= 1);
  const home = rel(k, side) <= 1;
  const near = (u) => { const m = move(u); return home && root.typeAt(m.from) === "p" && !root.isCapture(m) && files.includes(file(m.from)); };
  if (near(played[0]) && !near(best[0])) {
    const m = move(played[0]);
    out.push({ line: "played", type: "king_pawn", piece: name(m.from), ply: 1, at: [name(m.from), name(m.to), name(k)] });
  }
  const stripped = (u) => {
    const m = move(u);
    const before = root.occupied(side).filter((sq) => root.typeAt(sq) !== "k" && root.attacked(side, sq));
    const b = root.push(m);
    return new Set(before.filter((sq) => sq !== m.from && b.colorAt(sq) === side && !b.attacked(side, sq) && b.attacked(!side, sq)));
  };
  const sb = stripped(best[0]);
  const gone = [...stripped(played[0])].filter((s) => !sb.has(s)).sort((a, b) => a - b);
  if (gone.length) {
    const m = move(played[0]);
    out.push({ line: "played", type: "defender_moved", piece: name(m.from), ply: 1, at: [name(m.from), ...gone.map(name)] });
  }
  return out;
}

function exchangesOf(nodes) {
  const out = new Map();
  for (let i = 1; i <= Math.min(6, nodes.length - 2); i++) {
    const [pb] = nodes[i - 1], [b, , m] = nodes[i], [, , m2] = nodes[i + 1];
    const x = pb.typeAt(m.to);
    if (x && m2.to === m.to && VAL[x] === VAL[b.typeAt(m.to)] && !out.has(x)) out.set(x, [i, [name(m.to), name(m.from), name(m2.from)]]);
  }
  return out;
}

function twice(nodes, side) {
  let first = null;
  for (let i = 1; i < nodes.length; i++) if (nodes[i - 1][0].turn === side) { first = i; break; }
  if (first === null) return null;
  const pid = nodes[first][1].get(nodes[first][2].to);
  for (let i = first + 2; i <= Math.min(PLIES, nodes.length - 1); i += 2) {
    const pids = nodes[i - 1][1], m = nodes[i][2];
    if (pids.get(m.from) === pid) return [i, name(m.from), name(m.to)];
  }
  return null;
}

const centreDistance = (sq) => Math.max(Math.abs(file(sq) - 3.5), Math.abs(rank(sq) - 3.5));

function kingActive(fen, nodes, mover) {
  const root = new Board(fen), out = [];
  const light = !root.pieces("q", true).length && !root.pieces("q", false).length && [true, false].every((c) =>
    sum(root.occupied(c).filter((s) => !["p", "k"].includes(root.typeAt(s))).map((s) => VAL[root.typeAt(s)])) <= 8);
  if (!light) return out;
  const k = root.king(mover);
  const closer = (line) => nodes[line][1][2].from === k && centreDistance(nodes[line][1][2].to) < centreDistance(k);
  if (closer("best") && !closer("played")) {
    out.push({ line: "best", type: "king_active", piece: name(k), ply: 1, at: [name(k), name(nodes.best[1][2].to)] });
  }
  const enter = (line) => {
    for (let i = 1; i < Math.min(PLIES + 1, nodes[line].length); i++) if ((rank(nodes[line][i][0].king(!mover)) <= 3) === mover) return i;
    return null;
  };
  const i = enter("played");
  if (i && !enter("best")) out.push({ line: "played", type: "king_active", piece: null, ply: i, at: [name(nodes.played[i][0].king(!mover))] });
  return out;
}

function squares(fen, nodes, mover) {
  const root = new Board(fen);
  if (nodes.played.length < 2 || nodes.best.length < 2) return [];
  const after = { played: nodes.played[1][0], best: nodes.best[1][0] };
  const out = [];
  for (let i = 2; i <= Math.min(PLIES, nodes.played.length - 1); i += 2) {
    const m = nodes.played[i][2], sq = m.to;
    if (nodes.played[i - 1][0].isCapture(m)) continue;
    const given = root.attacked(mover, sq) && !after.played.attacked(mover, sq);
    const denied = after.best.attacked(mover, sq) && !root.attacked(mover, sq) && !after.played.attacked(mover, sq);
    if (given || denied) out.push({ line: "played", type: "square", piece: null, ply: i, how: given ? "given" : "denied", at: [name(sq), name(m.from)] });
  }
  return out;
}

const where = (nodes, i, p) => name([...nodes[i][1]].find(([, pid]) => pid === p)[0]);

function detectFacts(fen, played, best) {
  const mover = new Board(fen).turn;
  const nodes = { played: walk(fen, played), best: walk(fen, best) };
  const victim = { played: mover, best: !mover }, other = { played: "best", best: "played" };
  const out = [];
  for (const [line, side] of Object.entries(victim)) {
    const o = other[line];
    const a = attacks(nodes[line], side), ao = attacks(nodes[o], side);
    for (const [p, i] of a) if (!ao.has(p) || ao.get(p) > i) out.push({ line, type: "attacks", piece: p, ply: i, at: [where(nodes[line], i, p)] });
    const lo = loose(nodes[line], side), loo = loose(nodes[o], side);
    let seen = new Set();
    for (const [i, ps] of lo) {
      for (const p of ps) {
        if (loo.get(i)?.has(p) || seen.has(p)) continue;
        seen.add(p);
        out.push({ line, type: "loose", piece: p, ply: i, at: [where(nodes[line], i, p)] });
      }
    }
    const pn = pins(nodes[line], side), pno = pins(nodes[o], side);
    seen = new Set();
    for (const [i, ps] of pn) {
      for (const [p, q] of ps) {
        if (!seen.has(p) && !pno.get(i)?.has(p)) {
          seen.add(p);
          out.push({ line, type: "pin", piece: p, ply: i, at: [where(nodes[line], i, p), q] });
        }
      }
    }
  }
  const actor = { played: !mover, best: mover };
  for (const [line, side] of Object.entries(actor)) {
    const o = other[line];
    const ce = center(nodes[line], side), ceo = center(nodes[o], side);
    for (const [sq, i] of ce) if (!ceo.has(sq)) out.push({ line, type: "center", piece: null, ply: i, at: [sq] });
    const db = double(nodes[line], side), dbo = double(nodes[o], side);
    for (const [sq, [i, t]] of db) if (!dbo.has(sq) || dbo.get(sq)[0] > i) out.push({ line, type: "double", piece: null, ply: i, at: [sq, ...t] });
    const ck = firstCheck(nodes[line], side), cko = firstCheck(nodes[o], side);
    if (ck && (!cko || cko[0] > ck[0])) out.push({ line, type: "check", piece: null, ply: ck[0], at: [ck[1]] });
  }
  for (const [line, o] of Object.entries(other)) {
    const ex = exchangesOf(nodes[line]), exo = exchangesOf(nodes[o]);
    for (const [t, [i, sqs]] of ex) {
      if (!exo.has(t) || exo.get(t)[0] > i) out.push({ line, type: "exchange", piece: null, ply: i, what: { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" }[t], at: sqs });
    }
  }
  const tw = twice(nodes.played, mover), two = twice(nodes.best, mover);
  if (tw && !(two && two[0] <= tw[0])) out.push({ line: "played", type: "twice", piece: null, ply: tw[0], at: [tw[1], tw[2]] });
  out.push(...kingActive(fen, nodes, mover), ...squares(fen, nodes, mover));
  return [...out, ...undeveloped(fen, played, best), ...blocksPawn(fen, played, best), ...moverMoves(fen, played, best)];
}

// --- why/cut.py --------------------------------------------------------------

const CUT_VAL = { ...VAL, k: 0 };

/** Value of the man on candidate c's first square at its ply (null when it names no occupied square). */
export function man(c, fen, lines) {
  if (!c.at?.length) return null;
  let b = new Board(fen);
  for (const u of lines[c.line].slice(0, c.ply || 0)) b = b.push(move(u)) || b;
  const p = b.pieceAt(parse(c.at[0]));
  return p ? CUT_VAL[p.type] : null;
}

function cut(c, m) {
  const ply = c.ply || 0;
  return (c.type === "exchange" && ply > 1) || (["enter", "piece_harassed"].includes(c.type) && ply > 4)
    || (c.type === "center" && ply > 2) || (["loose", "pawn_weakness"].includes(c.type) && c.line === "best")
    || (c.type === "pin" && m === 1) || (c.type === "material" && (c.net || 0) < 2);
}

/** The frozen candidates of a card: fen, the played line (the move and the after-read PV) and the best line. */
export function cardFacts(fen, played, best) {
  const lines = { played, best };
  return [...candidates(fen, played, best), ...detectFacts(fen, played, best)].filter((c) => !cut(c, man(c, fen, lines)));
}
