// The Analyze report's facts (web-src/views/analyze-report.js). Before this the
// report was two grade bars and a handoff button: it said how each side's moves
// were graded but nothing about the game itself. These are the four facts a
// player reads first — how accurately each side played, the move the game turned
// on, where the game left their own preparation, and the opening it came from —
// all derived from the payload the run already saved and the PGN's own headers.
import { describe, expect, it } from "vitest";

import {
  biggestSwing,
  buildReportFacts,
  openingFromHeaders,
  prepDeparture,
  reportIdentity,
  renderReportBlock,
  sideAccuracy,
} from "./analyze-report.js";

// A game where Black throws the game away at move 2: the eval climbs from level
// to +2.20 for White, most of it on 2...Nc6. White plays the odd plies, Black the
// even ones.
const GRAPH = [
  { ply: 1, san: "e4", score_cp: 20, bounded_score_cp: 20 },
  { ply: 2, san: "e5", score_cp: 20, bounded_score_cp: 20 },
  { ply: 3, san: "Nf3", score_cp: 60, bounded_score_cp: 60 },
  { ply: 4, san: "Nc6", score_cp: 240, bounded_score_cp: 240 },
  { ply: 5, san: "Bb5", score_cp: 220, bounded_score_cp: 220 },
];
const MOVES = [
  { ply: 1, move_number: 1, side: "white", san: "e4", uci: "e2e4" },
  { ply: 2, move_number: 1, side: "black", san: "e5", uci: "e7e5" },
  { ply: 3, move_number: 2, side: "white", san: "Nf3", uci: "g1f3" },
  { ply: 4, move_number: 2, side: "black", san: "Nc6", uci: "b8c6" },
  { ply: 5, move_number: 3, side: "white", san: "Bb5", uci: "f1b5" },
];

describe("report accuracy", () => {
  it("averages each side's win-chance fidelity, from its own side", () => {
    const accuracy = sideAccuracy(GRAPH, MOVES);
    expect(accuracy).not.toBeNull();
    // White never gave anything away; Black's 2...Nc6 cost real win chance, and
    // the same curve the coach grades single moves with charges him for it.
    expect(accuracy.white).toBeGreaterThanOrEqual(90);
    expect(accuracy.white).toBeGreaterThan(accuracy.black);
    expect(accuracy.black).toBeLessThan(80);
  });

  it("reports nothing for a game with no engine evals", () => {
    expect(sideAccuracy([], MOVES)).toBeNull();
    expect(sideAccuracy([{ ply: 1, san: "e4", score_cp: 20 }], MOVES)).toBeNull();
  });
});

describe("report swing", () => {
  it("names the move that lost the most win chance, and how much", () => {
    const swing = biggestSwing(GRAPH, MOVES);
    expect(swing.label).toBe("2…Nc6");
    expect(swing.side).toBe("black");
    expect(swing.loss).toBeGreaterThan(10);
  });

  it("stays quiet on a game that never left level", () => {
    const flat = MOVES.map((m) => ({ ply: m.ply, san: m.san, score_cp: 0 }));
    expect(biggestSwing(flat, MOVES)).toBeNull();
  });
});

describe("report opening and identity", () => {
  it("joins the opening's name and code, and drops what the PGN lacks", () => {
    expect(openingFromHeaders({ Opening: "Ruy Lopez", ECO: "C60" })).toBe("Ruy Lopez · C60");
    expect(openingFromHeaders({ Opening: "Ruy Lopez" })).toBe("Ruy Lopez");
    expect(openingFromHeaders({ ECO: "C60" })).toBe("C60");
    expect(openingFromHeaders({})).toBe("");
  });

  it("names the players and the result, and nothing when the PGN has neither", () => {
    expect(reportIdentity({ White: "me_user", Black: "opp_one", Result: "1-0" })).toBe(
      "me_user vs opp_one · 1-0",
    );
    expect(reportIdentity({ White: "me_user" })).toBe("me_user vs ?");
    expect(reportIdentity({})).toBe("");
    // A PGN's empty result tag is a placeholder, not a result.
    expect(reportIdentity({ White: "a", Black: "b", Result: "*" })).toBe("a vs b");
  });
});

describe("where the game left the player's preparation", () => {
  // The shape analyze-book.js caches: one child per (parent node, uci).
  const repertoire = (ucis, rootId = "n0") => {
    const children = new Map();
    let walk = rootId;
    ucis.forEach((uci, i) => {
      children.set(`${walk}|${uci}`, { id: `n${i + 1}` });
      walk = `n${i + 1}`;
    });
    return { rootId, children };
  };

  it("names the first mainline move no repertoire continues", () => {
    // The book runs e4 e5 Nf3 Nc6; 3.Bb5 is the first move it does not have.
    const departure = prepDeparture(MOVES, [repertoire(["e2e4", "e7e5", "g1f3", "b8c6"])]);
    expect(departure.label).toBe("3.Bb5");
    expect(departure.ply).toBe(5);
  });

  it("says nothing while the game is still in the book, or with no book at all", () => {
    expect(prepDeparture(MOVES, [repertoire(MOVES.map((m) => m.uci))])).toBeNull();
    expect(prepDeparture(MOVES, [])).toBeNull();
    // A book that never enters the line is not a departure at ply 1: the player
    // was never in it.
    expect(prepDeparture(MOVES, [repertoire([])])).toBeNull();
  });
});

describe("the report's rows", () => {
  it("leads with accuracy and leaves out every row the game cannot fill", () => {
    const rows = buildReportFacts({ moves: MOVES, evalGraph: GRAPH, headers: {} });
    expect(rows.map((r) => r.key)).toEqual(["accuracy", "swing"]);
    expect(rows[0].label).toBe("Accuracy");
    expect(rows[0].value).toMatch(/^White \d+% · Black \d+%$/);
  });

  it("adds the prep and opening rows when the game has them", () => {
    const rows = buildReportFacts({
      moves: MOVES,
      evalGraph: GRAPH,
      headers: { Opening: "Ruy Lopez", ECO: "C60" },
      departure: { label: "3.Bb5", ply: 5 },
    });
    expect(rows.map((r) => r.key)).toEqual(["accuracy", "swing", "prep", "opening"]);
    expect(rows.find((r) => r.key === "prep")).toEqual({ key: "prep", label: "Left prep at", value: "3.Bb5" });
  });

  it("has nothing to say about a typed PGN that was never analysed", () => {
    expect(buildReportFacts({ moves: MOVES, evalGraph: [], headers: {} })).toEqual([]);
  });
});

// The view writes the block into #analysis-summary. Before this, that host was
// only ever a pair of grade bars: the report said how each side's moves graded
// and nothing about the game.
describe("the report block the view writes", () => {
  const host = () => {
    return {
      querySelectorAll: () => [],
      set innerHTML(value) { this._html = String(value); },
      get innerHTML() { return this._html ?? ""; },
    };
  };

  it("puts the facts above the grade bars and the game's name below them", () => {
    const el = host();
    const grades = [];
    renderReportBlock(el, {
      moves: MOVES,
      evalGraph: GRAPH,
      headers: { White: "me_user", Black: "opp_one", Result: "1-0", Opening: "Ruy Lopez", ECO: "C60" },
      reps: [],
      onGrade: (side, group) => grades.push([side, group]),
    });
    const markup = el.innerHTML;
    const facts = markup.indexOf("rpt-facts");
    const bars = markup.indexOf("class-bars");
    const identity = markup.indexOf("rpt-identity");
    expect(facts).toBeGreaterThan(-1);
    expect(bars).toBeGreaterThan(facts);
    expect(identity).toBeGreaterThan(bars);
    for (const label of ["Accuracy", "Biggest swing", "Opening"]) expect(markup).toContain(label);
    expect(markup).toContain("me_user vs opp_one · 1-0");
  });

  it("clears the block when there is nothing analysed", () => {
    const el = host();
    renderReportBlock(el, { moves: [], evalGraph: [] });
    expect(el.innerHTML).toBe("");
  });
});
