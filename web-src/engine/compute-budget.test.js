import { describe, expect, it } from "vitest";
import { createComputeBudget } from "./compute-budget.js";

describe("app-wide Stockfish allocation", () => {
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
