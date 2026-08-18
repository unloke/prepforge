import { describe, expect, it } from "vitest";

import { createScoutInitGuard, scoutStateCarryover } from "./scout-init-guard.js";

describe("createScoutInitGuard", () => {
  it("blocks a second tryBegin while initialization is in progress", () => {
    const guard = createScoutInitGuard();
    const first = guard.tryBegin();
    expect(first).toBe(1);
    expect(guard.isInitializing).toBe(true);
    expect(guard.tryBegin()).toBeNull();
    guard.finish(first);
    expect(guard.isInitializing).toBe(false);
    expect(guard.tryBegin()).toBe(2);
  });

  it("invalidates stale init tokens after reset", () => {
    const guard = createScoutInitGuard();
    const stale = guard.tryBegin();
    guard.invalidate();
    expect(guard.isCurrent(stale)).toBe(false);
    expect(guard.isInitializing).toBe(false);
    const fresh = guard.tryBegin();
    expect(fresh).toBeGreaterThan(stale);
    expect(guard.isCurrent(fresh)).toBe(true);
  });

  it("drops a slow init completion after invalidate so only the latest generation streams", () => {
    const guard = createScoutInitGuard();
    const stale = guard.tryBegin();
    guard.invalidate();
    const fresh = guard.tryBegin();
    expect(guard.isCurrent(stale)).toBe(false);
    expect(guard.isCurrent(fresh)).toBe(true);
    guard.finish(stale);
    expect(guard.isInitializing).toBe(true);
    guard.finish(fresh);
    expect(guard.isInitializing).toBe(false);
  });

  it("only the latest generation remains current after invalidate", () => {
    const guard = createScoutInitGuard();
    const a = guard.tryBegin();
    guard.invalidate();
    const b = guard.tryBegin();
    expect(guard.isCurrent(a)).toBe(false);
    expect(guard.isCurrent(b)).toBe(true);
    guard.finish(b);
    expect(guard.isInitializing).toBe(false);
  });
});

describe("scoutStateCarryover", () => {
  it("drops deep-scan and explorer from a previous same-username session", () => {
    const prev = {
      username: "rival",
      activeSpeed: "blitz",
      ecoCache: new Map([["k", "Sicilian"]]),
      maiaResults: new Map([["f", { maiaScorePct: 40 }]]),
      maiaCache: new Map([["c", 1]]),
      maiaEnrichState: "ready",
      prefilterCache: new Map([["fen", { score_cp: 20 }]]),
      engineByColor: { white: { scanRecords: [{ gameId: "old" }] } },
      explorerByColor: { white: { mastersByFen: new Map() } },
    };
    const carry = scoutStateCarryover(prev, "rival");
    expect(carry.activeSpeed).toBe("blitz");
    expect(carry.ecoCache).toBe(prev.ecoCache);
    expect(carry.maiaResults).toBe(prev.maiaResults);
    expect(carry.prefilterCache).toBe(prev.prefilterCache);
    expect(carry.engineByColor).toEqual({});
    expect(carry.explorerByColor).toEqual({});
  });

  it("starts clean when the username changes", () => {
    const prev = {
      username: "old",
      activeSpeed: "rapid",
      ecoCache: new Map([["k", "x"]]),
      maiaResults: new Map([["f", 1]]),
      engineByColor: { white: {} },
    };
    const carry = scoutStateCarryover(prev, "new");
    expect(carry.activeSpeed).toBe("all");
    expect(carry.ecoCache.size).toBe(0);
    expect(carry.maiaResults.size).toBe(0);
    expect(carry.engineByColor).toEqual({});
  });
});