import { Chess } from "chess.js";

// How deep each move of a depth-16 analysis is read. Every position is first searched at
// depth 12 (tiered-analysis.js); two boosted-tree models score each move from its two screen
// reads (the FEN and the search's per-depth history) and the moves around it. Both positions
// of a move `to20` flags are read at depth 20, of a move only `deepen` flags at depth 16; the
// rest keep the screen read. Trained on screen reads made like the browser's (hash carried
// between a worker's positions) against lite depth 20, and frozen in research/analyze-router
// (PROTOCOL.md, round 11, direct at the 0.5 budget). On 1,917 holdout games: 7.4 output
// changes per 100 moves against all-depth-20 (round 9: 17.9) in 0.52x its engine time.
// The models and features are a port of research/analyze-router/{features,predict}.mjs and
// round10.py's context; deepening-router.test.js checks both against those files.

export const ROUTER_DEPTH = 16;
export const ROUTER_DEEP_DEPTH = 20;
// The router was validated on uncapped depth-20 reads; 15% of them pass the 1.5M analysis cap,
// none of 300 sampled passed 7.1M. This cap only bounds a forcing finish that explodes.
export const ROUTER_DEEP_MAX_NODES = 10_000_000;

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

// Legal moves, captures and checking moves of the side to move. Counted from chess.js's
// internal moves: game.moves() builds SAN, which runs a mate search after every check.
function moveCounts(game) {
  let captures = 0, checks = 0;
  const moves = game._moves({ legal: true });
  for (const m of moves) {
    if (m.flags & 10) captures += 1; // capture | en passant
    game._makeMove(m);
    if (game.isCheck()) checks += 1;
    game._undoMove();
  }
  return [moves.length, captures, checks];
}

// The 21 features of one position. `it`: the screen search's rows per completed depth,
// { depth, cp, mate, best, nodes, seldepth }, side-to-move POV (stockfish-provider.js).
function positionFeatures(game, fen, it) {
  const [legal, captures, checks] = moveCounts(game);
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
    legal, game.inCheck() ? 1 : 0, captures, checks,
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
// The server's grade tier (0 = best move) and win% loss of a move from its two reads.
function grade(m, rb, ra) {
  const loss = Math.max(0, m.side !== "black" ? rb.w - ra.w : ra.w - rb.w);
  const best = rb.best != null && rb.best === m.uci;
  return [best ? 0 : loss <= 2 ? 1 : loss <= 5 ? 2 : loss <= 10 ? 3 : loss <= 15 ? 4 : 5, loss];
}

function moveFeatures(m, before, after, prevMove) {
  const white = m.side !== "black";
  const rb = before.read, ra = after.read;
  const [tier, loss] = grade(m, rb, ra);
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

// The two moves before and after move i (round10.py context): known, loss, tier, a mate on
// either read, eval swing; then the ply and its share of the game.
const CONTEXT = [-2, -1, 1, 2];

function context(moves, reads, i) {
  const out = [];
  for (const d of CONTEXT) {
    const m = moves[i + d], r = reads[i + d];
    if (!m || !r) {
      out.push(0, 0, 0, 0, 0);
      continue;
    }
    const [tier, loss] = grade(m, r.rb, r.ra);
    out.push(1, loss, tier, r.rb.mate != null || r.ra.mate != null ? 1 : 0, Math.abs(r.rb.w - r.ra.w));
  }
  return [...out, i, i / Math.max(1, moves.length)];
}

// Feature rows of every move in order (null when a read is missing). Training stored the
// move's own features as float32 and its context as float64.
export function moveRows(moves, evals) {
  const pos = new Map();
  const at = (fen) => {
    if (!pos.has(fen)) pos.set(fen, evals.has(fen) ? screenPosition(fen, evals.get(fen)) : null);
    return pos.get(fen);
  };
  let prevMove = null;
  const own = moves.map((m) => {
    const before = at(m.fen_before), after = at(m.fen_after);
    if (!before || !after) {
      prevMove = null;
      return null;
    }
    const mf = moveFeatures(m, before, after, prevMove);
    prevMove = mf.capture;
    return { x: [...before.features, ...after.features, ...mf.x].map(Math.fround), rb: before.read, ra: after.read };
  });
  return own.map((r, i) => (r ? [...r.x, ...context(moves, own, i)] : null));
}

// The read depth of each position past the screen: ROUTER_DEEP_DEPTH for both positions of
// every move `to20` flags, ROUTER_DEPTH for those of a move only `deepen` flags and for any
// position whose screen read came without a search history (reused from another pass).
export function routerDepths(model, moves, evals) {
  const depths = new Map();
  const all = moves || [];
  const rows = moveRows(all, evals);
  const set = (f, d) => depths.set(f, Math.max(depths.get(f) || 0, d));
  all.forEach((m, i) => {
    for (const f of [m.fen_before, m.fen_after]) {
      if (evals.get(f)?.depth > 0 && !evals.get(f).iterations) set(f, ROUTER_DEPTH);
    }
    if (!rows[i]) return;
    const d = score(model.to20, rows[i]) >= model.to20.threshold ? ROUTER_DEEP_DEPTH
      : score(model.deepen, rows[i]) >= model.deepen.threshold ? ROUTER_DEPTH : 0;
    if (d) {
      set(m.fen_before, d);
      set(m.fen_after, d);
    }
  });
  return depths;
}
