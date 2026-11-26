import { describe, expect, it, vi } from "vitest";

import { ExplorerRateLimited, explorerPositionFen, explorerUrl } from "./explorer.js";
import { fetchExplorerReads, isRateLimitedExplorerError } from "./scout-explorer.js";

const FEN_A = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_B = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const stats = { totalGames: 5000, moves: [{ uci: "c7c5", san: "c5", share: 0.4, total: 2000 }] };
const probe = (fen) => ({ fen, parentUcis: ["e2e4"], parentSans: ["e4"], moveUci: "c7c5", moveSan: "c5",
  opponentShare: 0.5, opponentGames: 6, opponentScorePct: 50, ply: 2 });

describe("explorer reads", () => {
  it("reads the probe positions side by side", async () => {
    const resolvers = [];
    const fetchStats = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = fetchExplorerReads({ fetchStats, positions: [probe(FEN_A), probe(FEN_B), probe(FEN_A)] });
    await Promise.resolve();
    // Both distinct positions were asked for before either answered.
    expect(fetchStats).toHaveBeenCalledTimes(2);
    resolvers.forEach((resolve) => resolve(stats));
    const out = await pending;
    expect(out.available).toBe(true);
    expect(out.mastersByFen.size).toBe(2);
  });

  it("waits out a rate limit once, then reads again", async () => {
    const fetchStats = vi.fn()
      .mockRejectedValueOnce(new ExplorerRateLimited(60_000))
      .mockResolvedValueOnce(stats);
    const wait = vi.fn(async () => {});
    const out = await fetchExplorerReads({ fetchStats, positions: [probe(FEN_A)], wait });
    expect(wait).toHaveBeenCalledWith(60_000, expect.any(Function));
    expect(fetchStats).toHaveBeenCalledTimes(2);
    expect(out.available).toBe(true);
  });

  it("says it was rate-limited when the one retry is limited too", async () => {
    const fetchStats = vi.fn(async () => { throw new ExplorerRateLimited(30_000); });
    const out = await fetchExplorerReads({ fetchStats, positions: [probe(FEN_A)], wait: async () => {} });
    expect(fetchStats).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ available: false, reason: "rate-limited", retryInMs: 30_000 });
    expect(isRateLimitedExplorerError(new ExplorerRateLimited(5))).toBe(true);
    expect(isRateLimitedExplorerError(new Error("Explorer responded 503"))).toBe(false);
  });

  it("stops waiting when the run is cancelled, and does not retry other failures", async () => {
    let cancelled = false;
    const limited = vi.fn(async () => { throw new ExplorerRateLimited(60_000); });
    const wait = vi.fn(async () => { cancelled = true; });
    const out = await fetchExplorerReads({ fetchStats: limited, positions: [probe(FEN_A)], wait,
      shouldCancel: () => cancelled });
    expect(out.reason).toBe("cancelled");
    expect(limited).toHaveBeenCalledTimes(1);
    const down = vi.fn(async () => { throw new Error("Explorer responded 503"); });
    expect((await fetchExplorerReads({ fetchStats: down, positions: [probe(FEN_A)], wait })).reason)
      .toBe("masters-unavailable");
    expect(down).toHaveBeenCalledTimes(1);
  });
});

describe("explorer cache keys", () => {
  it("ignore the move counters of a position", () => {
    const later = FEN_A.replace(/ 0 1$/, " 3 17");
    expect(explorerUrl("masters", later)).toBe(explorerUrl("masters", FEN_A));
    expect(explorerPositionFen(FEN_A.split(" ").slice(0, 4).join(" "))).toBe(FEN_A);
    expect(explorerPositionFen("not a fen")).toBe("not a fen");
  });
});
