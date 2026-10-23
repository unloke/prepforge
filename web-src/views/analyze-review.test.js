// The review bar's model (web-src/views/analyze-review.js): what its label shows,
// when it is hidden, and which action it offers on a stop where prep was left.
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";

import { reviewMoments } from "./analyze-report.js";
import { reviewBarModel } from "./analyze-review.js";

const GRAPH = [1, 2, 3, 4, 5].map((ply) => ({ ply, score_cp: 20 * ply, bounded_score_cp: 20 * ply }));

function movesOf(sans, grades) {
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
      best_move_uci: mv.lan,
    };
  });
}

const repertoire = (ucis, color = "white") => {
  const children = new Map();
  const kids = new Map();
  let walk = "n0";
  ucis.forEach((uci, i) => {
    const node = { id: `n${i + 1}`, san: uci };
    children.set(`${walk}|${uci}`, node);
    kids.set(walk, [node]);
    walk = `n${i + 1}`;
  });
  return { rootId: "n0", children, kids, name: "Italian", color };
};

const FOUR = ["e2e4", "e7e5", "g1f3", "b8c6"];
// The book goes on with 3.Bc4, so 3.Bb5 leaves a prepared move behind.
const GAME = movesOf(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], ["best", "best", "best", "blunder", "best", "best"]);
const LIST = reviewMoments(GAME, GRAPH, [repertoire([...FOUR, "f1c4"])], "white");
const SHOWN = { graded: true };

describe("review bar model", () => {
  it("is hidden with no moments, with no graded move, or while a run is going", () => {
    expect(reviewBarModel({ moments: [], ...SHOWN }).hidden).toBe(true);
    expect(reviewBarModel({ moments: LIST, graded: false }).hidden).toBe(true);
    expect(reviewBarModel({ moments: LIST, graded: true, running: true }).hidden).toBe(true);
  });

  it("labels the moment on the board, with its kind and its place in the list", () => {
    expect(reviewBarModel({ moments: LIST, ply: 4, ...SHOWN })).toMatchObject({
      hidden: false, label: "2…Nc6", grade: "blunder", kind: "Blunder", count: "1/2",
    });
    expect(reviewBarModel({ moments: LIST, ply: 5, ...SHOWN })).toMatchObject({ label: "3.Bb5", kind: "You left prep", grade: "none" });
  });

  it("shows the next moment between two, and the last one once it is passed", () => {
    expect(reviewBarModel({ moments: LIST, ply: 2, ...SHOWN })).toMatchObject({ label: "2…Nc6", count: "1/2", prevDisabled: true, nextDisabled: false });
    expect(reviewBarModel({ moments: LIST, ply: 9, ...SHOWN })).toMatchObject({ label: "3.Bb5", count: "2/2", prevDisabled: false, nextDisabled: true });
  });

  it("offers the coach's action only on a stop where prep was left, for a signed-in user", () => {
    expect(reviewBarModel({ moments: LIST, ply: 5, ...SHOWN, signedIn: true })).toMatchObject({ act: "train", actLabel: "Add to training" });
    expect(reviewBarModel({ moments: LIST, ply: 5, ...SHOWN, signedIn: false }).act).toBeNull();
    expect(reviewBarModel({ moments: LIST, ply: 4, ...SHOWN, signedIn: true }).act).toBeNull();
  });

  it("offers nothing on a departure the book had no move prepared for, as the coach says nothing there", () => {
    const list = reviewMoments(GAME, GRAPH, [repertoire(FOUR)], "white");
    expect(reviewBarModel({ moments: list, ply: 5, ...SHOWN, signedIn: true })).toMatchObject({ kind: "You left prep", act: null });
  });

  it("names the opponent's departure as the repertoire add", () => {
    const moves = movesOf(["e4", "e5", "Bc4", "Nc6"], ["best", "best", "best", "best"]);
    const black = repertoire(["e2e4", "e7e5", "g1f3"], "black");
    const list = reviewMoments(moves, GRAPH, [black], "black");
    expect(reviewBarModel({ moments: list, ply: 3, ...SHOWN, signedIn: true })).toMatchObject({ act: "build", actLabel: "Add to repertoire", kind: "Opponent left prep" });
  });

  it("offers Maia only when the saved review ran without it", () => {
    expect(reviewBarModel({ moments: LIST, ...SHOWN, maiaOff: true }).maia).toBe(true);
    expect(reviewBarModel({ moments: LIST, ...SHOWN }).maia).toBe(false);
  });
});
