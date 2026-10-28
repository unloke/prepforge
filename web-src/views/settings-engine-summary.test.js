import { describe, it, expect } from "vitest";
import { engineSummary, phaseLabel, speedLabel, disabledReason } from "./settings-engine-summary.js";

const idle = { phase: "ready" };
const det = (net, workers, extra = {}) => ({ detected: { net, workers, source: "detected" }, ceiling: null, cap: 3, consent: "yes", ...extra });
const scaling = (big, lite = [400000]) => ({ scaling: { lite, big }, nodesPerSecond: big.at(-1) });

describe("Engine card summary", () => {
  it("names the setup and the speed Detect measured for exactly that step", () => {
    const s = engineSummary({ profile: { net: "big", workers: 2, source: "detected" }, setup: idle,
      measurements: scaling([400000, 760000, 830000]), detection: det("big", 2) });
    expect(s.line).toBe("Full · 2 workers · 760 kn/s");
    // The 3rd worker added 70k of a 400k worker: 18%, under the 50% that pays.
    expect(s.detail).toBe("3rd worker +18%");
  });

  it("says when the device cap, a crashed step or a failed step stopped the ladder", () => {
    const cap = engineSummary({ profile: { net: "big", workers: 2, source: "detected" }, setup: idle,
      measurements: scaling([400000, 780000]), detection: det("big", 2, { cap: 2 }) });
    expect(cap.detail).toBe("Most this device runs");
    const crashed = engineSummary({ profile: { net: "big", workers: 1, source: "detected" }, setup: idle,
      measurements: scaling([400000]), detection: det("big", 1, { ceiling: 2 }) });
    expect(crashed.detail).toBe("Full ×2 closed this tab");
    // Straight after the kill the profile is the step below, not yet re-measured.
    const reloaded = engineSummary({ profile: { net: "big", workers: 2, source: "fallback" }, setup: idle, measurements: null,
      detection: { detected: { net: "big", workers: 2, source: "fallback" }, ceiling: 3, cap: 3, consent: "yes" } });
    expect(reloaded).toMatchObject({ line: "Full · 2 workers", detail: "Full ×3 closed this tab" });
    const failed = engineSummary({ profile: { net: "big", workers: 1, source: "detected" }, setup: idle,
      measurements: { ...scaling([400000]), error: "Search timed out" }, detection: det("big", 1) });
    expect(failed).toMatchObject({ detail: "Next step failed", title: "Search timed out" });
  });

  it("shows the live phase and step while Detect runs, bytes while a net downloads", () => {
    expect(engineSummary({ profile: { net: "lite", workers: 1, source: "fallback" }, detection: det("lite", 1),
      setup: { phase: "probe", label: "Measuring Full ×2…", done: 4, probeTotal: 9 } })).toMatchObject({ line: "Measuring Full ×2…", detail: "Step 5 of 9" });
    expect(engineSummary({ profile: { net: "lite", workers: 1, source: "fallback" }, detection: det("lite", 1),
      setup: { phase: "download", label: "Downloading full engine…", loaded: 10485760, total: 99614720 } }).detail).toBe("10 / 95 MB");
  });

  it("explains a run that closed the tab in words, keeping the dev phase in the tooltip", () => {
    const s = engineSummary({ profile: { net: "big", workers: 1, source: "fallback" }, setup: idle, measurements: null,
      crash: { net: "big", workers: 2, phase: "analyze-maia-phase-start" }, detection: det("big", 1) });
    expect(s).toEqual({ line: "Full · 1 worker", detail: "Full ×2 stopped during Analyze's Maia step", title: "Last phase: analyze-maia-phase-start" });
    expect(phaseLabel(null)).toBe("a run");
    expect(phaseLabel("build-generate-click")).toBe("Build");
  });

  it("marks a user's own choice and what Detect would have picked", () => {
    const s = engineSummary({ profile: { net: "lite", workers: 1, source: "user" }, setup: idle,
      measurements: scaling([400000, 760000]), detection: det("big", 2) });
    expect(s).toMatchObject({ line: "Lite · 1 worker · 400 kn/s", detail: "Set by you · Detect picked Full ×2" });
    expect(engineSummary({ profile: { net: "lite", workers: 1, source: "fallback" }, setup: idle, detection: { detected: null, ceiling: null, cap: 3 } }).detail)
      .toBe("Not measured yet");
  });

  it("formats speeds and greyed-out reasons", () => {
    expect(speedLabel(1234567)).toBe("1.2 Mn/s");
    expect(speedLabel(0)).toBe("");
    expect(disabledReason("workers", "3", { choices: { lite: 1, big: 2 }, net: "big" })).toBe("Detect held 2 workers on Full");
    expect(disabledReason("net", "big", { choices: { lite: 1, big: 0 }, net: "lite", fullChoice: "ask" })).toBe("Download Full first");
  });
});
