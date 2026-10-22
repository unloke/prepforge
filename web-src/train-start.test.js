// A Start 400 that only means "nothing to train" is not a fault.
import { describe, expect, it } from "vitest";

import { isNothingToTrainError } from "./train-start.js";

describe("isNothingToTrainError", () => {
  it("recognizes every server message that means the start had no cards", () => {
    for (const message of [
      "no active repertoires to train",
      "repertoire has no trainable moves yet",
      "repertoires have no trainable moves yet",
      "repertoire has no trainable lines yet",
    ]) {
      expect(isNothingToTrainError(Object.assign(new Error(message), { status: 400 }))).toBe(true);
    }
  });

  it("leaves real failures and non-400s on the generic path", () => {
    expect(isNothingToTrainError(Object.assign(new Error("database is down"), { status: 500 }))).toBe(false);
    expect(isNothingToTrainError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isNothingToTrainError(null)).toBe(false);
  });
});
