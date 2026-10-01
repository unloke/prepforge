import { expect, it } from "vitest";
import { personaTags } from "./scout-stats.js";
import { moverWinChanceAfter } from "./coach/features.js";

it("checking castling still counts as castling for either colour", () => {
  for (const color of ["white", "black"]) {
    const sans = color === "white" ? ["O-O+", "e5"] : ["e4", "O-O-O#"];
    const games = Array.from({ length: 8 }, () => ({ color, score: 1, sans, ucis: [] }));
    expect(personaTags(games, color).castling.side).toBe(color === "white" ? "kingside" : "queenside");
  }
});

it("a piece move to d4 cannot stand in for the London pawn setup", () => {
  const games = Array.from({ length: 8 }, () => ({ color: "white", score: 1,
    sans: ["Nd4", "e5", "Bf4", "Nc6", "e3", "Nf6"], ucis: [] }));
  expect(personaTags(games, "white").systemSetup.detected).toBe(false);
});

it("browser terminal mate zero respects its signed White score", () => {
  expect(moverWinChanceAfter({ cp: 100000, mate: 0 }, "white")).toBeGreaterThan(0.97);
  expect(moverWinChanceAfter({ cp: -100000, mate: 0 }, "white")).toBeLessThan(0.03);
});
