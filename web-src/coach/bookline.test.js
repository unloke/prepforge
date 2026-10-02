import { describe, expect, it } from "vitest";
import { buildBookline } from "./bookline.js";

describe("bookline", () => {
  it("names the prepared move when the user leaves their prep", () => {
    expect(buildBookline({ kind: "user", san: "d5", repName: "Caro-Kann", expectedSan: "c6" })).toBe(
      "Off your prep: Caro-Kann plays c6 here.",
    );
  });

  it("names the gap when the opponent leaves the book", () => {
    expect(buildBookline({ kind: "opponent", san: "Nc6", repName: "Italian" })).toBe("Nc6 isn't in Italian yet.");
  });
});
