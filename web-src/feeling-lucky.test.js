import { describe, expect, it, vi } from "vitest";

import { runFeelingLucky } from "./feeling-lucky.js";

const PICKED = {
  fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1",
  reason: "db-critical",
  phase: "middlegame",
  nodeId: null,
};

function harness({ picked = PICKED, failsWith = null, titledPicked = null, titledFailsWith = null } = {}) {
  const calls = { banner: [], session: [], status: [] };
  const luckyDbStartFn = vi.fn(async () => {
    if (failsWith) throw failsWith;
    return picked;
  });
  // Default: titled fallback throws (offline) so legacy single-path tests
  // keep asserting the masters-only outcome. Fallback tests opt in.
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

  it("routes the unlinked account to titled games, not the link hint", async () => {
    // New product contract: the link hint lives in app.js copy ("Connect
    // Lichess … masters database"), while runFeelingLucky itself falls
    // through to the no-auth titled path so the click still plays.
    const titled = { ...PICKED, reason: "titled-game", gameId: "titled1" };
    const error = new Error("link your Lichess account to use the opening explorer");
    error.status = 400;
    const h = harness({ failsWith: error, titledPicked: titled });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toEqual(titled);
    expect(h.calls.session).toHaveLength(1);
  });

  it("asks for a retry when masters is empty and titled is offline", async () => {
    const h = harness({ picked: null });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    expect(h.calls.banner.at(-1).join(" ")).toMatch(/fresh master game/);
  });

  it("falls through to titled on the explorer cooldown shape", async () => {
    // Production 429 shape: ExplorerRateLimited message, no .status.
    const cooldown = new Error("Lichess explorer rate limit hit - cooling down");
    cooldown.name = "ExplorerRateLimited";
    const titled = { ...PICKED, reason: "titled-game", gameId: "titled1" };
    const h = harness({ failsWith: cooldown, titledPicked: titled });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toEqual(titled);
    expect(h.calls.session).toHaveLength(1);
  });

  it("falls back to titled games when the masters walk is empty", async () => {
    const titled = { ...PICKED, reason: "titled-game", gameId: "titled1" };
    const h = harness({ picked: null, titledPicked: titled });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toEqual(titled);
    expect(h.calls.session).toHaveLength(1);
    expect(h.calls.session[0]).toMatchObject({ reason: "titled-game" });
    expect(h.luckyTitledStartFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to titled games on the unlinked-token shape", async () => {
    const titled = { ...PICKED, reason: "titled-game", gameId: "titled1" };
    const error = new Error("link your Lichess account to use the opening explorer");
    error.status = 400;
    const h = harness({ failsWith: error, titledPicked: titled });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toEqual(titled);
    expect(h.calls.session).toHaveLength(1);
  });

  it("shows Nothing sharp when both paths are empty", async () => {
    const error = new Error("No sharp database game found — try again");
    const h = harness({ failsWith: error });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    const banner = h.calls.banner.at(-1).join(" ");
    expect(banner).toMatch(/Nothing sharp/);
    expect(banner).not.toMatch(/Database unavailable/);
    expect(h.calls.status.join(" ")).toMatch(/No sharp database game/);
  });

  it("surfaces Database unavailable when the titled path is throttled", async () => {
    const dbError = new Error("No sharp database game found — try again");
    const titledError = Object.assign(new Error("Lichess games rate limit - try again shortly"), {
      status: 429,
    });
    const h = harness({ failsWith: dbError, titledFailsWith: titledError });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    const banner = h.calls.banner.at(-1).join(" ");
    expect(banner).toMatch(/Database unavailable/);
    expect(banner).not.toMatch(/Nothing sharp/);
  });

  it("still aborts loudly on transport failures (no quiet titled mask)", async () => {
    const h = harness({
      failsWith: new Error("Explorer responded 502"),
      titledPicked: { ...PICKED, reason: "titled-game", gameId: "titled1" },
    });
    const picked = await runFeelingLucky(h.deps);
    expect(picked).toBeNull();
    expect(h.calls.session).toHaveLength(0);
    expect(h.luckyTitledStartFn).not.toHaveBeenCalled();
    const banner = h.calls.banner.at(-1).join(" ");
    expect(banner).toMatch(/Database unavailable/);
    expect(banner).not.toMatch(/Nothing sharp/);
  });

  it("surfaces the real message when the Play session fails to start", async () => {
    const startSession = vi.fn(async () => {
      throw new Error("Open a repertoire first");
    });
    const h = harness();
    const picked = await runFeelingLucky({ ...h.deps, startSession });
    expect(picked).toBeNull();
    expect(h.calls.status.join(" ")).toMatch(/Open a repertoire first/);
    const banner = h.calls.banner.at(-1).join(" ");
    expect(banner).toMatch(/Could not start that position/);
    expect(banner).not.toMatch(/Database unavailable|Nothing sharp/);
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

  it("wires the app entry to a defined explorer provider", async () => {
    const fs = await import("node:fs");
    const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
    expect(app).toMatch(/ensureExplorer:\s*ensurePlayExplorer/);
    expect(app).not.toMatch(/[^a-zA-Z]ensureExplorer,/);
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
