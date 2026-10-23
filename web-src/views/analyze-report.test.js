// The Analyze game report (web-src/views/analyze-report.js): accuracy and grade
// counts per side, the key moments, the phases and the opening, all derived on
// the client from the payload the run already saved and the PGN's headers.
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import {
  buildGameReport,
  formatEval,
  gradeCounts,
  reviewMoments,
  openingFromHeaders,
  phaseBreakdown,
  prepDeparture,
  renderReportBlock,
  reportHtml,
  reviewState,
  sideAccuracy,
} from "./analyze-report.js";

// A game where Black throws the game away at move 2: the eval climbs from level
// to +2.40 for White, most of it on 2...Nc6. White plays the odd plies, Black the
// even ones.
const GRAPH = [
  { ply: 1, san: "e4", score_cp: 20, bounded_score_cp: 20 },
  { ply: 2, san: "e5", score_cp: 20, bounded_score_cp: 20 },
  { ply: 3, san: "Nf3", score_cp: 60, bounded_score_cp: 60 },
  { ply: 4, san: "Nc6", score_cp: 240, bounded_score_cp: 240 },
  { ply: 5, san: "Bb5", score_cp: 220, bounded_score_cp: 220 },
];

// The moves with their positions, as the saved payload carries them.
function movesOf(sans, grades = [], best = {}) {
  const chess = new Chess();
  return sans.map((san, i) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    return {
      ply: i + 1,
      move_number: Math.floor(i / 2) + 1,
      side: i % 2 ? "black" : "white",
      san: mv.san,
      uci: mv.lan,
      fen_before: fenBefore,
      fen_after: chess.fen(),
      classification: grades[i] ?? "best",
      best_move_uci: best[i + 1] || mv.lan,
    };
  });
}
const MOVES = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5"], ["best", "best", "excellent", "blunder", "good"], { 4: "d7d6" });
const FOUR = ["e2e4", "e7e5", "g1f3", "b8c6"];

describe("accuracy", () => {
  it("averages each side's win-chance fidelity, from its own side", () => {
    const accuracy = sideAccuracy(GRAPH, MOVES);
    expect(accuracy.white).toBeGreaterThanOrEqual(90);
    expect(accuracy.white).toBeGreaterThan(accuracy.black);
    expect(accuracy.black).toBeLessThan(80);
  });

  it("reports nothing for a game with no engine evals", () => {
    expect(sideAccuracy([], MOVES)).toBeNull();
    expect(sideAccuracy([{ ply: 1, san: "e4", score_cp: 20 }], MOVES)).toBeNull();
  });
});

describe("grade counts", () => {
  it("counts each side's grades, excellent with good and book with best", () => {
    const counts = gradeCounts([...MOVES, { ply: 6, side: "black", classification: "book" }, { ply: 7, side: "white", classification: "missed_win" }]);
    expect(counts.white).toEqual({ best: 1, good: 2, missed: 1 });
    expect(counts.black).toEqual({ best: 2, blunder: 1 });
  });
});

describe("key moments", () => {
  const SWINGS = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5"], ["brilliant", "best", "great", "blunder", "mistake"], { 4: "d7d6" });

  it("lists the brilliant, great, mistake and blunder moves in game order, with the better move", () => {
    const moments = reviewMoments(SWINGS, GRAPH);
    expect(moments.map((m) => [m.ply, m.grade])).toEqual([[1, "brilliant"], [3, "great"], [4, "blunder"], [5, "mistake"]]);
    expect(moments[2]).toMatchObject({ label: "2…Nc6", side: "black", before: "+0.6", after: "+2.4", departure: false });
    expect(moments[2].loss).toBeGreaterThan(10);
    expect(moments[2].best).toEqual({ san: "d6", uci: "d7d6" });
    expect(moments[0].loss).toBeNull();
  });

  it("adds the move that left the player's own preparation", () => {
    const moments = reviewMoments(MOVES, GRAPH, [repertoire(FOUR)]);
    expect(moments.map((m) => [m.ply, m.grade, m.departure])).toEqual([[4, "blunder", false], [5, null, true]]);
  });

  it("lists nothing when no move carries a marked grade", () => {
    expect(reviewMoments(movesOf(["e4", "e5"], ["best", "good"]), GRAPH)).toEqual([]);
  });

  it("keeps brilliant and great moves on both sides, and drops inaccuracies", () => {
    const moves = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], ["great", "brilliant", "inaccuracy", "inaccuracy", "great", "mistake"]);
    expect(reviewMoments(moves, GRAPH).map((m) => [m.ply, m.side, m.grade])).toEqual([
      [1, "white", "great"], [2, "black", "brilliant"], [5, "white", "great"], [6, "black", "mistake"],
    ]);
  });

  it("makes a departure that is also a blunder one stop, labelled by who left the book", () => {
    const moves = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5"], ["best", "best", "best", "best", "blunder"]);
    const moments = reviewMoments(moves, GRAPH, [repertoire(FOUR)], "white");
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ ply: 5, grade: "blunder", departure: true, by: "you", repName: "Italian" });
  });

  it("says whether the book had a move prepared at the departure", () => {
    expect(prepDeparture(MOVES, [repertoire(FOUR)], "white")).toMatchObject({ ply: 5, prepared: false });
    expect(prepDeparture(MOVES, [repertoire([...FOUR, "f1c4"])], "white")).toMatchObject({ ply: 5, prepared: true });
  });

  it("walks only the user's colour when the side is known, and gives the departure's side", () => {
    const white4 = repertoire(FOUR, "Italian", "white");
    const black4 = repertoire(FOUR, "Black book", "black");
    expect(prepDeparture(MOVES, [black4, white4], "white")).toMatchObject({ ply: 5, repName: "Italian", by: "you" });
    expect(prepDeparture(MOVES, [white4], "black")).toBeNull();
    expect(prepDeparture(MOVES, [white4], null)).toMatchObject({ ply: 5, by: null });
    expect(reviewMoments(MOVES, GRAPH, [black4], "white").map((m) => [m.ply, m.departure])).toEqual([[4, false]]);
  });

  it("reads a departure by the opponent as the opponent's move", () => {
    const moves = movesOf(["e4", "e5", "Bc4", "Nc6"]);
    const black = repertoire(["e2e4", "e7e5", "g1f3", "g8f6"], "Black book", "black");
    expect(prepDeparture(moves, [black], "black")).toMatchObject({ ply: 3, by: "opponent", repName: "Black book" });
  });

  it("states where a ply sits between and on the moments", () => {
    const list = reviewMoments(MOVES, GRAPH, [repertoire(["e2e4", "e7e5", "g1f3", "b8c6"])]);
    expect(reviewState(list, 0)).toMatchObject({ index: 0, count: 2, current: null, focus: list[0], prev: null, next: list[0] });
    expect(reviewState(list, 4)).toMatchObject({ index: 0, current: list[0], focus: list[0], prev: null, next: list[1] });
    expect(reviewState(list, 4).focus.ply).toBe(4);
    expect(reviewState(list, 7)).toMatchObject({ index: 1, current: null, focus: list[1], prev: list[1], next: null });
    expect(reviewState(list, 5).current).toBe(list[1]);
    expect(reviewState([], 3)).toEqual({ index: -1, count: 0, current: null, focus: null, prev: null, next: null });
  });

  it("reads a mate and a finished game as players do", () => {
    expect(formatEval({ mate_in: 3 })).toBe("#3");
    expect(formatEval({ mate_in: -2 })).toBe("#-2");
    expect(formatEval({ score_cp: 100000 })).toBe("1-0");
    expect(formatEval({ score_cp: -45 })).toBe("−0.5");
  });
});

describe("phases", () => {
  it("splits the game by phase, never going back, with each side's accuracy", () => {
    const phases = phaseBreakdown(GRAPH, MOVES);
    expect(phases.map((p) => p.key)).toEqual(["opening"]);
    expect(phases[0]).toMatchObject({ from: 1, to: 5, moves: "1–3" });
    expect(phases[0].white).toBeGreaterThan(phases[0].black);
    expect(phases[0].errors).toEqual({ white: 0, black: 1 });
  });
});

// The shape analyze-book.js caches: one child per (parent node, uci).
const repertoire = (ucis, name = "Italian", color = "white") => {
  const children = new Map();
  const kids = new Map();
  let walk = "n0";
  ucis.forEach((uci, i) => {
    const node = { id: `n${i + 1}`, san: uci };
    children.set(`${walk}|${uci}`, node);
    kids.set(walk, [node]);
    walk = `n${i + 1}`;
  });
  return { rootId: "n0", children, kids, name, color };
};

describe("opening and prep", () => {
  it("joins the opening's name and code, and drops what the PGN lacks", () => {
    expect(openingFromHeaders({ Opening: "Ruy Lopez", ECO: "C60" })).toBe("Ruy Lopez · C60");
    expect(openingFromHeaders({ ECO: "C60" })).toBe("C60");
    expect(openingFromHeaders({})).toBe("");
  });

  it("names the first mainline move no repertoire continues, and the repertoire", () => {
    const departure = prepDeparture(MOVES, [repertoire(["e2e4", "e7e5", "g1f3", "b8c6"])]);
    expect(departure).toMatchObject({ label: "3.Bb5", ply: 5, repName: "Italian" });
  });

  it("says nothing while the game is still in the book, or with no book at all", () => {
    expect(prepDeparture(MOVES, [repertoire(MOVES.map((m) => m.uci))])).toBeNull();
    expect(prepDeparture(MOVES, [])).toBeNull();
    expect(prepDeparture(MOVES, [repertoire([])])).toBeNull();
  });
});

describe("the report", () => {
  it("names each side from the PGN, or from the saved review's names", () => {
    const fromPgn = buildGameReport({ moves: MOVES, evalGraph: GRAPH, headers: { White: "me_user", Black: "opp_one", Result: "1-0" } });
    expect(fromPgn.sides.white.name).toBe("me_user");
    expect(fromPgn.result).toBe("1-0");
    const recalled = buildGameReport({ moves: MOVES, evalGraph: GRAPH, names: { white: "A", black: "B", result: "*" } });
    expect(recalled.sides.black.name).toBe("B");
    expect(recalled.result).toBe("");
    expect(buildGameReport({ moves: [] })).toBeNull();
  });

  it("writes accuracy, counts, moments, phases and opening, every move a link", () => {
    const html = String(reportHtml(buildGameReport({
      moves: MOVES,
      evalGraph: GRAPH,
      headers: { White: "me_user", Black: "opp_one", Result: "0-1", Opening: "Ruy Lopez", ECO: "C60" },
    })));
    const order = ["rp-moments", "rp-counts", "rp-phases", "rp-opening"].map((c) => html.indexOf(c));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The moment's own move sits inside the row's jump; its better move is a link.
    expect(html).toMatch(/<button type="button" class="km-go" data-ply="4"[^>]*>[\s\S]*?<span class="move-inline" data-mt="[^"]+\|b8c6" data-p="0">2…Nc6<\/span>/);
    expect(html).toMatch(/class="km-best">Best <span class="move-ref"[^>]*\|d7d6" data-p="0" aria-label="2…d6">d6<\/span>/);
    // A count is a control only when there is something to go to.
    expect(html).toMatch(/<button type="button" class="rp-n" data-side="black" data-grade="blunder"/);
    expect(html).toMatch(/<span class="rp-n is-zero">0<\/span>/);
    expect(html).toContain("Ruy Lopez · C60");
    // The result is written once, labelled; no repeated name header.
    expect(html.split("Result").length - 1).toBe(1);
    expect(html).not.toContain("rp-sides");
    // No standing explanation in the report.
    expect(html).not.toMatch(/how|means|click|tap/i);
  });

  it("shows a graded moment with its eval, and a departure with its side and book but no eval", () => {
    const moves = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5"], ["great", "best", "best", "best", "best"]);
    const html = String(reportHtml(buildGameReport({ moves, evalGraph: GRAPH, reps: [repertoire(FOUR)], selfSide: "white" })));
    expect(html).toMatch(/data-km-ply="1"[\s\S]*?<span class="km-eval">[^<]+<\/span><span class="km-loss"><\/span>/);
    expect(html).toMatch(/data-km-ply="5"[\s\S]*?<span class="km-kind">[\s\S]*?You left prep<\/span><span class="km-eval"><\/span>/);
    expect(html).toMatch(/data-km-ply="5"[\s\S]*?<span class="km-best">Italian<\/span>/);
    const opponent = String(reportHtml(buildGameReport({ moves, evalGraph: GRAPH, reps: [repertoire(FOUR, "Black", "black")], selfSide: "black" })));
    expect(opponent).toMatch(/data-km-ply="5"[\s\S]*?Opponent left prep/);
  });

  it("keeps a game whose only moment is the departure in the report", () => {
    const moves = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    const html = String(reportHtml(buildGameReport({ moves, evalGraph: GRAPH, reps: [repertoire(FOUR)], selfSide: "white" })));
    expect(html).toContain("rp-moments");
    expect(html).toContain("You left prep");
  });

  it("has no accuracy or counts for a typed PGN that was never graded", () => {
    const typed = MOVES.map((m) => ({ ...m, classification: null }));
    expect(String(reportHtml(buildGameReport({ moves: typed, evalGraph: [] })))).toBe("");
  });

  it("jumps to a moment's move and to the next move of a counted grade", () => {
    const calls = [];
    const host = { dataset: {}, set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; } };
    renderReportBlock(host, { moves: MOVES, evalGraph: GRAPH, onJump: (ply) => calls.push(["jump", ply]), onGrade: (side, grade) => calls.push(["grade", side, grade]) });
    const target = (attrs) => ({ closest: (sel) => (sel === ".move-ref" || sel === "[data-toggle-summary]" ? null : sel === "[data-grade]" ? (attrs.grade ? { dataset: attrs } : null) : attrs.ply ? { dataset: attrs } : null) });
    host.onclick({ target: target({ ply: "4" }) });
    host.onclick({ target: target({ side: "black", grade: "blunder" }) });
    expect(calls).toEqual([["jump", 4], ["grade", "black", "blunder"]]);
  });

  it("clears the block when there is nothing analysed", () => {
    const host = { dataset: {}, set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; } };
    renderReportBlock(host, { moves: [], evalGraph: [] });
    expect(host.innerHTML).toBe("");
  });
});

describe("the report's summary", () => {
  const headers = { White: "me_user", Black: "opp_one" };
  const fakeHost = () => ({ dataset: {}, set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; } });

  it("starts as one line that names both sides and their errors, and opens the full report", () => {
    const report = buildGameReport({ moves: MOVES, evalGraph: GRAPH, headers });
    const closed = String(reportHtml(report, false));
    expect(closed).toMatch(/<button type="button" class="rp-summary" data-toggle-summary aria-expanded="false">/);
    expect(closed).toContain("me_user");
    expect(closed).toContain("no errors");
    expect(closed).not.toContain("rp-counts");
    expect(String(reportHtml(report, true))).toMatch(/aria-expanded="true"[\s\S]*rp-counts/);

    const host = fakeHost();
    renderReportBlock(host, { moves: MOVES, evalGraph: GRAPH, headers });
    expect(host.innerHTML).not.toContain("rp-counts");
    host.onclick({ target: { closest: (sel) => (sel === "[data-toggle-summary]" ? {} : null) } });
    expect(host.dataset.open).toBe("true");
    expect(host.innerHTML).toContain("rp-counts");
    host.onclick({ target: { closest: (sel) => (sel === "[data-toggle-summary]" ? {} : null) } });
    expect(host.innerHTML).not.toContain("rp-counts");
  });

  it("keeps the open state when the block is written again", () => {
    const host = fakeHost();
    host.dataset.open = "true";
    renderReportBlock(host, { moves: MOVES, evalGraph: GRAPH, headers });
    expect(host.innerHTML).toContain("rp-counts");
  });
});
