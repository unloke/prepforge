import { describe, expect, it, vi } from "vitest";
import { retryTrainEntry, showTrainModuleLoadFailure, trainRouteMatches } from "./train-route-failure.js";
import { fakeDocument } from "./controllers/train-home.fixture.js";

describe("guarded Train route entry", () => {
  it("shows retryable failures only while Train is still active", async () => {
    let active = false;
    const failure = vi.fn();
    await retryTrainEntry(() => active, async () => { throw new Error("chunk failed"); }, failure);
    expect(failure).not.toHaveBeenCalled();
    active = true;
    await retryTrainEntry(() => active, async () => { throw new Error("chunk failed"); }, failure);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("does not enter Train when the retry starts after the user left", async () => {
    let active = true;
    let retry;
    const enter = vi.fn(async () => { throw new Error("chunk failed"); });
    const failure = vi.fn((error, again) => { retry = again; });
    await retryTrainEntry(() => active, enter, failure);
    expect(enter).toHaveBeenCalledTimes(1);
    active = false;
    await retry();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("lets the entry abort side effects after the user leaves mid-download", async () => {
    let active = true;
    let release;
    const entered = [];
    const attempt = retryTrainEntry(() => active, async (stillActive) => {
      await new Promise((done) => { release = done; });
      if (stillActive()) entered.push("open");
    }, vi.fn());
    active = false;
    release();
    await attempt;
    expect(entered).toEqual([]);
  });
  it("clears the module retry handler so a later listing Retry keeps its own action", async () => {
    vi.stubGlobal("document", fakeDocument());
    const retry = vi.fn(async () => {});
    showTrainModuleLoadFailure(new Error("chunk failed"), retry);
    const button = document.getElementById("train-due-retry");
    expect(typeof button.onclick).toBe("function");
    await button.onclick();
    expect(button.onclick).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("matches Train routes semantically rather than by query-string order", () => {
    vi.stubGlobal("window", { location: { href: "http://local.test/#/train?mode=smart&rep=r1" } });
    expect(trainRouteMatches({ view: "train", repertoireId: "r1", trainMode: "smart" })).toBe(true);
    expect(trainRouteMatches({ view: "train", repertoireId: "r2", trainMode: "smart" })).toBe(false);
    expect(trainRouteMatches({ view: "train", repertoireId: "r1", trainMode: null })).toBe(false);
  });
});
