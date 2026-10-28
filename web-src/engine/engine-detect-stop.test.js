import { describe, it, expect } from "vitest";
import { createEngineProfileManager, CRASH_KEY } from "./engine-profile.js";
import { fixture, PROBE } from "./engine-profile.fixture.js";

// Detect stopped by the user (Cancel, a reload, closing the tab) is not evidence
// about the device; only an OS kill is.
describe("stopping Detect", () => {
  const pageHide = persisted => Object.assign(new Event("pagehide"), { persisted });
  function paused(at_ = 1) {
    let release, reached;
    const at = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    return { at, release, prepare: (index) => { if (index === at_) { reached(); return gate; } } };
  }

  it("a reload or close during a step leaves no crash mark; the back/forward cache keeps it", async () => {
    const page = new EventTarget(), lifecycle = new EventTarget();
    page.visibilityState = "visible";
    const step = paused();
    const f = fixture({ page, lifecycle, prepare: step.prepare });
    const run = f.detectEngineProfile();
    await step.at; // big x1 holds its heap
    expect(JSON.parse(f.data.get(CRASH_KEY))).toMatchObject({ net: "big", workers: 1, probe: true });
    lifecycle.dispatchEvent(pageHide(true));
    expect(f.data.has(CRASH_KEY)).toBe(true);
    lifecycle.dispatchEvent(new Event("pageshow"));
    lifecycle.dispatchEvent(pageHide(false));
    expect(f.data.has(CRASH_KEY)).toBe(false);
    // The unloading page's own visibilitychange comes after pagehide in Chromium.
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(f.data.has(CRASH_KEY)).toBe(false);
    // The next load keeps the full net and Detects as a fresh device would.
    const reloaded = createEngineProfileManager({ storage: () => f.storage, probeId: PROBE, device: () => ({ hardwareConcurrency: 4, deviceMemory: 8 }),
      assetState: () => ({ phase: "ready" }), removeAsset: f.removeAsset });
    expect(reloaded.engineDetection()).toMatchObject({ detected: null, ceiling: null, consent: "yes", running: false });
    expect(f.removeAsset).not.toHaveBeenCalled();
    step.release();
    await run;
  });

  it("Cancel stops a Detect another caller started and keeps the last result", async () => {
    const step = paused(5); // the second Detect's big x1 (four engines ran in the first)
    const g = fixture({ prepare: step.prepare });
    expect(await g.detectEngineProfile()).toMatchObject({ net: "big", workers: 3 });
    const kept = g.engineMeasurements();
    const again = g.detectEngineProfile(); // e.g. Analyze's own start, no signal
    await step.at;
    expect(g.engineDetection().running).toBe(true);
    g.cancelEngineDetect();
    step.release();
    await expect(again).rejects.toMatchObject({ name: "AbortError" });
    expect(g.engineMeasurements()).toEqual(kept);
    expect(g.engineProfile()).toMatchObject({ net: "big", workers: 3, source: "detected" });
    expect(g.engines.every(e => e.closed)).toBe(true);
    expect(g.data.has(CRASH_KEY)).toBe(false);
    expect(g.engineSetupState().phase).toBe("idle");
    expect(kept.nodesPerSecond).toBeGreaterThan(0);
  });

  it("reports what Settings explains: the pick, the step that killed the tab, the device cap", () => {
    const f = fixture({ device: () => ({ hardwareConcurrency: 2, deviceMemory: 8 }) });
    f.data.set(CRASH_KEY, JSON.stringify({ net: "big", workers: 2, probe: true }));
    expect(f.engineDetection()).toEqual({ detected: { net: "big", workers: 1, source: "fallback" }, ceiling: 2, cap: 2, consent: "yes", running: false });
  });
});
