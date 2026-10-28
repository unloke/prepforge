// The Analyze game report: how each side played, the moves the game turned on,
// how each phase went and where the opening left the player's preparation.
//
// Everything is derived on the client from the payload the run already saved
// (moves with their grades and best moves, the eval graph) and the PGN's own
// headers. Accuracy is the same Lichess win-chance model the coach grades single
// moves with (explain.js), aggregated by volatility and harmonic mean.
// buildGameReport is pure; the rendered report links its error chart to the board.
import { Chess } from "chess.js";
import { html } from "../html.js";
import { evaluationToWin } from "../explain.js";
import { averageAccuracy } from "./analyze-accuracy.js";
import { bindErrorChart, errorChartHtml } from "./analyze-error-chart.js";
import { gamePhase } from "../coach/material.js";
import { setPref } from "../core/prefs.js";

const SIDES = ["white", "black"];
const START_FEN = new Chess().fen();

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
// complement when Black played. Missing engine scores stay unknown.
function whiteWin(point) {
  if (!point || (point.score_cp == null && point.mate_in == null)) return null;
  return evaluationToWin({ cp: point.score_cp, mate: point.mate_in });
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
function plies(evalGraph, moves = [], positionEvals = {}) {
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
    const initial = move?.fen_before === START_FEN ? { score_cp: 0 } : null;
    const prev = positionEvals[move?.fen_before] || pointsByPly.get(ply - 1) || initial;
    const flip = (w) => (w == null ? null : side === "black" ? 100 - w : w);
    const winBefore = flip(whiteWin(prev));
    const winAfter = flip(whiteWin(point));
    return { san: move?.san || point.san, ply, move, side, prev, point, winBefore, winAfter, loss: winBefore == null || winAfter == null ? null : Math.max(0, winBefore - winAfter), whiteBefore: whiteWin(prev), whiteAfter: whiteWin(point) };
  });
}

// A percentage per side, or null when the run graded too few plies for an
// average to mean anything (a typed PGN has no evals at all).
export function sideAccuracy(evalGraph, moves = [], positionEvals = {}) {
  const rows = plies(evalGraph, moves, positionEvals);
  if (rows.length < 2) return null;
  const { white, black } = accuracyOf(rows);
  return white == null || black == null ? null : { white, black };
}

const accuracyOf = (rows) => averageAccuracy(rows.map((r) => ({ ...r, winAfter: r.whiteAfter, winBefore: r.whiteBefore }))) || {};

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
        prepared: ply === departure?.ply ? departure.prepared : false,
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
export function phaseBreakdown(evalGraph, moves = [], positionEvals = {}) {
  const rows = plies(evalGraph, moves, positionEvals);
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
      ...accuracyOf(inPhase),
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
  let deepestWalk = null;
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
      deepestWalk = walk;
    }
  }
  if (deepest <= 0 || deepest >= moves.length) return null;
  const move = moves[deepest];
  const ply = Number(move.ply) || deepest + 1;
  const by = selfSide ? (sideOfMove(move, ply) === selfSide ? "you" : "opponent") : null;
  // `prepared`: the book had a move to play here, the one the coach would drill.
  const prepared = (deepestRep.kids?.get(deepestWalk)?.length || 0) > 0;
  return { ply, label: moveRef(move, ply), move, repName: deepestRep?.name || "", by, prepared };
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
export function buildGameReport({ moves = [], evalGraph = [], positionEvals = {}, headers = {}, reps = [], names = {}, selfSide = null } = {}) {
  if (!moves.length) return null;
  const accuracy = sideAccuracy(evalGraph, moves, positionEvals);
  const counts = gradeCounts(moves);
  return {
    from: Number(moves[0].ply),
    to: Number(moves.at(-1).ply),
    errors: plies(evalGraph, moves, positionEvals).filter((r) => ERRORS.has(reportGradeOf(r.move?.classification))).map((r) => ({ ply: r.ply, side: r.side, grade: reportGradeOf(r.move.classification), label: moveRef(r.move, r.ply), loss: r.loss })),
    sides: Object.fromEntries(
      SIDES.map((side) => [side, {
        name: known(side === "white" ? headers.White || names.white : headers.Black || names.black),
        accuracy: accuracy ? accuracy[side] : null,
        counts: counts[side],
      }]),
    ),
    moments: reviewMoments(moves, evalGraph, reps, selfSide),
    phases: phaseBreakdown(evalGraph, moves, positionEvals),
    opening: openingFromHeaders(headers),
    graded: moves.some((m) => reportGradeOf(m.classification)),
  };
}

const SIDE_WORD = { white: "White", black: "Black" };
const sideHead = (side) => html`<span class="rp-side-h" role="rowheader" title="${SIDE_WORD[side]}"><i class="rp-disc rp-${side}" aria-label="${SIDE_WORD[side]}"></i></span>`;

// Each grade's head in the counts table: the board badge's symbol on the
// grade's colour, so seven columns fit a phone without cutting the words
// ("Inacc…", "Brilli…"). Best and good share a badge on the board; here they
// are two columns, so best takes a star.
const GRADE_MARK = { brilliant: "!!", great: "!", best: "★", good: "✓", inaccuracy: "?!", mistake: "?", blunder: "??", missed: "×" }; // taste-skill-ignore: chess move annotation symbols, named in accessible column headers
const gradeBadge = (g) => html`<i class="rp-badge g-${g.key}" aria-hidden="true">${GRADE_MARK[g.key]}</i>`;

// Grade counts as a small table: a column per grade, a row per side. Every
// grade is a column, a zero printed as a zero; a count is a jump to that
// side's next move of the grade. The heads are symbols, named for a screen
// reader and in their tooltip; Key opens the same names as a legend.
function countsHtml(report, keyOpen = false) {
  const grades = REPORT_GRADES.filter((g) => g.key !== "missed" || SIDES.some((s) => report.sides[s].counts.missed));
  const cell = (side, g) => {
    const n = report.sides[side].counts[g.key] || 0;
    return n
      ? html`<button type="button" class="rp-n g-${g.key}" role="cell" data-side="${side}" data-grade="${g.key}" aria-label="${`${SIDE_WORD[side]} ${g.label}: ${n}, go to the next one`}">${n}</button>`
      : html`<span class="rp-n is-zero" role="cell">0</span>`;
  };
  return html`<section class="rp-sec rp-grades"><div class="rp-sec-head"><h3 class="rp-h">Move grades</h3><button type="button" class="rp-key-btn" data-toggle-key aria-expanded="${keyOpen ? "true" : "false"}" aria-controls="rp-key">Key</button></div><div class="rp-counts rp-grid" role="table" aria-label="Move grades"><span role="row" class="rp-tr"><span></span>${grades.map((g) => html`<span class="rp-col g-${g.key}" role="columnheader" aria-label="${g.label}" title="${g.label}">${gradeBadge(g)}</span>`)}</span>${SIDES.map(
    (side) => html`<span role="row" class="rp-tr">${sideHead(side)}${grades.map((g) => cell(side, g))}</span>`,
  )}</div><ul class="rp-key" id="rp-key"${keyOpen ? "" : " hidden"}>${grades.map((g) => html`<li>${gradeBadge(g)}<span>${g.label}</span></li>`)}</ul></section>`;
}

const LEFT_PREP = { you: "You left prep", opponent: "Opponent left prep" };

function prepHtml(report) {
  const departure = report.moments.find((m) => m.departure);
  return departure ? html`<p class="rp-sec rp-prep"><span>${LEFT_PREP[departure.by] || "Left prep"}</span><button type="button" class="rp-prep-jump" data-ply="${departure.ply}">${departure.label}</button><span class="rp-rep">${departure.repName}</span></p>` : "";
}

// Each side's accuracy by phase, the phases as columns; a phase's name goes
// to its first move.
function phasesHtml(report) {
  if (!report.phases.length || report.sides.white.accuracy == null) return "";
  const acc = (v) => (v == null ? "–" : v);
  return html`<section class="rp-sec rp-phases"><h3 class="rp-h">Accuracy by phase</h3><div class="rp-ph rp-grid" role="table" aria-label="Accuracy by phase"><span role="row" class="rp-tr"><span></span>${report.phases.map(
    (p) => html`<button type="button" class="rp-phase rp-col" role="columnheader" data-ply="${p.from}" title="${`Go to move ${p.moves.split("–")[0]}`}">${p.label}<span class="rp-span">${p.moves}</span></button>`,
  )}</span>${SIDES.map((side) => html`<span role="row" class="rp-tr">${sideHead(side)}${report.phases.map((p) => html`<span class="rp-n" role="cell">${acc(p[side])}</span>`)}</span>`)}</div></section>`;
}

function openingHtml(report) {
  return report.opening ? html`<p class="rp-sec rp-opening"><span class="rp-h">Opening</span> <span class="rp-opening-name">${report.opening}</span></p>` : "";
}

function compactErrors(counts) {
  const errors = REPORT_GRADES.filter((g) => ERRORS.has(g.key) && counts[g.key]);
  if (!errors.length) return html`<span class="rp-clean" title="No errors" aria-label="No errors"><span class="rp-error-total">0</span><span class="rp-error-word">No errors</span></span>`;
  const total = errors.reduce((sum, g) => sum + counts[g.key], 0);
  const worst = ["blunder", "mistake", "missed", "inaccuracy"].find((key) => counts[key]);
  const detail = errors.map((g) => `${counts[g.key]} ${g.label}`).join(", ");
  return html`<span class="rp-error-count g-${worst}" title="${detail}" aria-label="${`${total} errors: ${detail}`}"><i class="rp-glyph" aria-hidden="true">${GRADE_MARK[worst]}</i>${total}<span class="rp-error-word">${total === 1 ? "error" : "errors"}</span></span>`;
}

// The one line that says how each side played. Where the report heads the
// score sheet (the wide panel) it is the toggle that opens the rest, collapsed
// by default; where the report has a tab of its own the rest always shows.
function summaryHtml(report, open) {
  const side = (key) => {
    const s = report.sides[key];
    const name = s.name || (key === "white" ? "White" : "Black");
    return html`<span class="rp-side rp-${key}"><i class="rp-disc" aria-hidden="true"></i><span class="rp-name" title="${name}">${name}</span><b class="rp-acc" title="${`${SIDE_WORD[key]} accuracy`}">${s.accuracy == null ? "–" : `${s.accuracy}%`}</b><span class="rp-errs">${compactErrors(s.counts)}</span></span>`;
  };
  return html`<button type="button" class="rp-summary" data-toggle-summary aria-expanded="${open ? "true" : "false"}">${side("white")}${side("black")}<i class="rp-chev" aria-hidden="true"></i></button>`;
}

/** The report as markup (no listeners). `open` marks the summary's toggle; the body is always written. */
export function reportHtml(report, open = true, keyOpen = false) {
  if (!report) return "";
  if (!report.graded) return html`${prepHtml(report)}${openingHtml(report)}`;
  return html`${summaryHtml(report, open)}<div class="rp-body">${phasesHtml(report)}${errorChartHtml(report)}${openingHtml(report)}${prepHtml(report)}<details class="rp-detail"><summary>Move grades</summary>${countsHtml(report, keyOpen)}</details></div>`;
}

// Write the report into `host`. `onJump(ply)` goes to a move of the game;
// `onGrade(side, grade)` to the next move of that side by that side. The
// summary toggles the full report where CSS folds it; the host's `data-open`
// keeps that state across re-renders, and the report starts collapsed.
// Returns the built report (null when nothing was analysed), so the caller can
// read the same moments the block lists.
export function renderReportBlock(host, { moves, evalGraph = [], positionEvals = {}, headers = {}, reps = [], names = {}, selfSide = null, onJump = () => {}, onGrade = () => {} } = {}) {
  const report = buildGameReport({ moves: moves || [], evalGraph, positionEvals, headers, reps, names, selfSide });
  if (!host) return report;
  host.innerHTML = reportHtml(report, host.dataset.open === "true", host.dataset.key === "true");
  if (report?.graded) bindErrorChart(host, report, onJump);
  host.onclick = (event) => {
    if (event.target.closest?.(".move-ref")) return;
    const toggle = event.target.closest?.("[data-toggle-summary]");
    if (toggle) {
      host.dataset.open = host.dataset.open === "true" ? "false" : "true";
      toggle.setAttribute("aria-expanded", host.dataset.open);
      return;
    }
    const key = event.target.closest?.("[data-toggle-key]");
    if (key) {
      host.dataset.key = host.dataset.key === "true" ? "false" : "true";
      key.setAttribute("aria-expanded", host.dataset.key);
      host.querySelector("#rp-key")?.toggleAttribute("hidden", host.dataset.key !== "true");
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
  return report;
}

// A review that ran without Maia offers to run the game again with it. That
// runs the PGN box again, so it needs a game in the box.
export function paintFindGreat(analysis) {
  const btn = document.getElementById("analysis-find-great");
  if (!btn) return;
  btn.hidden = !(analysis?.quality?.maia?.available === false && document.getElementById("pgn-input")?.value.trim());
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    setPref("maiaAnalysis", true);
    document.getElementById("run-analysis")?.click();
  });
}
