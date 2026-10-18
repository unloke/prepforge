// An opponent leaving the repertoire within the first couple of moves did not
// play a "novelty" — they chose a different opening. The bucket is shared with
// late novelties (filter, Add reply); this splits the detail copy only.
import { describe, expect, it } from "vitest";

import { isDifferentOpening } from "./replay.js";

const game = (ply) => ({ departure_reason: "opponent_unprepared_branch", departure_ply: ply });

describe("isDifferentOpening", () => {
  it("treats very early opponent departures as a different opening", () => {
    expect(isDifferentOpening(game(2))).toBe(true);
    expect(isDifferentOpening(game(4))).toBe(true);
  });

  it("keeps the novelty read for later deviations and other outcomes", () => {
    expect(isDifferentOpening(game(9))).toBe(false);
    expect(isDifferentOpening({ departure_reason: "user_left_preparation", departure_ply: 2 })).toBe(false);
    expect(isDifferentOpening({ departure_reason: "opponent_unprepared_branch" })).toBe(false);
  });
});
