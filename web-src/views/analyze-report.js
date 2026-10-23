// The Analyze game report: how each side played, the moves the game turned on,
// how each phase went and where the opening left the player's preparation.
//
// Everything is derived on the client from the payload the run already saved
// (moves with their grades and best moves, the eval graph) and the PGN's own
// headers. Accuracy is the same Lichess win-chance model the coach grades single
// moves with (explain.js), so the report and the coach never disagree about what
// a move cost. buildGameReport is pure; renderReportBlock writes it into the
// view's host and turns every move it names into a move link.
import { Chess } from "chess.js";
import { html } from "../html.js";
import { classBadgeSymbol } from "../move-grades.js";
import { evaluationToWin, moveAccuracy } from "../explain.js";
import { moveTokenHtml } from "../move-text.js";
import { gamePhase } from "../coach/material.js";

const SIDES = ["white", "black"];

// The grades the report counts, in the order a player reads them. Book and
// forced moves count with the best ones: neither cost anything.
export const REPORT_GRADES = [
  { key: "brilliant", label: "Brilliant", members: ["brilliant"] },
  { key: "great", label: "Great", members: ["great"] },
  { key: "best", label: "Best", members: ["best", "book", "forced"] },
  { key: "good", label: "Good", members: ["excellent", "good"] },
  { key: "inaccuracy", label: "Inaccuracy", members: ["inaccuracy"] },
  { key: "mistake", label: "Mistake", members: ["mistake"] },
  { key: "blunder", label: "Blunder", members: ["blunder"] },
  { key: "missed", label: "Missed win", members: ["missed_win", "missed_tactic"] },
];
const GRADE_OF = Object.fromEntries(REPORT_GRADES.flatMap((g) => g.members.map((m) => [m, g.key])));
export const reportGradeOf = (classification) => GRADE_OF[String(classification || "").toLowerCase()] || null;
const ERRORS = new Set(["inaccuracy", "mistake", "blunder", "missed"]);

const PHASES = [
  { key: "opening", label: "Opening" },
  { key: "middlegame", label: "Middlegame" },
  { key: "endgame", label: "Endgame" },
];

// The evaluation of a point in the graph is White's, so the mover's is its
// complement when Black played. A missing point is a level position: the first
// ply has no predecessor in the graph.
function whiteWin(point) {
  if (!point) return 50;
  return evaluationToWin({ cp: point.score_cp ?? point.bounded_score_cp ?? 0, mate: point.mate_in ?? null });
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

// "+1.3" / "−0.4" / "#3" / "1-0": a graph point as players read it (White's view).
export function formatEval(point) {
  if (!point) return "0.0";
  if (point.mate_in != null && point.mate_in !== 0) return point.mate_in > 0 ? `#${point.mate_in}` : `#-${Math.abs(point.mate_in)}`;
  const cp = point.score_cp ?? point.bounded_score_cp ?? 0;
  if (Math.abs(cp) >= 10000) return cp > 0 ? "1-0" : "0-1";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(1)}`;
}

function sanOf(fen, uci) {
  if (!fen || !uci) return null;
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined })?.san || null;
  } catch (_) {
    return null;
  }
}

// One row per graded ply: who moved, the win chance before and after (mover's
// point of view), what the move cost and the points either side of it.
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
    const prev = pointsByPly.get(ply - 1) || null;
    const flip = (w) => (side === "black" ? 100 - w : w);
    const winBefore = flip(whiteWin(prev));
    const winAfter = flip(whiteWin(point));
    return { san: move?.san || point.san, ply, move, side, prev, point, winBefore, winAfter, loss: Math.max(0, winBefore - winAfter) };
  });
}

function average(rows) {
  if (!rows.length) return null;
  return Math.round(rows.reduce((sum, row) => sum + moveAccuracy(row.winBefore, row.winAfter), 0) / rows.length);
}

// A percentage per side, or null when the run graded too few plies for an
// average to mean anything (a typed PGN has no evals at all).
export function sideAccuracy(evalGraph, moves = []) {
  const rows = plies(evalGraph, moves);
  if (rows.length < 2) return null;
  const white = average(rows.filter((r) => r.side === "white"));
  const black = average(rows.filter((r) => r.side === "black"));
  return white == null || black == null ? null : { white, black };
}

// The grades a review lists, and the move that left the player's preparation.
const REVIEW_GRADES = new Set(["brilliant", "great", "mistake", "blunder"]);

/**
 * The moves a review lists, in game order: every brilliant, great, mistake and
 * blunder, and the move that left preparation (the user's or the opponent's).
 * Each carries its eval before and after, the win chance it cost (mistakes and
 * blunders), the better move the run found, and `by` ("you" | "opponent", or null
 * when the user's side is unknown). The report's list and the review bar both
 * read this one function, so they name the same moves.
 */
export function reviewMoments(moves = [], evalGraph = [], reps = [], selfSide = null) {
  const byPly = new Map(plies(evalGraph, moves).map((row) => [row.ply, row]));
  const departure = prepDeparture(moves, reps, selfSide);
  return moves
    .filter((move) => REVIEW_GRADES.has(reportGradeOf(move.classification)) || Number(move.ply) === departure?.ply)
    .map((move) => {
      const ply = Number(move.ply);
      const row = byPly.get(ply);
      const grade = reportGradeOf(move.classification);
      const marked = REVIEW_GRADES.has(grade) ? grade : null;
      const bestUci = move.best_move_uci && move.best_move_uci !== move.uci ? move.best_move_uci : null;
      const bestSan = bestUci ? sanOf(move.fen_before, bestUci) : null;
      return {
        ply,
        side: sideOfMove(move, ply),
        label: moveRef(move, ply),
        move,
        grade: marked,
        departure: ply === departure?.ply,
        by: ply === departure?.ply ? departure.by : null,
        repName: ply === departure?.ply ? departure.repName : "",
        before: formatEval(row?.prev),
        after: formatEval(row?.point),
        loss: row && (grade === "mistake" || grade === "blunder") ? Math.round(row.loss) : null,
        best: bestSan ? { san: bestSan, uci: bestUci } : null,
      };
    });
}

// Grade counts per side.
export function gradeCounts(moves = []) {
  const counts = { white: {}, black: {} };
  for (const move of moves) {
    const grade = reportGradeOf(move.classification);
    if (!grade) continue;
    const side = sideOfMove(move, Number(move.ply));
    counts[side][grade] = (counts[side][grade] || 0) + 1;
  }
  return counts;
}

// The game split by phase (the coach's material rule, never going back: a game
// that reached the endgame stays there), with each side's accuracy in it.
export function phaseBreakdown(evalGraph, moves = []) {
  const rows = plies(evalGraph, moves);
  if (!rows.length) return [];
  let at = 0;
  const byPhase = PHASES.map((p) => ({ ...p, rows: [] }));
  for (const row of rows) {
    const phase = row.move?.fen_before ? PHASES.findIndex((p) => p.key === gamePhase(row.move.fen_before)) : at;
    at = Math.max(at, phase);
    byPhase[at].rows.push(row);
  }
  return byPhase
    .filter((p) => p.rows.length)
    .map(({ key, label, rows: inPhase }) => ({
      key,
      label,
      from: inPhase[0].ply,
      to: inPhase[inPhase.length - 1].ply,
      moves: `${Math.ceil(inPhase[0].ply / 2)}–${Math.ceil(inPhase[inPhase.length - 1].ply / 2)}`,
      white: average(inPhase.filter((r) => r.side === "white")),
      black: average(inPhase.filter((r) => r.side === "black")),
      errors: Object.fromEntries(SIDES.map((side) => [side, inPhase.filter((r) => r.side === side && ERRORS.has(reportGradeOf(r.move?.classification))).length])),
    }));
}

// The opening's name and code, as the PGN records them.
export function openingFromHeaders(headers = {}) {
  const name = String(headers.Opening || "").trim();
  const eco = String(headers.ECO || "").trim();
  return [name, eco].filter(Boolean).join(" · ");
}

const known = (value) => (value && !/^[?*.\s]+$/.test(String(value)) ? String(value).trim() : "");

// The ply where the game left the player's own preparation, walked against the
// repertoire trees the Analyze coach already loads (analyze-book-state.js). The
// first mainline move no repertoire continues is the departure; a game still
// inside the book, or a player with no repertoire for that colour, reports
// nothing. A book that never enters the line is not a departure at move 1.
// With the user's side known, only that colour's repertoires are walked; `by`
// says whose move left the book, and is null when the side is unknown.
export function prepDeparture(moves = [], reps = [], selfSide = null) {
  const pool = selfSide ? reps.filter((rep) => rep.color === selfSide) : reps;
  if (!moves.length || !pool.length) return null;
  let deepest = -1;
  let deepestRep = null;
  for (const rep of pool) {
    let walk = rep.rootId;
    let matched = 0;
    for (const move of moves) {
      const child = rep.children.get(`${walk}|${move.uci}`);
      if (!child) break;
      walk = child.id;
      matched += 1;
    }
    if (matched > deepest) {
      deepest = matched;
      deepestRep = rep;
    }
  }
  if (deepest <= 0 || deepest >= moves.length) return null;
  const move = moves[deepest];
  const ply = Number(move.ply) || deepest + 1;
  const by = selfSide ? (sideOfMove(move, ply) === selfSide ? "you" : "opponent") : null;
  return { ply, label: moveRef(move, ply), move, repName: deepestRep?.name || "", by };
}

/**
 * Where a ply sits in the review: the moment on it (`current`), the ones either
 * side (`prev`, `next`), and the one the bar's label shows (`focus`: the current
 * moment, else the next, else the last one passed). `index` is focus's position
 * in the list, -1 when there is none.
 */
export function reviewState(moments = [], ply = 0) {
  const current = moments.find((m) => m.ply === ply) || null;
  const next = moments.find((m) => m.ply > ply) || null;
  const prev = [...moments].reverse().find((m) => m.ply < ply) || null;
  const focus = current ?? next ?? prev;
  return { index: focus ? moments.indexOf(focus) : -1, count: moments.length, current, focus, prev, next };
}

/**
 * The whole report as data: per side (name, accuracy, grade counts), key
 * moments, phases, the opening and the prep departure. Null when nothing was
 * analysed.
 */
export function buildGameReport({ moves = [], evalGraph = [], headers = {}, reps = [], names = {}, selfSide = null } = {}) {
  if (!moves.length) return null;
  const accuracy = sideAccuracy(evalGraph, moves);
  const counts = gradeCounts(moves);
  return {
    sides: Object.fromEntries(
      SIDES.map((side) => [side, {
        name: known(side === "white" ? headers.White || names.white : headers.Black || names.black),
        accuracy: accuracy ? accuracy[side] : null,
        counts: counts[side],
      }]),
    ),
    result: known(headers.Result || names.result),
    moments: reviewMoments(moves, evalGraph, reps, selfSide),
    phases: phaseBreakdown(evalGraph, moves),
    opening: openingFromHeaders(headers),
    graded: moves.some((m) => reportGradeOf(m.classification)),
  };
}

// A move the report names, as a move link: a control of its own, or (inside the
// row's own button) a hover peek.
function moveLink(move, label, opts) {
  return move?.fen_before && move.uci ? moveTokenHtml(move.fen_before, [move.uci], 0, label, opts) : label;
}

// The accuracy row heads the grade table: each side's figure in its own column.
function accuracyRowHtml(report) {
  const cell = (side) => {
    const acc = report.sides[side].accuracy;
    return html`<span class="rp-n rp-acc-n"><i class="rp-disc" aria-hidden="true"></i>${acc == null ? "–" : `${acc}%`}</span>`;
  };
  return html`<div class="rp-row rp-acc-row" role="row">${cell("white")}<span class="rp-grade" role="rowheader">Accuracy</span>${cell("black")}</div>`;
}

// The game's result, once, labelled.
function resultHtml(report) {
  return report.result ? html`<p class="rp-result"><span>Result</span> ${report.result}</p>` : "";
}

function countsHtml(report) {
  const rows = REPORT_GRADES.filter((g) => g.key !== "missed" || SIDES.some((s) => report.sides[s].counts.missed));
  const cell = (side, g) => {
    const n = report.sides[side].counts[g.key] || 0;
    return n
      ? html`<button type="button" class="rp-n" data-side="${side}" data-grade="${g.key}" aria-label="${`${side === "white" ? "White" : "Black"} ${g.label}: ${n}, go to the next one`}">${n}</button>`
      : html`<span class="rp-n is-zero">0</span>`;
  };
  return html`<div class="rp-counts" role="table" aria-label="Move grades">${accuracyRowHtml(report)}${rows.map(
    (g) => html`<div class="rp-row g-${g.key}" role="row">${cell("white", g)}<span class="rp-grade" role="rowheader"><i class="rp-glyph" aria-hidden="true">${classBadgeSymbol(g.members[0]) || ""}</i>${g.label}</span>${cell("black", g)}</div>`,
  )}</div>`;
}

const KIND_WORD = { brilliant: "Brilliant", great: "Great", mistake: "Mistake", blunder: "Blunder" };

// One row per review move: the move (a jump to it), its kind, the eval it moved
// and the win chance it cost, and the better move as a link on the same line.
function momentsHtml(report) {
  if (!report.moments.length) return "";
  return html`<section class="rp-sec rp-moments"><h3 class="rp-h">Key moments</h3><ol class="rp-km">${report.moments.map(
    (m) => html`<li class="km g-${m.grade || "none"}" data-km-ply="${m.ply}"><button type="button" class="km-go" data-ply="${m.ply}" title="Go to this move"><i class="km-disc km-${m.side}" aria-hidden="true"></i><span class="km-move">${moveLink(m.move, m.label, { focusable: false })}</span><span class="km-kind"><i class="rp-glyph" aria-hidden="true">${m.grade ? classBadgeSymbol(m.move?.classification) : ""}</i>${[m.grade && KIND_WORD[m.grade], m.departure && "Left prep"].filter(Boolean).join(" · ")}</span><span class="km-eval">${m.before} → ${m.after}</span><span class="km-loss">${m.loss == null ? "" : `−${m.loss}%`}</span></button>${m.best ? html`<span class="km-best">Best ${moveTokenHtml(m.move.fen_before, [m.best.uci], 0, m.best.san, { label: `${m.label.replace(/[^.…]+$/, "")}${m.best.san}` })}</span>` : ""}</li>`,
  )}</ol></section>`;
}

function phasesHtml(report) {
  if (!report.phases.length || report.sides.white.accuracy == null) return "";
  const acc = (v) => (v == null ? "–" : v);
  return html`<section class="rp-sec rp-phases"><h3 class="rp-h">Phases</h3><div class="rp-ph" role="table" aria-label="Accuracy by phase">${report.phases.map(
    (p) => html`<div class="rp-row" role="row"><span class="rp-n" role="cell">${acc(p.white)}</span><button type="button" class="rp-phase" role="rowheader" data-ply="${p.from}" title="${`Go to move ${p.moves.split("–")[0]}`}">${p.label}<span class="rp-span">${p.moves}</span></button><span class="rp-n" role="cell">${acc(p.black)}</span></div>`,
  )}</div></section>`;
}

function openingHtml(report) {
  return report.opening ? html`<section class="rp-sec rp-opening"><h3 class="rp-h">Opening</h3><p class="rp-opening-name">${report.opening}</p></section>` : "";
}

// The errors a side made, in words: "2 blunders, 1 mistake" or "no errors".
const errorsText = (counts) => {
  const part = (n, word) => (n ? `${n} ${word}${n > 1 ? "s" : ""}` : "");
  return [part(counts.blunder || 0, "blunder"), part(counts.mistake || 0, "mistake")].filter(Boolean).join(", ") || "no errors";
};

// The one line that says how each side played. It is the report's toggle:
// collapsed by default, it opens the full report beneath it.
function summaryHtml(report, open) {
  const side = (key) => {
    const s = report.sides[key];
    const name = s.name || (key === "white" ? "White" : "Black");
    return html`<span class="rp-side rp-${key}"><i class="rp-disc" aria-hidden="true"></i><span class="rp-name">${name}</span><b class="rp-acc">${s.accuracy == null ? "–" : `${s.accuracy}%`}</b><span class="rp-errs">${errorsText(s.counts)}</span></span>`;
  };
  return html`<button type="button" class="rp-summary" data-toggle-summary aria-expanded="${open ? "true" : "false"}">${side("white")}${side("black")}<i class="rp-chev" aria-hidden="true"></i></button>`;
}

/** The report as markup (no listeners). `open` shows the full report under the summary line. */
export function reportHtml(report, open = true) {
  if (!report) return "";
  const full = html`${momentsHtml(report)}${report.graded ? html`${countsHtml(report)}${resultHtml(report)}` : ""}${phasesHtml(report)}${openingHtml(report)}`;
  return report.graded ? html`${summaryHtml(report, open)}${open ? full : ""}` : full;
}

// Write the report into `host`. `onJump(ply)` goes to a move of the game;
// `onGrade(side, grade)` to the next move of that side by that side. The
// summary toggles the full report; the host's `data-open` keeps that state
// across re-renders, and the report starts collapsed.
export function renderReportBlock(host, { moves, evalGraph = [], headers = {}, reps = [], names = {}, selfSide = null, onJump = () => {}, onGrade = () => {} } = {}) {
  if (!host) return;
  const report = buildGameReport({ moves: moves || [], evalGraph, headers, reps, names, selfSide });
  const draw = () => {
    host.innerHTML = reportHtml(report, host.dataset.open === "true");
  };
  draw();
  host.onclick = (event) => {
    if (event.target.closest?.(".move-ref")) return;
    if (event.target.closest?.("[data-toggle-summary]")) {
      host.dataset.open = host.dataset.open === "true" ? "false" : "true";
      draw();
      host.querySelector?.("[data-toggle-summary]")?.focus();
      return;
    }
    const grade = event.target.closest?.("[data-grade]");
    if (grade) {
      onGrade(grade.dataset.side, grade.dataset.grade);
      return;
    }
    const jump = event.target.closest?.("[data-ply]");
    if (jump) onJump(Number(jump.dataset.ply));
  };
}
