// The Analyze report — the block under the score sheet that says how the game
// went. Two parts, both written into the view's one host (#analysis-summary):
// the facts a player reads first, and one grade bar per side.
//
// The facts are derived from the payload the run already saved and from the
// PGN's own headers; the accuracy figure is the same Lichess win-chance model
// the coach grades single moves with (explain.js), so the report and the coach
// can never disagree about what a move cost.
import { html } from "../html.js";
import { CLASS_GROUPS, CLASS_GROUP_OF, classBadgeSymbol } from "../move-grades.js";
import { evaluationToWin, moveAccuracy } from "../explain.js";
import { moveTokenHtml } from "../move-text.js";

// The evaluation of a point in the graph is White's, so the mover's is its
// complement when Black played. A missing point is a level position: the first
// ply has no predecessor in the graph.
function whiteWin(point) {
  if (!point) return 50;
  return evaluationToWin({ cp: point.score_cp ?? point.bounded_score_cp ?? 0, mate: point.mate_in ?? null });
}

function moverWin(point, side) {
  return side === "black" ? 100 - whiteWin(point) : whiteWin(point);
}

function sideOfMove(move, ply) {
  if (move?.side === "black" || move?.side === "white") return move.side;
  return ply % 2 ? "white" : "black";
}

// "3.Bb5" / "2…Nc6". The move number comes from the ply, which the graph and the
// move list always agree on, so the two halves of one move cannot be numbered
// differently.
function moveRef(move, ply) {
  const side = sideOfMove(move, ply);
  return `${Math.ceil(ply / 2)}${side === "black" ? "…" : "."}${move?.san || ""}`;
}

// One row per classified ply: who moved, the win chance of the position before
// the move and after it (mover's point of view), and what the move cost.
function plies(evalGraph, moves = []) {
  const points = (evalGraph || [])
    .filter((point) => point && Number(point.ply) >= 1)
    .sort((a, b) => Number(a.ply) - Number(b.ply));
  if (!points.length) return [];
  const pointsByPly = new Map(points.map((point) => [Number(point.ply), point]));
  const movesByPly = new Map((moves || []).map((move) => [Number(move.ply), move]));
  return points.map((point) => {
    const ply = Number(point.ply);
    const move = movesByPly.get(ply);
    const side = sideOfMove(move, ply);
    const winBefore = moverWin(pointsByPly.get(ply - 1), side);
    const winAfter = moverWin(point, side);
    return { san: move?.san || point.san, ply, move, side, winBefore, winAfter, loss: Math.max(0, winBefore - winAfter) };
  });
}

// A percentage per side, or null when the run classified too few plies for an
// average to mean anything (a typed PGN has no evals at all).
export function sideAccuracy(evalGraph, moves = []) {
  const rows = plies(evalGraph, moves);
  if (rows.length < 2) return null;
  const sums = { white: { total: 0, count: 0 }, black: { total: 0, count: 0 } };
  for (const row of rows) {
    const tally = sums[row.side];
    tally.total += moveAccuracy(row.winBefore, row.winAfter);
    tally.count += 1;
  }
  if (!sums.white.count || !sums.black.count) return null;
  return {
    white: Math.round(sums.white.total / sums.white.count),
    black: Math.round(sums.black.total / sums.black.count),
  };
}

// The move that decided the game: the largest win-chance drop anyone allowed.
// A game that never moved off level has no such move.
export function biggestSwing(evalGraph, moves = []) {
  const rows = plies(evalGraph, moves);
  if (!rows.length) return null;
  const worst = rows.reduce((a, b) => (b.loss > a.loss ? b : a));
  const loss = Math.round(worst.loss);
  if (loss < 1) return null;
  return { ply: worst.ply, san: worst.san, side: worst.side, loss, label: moveRef(worst.move, worst.ply), move: worst.move };
}

// The opening's name and code, as the PGN records them. A PGN without them has
// no opening to report, and the row is simply not drawn.
export function openingFromHeaders(headers = {}) {
  const name = String(headers.Opening || "").trim();
  const eco = String(headers.ECO || "").trim();
  return [name, eco].filter(Boolean).join(" · ");
}

// "me_user vs opp_one · 1-0". On a phone this is the only place the game is
// named: the panel head that carries it on a wide screen is not drawn there.
export function reportIdentity(headers = {}) {
  const known = (value) => (value && !/^[?*.\s]+$/.test(String(value)) ? String(value).trim() : "");
  const white = known(headers.White);
  const black = known(headers.Black);
  const players = white || black ? `${white || "?"} vs ${black || "?"}` : "";
  return [players, known(headers.Result)].filter(Boolean).join(" · ");
}

// The ply where the game left the player's own preparation, walked against the
// repertoire trees the Analyze coach already loads (analyze-book-state.js). The
// first mainline move no repertoire continues is the departure; a game still
// inside the book, or a player with no repertoire for that colour, reports
// nothing. A book that never enters the line is not a departure at move 1.
export function prepDeparture(moves = [], reps = []) {
  if (!moves.length || !reps.length) return null;
  let deepest = -1;
  for (const rep of reps) {
    let walk = rep.rootId;
    let matched = 0;
    for (const move of moves) {
      const child = rep.children.get(`${walk}|${move.uci}`);
      if (!child) break;
      walk = child.id;
      matched += 1;
    }
    if (matched > deepest) deepest = matched;
  }
  if (deepest <= 0 || deepest >= moves.length) return null;
  const move = moves[deepest];
  const ply = Number(move.ply) || deepest + 1;
  return { ply, label: moveRef(move, ply), move };
}

// The report's fact rows, in reading order. Each is a label and a figure built
// from data the app already has; nothing is inferred and no row explains itself.
export function buildReportFacts({ moves = [], evalGraph = [], headers = {}, departure = null } = {}) {
  const rows = [];
  const accuracy = sideAccuracy(evalGraph, moves);
  if (accuracy) {
    rows.push({ key: "accuracy", label: "Accuracy", value: `White ${accuracy.white}% · Black ${accuracy.black}%` });
  }
  const swing = biggestSwing(evalGraph, moves);
  if (swing) rows.push({ key: "swing", label: "Biggest swing", value: `${swing.label} · −${swing.loss}%`, ref: swing });
  if (departure) rows.push({ key: "prep", label: "Left prep at", value: departure.label, ref: departure });
  const opening = openingFromHeaders(headers);
  if (opening) rows.push({ key: "opening", label: "Opening", value: opening });
  return rows;
}

// A fact that names a move shows it as a move link (move-text.js).
function factValueHtml({ value, ref }) {
  const move = ref?.move;
  const at = move?.fen_before && move.uci ? value.indexOf(ref.label) : -1;
  if (at < 0) return value;
  return html`${value.slice(0, at)}${moveTokenHtml(move.fen_before, [move.uci], 0, ref.label)}${value.slice(at + ref.label.length)}`;
}

// One grade bar per side: a segment per grade present, its glyph and count in
// the segment. Reuses the move-classification palette, so the bar and the move
// list never colour the same grade differently.
function classBarsHtml(moves) {
  const tally = { white: {}, black: {} };
  moves.forEach((move) => {
    const side = move.side === "black" ? "black" : "white";
    const group = CLASS_GROUP_OF[move.classification];
    if (!group) return;
    tally[side][group] = (tally[side][group] || 0) + 1;
  });
  const rowHtml = (side, label) => {
    const counts = tally[side];
    const total = CLASS_GROUPS.reduce((sum, g) => sum + (counts[g.key] || 0), 0);
    const segs = CLASS_GROUPS.filter((g) => counts[g.key] > 0).map(
      (g, i) =>
        html`<button class="cbar-seg seg-${g.key}" style="flex:${counts[g.key]};--i:${i}" data-side="${side}" data-group="${g.key}" title="${g.label}: ${counts[g.key]}" aria-label="${label} ${g.label}: ${counts[g.key]}"><span class="cbar-seg-n">${classBadgeSymbol(g.members[0])} ${counts[g.key]}</span></button>`,
    );
    const track = total ? segs : html`<span class="cbar-empty">no scored moves</span>`;
    return html`<div class="cbar-row"><span class="cbar-side">${label}</span><span class="cbar-track">${track}</span></div>`;
  };
  return html`<div class="class-bars">${rowHtml("white", "White")}${rowHtml("black", "Black")}</div>`;
}

// Write the whole report into `host`: the facts, then the bars, then — on a
// phone, where nothing else names the game — whose game it was. `onGrade` is the
// bar segment's jump; `reps` is the book to walk for the prep row.
export function renderReportBlock(host, { moves, evalGraph = [], headers = {}, reps = [], onGrade = () => {} }) {
  if (!host) return;
  if (!moves || !moves.length) {
    host.innerHTML = "";
    return;
  }
  const rows = buildReportFacts({ moves, evalGraph, headers, departure: prepDeparture(moves, reps) });
  const identity = reportIdentity(headers);
  host.innerHTML = html`${rows.length
    ? html`<dl class="rpt-facts">${rows.map(
        (row) => html`<div class="rpt-fact"><dt>${row.label}</dt><dd>${factValueHtml(row)}</dd></div>`,
      )}</dl>`
    : ""}${classBarsHtml(moves)}${identity ? html`<p class="rpt-identity">${identity}</p>` : ""}`;
  host.querySelectorAll(".cbar-seg").forEach((seg) => {
    seg.addEventListener("click", () => {
      onGrade(seg.dataset.side, seg.dataset.group);
      seg.blur();
    });
  });
}
