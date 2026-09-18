import { describe, expect, it, vi } from "vitest";

import {
  fetchLichessProfile,
  lichessProfileUrl,
  normalizeLichessProfile,
  selectLichessRating,
} from "./lichess-profile.js";

describe("lichess profile contract", () => {
  it("encodes the username at the provider boundary", () => {
    expect(lichessProfileUrl("A/B player")).toBe(
      "https://lichess.org/api/user/A%2FB%20player",
    );
  });

  it("selects the most-played established rating and clamps it", () => {
    expect(
      selectLichessRating({
        bullet: { rating: 3100, games: 2 },
        blitz: { rating: 2750, games: 80 },
        rapid: { rating: 900, games: 120 },
        classical: { rating: 1800, games: 40, prov: true },
      }),
    ).toEqual({ rating: 900, games: 120, perf: "rapid" });
    expect(selectLichessRating({ blitz: { rating: 3200, games: 1 } })).toEqual({
      rating: 2600,
      games: 1,
      perf: "blitz",
    });
  });

  it("normalizes a raw provider response into the app contract", () => {
    expect(
      normalizeLichessProfile(
        { id: "alice", username: "Alice", perfs: { blitz: { rating: 1700, games: 10 } } },
        "fallback",
      ),
    ).toEqual({ username: "Alice", maiaRating: 1700, ratingGames: 10, ratingPerf: "blitz" });
  });

  it("fails closed when optional profile fields are missing", () => {
    expect(normalizeLichessProfile({ id: "alice" })).toEqual({
      username: "alice",
      maiaRating: null,
      ratingGames: 0,
      ratingPerf: null,
    });
    expect(normalizeLichessProfile(null, "fallback")).toEqual({
      username: "fallback",
      maiaRating: null,
      ratingGames: 0,
      ratingPerf: null,
    });
  });

  it("rejects HTTP errors, including rate limiting, with the provider status", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }));
    await expect(fetchLichessProfile("alice", { fetchImpl })).rejects.toMatchObject({
      status: 429,
      message: "Lichess profile responded 429",
    });
  });

  it("rejects malformed provider JSON without exposing raw fields", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad JSON");
      },
    }));
    await expect(fetchLichessProfile("alice", { fetchImpl })).rejects.toMatchObject({
      message: "Lichess profile response was not valid JSON",
    });
  });
});
