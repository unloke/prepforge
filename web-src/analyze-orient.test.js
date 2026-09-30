import { describe, expect, it } from "vitest";
import { pgnPlayers, selfSide } from "./analyze-orient.js";

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
