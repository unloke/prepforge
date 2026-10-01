// UX walkthrough 2026-09-30 P3-8: an opponent leaving the repertoire on their very first
// move was badged "Opponent novelty @ Ply 2" — it's a different opening, not a novelty.
import { describe, expect, it } from "vitest";

import { isDifferentOpening } from "./replay.js";

const game = (ply) => ({ departure_reason: "opponent_unprepared_branch", departure_ply: ply });

describe("isDifferentOpening", () => {
  it("labels very early opponent departures as a different opening", () => {
    expect(isDifferentOpening(game(2))).toBe(true);
    expect(isDifferentOpening(game(4))).toBe(true);
  });

  it("keeps the novelty read for later deviations and other outcomes", () => {
    expect(isDifferentOpening(game(9))).toBe(false);
    expect(isDifferentOpening({ departure_reason: "user_left_preparation", departure_ply: 2 })).toBe(false);
    expect(isDifferentOpening({ departure_reason: "opponent_unprepared_branch" })).toBe(false);
  });
});
