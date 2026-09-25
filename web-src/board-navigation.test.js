import { describe, it, expect } from "vitest";
import { squareInDirection } from "./board-navigation.js";

describe("squareInDirection (roving-focus geometry)", () => {
  it("moves in screen directions on a white board", () => {
    expect(squareInDirection("e2", "ArrowUp", "white")).toBe("e3");
    expect(squareInDirection("e2", "ArrowDown", "white")).toBe("e1");
    expect(squareInDirection("e2", "ArrowLeft", "white")).toBe("d2");
    expect(squareInDirection("e2", "ArrowRight", "white")).toBe("f2");
  });

  it("keeps left/right following the on-screen file strip on a flipped board", () => {
    // Black orientation renders h→a left-to-right, so ArrowLeft moves toward
    // the NEXT file letter and ArrowRight toward the previous one.
    expect(squareInDirection("e2", "ArrowLeft", "black")).toBe("f2");
    expect(squareInDirection("e2", "ArrowRight", "black")).toBe("d2");
  });

  it("inverts up/down on a flipped board to match what the eyes see", () => {
    // With ranks 1→8 drawn bottom-to-top... rather top-to-bottom? The flipped
    // grid lists rank 1 first (top row), so ArrowUp goes DOWN in rank numbers.
    expect(squareInDirection("e2", "ArrowUp", "black")).toBe("e1");
    expect(squareInDirection("e2", "ArrowDown", "black")).toBe("e3");
  });

  it("returns null at the board edges instead of wrapping", () => {
    expect(squareInDirection("a1", "ArrowLeft", "white")).toBe(null);
    expect(squareInDirection("h1", "ArrowRight", "white")).toBe(null);
    expect(squareInDirection("e8", "ArrowUp", "white")).toBe(null);
    expect(squareInDirection("e1", "ArrowDown", "white")).toBe(null);
    // Flipped edges mirror too.
    expect(squareInDirection("h1", "ArrowLeft", "black")).toBe(null);
    expect(squareInDirection("a8", "ArrowRight", "black")).toBe(null);
    expect(squareInDirection("e1", "ArrowUp", "black")).toBe(null);
    expect(squareInDirection("e8", "ArrowDown", "black")).toBe(null);
  });

  it("rejects malformed input", () => {
    expect(squareInDirection("", "ArrowUp", "white")).toBe(null);
    expect(squareInDirection("e9", "ArrowUp", "white")).toBe(null);
    expect(squareInDirection("i2", "ArrowUp", "white")).toBe(null);
    expect(squareInDirection("e2", "PageUp", "white")).toBe(null);
    expect(squareInDirection(null, "ArrowUp", "white")).toBe(null);
  });

  it("defaults to white orientation", () => {
    expect(squareInDirection("e2", "ArrowUp")).toBe("e3");
  });
});
