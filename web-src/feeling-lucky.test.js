import { describe, expect, it, vi } from "vitest";

import { runFeelingLucky } from "./feeling-lucky.js";

const PICKED = {
  fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1",
  reason: "db-critical",
  phase: "middlegame",
  nodeId: null,
};

function harness({
  picked = PICKED,
  failsWith = null,
  titledPicked = null,
  titledFailsWith = null,
} = {}) {
  const calls = { banner: [], session: [], status: [] };
  const luckyDbStartFn = vi.fn(async () => {
    if (failsWith) throw failsWith;
    return picked;
  });
  const luckyTitledStartFn = vi.fn(async () => {
    if (titledFailsWith) throw titledFailsWith;
    if (titledPicked) return titledPicked;
    throw new Error("No sharp titled game found — try again");
  });
  const deps = {
    luckyDbStartFn,
    luckyTitledStartFn,
    storage: null,
    exclude: [],
    rating: 1500,
    onStatus: (msg) => calls.status.push(msg),
    setBanner: (...args) => calls.banner.push(args),
    startSession: async (args) => calls.session.push(args),
  };
  return { calls, deps, luckyDbStartFn, luckyTitledStartFn };
}

describe("I'm Feeling Lucky entry", () => {
  it("uses the dynamic live Lichess selector by default", async () => {
    const live = {
      ...PICKED,
      reason: "titled-game",
      source: "lichess-user-feed",
      gameId: "live1",
      white: "AlphaGM",
      black: "BetaIM",
      sourceUrl: "https://lichess.org/api/games/user/AlphaGM",
    };
    const h = harness({ picked: null, titledPicked: live });
    const ensureExplorer = vi.fn(async () => ({ fetchStats: vi.fn() }));
    const picked = await runFeelingLucky({ ...h.deps, ensureExplorer });
    expect(picked).toEqual(live);
    expect(h.luckyTitledStartFn).toHaveBeenCalledTimes(1);
    expect(h.luckyTitledStartFn.mock.calls[0][0].allowReferences).toBe(false);
    expect(h.luckyDbStartFn).not.toHaveBeenCalled();
    expect(ensureExplorer).not.toHaveBeenCalled();
    expect(h.calls.banner[0]).toEqual([
      "runin",
      "Finding a position…",
      "Discovering a fresh titled player on Lichess",
    ]);
  });

  it("passes live game metadata through to the Play session", async () => {
    const h = harness({
      picked: null,
      titledPicked: {
        ...PICKED,
        reason: "titled-game",
        source: "lichess-user-feed",
        gameId: "live1",
        white: "AlphaGM",
        black: "BetaIM",
        sourceUrl: "https://example.test/feed",
      },
    });
    await runFeelingLucky(h.deps);
    expect(h.calls.session[0]).toMatchObject({
      fen: PICKED.fen,
      reason: "titled-game",
      phase: "middlegame",
      gameId: "live1",
      white: "AlphaGM",
      black: "BetaIM",
      source: "lichess-user-feed",
    });
  });

  it("uses Masters/Explorer only as a lazy quality fallback", async () => {
    const h = harness({ picked: PICKED, titledFailsWith: new Error("No sharp titled game found — try again") });
    const ensureExplorer = vi.fn(async () => ({ fetchStats: vi.fn(async () => ({})) }));
    h.luckyDbStartFn.mockImplementationOnce(async ({ fetchStats }) => {
      await fetchStats("masters", PICKED.fen, {});
      return PICKED;
    });
    const picked = await runFeelingLucky({ ...h.deps, ensureExplorer });
    expect(picked).toEqual(PICKED);
    expect(h.luckyTitledStartFn).toHaveBeenCalledTimes(1);
    expect(h.luckyDbStartFn).toHaveBeenCalledTimes(1);
    expect(ensureExplorer).toHaveBeenCalledTimes(1);
  });

  it("does not hide live-feed transport failure behind the slow Masters path", async () => {
    const network = Object.assign(new Error("Lichess rate limit"), { status: 429 });
    const h = harness({ picked: PICKED, titledFailsWith: network });
    const ensureExplorer = vi.fn(async () => ({ fetchStats: vi.fn() }));
    const picked = await runFeelingLucky({ ...h.deps, ensureExplorer });
    expect(picked).toBeNull();
    expect(h.luckyDbStartFn).not.toHaveBeenCalled();
    expect(ensureExplorer).not.toHaveBeenCalled();
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/Database unavailable/);
  });

  it("reports Nothing sharp when live feed is empty and no Explorer provider exists", async () => {
    const h = harness({ picked: null });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/Nothing sharp/);
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/fresh Lichess games/);
  });

  it("keeps the old Masters-first seam available only when explicitly requested", async () => {
    const h = harness();
    const picked = await runFeelingLucky({ ...h.deps, preferDynamic: false });
    expect(h.luckyDbStartFn).toHaveBeenCalledTimes(1);
    const args = h.luckyDbStartFn.mock.calls[0][0];
    expect(args.engine).toBeNull();
    expect(args.maia).toBeNull();
    expect(picked).toEqual(PICKED);
    expect(h.luckyTitledStartFn).not.toHaveBeenCalled();
  });

  it("falls back from an explicit legacy Masters no-quality result to live games", async () => {
    const live = { ...PICKED, reason: "titled-game", source: "lichess-user-feed", gameId: "live1" };
    const h = harness({ picked: null, titledPicked: live });
    const picked = await runFeelingLucky({ ...h.deps, preferDynamic: false });
    expect(picked).toEqual(live);
    expect(h.luckyDbStartFn).toHaveBeenCalledTimes(1);
    expect(h.luckyTitledStartFn).toHaveBeenCalledTimes(1);
  });

  it("surfaces a Play-session start failure without relabeling it as data failure", async () => {
    const startSession = vi.fn(async () => false);
    const live = { ...PICKED, reason: "titled-game", source: "lichess-user-feed", gameId: "live1" };
    const h = harness({ picked: null, titledPicked: live });
    const picked = await runFeelingLucky({ ...h.deps, startSession });
    expect(picked).toBeNull();
    expect(h.calls.status.join(" ")).toMatch(/Could not start that position/);
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/Could not start that position/);
    expect(h.calls.banner.at(-1).join(" ")).not.toMatch(/Database unavailable|Nothing sharp/);
  });

  it("wires the app entry to the dynamic selector and Explorer fallback", async () => {
    const fs = await import("node:fs");
    const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
    const entry = app.slice(app.indexOf("async function onFeelingLucky"));
    expect(entry).toMatch(/preferDynamic:\s*true/);
    expect(entry).not.toMatch(/preferCurated:\s*true/);
    expect(entry).toMatch(/ensureExplorer:\s*ensurePlayExplorer/);
    expect(entry).toMatch(/luckyBusy/);
  });

  it("gates the app entry on sign-in before sampling", async () => {
    const fs = await import("node:fs");
    const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
    const entry = app.slice(app.indexOf("async function onFeelingLucky"));
    expect(entry).toMatch(/accountUsername/);
    expect(entry).toMatch(/openAuthModal/);
  });

  it("never references the personal workspace flow", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./feeling-lucky.js", import.meta.url), "utf8");
    expect(src).not.toContain("luckyStartFromWorkspace");
    expect(src).not.toMatch(/from ["']\.\/train-lucky\.js["']/);
    expect(src).toContain('from "./train-lucky-db.js"');
  });
});
