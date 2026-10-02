import { describe, it, expect } from "vitest";
import { typedSquare } from "./board-navigation.js";

describe("typedSquare (keyboard square selection)", () => {
  it("completes a square from a file letter then a rank digit", () => {
    const first = typedSquare(null, "e");
    expect(first).toEqual({ pending: "e", square: null, handled: true });
    expect(typedSquare(first.pending, "4")).toEqual({ pending: null, square: "e4", handled: true });
  });

  it("restarts on a new file letter and leaves Shift+letters (F flips) to the app", () => {
    expect(typedSquare("g", "c")).toEqual({ pending: "c", square: null, handled: true });
    expect(typedSquare(null, "F").handled).toBe(false);
  });

  it("leaves arrow keys and other keys to the app (move navigation)", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "9", "x"]) {
      expect(typedSquare("e", key).handled).toBe(false);
      expect(typedSquare("e", key).square).toBe(null);
    }
  });

  it("ignores a rank digit with no pending file", () => {
    expect(typedSquare(null, "4")).toEqual({ pending: null, square: null, handled: false });
  });
});
