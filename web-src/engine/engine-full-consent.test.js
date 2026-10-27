import { describe, expect, it, vi } from "vitest";
import { createEngineProfileManager, CRASH_KEY, PROFILE_KEY } from "./engine-profile.js";
import { fixture, PROBE } from "./engine-profile.fixture.js";

// The full net is 94 MB. This device answers for it once (ask), the answer is
// remembered, and a step down to lite takes the bytes off the disk again.
const device = () => ({ hardwareConcurrency: 4, deviceMemory: 8 });
const reload = (f, options = {}) => createEngineProfileManager({ storage: () => f.storage, loadModule: f.loadModule,
  assetState: () => ({ phase: "idle" }), device, ...options });

describe("the full engine asks first", () => {
  it("never fetches the 94 MB net before the answer, and keep lite is remembered", async () => {
    const f = fixture({ consent: null, bigPhase: { value: "idle" } });
    // A first visit sets the device up without a byte of the full net: Detect
    // reserves its heap, learns it fits, and the question is what comes next.
    expect(await f.detectEngineProfile()).toMatchObject({ net: "lite", workers: 1 });
    expect(f.loadModule.mock.calls).toEqual([["lite"]]);
    expect(f.fullEngineChoice()).toBe("ask");
    // "Keep lite": still nothing fetched, and the question is not asked again.
    expect(await f.chooseFullEngine(false)).toMatchObject({ net: "lite", workers: 1 });
    expect(f.loadModule.mock.calls).toEqual([["lite"]]);
    expect(f.fullEngineChoice()).toBe("download");
    // Another visit reads the answer from this device's record.
    const again = reload(f);
    expect(again.fullEngineChoice()).toBe("download");
    again.engineStarted();
    await Promise.resolve();
    expect(f.loadModule.mock.calls).toEqual([["lite"]]);
  });

  it("fetches the full net on a yes, and starts it on a later visit", async () => {
    const bigPhase = { value: "idle" };
    const f = fixture({ consent: null, bigPhase });
    f.detectEngineProfile();
    await Promise.resolve();
    expect(f.loadModule).not.toHaveBeenCalledWith("big");
    expect(await f.chooseFullEngine(true)).toMatchObject({ net: "big", workers: 1, source: "user" });
    expect(f.loadModule).toHaveBeenCalledWith("big");
    // Yes is this device's answer: no question, and the net is prepared again.
    const again = reload(f);
    expect(again.engineProfile()).toMatchObject({ net: "big", source: "user" });
    expect(again.fullEngineChoice()).toBeNull();
    again.engineStarted();
    await vi.waitFor(() => expect(f.loadModule.mock.calls.filter(([net]) => net === "big")).toHaveLength(2));
  });

  it("never asks a device that cannot reserve the full net's heap", async () => {
    const Memory = class { constructor(d) { if (d.maximum === globalThis.__STOCKFISH__.big.maxHeapPages) throw new RangeError("no address space"); } };
    const f = fixture({ Memory });
    expect(await f.detectEngineProfile()).toMatchObject({ net: "lite", workers: 1 });
    expect(f.loadModule.mock.calls).toEqual([["lite"]]);
    expect(f.fullEngineChoice()).toBeNull();
  });

  it("steps down to lite by itself when the full net's heap kills the tab", () => {
    const f = fixture({ consent: null, bigPhase: { value: "ready" } });
    f.data.set(CRASH_KEY, JSON.stringify({ net: "big", workers: 1, probe: true }));
    const next = reload(f, { removeAsset: f.removeAsset });
    expect(next.engineProfile()).toMatchObject({ net: "lite", source: "fallback" });
    expect(f.removeAsset).toHaveBeenCalledWith("big");
    // The heap that killed the tab is not offered back: this device keeps lite.
    expect(next.fullEngineChoice()).toBeNull();
  });

  it("a crash in real use steps down but keeps the full net and lets Detect measure it again", async () => {
    const f = fixture({ bigPhase: { value: "ready" } });
    // The tab was killed in Analyze on big x1, with Maia and the page in memory too.
    f.data.set(CRASH_KEY, JSON.stringify({ net: "big", workers: 1, probe: false }));
    const next = reload(f, { probeId: PROBE, removeAsset: f.removeAsset, createEngine: f.createEngine, reserveMemory: f.reserveMemory,
      assetState: () => ({ phase: "ready" }), probeBudget: async () => () => {} });
    expect(next.engineProfile()).toMatchObject({ net: "lite", workers: 1 });
    expect(f.removeAsset).not.toHaveBeenCalled();
    expect(await next.detectEngineProfile()).toMatchObject({ net: "big", source: "detected" });
  });

  it("a crash in real use steps the profile down but keeps the workers Detect measured", async () => {
    const f = fixture({ throughput: (_net, n) => n });
    await f.detectEngineProfile();
    f.data.set(CRASH_KEY, JSON.stringify({ net: "big", workers: 3, probe: false }));
    const reloaded = createEngineProfileManager({ storage: () => f.storage, device, assetState: () => ({ phase: "ready" }) });
    expect([reloaded.engineProfile().workers, reloaded.engineWorkerChoices().big]).toEqual([2, 3]);
  });

  it("a step down deletes the bytes, and Settings fetches them again after a yes", async () => {
    const f = fixture({ bigPhase: { value: "ready" } });
    await f.detectEngineProfile();
    expect(f.engineProfile()).toMatchObject({ net: "big", workers: 3 });
    f.setEngineProfile({ net: "lite", workers: 1 });
    expect(f.removeAsset).toHaveBeenCalledWith("big");
    expect(f.fullEngineChoice()).toBe("download");
    f.loadModule.mockClear();
    // Bringing it back is the same yes, and it fetches the bytes again.
    expect(await f.chooseFullEngine(true)).toMatchObject({ net: "big", source: "user" });
    expect(f.loadModule).toHaveBeenCalledWith("big");
  });

  it("keeps the answer across a new engine build, and measures the net again", () => {
    const f = fixture({ consent: null });
    // Whether the net fits was measured on the last build, so a new one measures
    // again before it asks; the answer itself (a yes) survives the rebuild.
    expect(createEngineProfileManager({ storage: () => f.storage, probeId: "next", device }).fullEngineChoice()).toBeNull();
    f.data.set(PROFILE_KEY, JSON.stringify({ consent: "yes", probe: PROBE }));
    const answered = createEngineProfileManager({ storage: () => f.storage, probeId: "next", device });
    expect(answered.fullEngineChoice()).not.toBe("ask");
  });
});
