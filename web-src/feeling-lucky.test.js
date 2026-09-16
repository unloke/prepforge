import { describe, expect, it, vi } from "vitest";

import { runFeelingLucky } from "./feeling-lucky.js";

const PICKED = {
  fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1",
  reason: "db-critical",
  phase: "middlegame",
  nodeId: null,
};

function harness({ picked = PICKED, failsWith = null } = {}) {
  const calls = { banner: [], session: [], status: [] };
  const luckyDbStartFn = vi.fn(async () => {
    if (failsWith) throw failsWith;
    return picked;
  });
  const deps = {
    luckyDbStartFn,
    storage: null,
    exclude: [],
    rating: 1500,
    onStatus: (msg) => calls.status.push(msg),
    setBanner: (...args) => calls.banner.push(args),
    startSession: async (args) => calls.session.push(args),
  };
  return { calls, deps, luckyDbStartFn };
}

describe("I'm Feeling Lucky entry", () => {
  it("goes straight to the database sampler with no personal lookup", async () => {
    const h = harness();
    const picked = await runFeelingLucky(h.deps);
    expect(h.luckyDbStartFn).toHaveBeenCalledTimes(1);
    const args = h.luckyDbStartFn.mock.calls[0][0];
    expect(args.engine).toBeNull();
    expect(args.maia).toBeNull();
    expect(picked).toEqual(PICKED);
    expect(h.calls.session).toHaveLength(1);
    expect(h.calls.session[0]).toMatchObject({
      fen: PICKED.fen,
      reason: "db-critical",
      phase: "middlegame",
    });
  });

  it("surfaces a link-Lichess hint on auth errors", async () => {
    const error = new Error("link your Lichess account to use the opening explorer");
    error.status = 400;
    const h = harness({ failsWith: error });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    expect(h.calls.status.join(" ")).toMatch(/link your lichess/i);
    const banner = h.calls.banner.at(-1).join(" ");
    expect(banner).toMatch(/Connect Lichess/);
  });

  it("asks for a retry on rate limits or empty results", async () => {
    const h = harness({ picked: null });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/fresh master game/);
  });

  it("uses the injected explorer client when provided", async () => {
    const h = harness();
    const fetchStats = vi.fn(async () => ({}));
    const ensureExplorer = vi.fn(async () => ({ fetchStats }));
    await runFeelingLucky({ ...h.deps, ensureExplorer });
    expect(ensureExplorer).toHaveBeenCalledTimes(1);
    const stats = h.luckyDbStartFn.mock.calls[0][0].fetchStats;
    await stats("masters", "fen", {});
    expect(fetchStats).toHaveBeenCalledTimes(1);
  });

  it("never references the personal workspace flow", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./feeling-lucky.js", import.meta.url), "utf8");
    expect(src).not.toContain("luckyStartFromWorkspace");
    expect(src).not.toMatch(/from ["']\.\/train-lucky\.js["']/);
    expect(src).toContain('from "./train-lucky-db.js"');
  });
});
