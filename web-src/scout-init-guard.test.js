import { describe, expect, it } from "vitest";

import { createScoutInitGuard } from "./scout-init-guard.js";

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