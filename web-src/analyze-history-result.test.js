import { expect, it } from "vitest";
import { analysisHistoryResult } from "./analyze-orient.js";

it.each([
  ["1-0", "Me", "Opponent", "+", "Win"],
  ["0-1", "Me", "Opponent", "−", "Loss"],
  ["1-0", "Opponent", "me", "−", "Loss"],
  ["0-1", "Opponent", "ME", "+", "Win"],
  ["1/2-1/2", "Opponent", "Me", "=", "Draw"],
])("shows %s from the identified player's side", (result, white, black, mark, label) => {
  expect(analysisHistoryResult({ result, white, black }, [" Me "])).toMatchObject({ mark, label });
});

it("never guesses a player or a result", () => {
  expect(analysisHistoryResult({ result: "1-0", white: "A", black: "B" }, ["Me"]).mark).toBe("1-0");
  expect(analysisHistoryResult({ result: "1-0", white: "Me", black: "OtherSelf" }, ["Me", "OtherSelf"]).mark).toBe("1-0");
  expect(analysisHistoryResult({ result: "*", white: "Me" }, ["Me"]).mark).toBe("");
});
