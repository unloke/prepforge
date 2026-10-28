import { expect, it } from "vitest";
import { averageAccuracy } from "./analyze-accuracy.js";
import { sideAccuracy } from "./analyze-report.js";
import { Chess } from "chess.js";

it("does not bury a game-losing move under a long sequence of easy moves", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ side: i % 2 ? "black" : "white", winBefore: i < 2 ? 50 : 2, winAfter: i < 1 ? 50 : 2 }));
  const accuracy = averageAccuracy(rows);
  expect(accuracy.white).toBe(100);
  // The loss here is Black's gain, hence no penalty for Black either.
  expect(accuracy.black).toBe(100);
  rows[1].side = "white";
  expect(averageAccuracy(rows).white).toBe(74);
});

it("uses the same scale for either colour and returns missing sides as null", () => {
  const white = averageAccuracy([{ side: "white", winBefore: 50, winAfter: 25 }]);
  const black = averageAccuracy([{ side: "black", winBefore: 50, winAfter: 75 }]);
  expect(white.white).toBe(black.black);
  expect(white.black).toBeNull();
  expect(white.white).toBe(33);
});

it("uses the searched starting position rather than assuming a level custom position", () => {
  const moves = [{ ply: 1, side: "white", fen_before: "custom" }, { ply: 2, side: "black" }];
  const graph = [{ ply: 1, score_cp: 500 }, { ply: 2, score_cp: 500 }];
  expect(sideAccuracy(graph, moves, { custom: { score_cp: 900 } }).white).toBeLessThan(100);
  expect(sideAccuracy(graph, moves)).toBeNull();
});

it("does not count missing engine scores as perfect moves", () => {
  const graph = [{ ply: 1, score_cp: null, bounded_score_cp: 0 }, { ply: 2, score_cp: 20 }];
  expect(sideAccuracy(graph, [{ ply: 1, fen_before: new Chess().fen() }])).toBeNull();
});
