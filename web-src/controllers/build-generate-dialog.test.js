import { describe, expect, it } from "vitest";
import { generateFieldError, readGenerateInt } from "./build-generate-dialog.js";

describe("Build Generate numeric validation", () => {
  it("accepts exact integer boundaries without changing them", () => {
    for (const [min, max] of [[1, 10], [1, 50], [600, 2600], [1, 30]]) {
      expect(readGenerateInt(String(min), min, max)).toBe(min);
      expect(readGenerateInt(String(max), min, max)).toBe(max);
      for (const value of [min - 1, max + 1, min + 0.5, "", " ", "no", Infinity]) {
        expect(() => readGenerateInt(value, min, max)).toThrow("Invalid Generate value");
      }
    }
  });

  it("provides short field errors for missing, malformed, range and step failures", () => {
    const input = (validity, step = "1") => ({ validity, min: "1", max: "10", step });
    expect(generateFieldError(input({ valueMissing: true }))).toBe("Enter a number.");
    expect(generateFieldError(input({ badInput: true }))).toBe("Enter a number.");
    expect(generateFieldError(input({ rangeUnderflow: true }))).toBe("Use 1–10.");
    expect(generateFieldError(input({ rangeOverflow: true }))).toBe("Use 1–10.");
    expect(generateFieldError(input({ stepMismatch: true }))).toBe("Use a whole number.");
    expect(generateFieldError(input({ stepMismatch: true }, "50"))).toBe("Use steps of 50.");
    expect(generateFieldError(input({}))).toBe("");
  });
});
