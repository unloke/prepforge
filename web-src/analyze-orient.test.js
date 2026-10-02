import { describe, expect, it } from "vitest";
import { isReviewedMove, pgnPlayers, selfSide } from "./analyze-orient.js";

describe("selfSide", () => {
  it("picks the side that matches a linked identity, case-insensitively", () => {
    expect(selfSide("shutnik10", "Anonymousub", ["anonymousub"])).toBe("black");
    expect(selfSide("Anonymousub", "shutnik10", ["anonymousub"])).toBe("white");
  });

  it("matches any of several linked identities", () => {
    expect(selfSide("rival", "alt_account", ["main", "alt_account"])).toBe("black");
  });

  it("leaves the board alone when neither or both sides are Self", () => {
    expect(selfSide("a", "b", ["c"])).toBeNull();
    expect(selfSide("me", "me", ["me"])).toBeNull();
    expect(selfSide("", "", ["me"])).toBeNull();
    expect(selfSide("a", "b", [])).toBeNull();
  });
});

describe("pgnPlayers", () => {
  it("reads the White and Black tags", () => {
    const pgn = '[Event "Rated blitz"]\n[White "shutnik10"]\n[Black "Anonymousub"]\n\n1. Nf3 c5 *';
    expect(pgnPlayers(pgn)).toEqual({ white: "shutnik10", black: "Anonymousub" });
  });

  it("returns empty names for bare movetext", () => {
    expect(pgnPlayers("1. e4 e5 *")).toEqual({ white: "", black: "" });
  });
});

describe("isReviewedMove (Engine review)", () => {
  it("grades only the user's own mainline moves on a game they played as Black", () => {
    // UX walkthrough P1-6: the user played Black; 14. a3 was the opponent's move.
    expect(isReviewedMove({ mover: "white", selfSide: "black", mainline: true })).toBe(false);
    expect(isReviewedMove({ mover: "black", selfSide: "black", mainline: true })).toBe(true);
  });

  it("reviews every move when Self is unknown or the move is a free variation", () => {
    expect(isReviewedMove({ mover: "white", selfSide: null, mainline: true })).toBe(true);
    expect(isReviewedMove({ mover: "white", selfSide: "black", mainline: false })).toBe(true);
  });
});
