import { Chess } from "chess.js";

// Which moves of a depth-16 analysis need their depth-16 read. Every position is first
// searched at depth 12 (tiered-analysis.js); this boosted-tree model scores each move from
// its two screen reads (the FEN and the search's per-depth history) and deepens both
// positions of every move it scores at or above the threshold. Trained and frozen in
// research/analyze-router (PROTOCOL.md, round 2): on 1,917 fresh games it caught 0.855 of
// the moves whose grade changes at depth 16 (loss rule: 0.760) and 0.903 of the
// Great/Brilliant flips (0.835) in 0.831x the engine time of a full-depth pass (0.897x).
// The model and features are a port of research/analyze-router/{features,predict}.mjs;
// deepening-router.test.js checks both against those files.

export const ROUTER_DEPTH = 16;

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Side-to-move win% of one history row.
function rowWin(r) {
  const c = r.mate != null ? (r.mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, r.cp ?? 0));
  return 100 / (1 + Math.exp(-0.00368208 * c));
}

// White win% of a White-POV eval, cp clamped to ±1000 (the server's sigmoid).
function whiteWin(ev) {
  const mate = ev.mate_in;
  const cp = mate > 0 ? 1000 : mate < 0 ? -1000 : Math.max(-1000, Math.min(1000, Math.trunc(ev.score_cp ?? 0)));
  return 100 / (1 + Math.exp(-0.00368208 * cp));
}

const NO_ROW = { depth: 0, cp: 0, mate: null, best: null, nodes: 1, seldepth: 0 };

// The 21 features of one position. `it`: the screen search's rows per completed depth,
// { depth, cp, mate, best, nodes, seldepth }, side-to-move POV (stockfish-provider.js).
function positionFeatures(game, fen, it) {
  const moves = game.moves();
  let material = 0, balance = 0, queens = 0;
  const stm = game.turn();
  for (const row of game.board()) for (const sq of row) {
    if (!sq) continue;
    material += VALUE[sq.type];
    balance += sq.color === stm ? VALUE[sq.type] : -VALUE[sq.type];
    if (sq.type === "q") queens += 1;
  }
  const last = it[it.length - 1] || NO_ROW;
  const at = (d) => it.find((r) => r.depth === d) || last;
  const ws = it.filter((r) => r.depth >= 8).map(rowWin);
  let changes = 0, stable = last.depth;
  for (let i = 1; i < it.length; i++) if (it[i].depth >= 6 && it[i].best !== it[i - 1].best) changes += 1;
  for (let i = it.length - 1; i >= 0 && it[i].best === last.best; i--) stable = it[i].depth;
  const prev = it.length > 1 ? it[it.length - 2] : last;
  const w = rowWin(last);
  return [
    w, Math.min(1000, Math.abs(last.cp ?? 1000)) / 1000, last.mate != null ? 1 : 0, last.mate != null ? Math.abs(last.mate) : 0,
    ws.length ? Math.max(...ws) - Math.min(...ws) : 0,
    Math.abs(w - rowWin(at(11))), Math.abs(w - rowWin(at(10))), Math.abs(w - rowWin(at(8))),
    changes, stable,
    Math.log10(Math.max(1, last.nodes ?? 1)), Math.log2(Math.max(1, last.nodes ?? 1) / Math.max(1, prev.nodes ?? 1)),
    (last.seldepth ?? last.depth) - last.depth,
    moves.length, game.inCheck() ? 1 : 0, moves.filter((m) => m.includes("x")).length, moves.filter((m) => m.includes("+") || m.includes("#")).length,
    material, balance, queens, Number(fen.split(" ")[5]) * 2 - (stm === "w" ? 2 : 1),
  ];
}

// One position's screen summary: its features plus the read the grade uses (White win%,
// White-POV mate, best move). Stockfish answers a finished game with one depth-0 line
// (mate 0 or cp 0), which is what training saw; the game pass skips the engine there.
function screenPosition(fen, ev) {
  const game = new Chess(fen);
  let read, it = ev.iterations || [];
  if (game.isCheckmate()) {
    read = { w: game.turn() === "w" ? 0 : 100, mate: 0, best: null };
    it = [{ depth: 0, cp: null, mate: 0, best: null, nodes: null, seldepth: null }];
  } else if (game.isStalemate()) {
    read = { w: 50, mate: null, best: null };
    it = [{ depth: 0, cp: 0, mate: null, best: null, nodes: null, seldepth: null }];
  } else {
    read = { w: whiteWin(ev), mate: ev.mate_in ?? null, best: ev.best_move_uci ?? null };
  }
  return { read, features: positionFeatures(game, fen, it), game };
}

// The 11 move features after the two position blocks.
function moveFeatures(m, before, after, prevMove) {
  const white = m.side !== "black";
  const rb = before.read, ra = after.read;
  const loss = Math.max(0, white ? rb.w - ra.w : ra.w - rb.w);
  const best = rb.best != null && rb.best === m.uci;
  const tier = best ? 0 : loss <= 2 ? 1 : loss <= 5 ? 2 : loss <= 10 ? 3 : loss <= 15 ? 4 : 5;
  const game = new Chess(m.fen_before);
  const mv = game.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
  const capture = mv.isCapture() || mv.isEnPassant();
  // A forced move, or a recapture on the square just captured on.
  const sane = before.game.moves().length !== 1
    && !(capture && prevMove?.capture && prevMove.to === mv.to);
  const moverB = white ? rb.w : 100 - rb.w;
  const moverA = white ? ra.w : 100 - ra.w;
  return {
    capture: { capture, to: mv.to },
    x: [loss, tier === 0 ? 1 : 0, tier, capture ? 1 : 0, game.inCheck() ? 1 : 0, mv.promotion ? 1 : 0, sane ? 1 : 0,
      moverB, moverA, Math.abs(rb.w - ra.w), rb.mate != null || ra.mate != null ? 1 : 0],
  };
}

export function score(model, x) {
  let s = model.baseline;
  for (const t of model.trees) {
    let n = 0;
    while (t.f[n] !== -1) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
    s += t.t[n];
  }
  return 1 / (1 + Math.exp(-s));
}

// Feature rows of every move in order (null when a read is missing). Training stored
// features as float32.
export function moveRows(moves, evals) {
  const pos = new Map();
  const at = (fen) => {
    if (!pos.has(fen)) pos.set(fen, evals.has(fen) ? screenPosition(fen, evals.get(fen)) : null);
    return pos.get(fen);
  };
  let prevMove = null;
  return moves.map((m) => {
    const before = at(m.fen_before), after = at(m.fen_after);
    if (!before || !after) {
      prevMove = null;
      return null;
    }
    const mf = moveFeatures(m, before, after, prevMove);
    prevMove = mf.capture;
    return [...before.features, ...after.features, ...mf.x].map(Math.fround);
  });
}

// FENs that need the depth-16 read: both positions of every move the model flags, and
// any position whose screen read came without a search history (reused from another pass).
export function routerFlags(model, moves, evals) {
  const flagged = new Set();
  const all = moves || [];
  const rows = moveRows(all, evals);
  all.forEach((m, i) => {
    const bare = [m.fen_before, m.fen_after].filter((f) => evals.get(f)?.depth > 0 && !evals.get(f).iterations);
    for (const f of bare) flagged.add(f);
    if (rows[i] && score(model, rows[i]) >= model.threshold) {
      flagged.add(m.fen_before);
      flagged.add(m.fen_after);
    }
  });
  return flagged;
}
