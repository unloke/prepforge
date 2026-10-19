import { describe, expect, it, vi } from "vitest";
import { createComputeBudget } from "./compute-budget.js";

describe("app-wide Stockfish allocation", () => {
  it("pauses live engines during a game batch without an extra memory slot", async () => {
    const budget = createComputeBudget({ limit: 2, backgroundLimit: 2 });
    const releaseLive = await budget.acquire({ interactive: true, reclaim: () => releaseLive() });
    const end = budget.beginBatch();
    expect(budget.snapshot().used).toBe(0);
    const a = await budget.acquire({ batch: true });
    const b = await budget.acquire({ batch: true });
    let resumed = false;
    const live = budget.acquire({ interactive: true }).then(release => { resumed = true; return release; });
    a(); b();
    expect(resumed).toBe(false);
    end();
    (await live)();
    expect(budget.snapshot().used).toBe(0);
  });
  it("yields the idle probe immediately to foreground allocation without reclaiming foreground engines", async () => {
    let idle;
    const budget = createComputeBudget({ scheduleIdle: fn => { idle = fn; return 1; } });
    const onDemand = vi.fn();
    const probing = budget.acquireProbe({ onDemand });
    idle();
    const endProbe = await probing;
    budget.configure(1);
    const reclaim = vi.fn();
    const release = await budget.acquire({ interactive: true, reclaim });
    expect(onDemand).toHaveBeenCalledTimes(1);
    expect(reclaim).not.toHaveBeenCalled();
    release(); endProbe();
    expect(budget.snapshot()).toMatchObject({ used: 0, limit: 1, backgroundLimit: 1 });
  });

  it("waits across all batches and Maia gaps for a session boundary, then an idle window", async () => {
    let idle;
    const budget = createComputeBudget({ scheduleIdle: fn => { idle = fn; return 1; } });
    const endSession = budget.beginSession();
    const probing = budget.acquireProbe({ onDemand: vi.fn() });
    const endBatch = budget.beginBatch();
    const release = await budget.acquire({ batch: true });
    release(); endBatch();
    expect(idle).toBeUndefined();
    const endFollowup = budget.beginBatch(); endFollowup();
    expect(idle).toBeUndefined();
    endSession();
    idle();
    (await probing)();
  });

  it("never reclaims a busy worker for detection, and reclaims only its idle registration", async () => {
    let idle;
    const budget = createComputeBudget({ scheduleIdle: fn => { idle = fn; return 1; } });
    const reclaim = vi.fn();
    const release = await budget.acquire({ reclaim });
    const probing = budget.acquireProbe({ onDemand: vi.fn() });
    expect(reclaim).not.toHaveBeenCalled();
    expect(idle).toBeUndefined();
    budget.registerIdle(release);
    idle();
    (await probing)();
  });
  it("reserves interactive capacity across unrelated background consumers", async () => {
    const budget = createComputeBudget();
    const releases = await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);
    let backgroundStarted = false;
    const waiting = budget.acquire().then((release) => { backgroundStarted = true; return release; });
    const interactive = await budget.acquire({ interactive: true });
    expect(budget.snapshot()).toMatchObject({ used: 4, background: 3, queued: 1 });
    expect(backgroundStarted).toBe(false);
    interactive();
    expect(backgroundStarted).toBe(false);
    releases[0]();
    const last = await waiting;
    releases.forEach((release) => release());
    last(); last();
    expect(budget.snapshot().used).toBe(0);
  });

  it("reclaims warm idle workers immediately when another consumer needs capacity", async () => {
    const budget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
    const release = await budget.acquire();
    let reclaimed = 0;
    const unregister = budget.registerIdle(() => { reclaimed++; release(); });
    const next = await budget.acquire();
    expect(reclaimed).toBe(1);
    expect(budget.snapshot()).toMatchObject({ used: 1, queued: 0 });
    unregister();
    next();
    expect(budget.snapshot().used).toBe(0);
  });

  it("lets interactive requests overtake queued background work and cancel independently", async () => {
    const budget = createComputeBudget({ limit: 1, backgroundLimit: 1 });
    const first = await budget.acquire();
    const controller = new AbortController();
    const cancelled = budget.acquire({ signal: controller.signal }).catch((error) => error.name);
    const order = [];
    const background = budget.acquire().then((release) => { order.push("background"); return release; });
    const interactive = budget.acquire({ interactive: true }).then((release) => { order.push("interactive"); return release; });
    controller.abort();
    expect(await cancelled).toBe("AbortError");
    first();
    const release = await interactive;
    expect(order).toEqual(["interactive"]);
    release();
    (await background)();
    expect(order).toEqual(["interactive", "background"]);
    expect(budget.snapshot()).toMatchObject({ used: 0, queued: 0 });
  });
});
